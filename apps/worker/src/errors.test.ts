import type { TriageError } from '@tripwire/agent';
import { describe, expect, it } from '@jest/globals';
import { UnrecoverableError } from 'bullmq';
import { failureReason, FatalError, RetryableError, toJobError } from './errors.js';

describe('toJobError', () => {
  // 429, 5xx and timeouts retry with backoff; everything else fails the job now.
  it.each<[TriageError, typeof RetryableError | typeof FatalError]>([
    [{ kind: 'rate_limited', message: '429' }, RetryableError],
    [{ kind: 'upstream_unavailable', message: '503', status: 503 }, RetryableError],
    [{ kind: 'upstream_unavailable', message: 'socket hang up' }, RetryableError],
    [{ kind: 'timeout', message: 'slow' }, RetryableError],
    [{ kind: 'request_rejected', message: '400', status: 400 }, FatalError],
    [{ kind: 'request_rejected', message: '401', status: 401 }, FatalError],
  ])('%o becomes a %p', (error, expected) => {
    const jobError = toJobError(error);
    expect(jobError).toBeInstanceOf(expected);
    expect(jobError).toMatchObject({ kind: error.kind, message: error.message });
    // BullMQ skips the remaining attempts only for an UnrecoverableError.
    expect(jobError instanceof UnrecoverableError).toBe(expected === FatalError);
  });

  it("carries a rate limiter's Retry-After, and only a rate limiter's", () => {
    expect(
      toJobError({ kind: 'rate_limited', message: '429', retryAfterMs: 12_000 }),
    ).toMatchObject({ name: 'RetryableError', retryAfterMs: 12_000 });
    expect(toJobError({ kind: 'timeout', message: 'slow' })).toMatchObject({
      retryAfterMs: undefined,
    });
  });
});

describe('failureReason', () => {
  // What a dead-lettered job's triage_runs.failure_reason says killed it.
  it.each<[Error, string]>([
    [new RetryableError('429', 'rate_limited'), 'model_unavailable'],
    [new RetryableError('503', 'upstream_unavailable'), 'model_unavailable'],
    [new RetryableError('slow', 'timeout'), 'timed_out'],
    [new RetryableError('db', 'database'), 'internal_error'],
    [new FatalError('400', 'request_rejected'), 'request_rejected'],
    [new FatalError('bad', 'invalid_job'), 'invalid_output'],
    [new FatalError('gone', 'not_found'), 'internal_error'],
    [new Error('job stalled more than allowable limit'), 'internal_error'],
  ])('%o → %s', (error, reason) => {
    expect(failureReason(error)).toBe(reason);
  });
});
