// Generated from packages/contracts/schema by `pnpm generate`. Do not edit.

import type { GraphQLResolveInfo, GraphQLScalarType, GraphQLScalarTypeConfig } from 'graphql';
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;
export type RequireFields<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  /** RFC 3339 timestamp in UTC, e.g. 2026-10-11T18:05:48.780Z. */
  DateTime: { input: string; output: string };
  /** Any JSON value. */
  JSON: { input: unknown; output: unknown };
};

export type ActionDecided = {
  __typename?: 'ActionDecided';
  action: ProposedAction;
  approval: Approval;
};

/** An expected refusal, returned as data rather than as a GraphQL error. */
export type ActionDecisionError = {
  __typename?: 'ActionDecisionError';
  code: ActionDecisionErrorCode;
  message: Scalars['String']['output'];
};

export type ActionDecisionErrorCode =
  | 'ACTION_NOT_FOUND'
  /** Already approved, rejected, expired or executed. */
  | 'ACTION_NOT_PENDING'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'REASON_REQUIRED';

export type ActionDecisionResult = ActionDecided | ActionDecisionError;

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

export type Alert = Node & {
  __typename?: 'Alert';
  endsAt?: Maybe<Scalars['DateTime']['output']>;
  /** Stable identity used for deduplication. */
  fingerprint: Scalars['String']['output'];
  id: Scalars['ID']['output'];
  /** Null while the alert is still being clustered. */
  incident?: Maybe<Incident>;
  labels: Array<Label>;
  name: Scalars['String']['output'];
  receivedAt: Scalars['DateTime']['output'];
  service?: Maybe<Scalars['String']['output']>;
  severity: Severity;
  source: AlertSource;
  /** Link to the alert in its source system. */
  sourceUrl?: Maybe<Scalars['String']['output']>;
  startsAt: Scalars['DateTime']['output'];
  status: AlertStatus;
  /** Text from the sender. Untrusted: render as plain text. */
  summary?: Maybe<Scalars['String']['output']>;
};

export type AlertConnection = {
  __typename?: 'AlertConnection';
  edges: Array<AlertEdge>;
  pageInfo: PageInfo;
};

export type AlertEdge = {
  __typename?: 'AlertEdge';
  cursor: Scalars['String']['output'];
  node: Alert;
};

export type AlertSource = 'ALERTMANAGER' | 'GENERIC';

export type AlertStatus = 'FIRING' | 'RESOLVED';

export type Approval = Node & {
  __typename?: 'Approval';
  action: ProposedAction;
  /** When the executor consumed this approval. Approvals are single-use. */
  consumedAt?: Maybe<Scalars['DateTime']['output']>;
  decidedAt: Scalars['DateTime']['output'];
  /** Authenticated identity of the human who decided. */
  decidedBy: Scalars['String']['output'];
  decision: ApprovalDecision;
  /** An approved action must run before this time. Null for rejections. */
  expiresAt?: Maybe<Scalars['DateTime']['output']>;
  id: Scalars['ID']['output'];
  /** The payload hash decided on. Execution requires the action's payload to still match it. */
  payloadHash: Scalars['String']['output'];
  reason: Scalars['String']['output'];
};

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export type ApproveActionInput = {
  actionId: Scalars['ID']['input'];
  /** The payloadHash you reviewed. A mismatch means the action changed, and the approval is refused. */
  payloadHash: Scalars['String']['input'];
  /** Required: non-blank, at most 2000 characters. */
  reason: Scalars['String']['input'];
};

/** A triage job that failed for good and was moved to the triage-dlq queue. */
export type DeadLetteredTriageJob = {
  __typename?: 'DeadLetteredTriageJob';
  attempts: Array<TriageAttempt>;
  /** RetryableError (attempts exhausted), FatalError (not worth retrying) or StalledJobError. */
  errorClass: Scalars['String']['output'];
  failedAt: Scalars['DateTime']['output'];
  failedReason: Scalars['String']['output'];
  /** The dead-letter entry's id; pass it to redriveTriageJob. */
  id: Scalars['ID']['output'];
  incidentId: Scalars['ID']['output'];
  lastStack?: Maybe<Scalars['String']['output']>;
};

export type Evidence = {
  __typename?: 'Evidence';
  /** False when the backend could not be queried; the conclusion was reached without this evidence. */
  available: Scalars['Boolean']['output'];
  /** Verbatim excerpt supporting the claim. Untrusted: render as plain text. Null when unavailable. */
  excerpt?: Maybe<Scalars['String']['output']>;
  kind: EvidenceKind;
  /**
   * Identifier in the source system: log record id, trace id, PromQL query, deploy id or runbook
   * path. For unavailable evidence, the query that was attempted.
   */
  sourceId: Scalars['String']['output'];
  /** Why the evidence was unavailable, e.g. 'trace backend timed out after 3 attempts'. */
  unavailableReason?: Maybe<Scalars['String']['output']>;
  /** Deep link into Jaeger, Grafana or the log viewer. */
  url?: Maybe<Scalars['String']['output']>;
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

export type Hypothesis = {
  __typename?: 'Hypothesis';
  /** 0–1. */
  confidence: Scalars['Float']['output'];
  evidence: Array<Evidence>;
  explanation: Scalars['String']['output'];
  /** The kind of failure blamed. Null when the hypothesis was ranked from alert labels, not by the model. */
  faultClass?: Maybe<FaultClass>;
  rank: Scalars['Int']['output'];
  /** Service or component suspected as the root cause. */
  suspect?: Maybe<Scalars['String']['output']>;
  title: Scalars['String']['output'];
};

export type Incident = Node & {
  __typename?: 'Incident';
  alertCount: Scalars['Int']['output'];
  alerts: AlertConnection;
  firstSeenAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  lastSeenAt: Scalars['DateTime']['output'];
  proposedActions: Array<ProposedAction>;
  /** Primary affected service, when the alerts agree on one. */
  service?: Maybe<Scalars['String']['output']>;
  severity: Severity;
  status: IncidentStatus;
  title: Scalars['String']['output'];
  /** Outcome of the latest triage run. Null until the first run finishes. */
  triage?: Maybe<TriageResult>;
};

export type IncidentAlertsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
};

export type IncidentConnection = {
  __typename?: 'IncidentConnection';
  edges: Array<IncidentEdge>;
  pageInfo: PageInfo;
};

export type IncidentEdge = {
  __typename?: 'IncidentEdge';
  cursor: Scalars['String']['output'];
  node: Incident;
};

export type IncidentStatus =
  /** Collecting alerts; triage has not started. */
  'OPEN' | 'RESOLVED' | 'TRIAGED' | 'TRIAGING';

export type Label = {
  __typename?: 'Label';
  name: Scalars['String']['output'];
  value: Scalars['String']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  /**
   * Approve a pending action. This records the decision only; the executor re-checks the approval
   * in the same transaction that runs the action.
   */
  approveAction: ActionDecisionResult;
  /**
   * Re-enqueues a dead-lettered triage job as a fresh job with a full set of attempts, and removes
   * the dead-letter entry. The only way out of the dead-letter queue: nothing redrives automatically.
   */
  redriveTriageJob: RedriveTriageJobResult;
  rejectAction: ActionDecisionResult;
};

export type MutationApproveActionArgs = {
  input: ApproveActionInput;
};

export type MutationRedriveTriageJobArgs = {
  input: RedriveTriageJobInput;
};

export type MutationRejectActionArgs = {
  input: RejectActionInput;
};

/**
 * An object with a globally unique, opaque, type-prefixed id (inc_…, alr_…, act_…), shared with the
 * REST API.
 */
export type Node = {
  id: Scalars['ID']['output'];
};

/**
 * Relay cursor pagination. Tripwire paginates forward only (first/after, at most 100 per page), so
 * hasPreviousPage is always false.
 */
export type PageInfo = {
  __typename?: 'PageInfo';
  endCursor?: Maybe<Scalars['String']['output']>;
  hasNextPage: Scalars['Boolean']['output'];
  hasPreviousPage: Scalars['Boolean']['output'];
  startCursor?: Maybe<Scalars['String']['output']>;
};

/** A write action proposed by the agent. It never runs without an approval bound to its payloadHash. */
export type ProposedAction = Node & {
  __typename?: 'ProposedAction';
  /** The human decision, once made. */
  approval?: Maybe<Approval>;
  id: Scalars['ID']['output'];
  incident: Incident;
  kind: ActionKind;
  /** The canonical payload the executor will run. payloadHash is computed over exactly this. */
  payload: Scalars['JSON']['output'];
  /** Hex SHA-256 of the canonical payload. */
  payloadHash: Scalars['String']['output'];
  proposedAt: Scalars['DateTime']['output'];
  /** Why the agent proposes it. Model output: untrusted. */
  rationale: Scalars['String']['output'];
  status: ActionStatus;
  /** Exactly what will happen, e.g. 'Roll back payment from 2.4.1 to 2.4.0'. */
  summary: Scalars['String']['output'];
};

export type Query = {
  __typename?: 'Query';
  /** Triage jobs that failed for good, newest first (at most 100). Nothing redrives them on its own. */
  deadLetteredTriageJobs: Array<DeadLetteredTriageJob>;
  incident?: Maybe<Incident>;
  /** Incidents, most recently active first. */
  incidents: IncidentConnection;
  node?: Maybe<Node>;
  /** Liveness probe. Always returns 'pong'. */
  ping: Scalars['String']['output'];
};

export type QueryDeadLetteredTriageJobsArgs = {
  first?: InputMaybe<Scalars['Int']['input']>;
};

export type QueryIncidentArgs = {
  id: Scalars['ID']['input'];
};

export type QueryIncidentsArgs = {
  after?: InputMaybe<Scalars['String']['input']>;
  first?: InputMaybe<Scalars['Int']['input']>;
  status?: InputMaybe<Array<IncidentStatus>>;
};

export type QueryNodeArgs = {
  id: Scalars['ID']['input'];
};

/** An expected refusal, returned as data rather than as a GraphQL error. */
export type RedriveError = {
  __typename?: 'RedriveError';
  code: RedriveErrorCode;
  message: Scalars['String']['output'];
};

export type RedriveErrorCode = 'DEAD_LETTER_NOT_FOUND';

export type RedriveTriageJobInput = {
  /** A DeadLetteredTriageJob id. */
  id: Scalars['ID']['input'];
};

export type RedriveTriageJobResult = RedriveError | TriageJobRedriven;

export type RejectActionInput = {
  actionId: Scalars['ID']['input'];
  /** Required: non-blank, at most 2000 characters. */
  reason: Scalars['String']['input'];
};

export type Severity = 'CRITICAL' | 'INFO' | 'WARNING';

export type Subscription = {
  __typename?: 'Subscription';
  /**
   * Emits the incident whenever it changes: alerts added, status, triage result, actions proposed
   * or decided.
   */
  incidentUpdated: Incident;
};

export type SubscriptionIncidentUpdatedArgs = {
  id: Scalars['ID']['input'];
};

export type TriageAttempt = {
  __typename?: 'TriageAttempt';
  at: Scalars['DateTime']['output'];
  attempt: Scalars['Int']['output'];
  errorClass: Scalars['String']['output'];
  message: Scalars['String']['output'];
};

export type TriageFailed = Node & {
  __typename?: 'TriageFailed';
  failedAt: Scalars['DateTime']['output'];
  id: Scalars['ID']['output'];
  incident: Incident;
  message: Scalars['String']['output'];
  reason: TriageFailureReason;
  startedAt: Scalars['DateTime']['output'];
  usage: TriageUsage;
};

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

export type TriageJobRedriven = {
  __typename?: 'TriageJobRedriven';
  incidentId: Scalars['ID']['output'];
  /** The new triage job. */
  jobId: Scalars['ID']['output'];
};

export type TriageReport = Node & {
  __typename?: 'TriageReport';
  /**
   * False when the run was cut short: a limit was breached (tool calls, tokens, wall clock), the
   * model's report stayed invalid after a repair, or the model declined. stopReason says which.
   */
  complete: Scalars['Boolean']['output'];
  completedAt: Scalars['DateTime']['output'];
  /** 0–1, already lowered to account for unavailableEvidence. */
  confidence: Scalars['Float']['output'];
  /** Ranked best first: hypotheses[0] has rank 1. */
  hypotheses: Array<Hypothesis>;
  id: Scalars['ID']['output'];
  incident: Incident;
  model: Scalars['String']['output'];
  startedAt: Scalars['DateTime']['output'];
  stopReason: TriageStopReason;
  summary: Scalars['String']['output'];
  /** Evidence the agent tried and failed to gather. Each entry has available: false. */
  unavailableEvidence: Array<Evidence>;
  usage: TriageUsage;
};

export type TriageResult = TriageFailed | TriageReport;

/** Why a triage run ended. Anything but REPORT_SUBMITTED means the report is partial. */
export type TriageStopReason =
  | 'INPUT_TOKEN_BUDGET'
  | 'INVALID_OUTPUT'
  | 'OUTPUT_TOKEN_BUDGET'
  | 'REFUSAL'
  | 'REPORT_SUBMITTED'
  | 'TOOL_CALL_LIMIT'
  | 'WALL_CLOCK';

export type TriageUsage = {
  __typename?: 'TriageUsage';
  inputTokens: Scalars['Int']['output'];
  outputTokens: Scalars['Int']['output'];
  toolCalls: Scalars['Int']['output'];
};

export type ResolverTypeWrapper<T> = Promise<T> | T;

export type ResolverWithResolve<TResult, TParent, TContext, TArgs> = {
  resolve: ResolverFn<TResult, TParent, TContext, TArgs>;
};
export type Resolver<
  TResult,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  TArgs = Record<PropertyKey, never>,
> =
  | ResolverFn<TResult, TParent, TContext, TArgs>
  | ResolverWithResolve<TResult, TParent, TContext, TArgs>;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => Promise<TResult> | TResult;

export type SubscriptionSubscribeFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => AsyncIterable<TResult> | Promise<AsyncIterable<TResult>>;

export type SubscriptionResolveFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => TResult | Promise<TResult>;

export interface SubscriptionSubscriberObject<
  TResult,
  TKey extends string,
  TParent,
  TContext,
  TArgs,
> {
  subscribe: SubscriptionSubscribeFn<{ [key in TKey]: TResult }, TParent, TContext, TArgs>;
  resolve?: SubscriptionResolveFn<TResult, { [key in TKey]: TResult }, TContext, TArgs>;
}

export interface SubscriptionResolverObject<TResult, TParent, TContext, TArgs> {
  subscribe: SubscriptionSubscribeFn<any, TParent, TContext, TArgs>;
  resolve: SubscriptionResolveFn<TResult, any, TContext, TArgs>;
}

export type SubscriptionObject<TResult, TKey extends string, TParent, TContext, TArgs> =
  | SubscriptionSubscriberObject<TResult, TKey, TParent, TContext, TArgs>
  | SubscriptionResolverObject<TResult, TParent, TContext, TArgs>;

export type SubscriptionResolver<
  TResult,
  TKey extends string,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  TArgs = Record<PropertyKey, never>,
> =
  | ((...args: any[]) => SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>)
  | SubscriptionObject<TResult, TKey, TParent, TContext, TArgs>;

export type TypeResolveFn<
  TTypes,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
> = (
  parent: TParent,
  context: TContext,
  info: GraphQLResolveInfo,
) => Maybe<TTypes> | Promise<Maybe<TTypes>>;

export type IsTypeOfResolverFn<
  T = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
> = (obj: T, context: TContext, info: GraphQLResolveInfo) => boolean | Promise<boolean>;

export type NextResolverFn<T> = () => Promise<T>;

export type DirectiveResolverFn<
  TResult = Record<PropertyKey, never>,
  TParent = Record<PropertyKey, never>,
  TContext = Record<PropertyKey, never>,
  TArgs = Record<PropertyKey, never>,
> = (
  next: NextResolverFn<TResult>,
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => TResult | Promise<TResult>;

/** Mapping of union types */
export type ResolversUnionTypes<_RefType extends Record<string, unknown>> = {
  ActionDecisionResult:
    | (Omit<ActionDecided, 'action' | 'approval'> & {
        action: _RefType['ProposedAction'];
        approval: _RefType['Approval'];
      })
    | ActionDecisionError;
  RedriveTriageJobResult: RedriveError | TriageJobRedriven;
  TriageResult:
    | (Omit<TriageFailed, 'incident'> & { incident: _RefType['Incident'] })
    | (Omit<TriageReport, 'incident'> & { incident: _RefType['Incident'] });
};

/** Mapping of interface types */
export type ResolversInterfaceTypes<_RefType extends Record<string, unknown>> = {
  Node:
    | (Omit<Alert, 'incident'> & { incident?: Maybe<_RefType['Incident']> })
    | (Omit<Approval, 'action'> & { action: _RefType['ProposedAction'] })
    | (Omit<Incident, 'proposedActions' | 'triage'> & {
        proposedActions: Array<_RefType['ProposedAction']>;
        triage?: Maybe<_RefType['TriageResult']>;
      })
    | (Omit<ProposedAction, 'approval' | 'incident'> & {
        approval?: Maybe<_RefType['Approval']>;
        incident: _RefType['Incident'];
      })
    | (Omit<TriageFailed, 'incident'> & { incident: _RefType['Incident'] })
    | (Omit<TriageReport, 'incident'> & { incident: _RefType['Incident'] });
};

/** Mapping between all available schema types and the resolvers types */
export type ResolversTypes = {
  ActionDecided: ResolverTypeWrapper<
    Omit<ActionDecided, 'action' | 'approval'> & {
      action: ResolversTypes['ProposedAction'];
      approval: ResolversTypes['Approval'];
    }
  >;
  ActionDecisionError: ResolverTypeWrapper<ActionDecisionError>;
  ActionDecisionErrorCode: ActionDecisionErrorCode;
  ActionDecisionResult: ResolverTypeWrapper<
    ResolversUnionTypes<ResolversTypes>['ActionDecisionResult']
  >;
  ActionKind: ActionKind;
  ActionStatus: ActionStatus;
  Alert: ResolverTypeWrapper<
    Omit<Alert, 'incident'> & { incident?: Maybe<ResolversTypes['Incident']> }
  >;
  AlertConnection: ResolverTypeWrapper<AlertConnection>;
  AlertEdge: ResolverTypeWrapper<AlertEdge>;
  AlertSource: AlertSource;
  AlertStatus: AlertStatus;
  Approval: ResolverTypeWrapper<
    Omit<Approval, 'action'> & { action: ResolversTypes['ProposedAction'] }
  >;
  ApprovalDecision: ApprovalDecision;
  ApproveActionInput: ApproveActionInput;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
  DateTime: ResolverTypeWrapper<Scalars['DateTime']['output']>;
  DeadLetteredTriageJob: ResolverTypeWrapper<DeadLetteredTriageJob>;
  Evidence: ResolverTypeWrapper<Evidence>;
  EvidenceKind: EvidenceKind;
  FaultClass: FaultClass;
  Float: ResolverTypeWrapper<Scalars['Float']['output']>;
  Hypothesis: ResolverTypeWrapper<Hypothesis>;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  Incident: ResolverTypeWrapper<
    Omit<Incident, 'proposedActions' | 'triage'> & {
      proposedActions: Array<ResolversTypes['ProposedAction']>;
      triage?: Maybe<ResolversTypes['TriageResult']>;
    }
  >;
  IncidentConnection: ResolverTypeWrapper<
    Omit<IncidentConnection, 'edges'> & { edges: Array<ResolversTypes['IncidentEdge']> }
  >;
  IncidentEdge: ResolverTypeWrapper<
    Omit<IncidentEdge, 'node'> & { node: ResolversTypes['Incident'] }
  >;
  IncidentStatus: IncidentStatus;
  Int: ResolverTypeWrapper<Scalars['Int']['output']>;
  JSON: ResolverTypeWrapper<Scalars['JSON']['output']>;
  Label: ResolverTypeWrapper<Label>;
  Mutation: ResolverTypeWrapper<Record<PropertyKey, never>>;
  Node: ResolverTypeWrapper<ResolversInterfaceTypes<ResolversTypes>['Node']>;
  PageInfo: ResolverTypeWrapper<PageInfo>;
  ProposedAction: ResolverTypeWrapper<
    Omit<ProposedAction, 'approval' | 'incident'> & {
      approval?: Maybe<ResolversTypes['Approval']>;
      incident: ResolversTypes['Incident'];
    }
  >;
  Query: ResolverTypeWrapper<Record<PropertyKey, never>>;
  RedriveError: ResolverTypeWrapper<RedriveError>;
  RedriveErrorCode: RedriveErrorCode;
  RedriveTriageJobInput: RedriveTriageJobInput;
  RedriveTriageJobResult: ResolverTypeWrapper<
    ResolversUnionTypes<ResolversTypes>['RedriveTriageJobResult']
  >;
  RejectActionInput: RejectActionInput;
  Severity: Severity;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  Subscription: ResolverTypeWrapper<Record<PropertyKey, never>>;
  TriageAttempt: ResolverTypeWrapper<TriageAttempt>;
  TriageFailed: ResolverTypeWrapper<
    Omit<TriageFailed, 'incident'> & { incident: ResolversTypes['Incident'] }
  >;
  TriageFailureReason: TriageFailureReason;
  TriageJobRedriven: ResolverTypeWrapper<TriageJobRedriven>;
  TriageReport: ResolverTypeWrapper<
    Omit<TriageReport, 'incident'> & { incident: ResolversTypes['Incident'] }
  >;
  TriageResult: ResolverTypeWrapper<ResolversUnionTypes<ResolversTypes>['TriageResult']>;
  TriageStopReason: TriageStopReason;
  TriageUsage: ResolverTypeWrapper<TriageUsage>;
};

/** Mapping between all available schema types and the resolvers parents */
export type ResolversParentTypes = {
  ActionDecided: Omit<ActionDecided, 'action' | 'approval'> & {
    action: ResolversParentTypes['ProposedAction'];
    approval: ResolversParentTypes['Approval'];
  };
  ActionDecisionError: ActionDecisionError;
  ActionDecisionResult: ResolversUnionTypes<ResolversParentTypes>['ActionDecisionResult'];
  Alert: Omit<Alert, 'incident'> & { incident?: Maybe<ResolversParentTypes['Incident']> };
  AlertConnection: AlertConnection;
  AlertEdge: AlertEdge;
  Approval: Omit<Approval, 'action'> & { action: ResolversParentTypes['ProposedAction'] };
  ApproveActionInput: ApproveActionInput;
  Boolean: Scalars['Boolean']['output'];
  DateTime: Scalars['DateTime']['output'];
  DeadLetteredTriageJob: DeadLetteredTriageJob;
  Evidence: Evidence;
  Float: Scalars['Float']['output'];
  Hypothesis: Hypothesis;
  ID: Scalars['ID']['output'];
  Incident: Omit<Incident, 'proposedActions' | 'triage'> & {
    proposedActions: Array<ResolversParentTypes['ProposedAction']>;
    triage?: Maybe<ResolversParentTypes['TriageResult']>;
  };
  IncidentConnection: Omit<IncidentConnection, 'edges'> & {
    edges: Array<ResolversParentTypes['IncidentEdge']>;
  };
  IncidentEdge: Omit<IncidentEdge, 'node'> & { node: ResolversParentTypes['Incident'] };
  Int: Scalars['Int']['output'];
  JSON: Scalars['JSON']['output'];
  Label: Label;
  Mutation: Record<PropertyKey, never>;
  Node: ResolversInterfaceTypes<ResolversParentTypes>['Node'];
  PageInfo: PageInfo;
  ProposedAction: Omit<ProposedAction, 'approval' | 'incident'> & {
    approval?: Maybe<ResolversParentTypes['Approval']>;
    incident: ResolversParentTypes['Incident'];
  };
  Query: Record<PropertyKey, never>;
  RedriveError: RedriveError;
  RedriveTriageJobInput: RedriveTriageJobInput;
  RedriveTriageJobResult: ResolversUnionTypes<ResolversParentTypes>['RedriveTriageJobResult'];
  RejectActionInput: RejectActionInput;
  String: Scalars['String']['output'];
  Subscription: Record<PropertyKey, never>;
  TriageAttempt: TriageAttempt;
  TriageFailed: Omit<TriageFailed, 'incident'> & { incident: ResolversParentTypes['Incident'] };
  TriageJobRedriven: TriageJobRedriven;
  TriageReport: Omit<TriageReport, 'incident'> & { incident: ResolversParentTypes['Incident'] };
  TriageResult: ResolversUnionTypes<ResolversParentTypes>['TriageResult'];
  TriageUsage: TriageUsage;
};

export type ActionDecidedResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['ActionDecided'] = ResolversParentTypes['ActionDecided'],
> = {
  action?: Resolver<ResolversTypes['ProposedAction'], ParentType, ContextType>;
  approval?: Resolver<ResolversTypes['Approval'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type ActionDecisionErrorResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['ActionDecisionError'] =
    ResolversParentTypes['ActionDecisionError'],
> = {
  code?: Resolver<ResolversTypes['ActionDecisionErrorCode'], ParentType, ContextType>;
  message?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type ActionDecisionResultResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['ActionDecisionResult'] =
    ResolversParentTypes['ActionDecisionResult'],
> = {
  __resolveType: TypeResolveFn<'ActionDecided' | 'ActionDecisionError', ParentType, ContextType>;
};

export type AlertResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Alert'] = ResolversParentTypes['Alert'],
> = {
  endsAt?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  fingerprint?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  incident?: Resolver<Maybe<ResolversTypes['Incident']>, ParentType, ContextType>;
  labels?: Resolver<Array<ResolversTypes['Label']>, ParentType, ContextType>;
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  receivedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  service?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  severity?: Resolver<ResolversTypes['Severity'], ParentType, ContextType>;
  source?: Resolver<ResolversTypes['AlertSource'], ParentType, ContextType>;
  sourceUrl?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  startsAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['AlertStatus'], ParentType, ContextType>;
  summary?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type AlertConnectionResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['AlertConnection'] =
    ResolversParentTypes['AlertConnection'],
> = {
  edges?: Resolver<Array<ResolversTypes['AlertEdge']>, ParentType, ContextType>;
  pageInfo?: Resolver<ResolversTypes['PageInfo'], ParentType, ContextType>;
};

export type AlertEdgeResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['AlertEdge'] = ResolversParentTypes['AlertEdge'],
> = {
  cursor?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  node?: Resolver<ResolversTypes['Alert'], ParentType, ContextType>;
};

export type ApprovalResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Approval'] = ResolversParentTypes['Approval'],
> = {
  action?: Resolver<ResolversTypes['ProposedAction'], ParentType, ContextType>;
  consumedAt?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  decidedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  decidedBy?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  decision?: Resolver<ResolversTypes['ApprovalDecision'], ParentType, ContextType>;
  expiresAt?: Resolver<Maybe<ResolversTypes['DateTime']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  payloadHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  reason?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export interface DateTimeScalarConfig extends GraphQLScalarTypeConfig<
  ResolversTypes['DateTime'],
  any
> {
  name: 'DateTime';
}

export type DeadLetteredTriageJobResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['DeadLetteredTriageJob'] =
    ResolversParentTypes['DeadLetteredTriageJob'],
> = {
  attempts?: Resolver<Array<ResolversTypes['TriageAttempt']>, ParentType, ContextType>;
  errorClass?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  failedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  failedReason?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  incidentId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  lastStack?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type EvidenceResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Evidence'] = ResolversParentTypes['Evidence'],
> = {
  available?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  excerpt?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  kind?: Resolver<ResolversTypes['EvidenceKind'], ParentType, ContextType>;
  sourceId?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  unavailableReason?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  url?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type HypothesisResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Hypothesis'] = ResolversParentTypes['Hypothesis'],
> = {
  confidence?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  evidence?: Resolver<Array<ResolversTypes['Evidence']>, ParentType, ContextType>;
  explanation?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  faultClass?: Resolver<Maybe<ResolversTypes['FaultClass']>, ParentType, ContextType>;
  rank?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  suspect?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  title?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type IncidentResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Incident'] = ResolversParentTypes['Incident'],
> = {
  alertCount?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  alerts?: Resolver<
    ResolversTypes['AlertConnection'],
    ParentType,
    ContextType,
    RequireFields<IncidentAlertsArgs, 'first'>
  >;
  firstSeenAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  lastSeenAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  proposedActions?: Resolver<Array<ResolversTypes['ProposedAction']>, ParentType, ContextType>;
  service?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  severity?: Resolver<ResolversTypes['Severity'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['IncidentStatus'], ParentType, ContextType>;
  title?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  triage?: Resolver<Maybe<ResolversTypes['TriageResult']>, ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type IncidentConnectionResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['IncidentConnection'] =
    ResolversParentTypes['IncidentConnection'],
> = {
  edges?: Resolver<Array<ResolversTypes['IncidentEdge']>, ParentType, ContextType>;
  pageInfo?: Resolver<ResolversTypes['PageInfo'], ParentType, ContextType>;
};

export type IncidentEdgeResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['IncidentEdge'] = ResolversParentTypes['IncidentEdge'],
> = {
  cursor?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  node?: Resolver<ResolversTypes['Incident'], ParentType, ContextType>;
};

export interface JsonScalarConfig extends GraphQLScalarTypeConfig<ResolversTypes['JSON'], any> {
  name: 'JSON';
}

export type LabelResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Label'] = ResolversParentTypes['Label'],
> = {
  name?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  value?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type MutationResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation'],
> = {
  approveAction?: Resolver<
    ResolversTypes['ActionDecisionResult'],
    ParentType,
    ContextType,
    RequireFields<MutationApproveActionArgs, 'input'>
  >;
  redriveTriageJob?: Resolver<
    ResolversTypes['RedriveTriageJobResult'],
    ParentType,
    ContextType,
    RequireFields<MutationRedriveTriageJobArgs, 'input'>
  >;
  rejectAction?: Resolver<
    ResolversTypes['ActionDecisionResult'],
    ParentType,
    ContextType,
    RequireFields<MutationRejectActionArgs, 'input'>
  >;
};

export type NodeResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Node'] = ResolversParentTypes['Node'],
> = {
  __resolveType: TypeResolveFn<
    'Alert' | 'Approval' | 'Incident' | 'ProposedAction' | 'TriageFailed' | 'TriageReport',
    ParentType,
    ContextType
  >;
};

export type PageInfoResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['PageInfo'] = ResolversParentTypes['PageInfo'],
> = {
  endCursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
  hasNextPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  hasPreviousPage?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  startCursor?: Resolver<Maybe<ResolversTypes['String']>, ParentType, ContextType>;
};

export type ProposedActionResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['ProposedAction'] =
    ResolversParentTypes['ProposedAction'],
> = {
  approval?: Resolver<Maybe<ResolversTypes['Approval']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  incident?: Resolver<ResolversTypes['Incident'], ParentType, ContextType>;
  kind?: Resolver<ResolversTypes['ActionKind'], ParentType, ContextType>;
  payload?: Resolver<ResolversTypes['JSON'], ParentType, ContextType>;
  payloadHash?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  proposedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  rationale?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  status?: Resolver<ResolversTypes['ActionStatus'], ParentType, ContextType>;
  summary?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type QueryResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query'],
> = {
  deadLetteredTriageJobs?: Resolver<
    Array<ResolversTypes['DeadLetteredTriageJob']>,
    ParentType,
    ContextType,
    RequireFields<QueryDeadLetteredTriageJobsArgs, 'first'>
  >;
  incident?: Resolver<
    Maybe<ResolversTypes['Incident']>,
    ParentType,
    ContextType,
    RequireFields<QueryIncidentArgs, 'id'>
  >;
  incidents?: Resolver<
    ResolversTypes['IncidentConnection'],
    ParentType,
    ContextType,
    RequireFields<QueryIncidentsArgs, 'first'>
  >;
  node?: Resolver<
    Maybe<ResolversTypes['Node']>,
    ParentType,
    ContextType,
    RequireFields<QueryNodeArgs, 'id'>
  >;
  ping?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type RedriveErrorResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['RedriveError'] = ResolversParentTypes['RedriveError'],
> = {
  code?: Resolver<ResolversTypes['RedriveErrorCode'], ParentType, ContextType>;
  message?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type RedriveTriageJobResultResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['RedriveTriageJobResult'] =
    ResolversParentTypes['RedriveTriageJobResult'],
> = {
  __resolveType: TypeResolveFn<'RedriveError' | 'TriageJobRedriven', ParentType, ContextType>;
};

export type SubscriptionResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Subscription'] = ResolversParentTypes['Subscription'],
> = {
  incidentUpdated?: SubscriptionResolver<
    ResolversTypes['Incident'],
    'incidentUpdated',
    ParentType,
    ContextType,
    RequireFields<SubscriptionIncidentUpdatedArgs, 'id'>
  >;
};

export type TriageAttemptResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['TriageAttempt'] = ResolversParentTypes['TriageAttempt'],
> = {
  at?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  attempt?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  errorClass?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  message?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type TriageFailedResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['TriageFailed'] = ResolversParentTypes['TriageFailed'],
> = {
  failedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  incident?: Resolver<ResolversTypes['Incident'], ParentType, ContextType>;
  message?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  reason?: Resolver<ResolversTypes['TriageFailureReason'], ParentType, ContextType>;
  startedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  usage?: Resolver<ResolversTypes['TriageUsage'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type TriageJobRedrivenResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['TriageJobRedriven'] =
    ResolversParentTypes['TriageJobRedriven'],
> = {
  incidentId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  jobId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type TriageReportResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['TriageReport'] = ResolversParentTypes['TriageReport'],
> = {
  complete?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
  completedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  confidence?: Resolver<ResolversTypes['Float'], ParentType, ContextType>;
  hypotheses?: Resolver<Array<ResolversTypes['Hypothesis']>, ParentType, ContextType>;
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  incident?: Resolver<ResolversTypes['Incident'], ParentType, ContextType>;
  model?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  startedAt?: Resolver<ResolversTypes['DateTime'], ParentType, ContextType>;
  stopReason?: Resolver<ResolversTypes['TriageStopReason'], ParentType, ContextType>;
  summary?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  unavailableEvidence?: Resolver<Array<ResolversTypes['Evidence']>, ParentType, ContextType>;
  usage?: Resolver<ResolversTypes['TriageUsage'], ParentType, ContextType>;
  __isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>;
};

export type TriageResultResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['TriageResult'] = ResolversParentTypes['TriageResult'],
> = {
  __resolveType: TypeResolveFn<'TriageFailed' | 'TriageReport', ParentType, ContextType>;
};

export type TriageUsageResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['TriageUsage'] = ResolversParentTypes['TriageUsage'],
> = {
  inputTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  outputTokens?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
  toolCalls?: Resolver<ResolversTypes['Int'], ParentType, ContextType>;
};

export type Resolvers<ContextType = unknown> = {
  ActionDecided?: ActionDecidedResolvers<ContextType>;
  ActionDecisionError?: ActionDecisionErrorResolvers<ContextType>;
  ActionDecisionResult?: ActionDecisionResultResolvers<ContextType>;
  Alert?: AlertResolvers<ContextType>;
  AlertConnection?: AlertConnectionResolvers<ContextType>;
  AlertEdge?: AlertEdgeResolvers<ContextType>;
  Approval?: ApprovalResolvers<ContextType>;
  DateTime?: GraphQLScalarType;
  DeadLetteredTriageJob?: DeadLetteredTriageJobResolvers<ContextType>;
  Evidence?: EvidenceResolvers<ContextType>;
  Hypothesis?: HypothesisResolvers<ContextType>;
  Incident?: IncidentResolvers<ContextType>;
  IncidentConnection?: IncidentConnectionResolvers<ContextType>;
  IncidentEdge?: IncidentEdgeResolvers<ContextType>;
  JSON?: GraphQLScalarType;
  Label?: LabelResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  Node?: NodeResolvers<ContextType>;
  PageInfo?: PageInfoResolvers<ContextType>;
  ProposedAction?: ProposedActionResolvers<ContextType>;
  Query?: QueryResolvers<ContextType>;
  RedriveError?: RedriveErrorResolvers<ContextType>;
  RedriveTriageJobResult?: RedriveTriageJobResultResolvers<ContextType>;
  Subscription?: SubscriptionResolvers<ContextType>;
  TriageAttempt?: TriageAttemptResolvers<ContextType>;
  TriageFailed?: TriageFailedResolvers<ContextType>;
  TriageJobRedriven?: TriageJobRedrivenResolvers<ContextType>;
  TriageReport?: TriageReportResolvers<ContextType>;
  TriageResult?: TriageResultResolvers<ContextType>;
  TriageUsage?: TriageUsageResolvers<ContextType>;
};
