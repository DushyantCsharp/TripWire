import {
  anthropicModelClient,
  baselineTriager,
  claudeTriager,
  type ModelClient,
  pricingFor,
  telemetryTools,
  type Triager,
} from '@tripwire/agent';
import type { Database } from '@tripwire/db';
import type { Embedder } from '@tripwire/pipeline';
import type { WorkerConfig } from '../config.js';
import type { Log } from '../runtime.js';
import { telemetryPorts } from './tools.js';

export interface TriagerDeps {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly log: Log;
  /** Replaces the Anthropic client, for tests. */
  readonly client?: ModelClient | undefined;
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
  return claudeTriager({
    model: config.TRIAGE_MODEL,
    client: deps.client ?? anthropicModelClient({ apiKey, timeoutMs: config.TRIAGE_WALL_CLOCK_MS }),
    tools: telemetryTools(telemetryPorts(config, deps)),
    effort: config.TRIAGE_EFFORT,
    pricing: pricingFor(config.TRIAGE_MODEL),
    onEvent: (event) => {
      deps.log.info(`triage ${event.type}`, { ...event });
    },
  });
}
