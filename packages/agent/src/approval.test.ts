import { describe, expect, it } from '@jest/globals';
import {
  authorizeExecution,
  isPerson,
  payloadHash,
  type ApprovalRecord,
  type ProposedActionRecord,
} from './approval.js';

const now = new Date('2026-10-01T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

const payload = { service: 'payment', from: '1.12.0', to: '1.11.4' };
const action: ProposedActionRecord = {
  id: 'act-1',
  kind: 'rollback',
  payload,
  payloadHash: payloadHash(payload),
  status: 'approved',
};
const approval: ApprovalRecord = {
  actionId: 'act-1',
  decision: 'approved',
  actor: 'user:oncall-7',
  payloadHash: payloadHash(payload),
  expiresAt: later(15 * 60_000),
  consumedAt: null,
};

describe('authorizeExecution', () => {
  it('lets a person-approved, matching, unexpired, unused approval run the action once', () => {
    expect(authorizeExecution(action, approval, now)).toEqual({
      ok: true,
      value: { actionId: 'act-1', payloadHash: action.payloadHash, approvedBy: 'user:oncall-7' },
    });
  });

  // Each row breaks exactly one condition, so each condition is shown to be required.
  it.each<[string, Partial<ProposedActionRecord>, Partial<ApprovalRecord> | null, string]>([
    ['unapproved: no approval record', {}, null, 'no_approval'],
    [
      'unapproved: the person rejected it',
      {},
      { decision: 'rejected', expiresAt: null },
      'rejected',
    ],
    ['mismatched: approval is for another action', {}, { actionId: 'act-2' }, 'wrong_action'],
    ['not a person: a service identity', {}, { actor: 'service:tripwire-worker' }, 'not_a_person'],
    ['not a person: the agent', {}, { actor: 'agent' }, 'not_a_person'],
    ['not a person: an empty user id', {}, { actor: 'user:' }, 'not_a_person'],
    [
      'mismatched: the payload changed after approval',
      {
        payload: { ...payload, to: '0.0.1' },
        payloadHash: payloadHash({ ...payload, to: '0.0.1' }),
      },
      {},
      'payload_mismatch',
    ],
    [
      'tampered: the stored hash no longer matches the payload',
      { payload: { ...payload, to: '0.0.1' } },
      {},
      'payload_tampered',
    ],
    ['replayed: approval already consumed', {}, { consumedAt: later(-60_000) }, 'already_consumed'],
    ['expired: at the expiry instant', {}, { expiresAt: now }, 'expired'],
    ['expired: an hour ago', {}, { expiresAt: later(-3_600_000) }, 'expired'],
    ['already executed', { status: 'executed' }, {}, 'not_executable'],
    ['still pending', { status: 'pending_approval' }, {}, 'not_executable'],
  ])('refuses when %s', (_case, actionChange, approvalChange, denial) => {
    const result = authorizeExecution(
      { ...action, ...actionChange },
      approvalChange === null ? null : { ...approval, ...approvalChange },
      now,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: denial } });
  });

  it('runs a millisecond before expiry', () => {
    expect(authorizeExecution(action, { ...approval, expiresAt: later(1) }, now).ok).toBe(true);
  });

  it('treats an approval without an expiry as the bug it is', () => {
    expect(() => authorizeExecution(action, { ...approval, expiresAt: null }, now)).toThrow(
      /no expiry/,
    );
  });
});

describe('payloadHash', () => {
  it.each([
    [{ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }, true],
    [{ outer: { y: 2, x: 1 } }, { outer: { x: 1, y: 2 } }, true],
    [{ a: [1, 2] }, { a: [2, 1] }, false],
    [{ a: 1 }, { a: '1' }, false],
    [{ a: 1, b: undefined }, { a: 1 }, true],
  ])('%j and %j hash equal: %p', (left, right, equal) => {
    expect(payloadHash(left) === payloadHash(right)).toBe(equal);
  });

  it('is a SHA-256 hex digest, as proposed_actions.payload_hash requires', () => {
    expect(payloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isPerson', () => {
  it.each([
    ['user:oncall-7', true],
    ['user:alice@example.com', true],
    ['service:tripwire-worker', false],
    ['user:', false],
    ['user: spaced', false],
    ['', false],
  ])('%j → %p', (actor, expected) => {
    expect(isPerson(actor)).toBe(expected);
  });
});
