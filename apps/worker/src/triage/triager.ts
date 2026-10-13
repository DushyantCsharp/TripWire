import {
  anthropicModelClient,
  baselineTriager,
  claudeTriager,
  costUsdMicros,
  type ModelClient,
  type ModelPricing,
  type ModelUsage,
  pricingFor,
  telemetryTools,
  type Triager,
} from '@tripwire/agent';
import type { Database } from '@tripwire/db';
import type { Embedder } from '@tripwire/pipeline';
import type { WorkerConfig } from '../config.js';
import type { Log } from '../runtime.js';
import { type WorkerMetrics, workerMetrics } from '../telemetry.js';
import { telemetryPorts } from './tools.js';

export interface TriagerDeps {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly log: Log;
  /** Replaces the Anthropic client, for tests. */
  readonly client?: ModelClient | undefined;
  /** The worker's metrics; built with the triager when not given. */
  readonly metrics?: WorkerMetrics | undefined;
}

/**
 * The triager the worker runs, as TRIAGER says: the Claude tool-use loop over the configured
 * telemetry, or the model-free baseline (chaos tests, development without a key).
 */
export function createTriager(config: WorkerConfig, deps: TriagerDeps): Triager {
  if (config.TRIAGER === 'baseline') {
    return baselineTriager({ latencyMs: config.TRIAGE_SIMULATED_LATENCY_MS });
  }
  const apiKey = config.ANTHROPIC_API_KEY;
  // workerEnv refuses TRIAGER=claude without a key, so this is a bug if it happens.
  if (apiKey === undefined) throw new Error('TRIAGER=claude without ANTHROPIC_API_KEY');
  const metrics = deps.metrics ?? workerMetrics();
  const pricing = pricingFor(config.TRIAGE_MODEL);
  return claudeTriager({
    model: config.TRIAGE_MODEL,
    client: deps.client ?? anthropicModelClient({ apiKey, timeoutMs: config.TRIAGE_WALL_CLOCK_MS }),
    tools: telemetryTools(telemetryPorts(config, deps)),
    effort: config.TRIAGE_EFFORT,
    pricing,
    captureContent: config.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
    onEvent: (event) => {
      deps.log.info(`triage ${event.type}`, { ...event });
      // Per model call, so a run that fails afterwards still counts what it spent.
      if (event.type === 'model_call') {
        recordUsage(metrics, config.TRIAGE_MODEL, pricing, event.usage);
      }
    },
  });
}

/** Tokens by type (input counts the cached parts too) and dollars, for one model call. */
export function recordUsage(
  metrics: WorkerMetrics,
  model: string,
  pricing: ModelPricing | undefined,
  usage: ModelUsage,
): void {
  const tokens: [string, number][] = [
    ['input', usage.inputTokens],
    ['output', usage.outputTokens],
    ['cache_read', usage.cacheReadTokens],
    ['cache_write', usage.cacheWriteTokens],
  ];
  for (const [type, count] of tokens) {
    if (count > 0) metrics.tokens.add(count, { model, type });
  }
  metrics.cost.add(costUsdMicros(usage, pricing) / 1_000_000, { model });
}
