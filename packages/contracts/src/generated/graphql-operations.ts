// Generated from packages/contracts/schema by `pnpm generate`. Do not edit.

/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> =
  T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type ActionDecisionErrorCode =
  | 'ACTION_NOT_FOUND'
  /** Already approved, rejected, expired or executed. */
  | 'ACTION_NOT_PENDING'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'REASON_REQUIRED';

export type ActionKind = 'PAGE' | 'ROLLBACK' | 'SCALE';

export type ActionStatus =
  /** Approved; waiting for the executor. */
  | 'APPROVED'
  | 'EXECUTED'
  | 'EXECUTION_FAILED'
  /** The approval expired before the action ran. Needs a fresh approval. */
  | 'EXPIRED'
  | 'PENDING_APPROVAL'
  | 'REJECTED';

export type AlertSource = 'ALERTMANAGER' | 'GENERIC';

export type AlertStatus = 'FIRING' | 'RESOLVED';

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export type ApproveActionInput = {
  actionId: string;
  /** The payloadHash you reviewed. A mismatch means the action changed, and the approval is refused. */
  payloadHash: string;
  /** Required: non-blank, at most 2000 characters. */
  reason: string;
};

export type EvidenceKind = 'DEPLOY' | 'LOG' | 'METRIC' | 'RUNBOOK' | 'TRACE';

export type FaultClass =
  | 'APPLICATION_ERROR'
  | 'CPU_SATURATION'
  | 'GC_PRESSURE'
  | 'LATENCY'
  | 'LOCK_CONTENTION'
  | 'MEMORY_LEAK'
  | 'OTHER'
  | 'QUEUE_BACKLOG'
  | 'TRAFFIC_SURGE'
  | 'UNAVAILABLE';

export type IncidentStatus =
  /** Collecting alerts; triage has not started. */
  'OPEN' | 'RESOLVED' | 'TRIAGED' | 'TRIAGING';

export type RedriveErrorCode = 'DEAD_LETTER_NOT_FOUND';

export type RedriveTriageJobInput = {
  /** A DeadLetteredTriageJob id. */
  id: string;
};

export type RejectActionInput = {
  actionId: string;
  /** Required: non-blank, at most 2000 characters. */
  reason: string;
};

export type Severity = 'CRITICAL' | 'INFO' | 'WARNING';

export type TriageFailureReason =
  /** A bug or a crash rather than an expected failure. */
  | 'INTERNAL_ERROR'
  /** The model's output, or the request built for it, failed validation. */
  | 'INVALID_OUTPUT'
  /** The model provider kept failing after retries. */
  | 'MODEL_UNAVAILABLE'
  /** The model provider rejected the request (a 4xx other than 408 or 429). */
  | 'REQUEST_REJECTED'
  | 'TIMED_OUT'
  /** The per-incident token budget ran out before a report was produced. */
  | 'TOKEN_BUDGET_EXHAUSTED'
  | 'TOOL_CALL_LIMIT_REACHED';

/** Why a triage run ended. Anything but REPORT_SUBMITTED means the report is partial. */
export type TriageStopReason =
  | 'INPUT_TOKEN_BUDGET'
  | 'INVALID_OUTPUT'
  | 'OUTPUT_TOKEN_BUDGET'
  | 'REFUSAL'
  | 'REPORT_SUBMITTED'
  | 'TOOL_CALL_LIMIT'
  | 'WALL_CLOCK';

export type ProposedActionFieldsFragment = {
  id: string;
  kind: ActionKind;
  summary: string;
  rationale: string;
  payload: unknown;
  payloadHash: string;
  status: ActionStatus;
  proposedAt: string;
  approval: {
    id: string;
    decision: ApprovalDecision;
    reason: string;
    decidedBy: string;
    decidedAt: string;
    expiresAt: string | null;
    consumedAt: string | null;
  } | null;
};

export type ApproveActionMutationVariables = Exact<{
  input: ApproveActionInput;
}>;

export type ApproveActionMutation = {
  approveAction:
    | {
        __typename: 'ActionDecided';
        action: {
          id: string;
          kind: ActionKind;
          summary: string;
          rationale: string;
          payload: unknown;
          payloadHash: string;
          status: ActionStatus;
          proposedAt: string;
          approval: {
            id: string;
            decision: ApprovalDecision;
            reason: string;
            decidedBy: string;
            decidedAt: string;
            expiresAt: string | null;
            consumedAt: string | null;
          } | null;
        };
      }
    | { __typename: 'ActionDecisionError'; code: ActionDecisionErrorCode; message: string };
};

export type RejectActionMutationVariables = Exact<{
  input: RejectActionInput;
}>;

export type RejectActionMutation = {
  rejectAction:
    | {
        __typename: 'ActionDecided';
        action: {
          id: string;
          kind: ActionKind;
          summary: string;
          rationale: string;
          payload: unknown;
          payloadHash: string;
          status: ActionStatus;
          proposedAt: string;
          approval: {
            id: string;
            decision: ApprovalDecision;
            reason: string;
            decidedBy: string;
            decidedAt: string;
            expiresAt: string | null;
            consumedAt: string | null;
          } | null;
        };
      }
    | { __typename: 'ActionDecisionError'; code: ActionDecisionErrorCode; message: string };
};

export type DeadLetteredTriageJobsQueryVariables = Exact<{
  first?: number | null | undefined;
}>;

export type DeadLetteredTriageJobsQuery = {
  deadLetteredTriageJobs: Array<{
    id: string;
    incidentId: string;
    errorClass: string;
    failedReason: string;
    lastStack: string | null;
    failedAt: string;
    attempts: Array<{ attempt: number; errorClass: string; message: string; at: string }>;
  }>;
};

export type RedriveTriageJobMutationVariables = Exact<{
  input: RedriveTriageJobInput;
}>;

export type RedriveTriageJobMutation = {
  redriveTriageJob:
    | { __typename: 'RedriveError'; code: RedriveErrorCode; message: string }
    | { __typename: 'TriageJobRedriven'; jobId: string; incidentId: string };
};

export type IncidentSummaryFragment = {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  service: string | null;
  alertCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type EvidenceFieldsFragment = {
  kind: EvidenceKind;
  sourceId: string;
  excerpt: string | null;
  available: boolean;
  unavailableReason: string | null;
  url: string | null;
};

export type IncidentDetailFragment = {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: Severity;
  service: string | null;
  alertCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  triage:
    | {
        __typename: 'TriageFailed';
        id: string;
        reason: TriageFailureReason;
        message: string;
        startedAt: string;
        failedAt: string;
        usage: { inputTokens: number; outputTokens: number; toolCalls: number };
      }
    | {
        __typename: 'TriageReport';
        id: string;
        summary: string;
        confidence: number;
        complete: boolean;
        stopReason: TriageStopReason;
        model: string;
        startedAt: string;
        completedAt: string;
        hypotheses: Array<{
          rank: number;
          title: string;
          explanation: string;
          confidence: number;
          suspect: string | null;
          faultClass: FaultClass | null;
          evidence: Array<{
            kind: EvidenceKind;
            sourceId: string;
            excerpt: string | null;
            available: boolean;
            unavailableReason: string | null;
            url: string | null;
          }>;
        }>;
        unavailableEvidence: Array<{
          kind: EvidenceKind;
          sourceId: string;
          excerpt: string | null;
          available: boolean;
          unavailableReason: string | null;
          url: string | null;
        }>;
        usage: { inputTokens: number; outputTokens: number; toolCalls: number };
      }
    | null;
  proposedActions: Array<{
    id: string;
    kind: ActionKind;
    summary: string;
    rationale: string;
    payload: unknown;
    payloadHash: string;
    status: ActionStatus;
    proposedAt: string;
    approval: {
      id: string;
      decision: ApprovalDecision;
      reason: string;
      decidedBy: string;
      decidedAt: string;
      expiresAt: string | null;
      consumedAt: string | null;
    } | null;
  }>;
};

export type IncidentListQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
  status?: Array<IncidentStatus> | IncidentStatus | null | undefined;
}>;

export type IncidentListQuery = {
  incidents: {
    edges: Array<{
      cursor: string;
      node: {
        id: string;
        title: string;
        status: IncidentStatus;
        severity: Severity;
        service: string | null;
        alertCount: number;
        firstSeenAt: string;
        lastSeenAt: string;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type IncidentQueryVariables = Exact<{
  id: string;
}>;

export type IncidentQuery = {
  incident: {
    id: string;
    title: string;
    status: IncidentStatus;
    severity: Severity;
    service: string | null;
    alertCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    triage:
      | {
          __typename: 'TriageFailed';
          id: string;
          reason: TriageFailureReason;
          message: string;
          startedAt: string;
          failedAt: string;
          usage: { inputTokens: number; outputTokens: number; toolCalls: number };
        }
      | {
          __typename: 'TriageReport';
          id: string;
          summary: string;
          confidence: number;
          complete: boolean;
          stopReason: TriageStopReason;
          model: string;
          startedAt: string;
          completedAt: string;
          hypotheses: Array<{
            rank: number;
            title: string;
            explanation: string;
            confidence: number;
            suspect: string | null;
            faultClass: FaultClass | null;
            evidence: Array<{
              kind: EvidenceKind;
              sourceId: string;
              excerpt: string | null;
              available: boolean;
              unavailableReason: string | null;
              url: string | null;
            }>;
          }>;
          unavailableEvidence: Array<{
            kind: EvidenceKind;
            sourceId: string;
            excerpt: string | null;
            available: boolean;
            unavailableReason: string | null;
            url: string | null;
          }>;
          usage: { inputTokens: number; outputTokens: number; toolCalls: number };
        }
      | null;
    proposedActions: Array<{
      id: string;
      kind: ActionKind;
      summary: string;
      rationale: string;
      payload: unknown;
      payloadHash: string;
      status: ActionStatus;
      proposedAt: string;
      approval: {
        id: string;
        decision: ApprovalDecision;
        reason: string;
        decidedBy: string;
        decidedAt: string;
        expiresAt: string | null;
        consumedAt: string | null;
      } | null;
    }>;
  } | null;
};

export type IncidentAlertsQueryVariables = Exact<{
  id: string;
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;

export type IncidentAlertsQuery = {
  incident: {
    id: string;
    alerts: {
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          source: AlertSource;
          name: string;
          status: AlertStatus;
          severity: Severity;
          service: string | null;
          summary: string | null;
          fingerprint: string;
          startsAt: string;
          endsAt: string | null;
          receivedAt: string;
          sourceUrl: string | null;
          labels: Array<{ name: string; value: string }>;
        };
      }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

export type IncidentUpdatedSubscriptionVariables = Exact<{
  id: string;
}>;

export type IncidentUpdatedSubscription = {
  incidentUpdated: {
    id: string;
    title: string;
    status: IncidentStatus;
    severity: Severity;
    service: string | null;
    alertCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    triage:
      | {
          __typename: 'TriageFailed';
          id: string;
          reason: TriageFailureReason;
          message: string;
          startedAt: string;
          failedAt: string;
          usage: { inputTokens: number; outputTokens: number; toolCalls: number };
        }
      | {
          __typename: 'TriageReport';
          id: string;
          summary: string;
          confidence: number;
          complete: boolean;
          stopReason: TriageStopReason;
          model: string;
          startedAt: string;
          completedAt: string;
          hypotheses: Array<{
            rank: number;
            title: string;
            explanation: string;
            confidence: number;
            suspect: string | null;
            faultClass: FaultClass | null;
            evidence: Array<{
              kind: EvidenceKind;
              sourceId: string;
              excerpt: string | null;
              available: boolean;
              unavailableReason: string | null;
              url: string | null;
            }>;
          }>;
          unavailableEvidence: Array<{
            kind: EvidenceKind;
            sourceId: string;
            excerpt: string | null;
            available: boolean;
            unavailableReason: string | null;
            url: string | null;
          }>;
          usage: { inputTokens: number; outputTokens: number; toolCalls: number };
        }
      | null;
    proposedActions: Array<{
      id: string;
      kind: ActionKind;
      summary: string;
      rationale: string;
      payload: unknown;
      payloadHash: string;
      status: ActionStatus;
      proposedAt: string;
      approval: {
        id: string;
        decision: ApprovalDecision;
        reason: string;
        decidedBy: string;
        decidedAt: string;
        expiresAt: string | null;
        consumedAt: string | null;
      } | null;
    }>;
  };
};

export type PingQueryVariables = Exact<{ [key: string]: never }>;

export type PingQuery = { ping: string };

export const IncidentSummaryFragmentDoc = {
  kind: 'Document',
  definitions: [
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentSummary' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'title' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'severity' } },
          { kind: 'Field', name: { kind: 'Name', value: 'service' } },
          { kind: 'Field', name: { kind: 'Name', value: 'alertCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'firstSeenAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastSeenAt' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IncidentSummaryFragment, unknown>;
export const EvidenceFieldsFragmentDoc = {
  kind: 'Document',
  definitions: [
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'EvidenceFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Evidence' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'sourceId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'excerpt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'available' } },
          { kind: 'Field', name: { kind: 'Name', value: 'unavailableReason' } },
          { kind: 'Field', name: { kind: 'Name', value: 'url' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<EvidenceFieldsFragment, unknown>;
export const ProposedActionFieldsFragmentDoc = {
  kind: 'Document',
  definitions: [
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'ProposedActionFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'ProposedAction' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
          { kind: 'Field', name: { kind: 'Name', value: 'rationale' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payload' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payloadHash' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'proposedAt' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approval' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decision' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'expiresAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'consumedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ProposedActionFieldsFragment, unknown>;
export const IncidentDetailFragmentDoc = {
  kind: 'Document',
  definitions: [
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentDetail' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'FragmentSpread', name: { kind: 'Name', value: 'IncidentSummary' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'triage' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: '__typename' } },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageReport' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'confidence' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'complete' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stopReason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'model' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'completedAt' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'hypotheses' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'rank' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'title' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'explanation' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'confidence' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'suspect' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'faultClass' } },
                            {
                              kind: 'Field',
                              name: { kind: 'Name', value: 'evidence' },
                              selectionSet: {
                                kind: 'SelectionSet',
                                selections: [
                                  {
                                    kind: 'FragmentSpread',
                                    name: { kind: 'Name', value: 'EvidenceFields' },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'unavailableEvidence' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            {
                              kind: 'FragmentSpread',
                              name: { kind: 'Name', value: 'EvidenceFields' },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'usage' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'inputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'outputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'toolCalls' } },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageFailed' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'failedAt' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'usage' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'inputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'outputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'toolCalls' } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'proposedActions' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'FragmentSpread', name: { kind: 'Name', value: 'ProposedActionFields' } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentSummary' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'title' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'severity' } },
          { kind: 'Field', name: { kind: 'Name', value: 'service' } },
          { kind: 'Field', name: { kind: 'Name', value: 'alertCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'firstSeenAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastSeenAt' } },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'EvidenceFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Evidence' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'sourceId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'excerpt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'available' } },
          { kind: 'Field', name: { kind: 'Name', value: 'unavailableReason' } },
          { kind: 'Field', name: { kind: 'Name', value: 'url' } },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'ProposedActionFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'ProposedAction' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
          { kind: 'Field', name: { kind: 'Name', value: 'rationale' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payload' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payloadHash' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'proposedAt' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approval' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decision' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'expiresAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'consumedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IncidentDetailFragment, unknown>;
export const ApproveActionDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'ApproveAction' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'ApproveActionInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approveAction' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: '__typename' } },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'ActionDecided' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'action' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            {
                              kind: 'FragmentSpread',
                              name: { kind: 'Name', value: 'ProposedActionFields' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'ActionDecisionError' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'code' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'ProposedActionFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'ProposedAction' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
          { kind: 'Field', name: { kind: 'Name', value: 'rationale' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payload' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payloadHash' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'proposedAt' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approval' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decision' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'expiresAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'consumedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<ApproveActionMutation, ApproveActionMutationVariables>;
export const RejectActionDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'RejectAction' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'RejectActionInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'rejectAction' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: '__typename' } },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'ActionDecided' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'action' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            {
                              kind: 'FragmentSpread',
                              name: { kind: 'Name', value: 'ProposedActionFields' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'ActionDecisionError' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'code' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'ProposedActionFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'ProposedAction' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
          { kind: 'Field', name: { kind: 'Name', value: 'rationale' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payload' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payloadHash' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'proposedAt' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approval' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decision' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'expiresAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'consumedAt' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<RejectActionMutation, RejectActionMutationVariables>;
export const DeadLetteredTriageJobsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'DeadLetteredTriageJobs' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'first' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'deadLetteredTriageJobs' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'first' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'first' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'incidentId' } },
                { kind: 'Field', name: { kind: 'Name', value: 'errorClass' } },
                { kind: 'Field', name: { kind: 'Name', value: 'failedReason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'lastStack' } },
                { kind: 'Field', name: { kind: 'Name', value: 'failedAt' } },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'attempts' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'attempt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'errorClass' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'at' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<DeadLetteredTriageJobsQuery, DeadLetteredTriageJobsQueryVariables>;
export const RedriveTriageJobDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'mutation',
      name: { kind: 'Name', value: 'RedriveTriageJob' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'RedriveTriageJobInput' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'redriveTriageJob' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'input' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'input' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: '__typename' } },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageJobRedriven' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'jobId' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'incidentId' } },
                    ],
                  },
                },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'RedriveError' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'code' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<RedriveTriageJobMutation, RedriveTriageJobMutationVariables>;
export const IncidentListDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'IncidentList' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'first' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'after' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'status' } },
          type: {
            kind: 'ListType',
            type: {
              kind: 'NonNullType',
              type: { kind: 'NamedType', name: { kind: 'Name', value: 'IncidentStatus' } },
            },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'incidents' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'first' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'first' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'after' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'after' } },
              },
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'status' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'status' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'edges' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'cursor' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'node' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            {
                              kind: 'FragmentSpread',
                              name: { kind: 'Name', value: 'IncidentSummary' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'pageInfo' },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'hasNextPage' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'endCursor' } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentSummary' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'title' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'severity' } },
          { kind: 'Field', name: { kind: 'Name', value: 'service' } },
          { kind: 'Field', name: { kind: 'Name', value: 'alertCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'firstSeenAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastSeenAt' } },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IncidentListQuery, IncidentListQueryVariables>;
export const IncidentDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'Incident' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'id' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'incident' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'id' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'id' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'FragmentSpread', name: { kind: 'Name', value: 'IncidentDetail' } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentSummary' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'title' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'severity' } },
          { kind: 'Field', name: { kind: 'Name', value: 'service' } },
          { kind: 'Field', name: { kind: 'Name', value: 'alertCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'firstSeenAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastSeenAt' } },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'EvidenceFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Evidence' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'sourceId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'excerpt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'available' } },
          { kind: 'Field', name: { kind: 'Name', value: 'unavailableReason' } },
          { kind: 'Field', name: { kind: 'Name', value: 'url' } },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'ProposedActionFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'ProposedAction' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
          { kind: 'Field', name: { kind: 'Name', value: 'rationale' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payload' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payloadHash' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'proposedAt' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approval' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decision' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'expiresAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'consumedAt' } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentDetail' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'FragmentSpread', name: { kind: 'Name', value: 'IncidentSummary' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'triage' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: '__typename' } },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageReport' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'confidence' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'complete' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stopReason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'model' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'completedAt' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'hypotheses' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'rank' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'title' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'explanation' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'confidence' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'suspect' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'faultClass' } },
                            {
                              kind: 'Field',
                              name: { kind: 'Name', value: 'evidence' },
                              selectionSet: {
                                kind: 'SelectionSet',
                                selections: [
                                  {
                                    kind: 'FragmentSpread',
                                    name: { kind: 'Name', value: 'EvidenceFields' },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'unavailableEvidence' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            {
                              kind: 'FragmentSpread',
                              name: { kind: 'Name', value: 'EvidenceFields' },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'usage' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'inputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'outputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'toolCalls' } },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageFailed' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'failedAt' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'usage' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'inputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'outputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'toolCalls' } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'proposedActions' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'FragmentSpread', name: { kind: 'Name', value: 'ProposedActionFields' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IncidentQuery, IncidentQueryVariables>;
export const IncidentAlertsDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'IncidentAlerts' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'id' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } },
          },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'first' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'Int' } },
        },
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'after' } },
          type: { kind: 'NamedType', name: { kind: 'Name', value: 'String' } },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'incident' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'id' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'id' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                {
                  kind: 'Field',
                  name: { kind: 'Name', value: 'alerts' },
                  arguments: [
                    {
                      kind: 'Argument',
                      name: { kind: 'Name', value: 'first' },
                      value: { kind: 'Variable', name: { kind: 'Name', value: 'first' } },
                    },
                    {
                      kind: 'Argument',
                      name: { kind: 'Name', value: 'after' },
                      value: { kind: 'Variable', name: { kind: 'Name', value: 'after' } },
                    },
                  ],
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'edges' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'cursor' } },
                            {
                              kind: 'Field',
                              name: { kind: 'Name', value: 'node' },
                              selectionSet: {
                                kind: 'SelectionSet',
                                selections: [
                                  { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'source' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'status' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'severity' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'service' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'fingerprint' } },
                                  {
                                    kind: 'Field',
                                    name: { kind: 'Name', value: 'labels' },
                                    selectionSet: {
                                      kind: 'SelectionSet',
                                      selections: [
                                        { kind: 'Field', name: { kind: 'Name', value: 'name' } },
                                        { kind: 'Field', name: { kind: 'Name', value: 'value' } },
                                      ],
                                    },
                                  },
                                  { kind: 'Field', name: { kind: 'Name', value: 'startsAt' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'endsAt' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'receivedAt' } },
                                  { kind: 'Field', name: { kind: 'Name', value: 'sourceUrl' } },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'pageInfo' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'hasNextPage' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'endCursor' } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IncidentAlertsQuery, IncidentAlertsQueryVariables>;
export const IncidentUpdatedDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'subscription',
      name: { kind: 'Name', value: 'IncidentUpdated' },
      variableDefinitions: [
        {
          kind: 'VariableDefinition',
          variable: { kind: 'Variable', name: { kind: 'Name', value: 'id' } },
          type: {
            kind: 'NonNullType',
            type: { kind: 'NamedType', name: { kind: 'Name', value: 'ID' } },
          },
        },
      ],
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'incidentUpdated' },
            arguments: [
              {
                kind: 'Argument',
                name: { kind: 'Name', value: 'id' },
                value: { kind: 'Variable', name: { kind: 'Name', value: 'id' } },
              },
            ],
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'FragmentSpread', name: { kind: 'Name', value: 'IncidentDetail' } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentSummary' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'title' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'severity' } },
          { kind: 'Field', name: { kind: 'Name', value: 'service' } },
          { kind: 'Field', name: { kind: 'Name', value: 'alertCount' } },
          { kind: 'Field', name: { kind: 'Name', value: 'firstSeenAt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'lastSeenAt' } },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'EvidenceFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Evidence' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'sourceId' } },
          { kind: 'Field', name: { kind: 'Name', value: 'excerpt' } },
          { kind: 'Field', name: { kind: 'Name', value: 'available' } },
          { kind: 'Field', name: { kind: 'Name', value: 'unavailableReason' } },
          { kind: 'Field', name: { kind: 'Name', value: 'url' } },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'ProposedActionFields' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'ProposedAction' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'Field', name: { kind: 'Name', value: 'id' } },
          { kind: 'Field', name: { kind: 'Name', value: 'kind' } },
          { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
          { kind: 'Field', name: { kind: 'Name', value: 'rationale' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payload' } },
          { kind: 'Field', name: { kind: 'Name', value: 'payloadHash' } },
          { kind: 'Field', name: { kind: 'Name', value: 'status' } },
          { kind: 'Field', name: { kind: 'Name', value: 'proposedAt' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'approval' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decision' } },
                { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedBy' } },
                { kind: 'Field', name: { kind: 'Name', value: 'decidedAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'expiresAt' } },
                { kind: 'Field', name: { kind: 'Name', value: 'consumedAt' } },
              ],
            },
          },
        ],
      },
    },
    {
      kind: 'FragmentDefinition',
      name: { kind: 'Name', value: 'IncidentDetail' },
      typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'Incident' } },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [
          { kind: 'FragmentSpread', name: { kind: 'Name', value: 'IncidentSummary' } },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'triage' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'Field', name: { kind: 'Name', value: '__typename' } },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageReport' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'summary' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'confidence' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'complete' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'stopReason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'model' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'completedAt' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'hypotheses' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'rank' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'title' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'explanation' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'confidence' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'suspect' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'faultClass' } },
                            {
                              kind: 'Field',
                              name: { kind: 'Name', value: 'evidence' },
                              selectionSet: {
                                kind: 'SelectionSet',
                                selections: [
                                  {
                                    kind: 'FragmentSpread',
                                    name: { kind: 'Name', value: 'EvidenceFields' },
                                  },
                                ],
                              },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'unavailableEvidence' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            {
                              kind: 'FragmentSpread',
                              name: { kind: 'Name', value: 'EvidenceFields' },
                            },
                          ],
                        },
                      },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'usage' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'inputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'outputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'toolCalls' } },
                          ],
                        },
                      },
                    ],
                  },
                },
                {
                  kind: 'InlineFragment',
                  typeCondition: {
                    kind: 'NamedType',
                    name: { kind: 'Name', value: 'TriageFailed' },
                  },
                  selectionSet: {
                    kind: 'SelectionSet',
                    selections: [
                      { kind: 'Field', name: { kind: 'Name', value: 'id' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'reason' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'message' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'startedAt' } },
                      { kind: 'Field', name: { kind: 'Name', value: 'failedAt' } },
                      {
                        kind: 'Field',
                        name: { kind: 'Name', value: 'usage' },
                        selectionSet: {
                          kind: 'SelectionSet',
                          selections: [
                            { kind: 'Field', name: { kind: 'Name', value: 'inputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'outputTokens' } },
                            { kind: 'Field', name: { kind: 'Name', value: 'toolCalls' } },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            kind: 'Field',
            name: { kind: 'Name', value: 'proposedActions' },
            selectionSet: {
              kind: 'SelectionSet',
              selections: [
                { kind: 'FragmentSpread', name: { kind: 'Name', value: 'ProposedActionFields' } },
              ],
            },
          },
        ],
      },
    },
  ],
} as unknown as DocumentNode<IncidentUpdatedSubscription, IncidentUpdatedSubscriptionVariables>;
export const PingDocument = {
  kind: 'Document',
  definitions: [
    {
      kind: 'OperationDefinition',
      operation: 'query',
      name: { kind: 'Name', value: 'Ping' },
      selectionSet: {
        kind: 'SelectionSet',
        selections: [{ kind: 'Field', name: { kind: 'Name', value: 'ping' } }],
      },
    },
  ],
} as unknown as DocumentNode<PingQuery, PingQueryVariables>;
