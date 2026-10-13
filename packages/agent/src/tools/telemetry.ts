import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@tripwire/result';
import { z } from 'zod';
import { canonicalJson } from '../canonical.js';
import type { ToolHandlers, ToolInput, ToolOutput } from './definitions.js';
import type { LogLine, MetricSeries, TelemetryPorts, ToolError, Trace } from './ports.js';
import type { SEVERITIES } from './schemas.js';

// The read tools over the telemetry ports. This is the "server side" of each tool: it queries the
// backend, then summarises (counts, line patterns, trace and series statistics) so the model gets
// a compact answer rather than raw telemetry. Live runs and the evals share it.

export interface TelemetryToolOptions {
  /** The present. The evals pin it to when a case was captured. */
  readonly now?: (() => Date) | undefined;
  /** Newest lines read to count log patterns. */
  readonly patternSample?: number | undefined;
}

const MIN_SEVERITY: Record<(typeof SEVERITIES)[number], number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

/** OpenTelemetry severity number to its bucket name. */
export function severityName(severityNumber: number): string {
  if (severityNumber >= 17) return 'error';
  if (severityNumber >= 13) return 'warn';
  if (severityNumber >= 9) return 'info';
  if (severityNumber >= 5) return 'debug';
  return 'trace';
}

export function telemetryTools(
  ports: TelemetryPorts,
  options: TelemetryToolOptions = {},
): ToolHandlers {
  const now = options.now ?? (() => new Date());
  const patternSample = options.patternSample ?? 500;

  return {
    async query_logs(input, { signal }) {
      const page = resolvePage(input, now());
      if (!page.ok) return page;
      const { from, to, offset } = page.value;
      const result = await ports.logs.search(
        {
          service: input.service,
          minSeverityNumber: input.minSeverity && MIN_SEVERITY[input.minSeverity],
          contains: input.contains,
          from,
          to,
          offset,
          limit: input.limit,
          sampleSize: offset === 0 ? patternSample : 0,
        },
        { signal },
      );
      if (!result.ok) return result;
      const { total, bySeverity, byService, lines, sample } = result.value;
      const next = offset + lines.length;
      return ok({
        window: { from: from.toISOString(), to: to.toISOString() },
        total,
        bySeverity: { ...bySeverity },
        byService: { ...byService },
        patterns: offset === 0 ? logPatterns(sample.length > 0 ? sample : lines, 5) : [],
        lines: lines.map((line) => ({
          id: `log:${line.id}`,
          at: line.at.toISOString(),
          service: line.service,
          severity: severityName(line.severityNumber),
          body: clip(line.body, 160),
        })),
        truncated: false,
        nextCursor:
          next < total && lines.length > 0
            ? encodeCursor({
                from: from.getTime(),
                to: to.getTime(),
                offset: next,
                filter: filterKey(input),
              })
            : null,
      });
    },

    async query_traces(input, { signal }) {
      const { from, to } = windowEnding(now(), input.minutes);
      const result = await ports.traces.search(
        {
          service: input.service,
          operation: input.operation,
          errorsOnly: input.errorsOnly,
          minDurationMs: input.minDurationMs,
          from,
          to,
          limit: input.limit,
        },
        { signal },
      );
      if (!result.ok) return result;
      const summaries = result.value.map(summariseTrace);
      const durations = summaries.map((trace) => trace.durationMs);
      // Failing first, then slowest: the traces most likely to explain an incident.
      const ranked = summaries
        .sort((a, b) => b.errors.length - a.errors.length || b.durationMs - a.durationMs)
        .slice(0, input.limit);
      return ok({
        window: { from: from.toISOString(), to: to.toISOString() },
        summary: {
          traces: summaries.length,
          withErrors: summaries.filter((trace) => trace.errors.length > 0).length,
          p50Ms: percentile(durations, 0.5),
          p95Ms: percentile(durations, 0.95),
        },
        traces: ranked,
        truncated: false,
      });
    },

    async query_metrics(input, { signal }) {
      const { from, to } = windowEnding(now(), input.minutes);
      const stepSeconds = input.stepSeconds ?? Math.max(15, Math.round((input.minutes * 60) / 60));
      const result = await ports.metrics.queryRange(
        { promql: input.promql, start: from, end: to, stepSeconds },
        { signal },
      );
      if (!result.ok) return result;
      return ok({
        window: { from: from.toISOString(), to: to.toISOString() },
        stepSeconds,
        ...summariseSeries(input.promql, result.value, to, 8),
        truncated: false,
      });
    },

    ...(ports.changes && {
      list_deploys: async (input: ToolInput<'list_deploys'>, { signal }) => {
        const { from, to } = windowEnding(now(), input.minutes);
        const changes = ports.changes;
        if (!changes) return err({ kind: 'unavailable', message: 'no change source' });
        const result = await changes.list({ service: input.service, from, to }, { signal });
        if (!result.ok) return result;
        return ok({
          window: { from: from.toISOString(), to: to.toISOString() },
          changes: [...result.value]
            .sort((a, b) => b.at.getTime() - a.at.getTime())
            .slice(0, 10)
            .map((change) => ({
              id: `change:${change.id}`,
              service: change.service,
              kind: change.kind,
              description: clip(change.description, 200),
              at: change.at.toISOString(),
            })),
          truncated: result.value.length > 10,
        } satisfies ToolOutput<'list_deploys'>);
      },
    }),

    async get_runbook(input, { signal }) {
      const result = await ports.runbooks.search(
        { text: input.query, service: input.service, k: input.k },
        { signal },
      );
      if (!result.ok) return result;
      return ok({
        sections: result.value.slice(0, input.k).map((section) => ({
          id: `runbook:${section.id}`,
          title: section.title,
          service: section.service,
          excerpt: clip(section.content, 600),
          score: round(section.score, 3),
        })),
        truncated: false,
      });
    },
  };
}

// --- logs ---------------------------------------------------------------------------------------

const cursorSchema = z.strictObject({
  from: z.number().int(),
  to: z.number().int(),
  offset: z.number().int().positive(),
  filter: z.string(),
});

type Cursor = z.output<typeof cursorSchema>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** The window and offset of a query_logs page: a cursor freezes the first page's window. */
function resolvePage(
  input: ToolInput<'query_logs'>,
  at: Date,
): Result<{ from: Date; to: Date; offset: number }, ToolError> {
  if (input.cursor === undefined) return ok({ ...windowEnding(at, input.minutes), offset: 0 });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
  } catch {
    return err({ kind: 'invalid_query', message: 'cursor is not one this tool returned' });
  }
  const cursor = cursorSchema.safeParse(decoded);
  if (!cursor.success) {
    return err({ kind: 'invalid_query', message: 'cursor is not one this tool returned' });
  }
  if (cursor.data.filter !== filterKey(input)) {
    return err({
      kind: 'invalid_query',
      message: 'cursor belongs to a query with other filters: repeat those filters to page on',
    });
  }
  return ok({
    from: new Date(cursor.data.from),
    to: new Date(cursor.data.to),
    offset: cursor.data.offset,
  });
}

function filterKey(input: ToolInput<'query_logs'>): string {
  const filters = {
    service: input.service,
    minSeverity: input.minSeverity,
    contains: input.contains,
  };
  return createHash('sha256').update(canonicalJson(filters)).digest('hex').slice(0, 12);
}

// Variable parts of a log line: ids, hex, numbers and quoted values.
const VARIABLE_PARTS: readonly [RegExp, string][] = [
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '*'],
  [/\b[0-9a-f]{12,}\b/gi, '*'],
  [/"[^"]*"/g, '"*"'],
  [/'[^']*'/g, "'*'"],
  // A number, even with a unit after it (12.5ms), unless it is part of a word (http2, x86).
  [/(?<![A-Za-z\d.])\d+(?:\.\d+)?/g, '#'],
];

/** A log line's shape: the same message with different ids or numbers maps to one template. */
export function logTemplate(body: string): string {
  let template = body;
  for (const [pattern, replacement] of VARIABLE_PARTS)
    template = template.replace(pattern, replacement);
  return clip(template.replace(/\s+/g, ' ').trim(), 160);
}

export function logPatterns(
  lines: readonly LogLine[],
  top: number,
): ToolOutput<'query_logs'>['patterns'] {
  const groups = new Map<
    string,
    { count: number; example: LogLine; services: Map<string, number> }
  >();
  for (const line of lines) {
    const key = `${severityName(line.severityNumber)} ${logTemplate(line.body)}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.services.set(line.service, (group.services.get(line.service) ?? 0) + 1);
    } else {
      groups.set(key, { count: 1, example: line, services: new Map([[line.service, 1]]) });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.example.severityNumber - a.example.severityNumber)
    .slice(0, top)
    .map((group) => ({
      template: logTemplate(group.example.body),
      count: group.count,
      service:
        [...group.services.entries()].sort(([, x], [, y]) => y - x)[0]?.[0] ??
        group.example.service,
      severity: severityName(group.example.severityNumber),
      exampleId: `log:${group.example.id}`,
    }));
}

// --- traces -------------------------------------------------------------------------------------

type TraceSummary = ToolOutput<'query_traces'>['traces'][number];

export function summariseTrace(trace: Trace): TraceSummary {
  const ids = new Set(trace.spans.map((span) => span.spanId));
  const root =
    trace.spans.find((span) => span.parentSpanId === null || !ids.has(span.parentSpanId)) ??
    trace.spans[0];
  const start = Math.min(...trace.spans.map((span) => span.startUs));
  const end = Math.max(...trace.spans.map((span) => span.startUs + span.durationUs));
  const depth = spanDepths(trace);
  return {
    id: `trace:${trace.traceId}`,
    root: root ? `${root.service} ${root.operation}` : 'unknown',
    startedAt: new Date(Math.floor(start / 1000)).toISOString(),
    durationMs: round((root ? root.durationUs : end - start) / 1000, 1),
    spanCount: trace.spans.length,
    services: [...new Set(trace.spans.map((span) => span.service))],
    // Outermost failure first, innermost (the likeliest origin) last; at most 3.
    errors: trace.spans
      .filter((span) => span.error)
      .sort((a, b) => (depth.get(a.spanId) ?? 0) - (depth.get(b.spanId) ?? 0))
      .slice(-3)
      .map((span) => ({
        service: span.service,
        operation: span.operation,
        message: span.message === null ? null : clip(span.message, 120),
      })),
  };
}

function spanDepths(trace: Trace): Map<string, number> {
  const parents = new Map(trace.spans.map((span) => [span.spanId, span.parentSpanId]));
  const depths = new Map<string, number>();
  for (const span of trace.spans) {
    let depth = 0;
    let parent = span.parentSpanId;
    const seen = new Set<string>();
    while (parent !== null && parents.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = parents.get(parent) ?? null;
    }
    depths.set(span.spanId, depth);
  }
  return depths;
}

// --- metrics ------------------------------------------------------------------------------------

/** Labels that identify a process or collector, not a service: noise to the model. */
const NOISY_LABELS = new Set([
  'instance',
  'service_instance_id',
  'collector_instance_id',
  'host_name',
  'container_id',
]);

type SeriesSummary = Pick<ToolOutput<'query_metrics'>, 'commonLabels' | 'series' | 'totalSeries'>;

export function summariseSeries(
  promql: string,
  series: readonly MetricSeries[],
  end: Date,
  maxSeries: number,
): SeriesSummary {
  const labelled = series.map((s) => ({
    labels: Object.fromEntries(
      Object.entries(s.labels).filter(([name]) => !NOISY_LABELS.has(name)),
    ),
    points: s.points.filter(([, value]) => Number.isFinite(value)),
  }));
  const common = commonLabels(labelled.map((s) => s.labels));
  const summaries = labelled.map((s) => {
    const values = s.points.map(([, value]) => value);
    const labels = Object.fromEntries(
      Object.entries(s.labels).filter(([name]) => !(name in common)),
    );
    return {
      id: `metric:${createHash('sha256')
        .update(`${promql}\0${canonicalJson(s.labels)}`)
        .digest('hex')
        .slice(0, 12)}`,
      labels,
      min: values.length ? significant(Math.min(...values)) : null,
      max: values.length ? significant(Math.max(...values)) : null,
      mean: values.length ? significant(values.reduce((a, b) => a + b, 0) / values.length) : null,
      first: values.length ? significant(values[0] ?? 0) : null,
      last: values.length ? significant(values.at(-1) ?? 0) : null,
      points: downsample(s.points, 12).map(([at, value]): [number, number] => [
        round((at * 1000 - end.getTime()) / 60_000, 1),
        significant(value),
      ]),
    };
  });
  // The series that peak highest first: they're the ones an incident shows in.
  summaries.sort((a, b) => (b.max ?? -Infinity) - (a.max ?? -Infinity));
  return {
    commonLabels: common,
    series: summaries.slice(0, maxSeries),
    totalSeries: summaries.length,
  };
}

function commonLabels(labelSets: readonly Record<string, string>[]): Record<string, string> {
  const [first, ...rest] = labelSets;
  if (!first || rest.length === 0) return {};
  return Object.fromEntries(
    Object.entries(first).filter(([name, value]) => rest.every((labels) => labels[name] === value)),
  );
}

function downsample<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  return Array.from(
    { length: max },
    (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))] as T,
  );
}

// --- shared -------------------------------------------------------------------------------------

function windowEnding(at: Date, minutes: number): { from: Date; to: Date } {
  return { from: new Date(at.getTime() - minutes * 60_000), to: at };
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Three significant figures. */
export function significant(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(3));
}

function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null;
}
