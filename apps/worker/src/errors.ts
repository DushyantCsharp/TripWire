import { isRetryable, type TriageError } from '@tripwire/agent';
import type { TriageFailureReason } from '@tripwire/db';
import { UnrecoverableError } from 'bullmq';

export type JobErrorKind = TriageError['kind'] | 'database' | 'invalid_job' | 'not_found';

/** Another attempt could succeed (429, 5xx, timeouts, a database blip): BullMQ retries it. */
export class RetryableError extends Error {
  override readonly name = 'RetryableError';
  constructor(
    message: string,
    readonly kind: JobErrorKind,
    /** A rate limiter's Retry-After: the next attempt waits at least this long. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Retrying can't help (a rejected request, bad job data): an UnrecoverableError, so BullMQ fails the job now. */
export class FatalError extends UnrecoverableError {
  override readonly name = 'FatalError';
  constructor(
    message: string,
    readonly kind: JobErrorKind,
  ) {
    super(message);
  }
}

/** The worker edge from CLAUDE.md: a triage Result error becomes BullMQ retry semantics. */
export function toJobError(error: TriageError): RetryableError | FatalError {
  if (!isRetryable(error)) return new FatalError(error.message, error.kind);
  const retryAfterMs = error.kind === 'rate_limited' ? error.retryAfterMs : undefined;
  return new RetryableError(error.message, error.kind, retryAfterMs);
}

/** The triage_failure_reason recorded when a triage job is dead-lettered with this error. */
export function failureReason(error: unknown): TriageFailureReason {
  if (!(error instanceof RetryableError || error instanceof FatalError)) return 'internal_error';
  switch (error.kind) {
    case 'rate_limited':
    case 'upstream_unavailable':
      return 'model_unavailable';
    case 'timeout':
      return 'timed_out';
    case 'request_rejected':
      return 'request_rejected';
    case 'invalid_job':
      return 'invalid_output';
    case 'database':
    case 'not_found':
      return 'internal_error';
  }
}
