import type { BackoffStrategy } from 'bullmq';
import { RetryableError } from './errors.js';

/** The job option `backoff: { type: 'full-jitter' }` (see jobOptions.triage in contracts). */
export const FULL_JITTER = 'full-jitter';

export interface FullJitterOptions {
  readonly baseMs: number;
  readonly capMs: number;
  readonly random?: () => number;
}

/**
 * "Full jitter": a uniform delay between 0 and the capped exponential ceiling, base × 2^(n-1). It
 * spreads retries out, so a burst of failures doesn't come back as a synchronised burst of retries.
 * `retry` is 1 for the first retry.
 */
export function fullJitterDelay(
  retry: number,
  { baseMs, capMs, random = Math.random }: FullJitterOptions,
): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** (retry - 1)));
}

/** BullMQ's backoffStrategy: full jitter, but never sooner than a rate limiter's Retry-After. */
export function backoffStrategy(options: FullJitterOptions): BackoffStrategy {
  return (attemptsMade, type, error) => {
    if (type !== FULL_JITTER) throw new Error(`unknown backoff type "${String(type)}"`);
    const retryAfterMs = error instanceof RetryableError ? (error.retryAfterMs ?? 0) : 0;
    return Math.max(fullJitterDelay(attemptsMade, options), retryAfterMs);
  };
}
