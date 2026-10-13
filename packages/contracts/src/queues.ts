import { z } from 'zod';

/** BullMQ queue names, shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  ingest: 'ingest',
  cluster: 'cluster',
  triage: 'triage',
  backfill: 'backfill',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Parking queues for jobs that failed for good. No worker consumes them: an operator inspects an
 * entry and redrives it with the GraphQL `redriveTriageJob` mutation. Nothing redrives on its own.
 */
export const DEAD_LETTER_QUEUES = { triage: 'triage-dlq' } as const;

/**
 * Deterministic job ids make enqueueing idempotent: BullMQ ignores an add whose id still exists,
 * so a retried producer never doubles a job. BullMQ forbids ":" in ids.
 */
export const jobIds = {
  ingest: (ingestId: string) => ingestId,
  cluster: (alertId: string) => `cluster-${alertId}`,
  triage: (incidentId: string) => `triage-${incidentId}`,
  redrive: (deadLetterId: string) => `redrive-${deadLetterId}`,
  deadLetter: (jobId: string) => `dlq-${jobId}`,
};

const keepCompleted = (seconds: number) => ({ age: seconds, count: 10_000 });
const KEEP_FAILED = { age: 7 * 24 * 3600 };

/** Retry and retention policy per queue, used by every producer of that queue. */
export const jobOptions = {
  ingest: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: keepCompleted(3600),
    removeOnFail: KEEP_FAILED,
  },
  cluster: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: keepCompleted(3600),
    removeOnFail: KEEP_FAILED,
  },
  // 'full-jitter' is the worker's custom backoff strategy: base 2s, cap 60s. Completed jobs are kept
  // for a day so a re-added id stays a no-op; triage_runs.job_key backstops it after that.
  triage: {
    attempts: 5,
    backoff: { type: 'full-jitter' },
    removeOnComplete: keepCompleted(24 * 3600),
    removeOnFail: KEEP_FAILED,
  },
} as const;

const isoDateTime = z.iso.datetime({ offset: true });

/**
 * W3C trace context of the span that added the job (`@tripwire/telemetry`), so processing it joins
 * the trace of whatever caused it. Absent when nothing is traced; a malformed one is dropped, never
 * a reason to reject the job.
 */
const traceCarrier = z
  .object({ traceparent: z.string().min(1), tracestate: z.string().optional() })
  .optional()
  .catch(undefined);

export const ingestJobSchema = z.object({
  /** Database id of the delivery; the 202's `ingest_id` is its public form. */
  ingestId: z.uuid(),
  idempotencyKey: z.string().min(1).max(255),
  bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(['alertmanager', 'generic']),
  receivedAt: isoDateTime,
  /** The webhook body, already validated by the API; the worker parses it again for its source. */
  payload: z.unknown(),
  trace: traceCarrier,
});
export type IngestJob = z.infer<typeof ingestJobSchema>;

export const clusterJobSchema = z.object({ alertId: z.uuid(), trace: traceCarrier });
export type ClusterJob = z.infer<typeof clusterJobSchema>;

export const triageAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  errorClass: z.string(),
  message: z.string(),
  at: isoDateTime,
});
export type TriageAttempt = z.infer<typeof triageAttemptSchema>;

export const triageJobSchema = z.object({
  incidentId: z.uuid(),
  trigger: z.enum(['new_incident', 'redrive']),
  /** On a redriven job: the dead-letter entry it came from. */
  redrivenFrom: z.string().optional(),
  /** Appended by the worker after each failed attempt; becomes the dead-letter history. */
  attempts: z.array(triageAttemptSchema).default([]),
  trace: traceCarrier,
});
export type TriageJob = z.infer<typeof triageJobSchema>;

/** What the worker writes to the triage dead-letter queue. */
export const triageDeadLetterSchema = z.object({
  jobId: z.string(),
  job: triageJobSchema,
  /** RetryableError (attempts exhausted), FatalError (not worth retrying) or StalledJobError. */
  errorClass: z.string(),
  failedReason: z.string(),
  lastStack: z.string().nullable(),
  attempts: z.array(triageAttemptSchema),
  failedAt: isoDateTime,
});
export type TriageDeadLetter = z.infer<typeof triageDeadLetterSchema>;
