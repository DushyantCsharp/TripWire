import { err, ok, type Result } from '@tripwire/result';
import { canonicalHash } from './canonical.js';

// The approval policy from CLAUDE.md's invariant: a write action runs only with a human approval,
// bound to this exact proposal and payload, unexpired and unused. The executor (apps/worker) applies
// it to rows it loaded in the transaction that marks the approval consumed; the database's triggers
// and composite foreign key hold the same line underneath. Nothing here can grant an approval.

export type ActionKind = 'rollback' | 'scale' | 'page';
export type ActionStatus =
  'pending_approval' | 'approved' | 'rejected' | 'expired' | 'executed' | 'execution_failed';

export interface ProposedActionRecord {
  readonly id: string;
  readonly kind: ActionKind;
  readonly payload: unknown;
  /** payloadHash(payload), stored when the action was proposed. */
  readonly payloadHash: string;
  readonly status: ActionStatus;
}

export interface ApprovalRecord {
  readonly actionId: string;
  readonly decision: 'approved' | 'rejected';
  /** Authenticated identity of whoever decided: `user:<id>` for a person. */
  readonly actor: string;
  /** The payload hash the approver reviewed. */
  readonly payloadHash: string;
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
}

export type ApprovalDenial =
  | { readonly kind: 'no_approval' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'wrong_action'; readonly approvedActionId: string }
  | { readonly kind: 'not_a_person'; readonly actor: string }
  | { readonly kind: 'payload_tampered' }
  | { readonly kind: 'payload_mismatch' }
  | { readonly kind: 'already_consumed'; readonly consumedAt: Date }
  | { readonly kind: 'expired'; readonly expiredAt: Date }
  | { readonly kind: 'not_executable'; readonly status: ActionStatus };

/** Permission to run one action once. Only authorizeExecution makes one. */
export interface ExecutionGrant {
  readonly actionId: string;
  readonly payloadHash: string;
  readonly approvedBy: string;
}

/** Hex SHA-256 of an action's canonical payload: what an approval is bound to. */
export function payloadHash(payload: unknown): string {
  return canonicalHash(payload);
}

/** Approvals come from people. Service identities (`service:…`), and so the agent, never qualify. */
const PERSON = /^user:\S+$/;

export function isPerson(actor: string): boolean {
  return PERSON.test(actor);
}

/**
 * Whether `approval` lets `action` run now. Every check must pass; the first that fails is the
 * reason. The caller marks the approval consumed in the same transaction as the execution.
 */
export function authorizeExecution(
  action: ProposedActionRecord,
  approval: ApprovalRecord | null,
  now: Date,
): Result<ExecutionGrant, ApprovalDenial> {
  if (!approval) return err({ kind: 'no_approval' });
  if (approval.decision !== 'approved') return err({ kind: 'rejected' });
  if (approval.actionId !== action.id) {
    return err({ kind: 'wrong_action', approvedActionId: approval.actionId });
  }
  if (!isPerson(approval.actor)) return err({ kind: 'not_a_person', actor: approval.actor });
  // The stored hash must still describe the payload, and be the one the person reviewed.
  if (payloadHash(action.payload) !== action.payloadHash) return err({ kind: 'payload_tampered' });
  if (approval.payloadHash !== action.payloadHash) return err({ kind: 'payload_mismatch' });
  if (approval.consumedAt) {
    return err({ kind: 'already_consumed', consumedAt: approval.consumedAt });
  }
  if (!approval.expiresAt) {
    // approvals_expiry_iff_approved makes this impossible; reaching it is a bug, not a denial.
    throw new Error(`approved approval for action ${action.id} has no expiry`);
  }
  if (now.getTime() >= approval.expiresAt.getTime()) {
    return err({ kind: 'expired', expiredAt: approval.expiresAt });
  }
  if (action.status !== 'approved') return err({ kind: 'not_executable', status: action.status });
  return ok({ actionId: action.id, payloadHash: action.payloadHash, approvedBy: approval.actor });
}
