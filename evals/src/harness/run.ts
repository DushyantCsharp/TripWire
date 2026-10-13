import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  anthropicModelClient,
  baselineTriager,
  claudeTriager,
  type Clock,
  type Effort,
  memoryChangeSource,
  memoryLogStore,
  memoryTraceStore,
  type MetricStore,
  type ModelClient,
  pricingFor,
  prometheusMetricStore,
  READ_TOOLS,
  type ReadToolName,
  systemClock,
  telemetryTools,
  type ToolHandler,
  type ToolHandlers,
  type ToolRecord,
  type TriageBudget,
  type Triager,
  type TriageReport,
} from '@tripwire/agent';
import { manualClock, type RecordedFetch, recordFetch, replayFetch } from '@tripwire/agent/testing';
import { hashingEmbedder, pgvectorRunbookIndex } from '@tripwire/pipeline';
import type { Result } from '@tripwire/result';
import type { CaseData } from '../cases.js';
import { ingestCase, replayDatabase } from '../replay/incident.js';
import { replayPrometheus } from '../replay/prometheus.js';
import type { RunOutcome } from '../score.js';

// Runs one case: its incident formed as production would form it, the triager given tools over
// the case's captured telemetry (and a real Prometheus for its metrics), its report kept with
// every record the tools returned, for scoring.

/** The worker's budget (apps/worker config). */
export const EVAL_BUDGET: TriageBudget = {
  maxInputTokens: 40_000,
  maxOutputTokens: 4_000,
  maxToolCalls: 8,
  maxWallClockMs: 60_000,
};

/**
 * Model responses kept per case in `<dir>/<case id>/`: `record` calls the model and writes them,
 * `replay` serves them and calls nothing. Either way the run is made repeatable: the loop's clock
 * stands still at the capture (a replay never times out; a recording still does, on real timers)
 * and the case runs once, with no retries.
 */
export interface Recordings {
  readonly mode: 'record' | 'replay';
  readonly dir: string;
  /** Where `record` sends requests: the API by default, a fake in tests. */
  readonly upstream?: typeof fetch | undefined;
}

export interface HarnessOptions {
  readonly triager: 'claude' | 'baseline';
  readonly model: string;
  readonly effort: Effort;
  readonly apiKey?: string | undefined;
  /** A Postgres server (pgvector) to create each case's database on. */
  readonly databaseServerUrl: string;
  readonly runbooksDir: string;
  readonly budget?: TriageBudget | undefined;
  /** Replaces the Anthropic client: tests script the model. */
  readonly client?: ModelClient | undefined;
  readonly recordings?: Recordings | undefined;
  /** Replaces the per-case Prometheus: tests stub metrics. */
  readonly metrics?:
    ((data: CaseData) => Promise<{ store: MetricStore; stop(): Promise<void> }>) | undefined;
  /** Attempts for a run the model provider fails transiently (429, 5xx): the worker's retry. */
  readonly attempts?: number | undefined;
}

/**
 * The incident id the triager sees. The database's is random and the model reads it, so a case
 * gets one derived from its id: the same request every run, which replay depends on.
 */
export function caseIncidentId(caseId: string): string {
  const hex = createHash('sha256').update(`tripwire-eval-case:${caseId}`).digest('hex');
  // A UUIDv8 (custom): version 8, RFC 4122 variant.
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function runCase(data: CaseData, options: HarnessOptions): Promise<RunOutcome> {
  const embedder = hashingEmbedder();
  const database = await replayDatabase(options.databaseServerUrl, options.runbooksDir, embedder);
  let metrics: { store: MetricStore; stop(): Promise<void> } | undefined;
  try {
    const ingested = await ingestCase(database.db, data, embedder);
    const input = { ...ingested.input, incidentId: caseIncidentId(data.meta.id) };
    metrics = options.metrics ? await options.metrics(data) : await prometheusFor(data);
    const capturedAt = new Date(data.meta.capturedAt);
    const { handlers, returned } = recording(
      telemetryTools(
        {
          logs: memoryLogStore(data.logs),
          traces: memoryTraceStore(data.traces),
          metrics: metrics.store,
          changes: memoryChangeSource(data.changes),
          runbooks: pgvectorRunbookIndex(database.db, embedder),
        },
        { now: () => capturedAt },
      ),
    );
    const model = modelFor(options, data);
    const triager = triagerFor(options, handlers, model);
    const attempts = options.recordings ? 1 : (options.attempts ?? 3);
    let latencyMs = 0;
    let result:
      | Result<TriageReport, { kind: string; message: string; retryAfterMs?: number | undefined }>
      | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      returned.clear();
      const started = performance.now();
      result = await triager.triage(input, {
        budget: options.budget ?? EVAL_BUDGET,
        runKey: `eval-${data.meta.id}`,
      });
      latencyMs = Math.round(performance.now() - started);
      if (
        result.ok ||
        !['rate_limited', 'upstream_unavailable', 'timeout'].includes(result.error.kind)
      )
        break;
      if (attempt < attempts) {
        const retryAfter = 'retryAfterMs' in result.error ? (result.error.retryAfterMs ?? 0) : 0;
        await sleep(Math.max(retryAfter, 2_000 * 2 ** (attempt - 1)));
      }
    }
    if (!result) throw new Error('no attempt ran');
    if (options.recordings?.mode === 'replay' && model.recorder) {
      checkReplayed(data.meta.id, model.recorder, join(options.recordings.dir, data.meta.id));
    }
    return {
      meta: data.meta,
      triager: triager.model,
      report: result.ok ? result.value : null,
      error: result.ok ? null : `${result.error.kind}: ${result.error.message}`,
      returned: new Map(returned),
      latencyMs,
      incidents: ingested.incidents,
    };
  } finally {
    await metrics?.stop();
    await database.drop();
  }
}

async function prometheusFor(data: CaseData) {
  const prometheus = await replayPrometheus(data.metrics);
  return { store: prometheusMetricStore({ url: prometheus.url }), stop: () => prometheus.stop() };
}

interface CaseModel {
  readonly client?: ModelClient | undefined;
  readonly recorder?: RecordedFetch | undefined;
  readonly clock?: Clock | undefined;
}

/** The model client for a case: live, scripted (tests), or recorded and replayed. */
function modelFor(options: HarnessOptions, data: CaseData): CaseModel {
  if (options.triager === 'baseline') return {};
  const recordings = options.recordings;
  if (!recordings) {
    return {
      client:
        options.client ??
        (options.apiKey ? anthropicModelClient({ apiKey: options.apiKey }) : undefined),
    };
  }
  const dir = join(recordings.dir, data.meta.id);
  const capturedAt = Date.parse(data.meta.capturedAt);
  if (recordings.mode === 'replay') {
    if (!existsSync(dir)) {
      throw new Error(
        `${data.meta.id} has no recordings in ${recordings.dir}: record the replay subset ` +
          '(just eval --record evals/replay --subset nightly)',
      );
    }
    const recorder = replayFetch(dir);
    return {
      recorder,
      client: anthropicModelClient({ apiKey: 'replay', fetch: recorder.fetch }),
      clock: manualClock(capturedAt),
    };
  }
  if (!options.apiKey && !recordings.upstream) {
    throw new Error('--record calls the model, so it needs ANTHROPIC_API_KEY');
  }
  const recorder = recordFetch(dir, recordings.upstream ?? globalThis.fetch);
  return {
    recorder,
    client: anthropicModelClient({ apiKey: options.apiKey ?? 'fake', fetch: recorder.fetch }),
    // Standing still, as the replay's does, but with real timers so a hung call still ends.
    clock: { now: () => capturedAt, setTimer: (ms, fn) => systemClock.setTimer(ms, fn) },
  };
}

/** A replay must ask for exactly what was recorded: anything else means the input changed. */
function checkReplayed(caseId: string, recorder: RecordedFetch, dir: string): void {
  const unused = recorder.unused();
  if (recorder.missing.length === 0 && unused.length === 0) return;
  throw new Error(
    `${caseId}: the run doesn't match its recordings in ${dir} (${String(recorder.missing.length)} ` +
      `request(s) never recorded: ${recorder.missing.join(', ') || 'none'}; ${String(unused.length)} ` +
      'recording(s) never asked for). Something the model sees changed (prompt, tools, schemas or ' +
      'the case): re-record the replay subset (just eval --record evals/replay --subset nightly).',
  );
}

function triagerFor(options: HarnessOptions, tools: ToolHandlers, model: CaseModel): Triager {
  if (options.triager === 'baseline') return baselineTriager();
  if (!model.client) throw new Error('the claude triager needs ANTHROPIC_API_KEY');
  return claudeTriager({
    model: options.model,
    client: model.client,
    tools,
    effort: options.effort,
    pricing: pricingFor(options.model),
    clock: model.clock,
  });
}

/** Wraps tool handlers to keep every record they return: what a report may cite. */
export function recording(handlers: ToolHandlers): {
  handlers: ToolHandlers;
  returned: Map<string, ToolRecord>;
} {
  const returned = new Map<string, ToolRecord>();
  const wrap = <K extends ReadToolName>(name: K, handler: ToolHandler<K> | undefined) =>
    handler &&
    (async (input: Parameters<ToolHandler<K>>[0], options: Parameters<ToolHandler<K>>[1]) => {
      const result = await handler(input, options);
      if (result.ok) {
        for (const record of READ_TOOLS[name].records(result.value))
          returned.set(record.id, record);
      }
      return result;
    });
  return {
    returned,
    handlers: {
      query_logs: wrap('query_logs', handlers.query_logs),
      query_traces: wrap('query_traces', handlers.query_traces),
      query_metrics: wrap('query_metrics', handlers.query_metrics),
      list_deploys: wrap('list_deploys', handlers.list_deploys),
      get_runbook: wrap('get_runbook', handlers.get_runbook),
    },
  };
}
