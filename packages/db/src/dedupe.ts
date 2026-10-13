import type { IncidentStatus } from './incidents.js';

// The dedupe rule clusterAlert applies. Its queries prefilter with the same window and status, so
// they stay on their indexes; this is the rule itself, kept pure so it can be tested case by case.

/** The earliest moment still inside an alert's dedupe window. The window includes its start. */
export function dedupeWindowStart(receivedAt: Date, windowMs: number): Date {
  return new Date(receivedAt.getTime() - windowMs);
}

export interface DedupeCandidates {
  /** The most recent alert sharing this alert's fingerprint, and its incident. */
  readonly sameFingerprint?:
    | {
        readonly incidentId: string;
        readonly incidentStatus: IncidentStatus;
        readonly receivedAt: Date;
      }
    | undefined;
  /** The incident whose embedding is nearest this alert's, by cosine similarity. */
  readonly nearest?:
    | {
        readonly incidentId: string;
        readonly incidentStatus: IncidentStatus;
        readonly lastSeen: Date;
        readonly similarity: number;
      }
    | undefined;
}

export interface DedupeOptions {
  /** How long an open incident keeps attracting alerts: same-fingerprint alerts and activity. */
  readonly windowMs: number;
  /** An alert joins an incident with another fingerprint only when similarity exceeds this. */
  readonly similarityThreshold: number;
}

export type DedupeDecision =
  | { readonly match: 'fingerprint'; readonly incidentId: string }
  | { readonly match: 'embedding'; readonly incidentId: string; readonly similarity: number }
  | { readonly match: 'new_incident' };

/**
 * Where an alert received at `receivedAt` belongs, in order of preference:
 *  1. the unresolved incident holding a same-fingerprint alert from inside the window,
 *  2. the unresolved incident active inside the window whose similarity exceeds the threshold,
 *  3. a new incident.
 */
export function decideCluster(
  receivedAt: Date,
  { sameFingerprint, nearest }: DedupeCandidates,
  { windowMs, similarityThreshold }: DedupeOptions,
): DedupeDecision {
  const since = dedupeWindowStart(receivedAt, windowMs).getTime();
  if (
    sameFingerprint &&
    sameFingerprint.incidentStatus !== 'resolved' &&
    sameFingerprint.receivedAt.getTime() >= since
  ) {
    return { match: 'fingerprint', incidentId: sameFingerprint.incidentId };
  }
  if (
    nearest &&
    nearest.incidentStatus !== 'resolved' &&
    nearest.lastSeen.getTime() >= since &&
    nearest.similarity > similarityThreshold
  ) {
    return { match: 'embedding', incidentId: nearest.incidentId, similarity: nearest.similarity };
  }
  return { match: 'new_incident' };
}
