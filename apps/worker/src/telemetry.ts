import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { meter } from '@tripwire/telemetry';

// The worker's metrics (CLAUDE.md "Observability"). Prometheus names them triage_duration_seconds,
// tokens_total and cost_usd_total. Build them once the SDK (if any) has started, never at module
// load: an instrument made before then stays a no-op.

export interface WorkerMetrics {
  /** Seconds per triage run, by model, stop reason and outcome. */
  readonly triageDuration: Histogram;
  /** Model tokens by model and type: input (cached included), output, and the cached parts. */
  readonly tokens: Counter;
  /** Model spend in US dollars, by model. */
  readonly cost: Counter;
}

export function workerMetrics(m: Meter = meter()): WorkerMetrics {
  return {
    triageDuration: m.createHistogram('triage_duration', {
      unit: 's',
      description: 'Time to triage an incident, from loading it to its report',
      // Around the targets: p50 under 25 s, p95 under 60 s.
      advice: {
        explicitBucketBoundaries: [0.1, 0.5, 1, 2.5, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120],
      },
    }),
    tokens: m.createCounter('tokens_total', {
      unit: '{token}',
      description: 'Model tokens: type input (cached included), output, cache_read, cache_write',
    }),
    // A braced unit: Prometheus would turn a bare USD into a cost_usd_USD_total suffix.
    cost: m.createCounter('cost_usd_total', {
      unit: '{USD}',
      description: 'Model spend in US dollars, at the prices in packages/agent/src/pricing.ts',
    }),
  };
}
