import { describe, expect, it } from '@jest/globals';
import { attempt, err, ok, type Result } from './index.js';

describe('Result', () => {
  it('narrows on the ok discriminant', () => {
    const results: Result<number, string>[] = [ok(1), err('nope')];
    const seen = results.map((result) => (result.ok ? result.value : result.error));
    expect(seen).toEqual([1, 'nope']);
  });
});

describe('attempt', () => {
  const toMessage = (cause: unknown) => ({
    kind: 'failed' as const,
    message: cause instanceof Error ? cause.message : String(cause),
  });

  it('wraps a resolved value in Ok', async () => {
    expect(await attempt(() => Promise.resolve(42), toMessage)).toEqual({ ok: true, value: 42 });
  });

  it('maps a rejection to Err instead of throwing', async () => {
    const result = await attempt(() => Promise.reject(new Error('boom')), toMessage);
    expect(result).toEqual({ ok: false, error: { kind: 'failed', message: 'boom' } });
  });
});
