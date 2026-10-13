import { describe, expect, it } from '@jest/globals';
import { sign, signatureHeader, verifySignature } from './signature.js';

const secret = 'current-webhook-secret';
const now = new Date('2026-10-11T12:00:00Z');
const t = now.getTime() / 1000;
const body = Buffer.from('{"source":"k6","alerts":[]}');
const key = 'k6-1';

const verify = (
  header: string | undefined,
  overrides: Partial<Parameters<typeof verifySignature>[0]> = {},
) => verifySignature({ header, idempotencyKey: key, body, secrets: [secret], now, ...overrides });

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verify(signatureHeader(secret, t, key, body))).toEqual({ ok: true, value: undefined });
  });

  it.each([
    ['missing', undefined],
    ['malformed', 'sha256=abc'],
    ['malformed', `t=${String(t)}`],
  ] as const)('reports %s for %s', (reason, header) => {
    expect(verify(header)).toEqual({ ok: false, error: reason });
  });

  it('rejects a timestamp more than five minutes away', () => {
    expect(verify(signatureHeader(secret, t - 301, key, body))).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(verify(signatureHeader(secret, t + 301, key, body))).toEqual({
      ok: false,
      error: 'expired',
    });
    expect(verify(signatureHeader(secret, t - 299, key, body)).ok).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, or a swapped idempotency key', () => {
    const header = signatureHeader(secret, t, key, body);
    expect(verify(signatureHeader('some-other-secret!', t, key, body))).toEqual({
      ok: false,
      error: 'mismatch',
    });
    expect(verify(header, { body: Buffer.from('{"source":"k6","alerts":[1]}') })).toEqual({
      ok: false,
      error: 'mismatch',
    });
    expect(verify(header, { idempotencyKey: 'k6-2' })).toEqual({ ok: false, error: 'mismatch' });
  });

  it('accepts either secret during a rotation, and any of several signatures', () => {
    const old = 'previous-webhook-secret';
    expect(verify(signatureHeader(old, t, key, body), { secrets: [secret, old] }).ok).toBe(true);
    const both = `t=${String(t)},v1=${sign(old, t, key, body)},v1=${sign(secret, t, key, body)}`;
    expect(verify(both).ok).toBe(true);
  });
});
