import { describe, expect, it } from '@jest/globals';
import { backoffStrategy, FULL_JITTER, fullJitterDelay } from './backoff.js';
import { RetryableError } from './errors.js';

// Triage: base 2s, cap 60s (jobOptions.triage, TRIAGE_BACKOFF_*).
const policy = { baseMs: 2_000, capMs: 60_000 };
const at = (random: number) => ({ ...policy, random: () => random });

describe('full-jitter backoff', () => {
  // [retry, random draw, delay]: a uniform draw from [0, min(cap, base × 2^(retry-1))).
  it.each([
    [1, 0, 0],
    [1, 0.5, 1_000],
    [1, 0.999_999, 1_999],
    [2, 0.5, 2_000],
    [3, 0.5, 4_000],
    [4, 0.25, 4_000],
    [4, 0.999_999, 15_999],
    [5, 0.999_999, 31_999],
    [6, 0.5, 30_000],
    // 2s × 2^5 = 64s: capped from here on.
    [6, 0.999_999, 59_999],
    [7, 0.999_999, 59_999],
    [20, 0.999_999, 59_999],
  ])('retry %i with draw %p waits %i ms', (retry, random, delay) => {
    expect(fullJitterDelay(retry, at(random))).toBe(delay);
  });

  it('spreads retries out instead of synchronising them', () => {
    const delays = Array.from({ length: 1000 }, () => fullJitterDelay(4, policy));
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(16_000);
    expect(new Set(delays.map((d) => Math.floor(d / 1000))).size).toBeGreaterThan(10);
  });

  // [retry, draw, error, delay]: never sooner than a rate limiter's Retry-After.
  it.each([
    [1, 0, new RetryableError('429', 'rate_limited', 30_000), 30_000],
    [5, 0.999_999, new RetryableError('429', 'rate_limited', 30_000), 31_999],
    [1, 0.5, new RetryableError('503', 'upstream_unavailable'), 1_000],
    [1, 0.5, new Error('stalled'), 1_000],
    [1, 0, undefined, 0],
  ])('retry %i, draw %p, after %o: waits %i ms', (retry, random, error, delay) => {
    expect(backoffStrategy(at(random))(retry, FULL_JITTER, error)).toBe(delay);
  });

  it('refuses a backoff type it does not implement', () => {
    expect(() => backoffStrategy(policy)(1, 'linear')).toThrow(/unknown backoff type/);
  });
});
