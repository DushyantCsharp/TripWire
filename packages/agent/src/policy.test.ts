import { describe, expect, it } from '@jest/globals';
import { payloadHash } from './approval.js';
import {
  checkProposal,
  MAX_PROPOSALS,
  type PolicyContext,
  type ProposedAction,
  proposalId,
  type RejectionReason,
} from './policy.js';

const CHANGE = 'change:config-payment-2026-10-01T11:59:30Z';

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    services: new Map([
      ['payment', 'payment'],
      ['checkout', 'checkout'],
    ]),
    returnedIds: new Set(['log:pay-7f3a', CHANGE, 'change:deploy-frontend-2.1.0']),
    changes: new Map([
      [CHANGE, 'payment'],
      ['change:deploy-frontend-2.1.0', 'frontend'],
    ]),
    accepted: [],
    runKey: 'triage-run-1',
    ...overrides,
  };
}

const rationale = 'Charge failures began with this change.';
const evidence = ['log:pay-7f3a'];

describe('propose_action policy', () => {
  // Each row is a request the model might make (perhaps because a log line told it to) and why
  // policy refuses it. A refusal reaches the model as a tool error; nothing is recorded.
  it.each<[string, unknown, RejectionReason]>([
    [
      'a service nothing named',
      { action: { kind: 'rollback', service: 'prod', changeId: CHANGE }, rationale, evidence },
      'unknown_service',
    ],
    [
      'a change list_deploys never returned',
      {
        action: { kind: 'rollback', service: 'payment', changeId: 'change:made-up' },
        rationale,
        evidence,
      },
      'unknown_change',
    ],
    [
      "another service's change",
      {
        action: { kind: 'rollback', service: 'payment', changeId: 'change:deploy-frontend-2.1.0' },
        rationale,
        evidence,
      },
      'change_of_other_service',
    ],
    [
      'evidence no tool returned',
      {
        action: { kind: 'scale', service: 'payment', replicas: 3 },
        rationale,
        evidence: ['log:invented'],
      },
      'unknown_evidence',
    ],
    [
      'no evidence at all',
      { action: { kind: 'scale', service: 'payment', replicas: 3 }, rationale, evidence: [] },
      'invalid_input',
    ],
    [
      'scaling to zero',
      { action: { kind: 'scale', service: 'payment', replicas: 0 }, rationale, evidence },
      'invalid_input',
    ],
    [
      'scaling past the cap',
      { action: { kind: 'scale', service: 'payment', replicas: 50 }, rationale, evidence },
      'invalid_input',
    ],
    [
      'an action kind that does not exist',
      { action: { kind: 'delete', service: 'payment' }, rationale, evidence },
      'invalid_input',
    ],
    [
      'extra fields',
      {
        action: { kind: 'scale', service: 'payment', replicas: 2, force: true },
        rationale,
        evidence,
      },
      'invalid_input',
    ],
    [
      'a page with a novel for a message',
      {
        action: { kind: 'page', service: 'payment', urgency: 'high', message: 'x'.repeat(281) },
        rationale,
        evidence,
      },
      'invalid_input',
    ],
  ])('refuses %s', (_case, input, reason) => {
    expect(checkProposal(input, context())).toMatchObject({ ok: false, error: { reason, input } });
  });

  it('refuses a duplicate, and more than the per-run maximum', () => {
    const input = {
      action: { kind: 'scale', service: 'payment', replicas: 3 },
      rationale,
      evidence,
    };
    const first = checkProposal(input, context());
    if (!first.ok) throw new Error(first.error.message);
    expect(checkProposal(input, context({ accepted: [first.value] }))).toMatchObject({
      ok: false,
      error: { reason: 'duplicate' },
    });
    const full = Array.from({ length: MAX_PROPOSALS }, () => first.value);
    expect(checkProposal(input, context({ accepted: full }))).toMatchObject({
      ok: false,
      error: { reason: 'too_many' },
    });
  });

  it('accepts a grounded rollback, with a summary written by code and a payload hash', () => {
    const result = checkProposal(
      { action: { kind: 'rollback', service: 'Payment ', changeId: CHANGE }, rationale, evidence },
      context(),
    );
    const payload = { kind: 'rollback' as const, service: 'payment', changeId: CHANGE };
    expect(result).toEqual({
      ok: true,
      value: {
        id: proposalId('triage-run-1', payloadHash(payload)),
        kind: 'rollback',
        // The service as the run named it, not as the model spelled it.
        summary: `Roll back payment change ${CHANGE}`,
        rationale,
        payload,
        payloadHash: payloadHash(payload),
        evidence,
      } satisfies ProposedAction,
    });
  });

  it.each([
    [{ kind: 'scale', service: 'checkout', replicas: 4 }, 'Scale checkout to 4 replicas'],
    [
      {
        kind: 'page',
        service: 'payment',
        urgency: 'high',
        message: 'Charge failing for gold users',
      },
      'Page the payment on-call (high urgency)',
    ],
  ])('accepts %j as "%s"', (action, summary) => {
    expect(checkProposal({ action, rationale, evidence }, context())).toMatchObject({
      ok: true,
      value: { summary, payload: action },
    });
  });

  it('keeps invisible characters out of what a person will read', () => {
    const result = checkProposal(
      {
        action: {
          kind: 'page',
          service: 'payment',
          urgency: 'low',
          message: 'look\u202e at\u200b this',
        },
        rationale: 'see\u2066 logs',
        evidence,
      },
      context(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { rationale: 'see logs', payload: { message: 'look at this' } },
    });
  });

  it('derives the same id for the same run and payload, and a different one otherwise', () => {
    const hash = payloadHash({ kind: 'scale', service: 'payment', replicas: 3 });
    const id = proposalId('triage-run-1', hash);
    expect(id).toBe(proposalId('triage-run-1', hash));
    expect(id).not.toBe(proposalId('triage-run-2', hash));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
