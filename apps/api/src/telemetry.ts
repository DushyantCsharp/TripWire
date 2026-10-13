import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { attempt } from '@tripwire/result';
import { meter } from '@tripwire/telemetry';

// The API's metrics (CLAUDE.md "Observability"). Prometheus names them ingest_ack_latency_seconds,
// shed_requests_total, queue_depth and dlq_size. Build them when the server is built, never at
// module load: an instrument made before the SDK starts stays a no-op.

export interface IngestMetrics {
  /** Seconds from a webhook request's arrival to its response, by route and status. */
  readonly ackLatency: Histogram;
  /** Webhook requests refused with a 503, by reason. */
  readonly shed: Counter;
}

export function ingestMetrics(m: Meter = meter()): IngestMetrics {
  return {
    ackLatency: m.createHistogram('ingest_ack_latency', {
      unit: 's',
      description: 'Webhook request to acknowledgement (202) or refusal',
      // Fine below 50 ms, the target's p99, with a boundary at exactly 50 ms.
      advice: {
        explicitBucketBoundaries: [
          0.001, 0.0025, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.075, 0.1, 0.25, 0.5,
          1, 2.5,
        ],
      },
    }),
    shed: m.createCounter('shed_requests_total', {
      unit: '{request}',
      description: 'Webhook requests refused with 503: overloaded, or a dependency down',
    }),
  };
}

/** What the gauges read of a BullMQ queue. */
export interface CountedQueue {
  readonly name: string;
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
}

const STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Queue depth per queue and state, and the dead-letter queue's size, read from Redis whenever
 * metrics are collected. A queue that can't be read reports nothing for that collection.
 */
export function observeQueues(
  queues: readonly CountedQueue[],
  deadLetters: CountedQueue,
  m: Meter = meter(),
): void {
  const depth = m.createObservableGauge('queue_depth', {
    unit: '{job}',
    description: 'Jobs in each BullMQ queue, by state',
  });
  depth.addCallback(async (result) => {
    for (const queue of queues) {
      const counts = await attempt(
        () => queue.getJobCounts(...STATES),
        (cause) => cause,
      );
      if (!counts.ok) continue;
      for (const state of STATES) {
        result.observe(counts.value[state] ?? 0, { queue: queue.name, state });
      }
    }
  });
  const dlq = m.createObservableGauge('dlq_size', {
    unit: '{job}',
    description: 'Triage jobs in the dead-letter queue, waiting for a person',
  });
  dlq.addCallback(async (result) => {
    const counts = await attempt(
      () => deadLetters.getJobCounts('waiting', 'delayed', 'paused'),
      (cause) => cause,
    );
    if (!counts.ok) return;
    const size = Object.values(counts.value).reduce((sum, count) => sum + count, 0);
    result.observe(size, { queue: deadLetters.name });
  });
}
