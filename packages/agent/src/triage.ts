import type { Result } from '@tripwire/result';
import type { ProposedAction, RejectedProposal } from './policy.js';

export type Severity = 'critical' | 'warning' | 'info';
export type EvidenceKind = 'log' | 'trace' | 'metric' | 'deploy' | 'runbook';

/** What kind of failure a hypothesis blames. The evals' ground truth uses the same classes. */
export const FAULT_CLASSES = [
  'application_error',
  'unavailable',
  'latency',
  'cpu_saturation',
  'memory_leak',
  'gc_pressure',
  'queue_backlog',
  'traffic_surge',
  'lock_contention',
  'other',
] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

export interface TriageAlert {
  readonly name: string;
  readonly service: string | null;
  readonly severity: Severity;
  readonly status: 'firing' | 'resolved';
  readonly summary: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly startsAt: Date;
  readonly receivedAt: Date;
}

/** Every alert of an incident with this name and service, counted. */
export interface AlertGroup {
  readonly name: string;
  readonly service: string | null;
  readonly count: number;
  readonly firstStartsAt: Date;
  readonly lastReceivedAt: Date;
}

export interface TriageInput {
  readonly incidentId: string;
  readonly title: string;
  readonly service: string | null;
  readonly severity: Severity;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
  readonly alertCount: number;
  /** The most recent alerts, newest first. */
  readonly alerts: readonly TriageAlert[];
  /** The incident's first alerts by start time: in a cascade, the nearest the root cause. */
  readonly earliestAlerts: readonly TriageAlert[];
  /** All of the incident's alerts, grouped, so a storm's shape survives the alert cap. */
  readonly alertGroups: readonly AlertGroup[];
}

export interface TriageBudget {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxToolCalls: number;
  readonly maxWallClockMs: number;
}

export interface TriageUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly costUsdMicros: number;
}

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly sourceId: string;
  readonly excerpt: string | null;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly url: string | null;
}

export interface Hypothesis {
  /** 1 is the most likely. */
  readonly rank: number;
  readonly title: string;
  readonly explanation: string;
  /** 0–1. */
  readonly confidence: number;
  readonly suspect: string | null;
  /** Null when the hypothesis didn't come from the model. */
  readonly faultClass: FaultClass | null;
  readonly evidence: readonly Evidence[];
}

/** A limit that ended a run, or cut it short. */
export type TriageLimit =
  'tool_call_limit' | 'input_token_budget' | 'output_token_budget' | 'wall_clock';

/**
 * Why a run ended. Anything but `report_submitted` makes the report partial: a limit was breached,
 * the model's report stayed invalid after its one repair, or the model refused.
 */
export type StopReason = 'report_submitted' | TriageLimit | 'invalid_output' | 'refusal';

export interface TriageReport {
  readonly model: string;
  readonly summary: string;
  /** 0–1, already lowered for evidence that couldn't be gathered. */
  readonly confidence: number;
  /** 'alert_labels' when the model produced no usable report and the ranking is a fallback. */
  readonly basis: 'model' | 'alert_labels';
  readonly hypotheses: readonly Hypothesis[];
  readonly unavailableEvidence: readonly Evidence[];
  readonly stopReason: StopReason;
  /** The limit that made the loop ask for the report early, if one did. */
  readonly windDown: TriageLimit | null;
  /** Write actions the model proposed that passed policy. None of them has been executed. */
  readonly proposedActions: readonly ProposedAction[];
  /** Proposals policy refused, kept for audit and the evals. */
  readonly rejectedProposals: readonly RejectedProposal[];
  /** Ids the model cited that no tool returned. They aren't in any hypothesis's evidence. */
  readonly rejectedCitations: readonly string[];
  readonly usage: TriageUsage;
}

export function isComplete(report: Pick<TriageReport, 'stopReason'>): boolean {
  return report.stopReason === 'report_submitted';
}

/** Expected ways a triage run fails. `isRetryable` says which another attempt could fix. */
export type TriageError =
  | {
      readonly kind: 'rate_limited';
      readonly message: string;
      readonly retryAfterMs?: number | undefined;
    }
  | {
      readonly kind: 'upstream_unavailable';
      readonly message: string;
      readonly status?: number | undefined;
    }
  | { readonly kind: 'timeout'; readonly message: string }
  | { readonly kind: 'request_rejected'; readonly message: string; readonly status: number };

export interface TriageOptions {
  readonly budget: TriageBudget;
  /**
   * Identifies the run across retries (the triage job's id). Proposal ids derive from it, so a
   * retried attempt proposes the same rows rather than new ones.
   */
  readonly runKey: string;
  /** Aborted when the job is cancelled, e.g. on a worker shutdown deadline. */
  readonly signal?: AbortSignal | undefined;
}

export interface Triager {
  /** Recorded on every triage run. */
  readonly model: string;
  triage(input: TriageInput, options: TriageOptions): Promise<Result<TriageReport, TriageError>>;
}

/** 429s, 5xx and timeouts are transient. A request the provider rejects won't change. */
export function isRetryable(error: TriageError): boolean {
  switch (error.kind) {
    case 'rate_limited':
    case 'upstream_unavailable':
    case 'timeout':
      return true;
    case 'request_rejected':
      return false;
  }
}

/** Maps a failed HTTP call to the model provider to a TriageError. */
export function errorFromHttpStatus(
  status: number,
  message: string,
  retryAfterMs?: number,
): TriageError {
  if (status === 429) return { kind: 'rate_limited', message, retryAfterMs };
  if (status === 408) return { kind: 'timeout', message };
  if (status >= 500) return { kind: 'upstream_unavailable', message, status };
  return { kind: 'request_rejected', message, status };
}
