// What the webhook routes need from the outside world. Redis and BullMQ implement these in
// production (redis.ts, admission.ts); tests use in-memory fakes.
import type { IngestJob } from '@tripwire/contracts/queues';
import type { Result } from '@tripwire/result';
import type { IngestMetrics } from '../telemetry.js';

export interface DependencyError {
  readonly kind: 'dependency_unavailable';
  readonly message: string;
}

export interface IdempotencyRecord {
  readonly ingestId: string;
  readonly bodyHash: string;
  readonly receivedAt: string;
}

export type ClaimOutcome =
  { readonly claimed: true } | { readonly claimed: false; readonly existing: IdempotencyRecord };

export interface IdempotencyStore {
  /** Records the key if it's new (SET NX, 24h TTL); otherwise returns what the first request stored. */
  claim(key: string, record: IdempotencyRecord): Promise<Result<ClaimOutcome, DependencyError>>;
  /** Forgets a claim whose job never made it onto the queue, so a retry starts fresh. */
  release(key: string): Promise<Result<void, DependencyError>>;
}

export interface IngestQueue {
  /** Idempotent: the job id is the ingest id, and BullMQ ignores an id it already holds. */
  enqueue(job: IngestJob): Promise<Result<void, DependencyError>>;
}

export interface AdmissionControl {
  /** Null to admit; otherwise how long the sender should wait before retrying. */
  check(): { readonly retryAfterSeconds: number } | null;
}

export interface IngestDeps {
  readonly idempotency: IdempotencyStore;
  readonly queue: IngestQueue;
  readonly admission: AdmissionControl;
  readonly secrets: readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Ack latency and shedding; built with the routes when not given. */
  readonly metrics?: IngestMetrics | undefined;
}
