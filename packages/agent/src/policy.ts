import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@tripwire/result';
import { z } from 'zod';
import { payloadHash, type ActionKind } from './approval.js';
import { sanitizeText } from './untrusted.js';

// propose_action: the one tool that records something. It turns the model's request into a
// ProposedAction, which the worker stores as pending_approval with the report. Nothing here, or
// anywhere in this package, executes an action: that takes a person's approval (approval.ts).
//
// The model's request is untrusted (a log line may have told it what to ask for), so policy checks
// it against what the run actually saw, in structured fields only: free text never makes a service
// or a change "known".

export const PROPOSE_ACTION = 'propose_action';

const service = z
  .string()
  .min(1)
  .max(100)
  .describe('The service to act on, exactly as the incident or a tool result names it.');

export const proposeActionInput = z.strictObject({
  action: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('rollback'),
      service,
      changeId: z
        .string()
        .min(1)
        .max(200)
        .describe('The id of the deploy or change to roll back, as list_deploys returned it.'),
    }),
    z.strictObject({
      kind: z.literal('scale'),
      service,
      replicas: z.number().int().min(1).max(10).describe('The replica count to scale to.'),
    }),
    z.strictObject({
      kind: z.literal('page'),
      service,
      urgency: z.enum(['high', 'low']),
      message: z.string().min(1).max(280).describe('What the on-call engineer needs to know.'),
    }),
  ]),
  rationale: z.string().min(1).max(500).describe('Why this action, in one or two sentences.'),
  evidence: z
    .array(z.string().min(1).max(300))
    .min(1)
    .max(5)
    .describe('Ids of records that tools returned which justify the action.'),
});

export type ActionPayload =
  | { readonly kind: 'rollback'; readonly service: string; readonly changeId: string }
  | { readonly kind: 'scale'; readonly service: string; readonly replicas: number }
  | {
      readonly kind: 'page';
      readonly service: string;
      readonly urgency: 'high' | 'low';
      readonly message: string;
    };

/** A write action the model proposed and policy accepted. It has not run, and can't without approval. */
export interface ProposedAction {
  /** Derived from the run and the payload, so a retried run proposes the same row. */
  readonly id: string;
  readonly kind: ActionKind;
  /** What would happen, rendered from the payload by code: never model text. */
  readonly summary: string;
  /** The model's reasoning. Untrusted. */
  readonly rationale: string;
  readonly payload: ActionPayload;
  readonly payloadHash: string;
  readonly evidence: readonly string[];
}

export type RejectionReason =
  | 'invalid_input'
  | 'unknown_service'
  | 'unknown_evidence'
  | 'unknown_change'
  | 'change_of_other_service'
  | 'duplicate'
  | 'too_many';

export interface RejectedProposal {
  readonly input: unknown;
  readonly reason: RejectionReason;
  readonly message: string;
}

export interface PolicyContext {
  /** Services named in structured fields of the incident and of returned records, by normalised name. */
  readonly services: ReadonlyMap<string, string>;
  readonly returnedIds: ReadonlySet<string>;
  /** Changes list_deploys returned: id → service. */
  readonly changes: ReadonlyMap<string, string>;
  /** Proposals already accepted in this run. */
  readonly accepted: readonly ProposedAction[];
  readonly runKey: string;
}

export const MAX_PROPOSALS = 3;

export function normaliseService(name: string): string {
  return name.trim().toLowerCase();
}

/** Accepts a propose_action call as a ProposedAction, or says why not. */
export function checkProposal(
  raw: unknown,
  context: PolicyContext,
): Result<ProposedAction, RejectedProposal> {
  const reject = (reason: RejectionReason, message: string) => err({ input: raw, reason, message });

  const parsed = proposeActionInput.safeParse(raw);
  if (!parsed.success) return reject('invalid_input', z.prettifyError(parsed.error));
  const { action, rationale, evidence } = parsed.data;

  if (context.accepted.length >= MAX_PROPOSALS) {
    return reject('too_many', `a run proposes at most ${String(MAX_PROPOSALS)} actions`);
  }
  const target = context.services.get(normaliseService(action.service));
  if (target === undefined) {
    return reject(
      'unknown_service',
      `"${action.service}" is not a service the incident or any tool result names`,
    );
  }
  const unknown = evidence.filter((id) => !context.returnedIds.has(id));
  if (unknown.length > 0) {
    return reject('unknown_evidence', `no tool returned ${unknown.join(', ')}`);
  }

  let payload: ActionPayload;
  switch (action.kind) {
    case 'rollback': {
      const changed = context.changes.get(action.changeId);
      if (changed === undefined) {
        return reject('unknown_change', `list_deploys did not return ${action.changeId}`);
      }
      if (normaliseService(changed) !== normaliseService(target)) {
        return reject(
          'change_of_other_service',
          `${action.changeId} changed ${changed}, not ${target}`,
        );
      }
      payload = { kind: 'rollback', service: target, changeId: action.changeId };
      break;
    }
    case 'scale':
      payload = { kind: 'scale', service: target, replicas: action.replicas };
      break;
    case 'page':
      payload = {
        kind: 'page',
        service: target,
        urgency: action.urgency,
        message: sanitizeText(action.message),
      };
      break;
  }

  const hash = payloadHash(payload);
  if (context.accepted.some((proposal) => proposal.payloadHash === hash)) {
    return reject('duplicate', 'this action is already proposed');
  }
  return ok({
    id: proposalId(context.runKey, hash),
    kind: payload.kind,
    summary: summarise(payload),
    rationale: sanitizeText(rationale),
    payload,
    payloadHash: hash,
    evidence: [...new Set(evidence)],
  });
}

function summarise(payload: ActionPayload): string {
  switch (payload.kind) {
    case 'rollback':
      return `Roll back ${payload.service} change ${payload.changeId}`;
    case 'scale':
      return `Scale ${payload.service} to ${String(payload.replicas)} replicas`;
    case 'page':
      return `Page the ${payload.service} on-call (${payload.urgency} urgency)`;
  }
}

/** A UUID (version 8: custom) from the run and the payload hash. */
export function proposalId(runKey: string, hash: string): string {
  const hex = createHash('sha256').update(`${runKey}\0${hash}`).digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
