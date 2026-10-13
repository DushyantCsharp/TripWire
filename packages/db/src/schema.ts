import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

// Column names are snake_case in SQL via `casing: 'snake_case'` (drizzle.config.ts and the client).
// Primary keys are UUIDv7, generated here: time-ordered, so new rows land at the end of the index.
const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
const timestamptz = () => timestamp({ withTimezone: true, mode: 'date' });
const sha256Hex = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;
// Descending index columns are written `.desc().nullsFirst()`: drizzle-kit's bare `.desc()` emits
// DESC NULLS LAST, which doesn't match `ORDER BY x DESC` (NULLS FIRST), so Postgres would sort.

export const alertSource = pgEnum('alert_source', ['alertmanager', 'generic']);
export const alertStatus = pgEnum('alert_status', ['firing', 'resolved']);
export const severity = pgEnum('severity', ['critical', 'warning', 'info']);
export const incidentStatus = pgEnum('incident_status', [
  'open',
  'triaging',
  'triaged',
  'resolved',
]);
export const alertMatch = pgEnum('alert_match', ['fingerprint', 'embedding', 'new_incident']);
export const triageStatus = pgEnum('triage_status', ['queued', 'running', 'succeeded', 'failed']);
export const triageFailureReason = pgEnum('triage_failure_reason', [
  'token_budget_exhausted',
  'tool_call_limit_reached',
  'model_unavailable',
  'timed_out',
  'invalid_output',
  'request_rejected',
  'internal_error',
]);
export const evidenceKind = pgEnum('evidence_kind', [
  'log',
  'trace',
  'metric',
  'deploy',
  'runbook',
]);
export const actionKind = pgEnum('action_kind', ['rollback', 'scale', 'page']);
export const actionStatus = pgEnum('action_status', [
  'pending_approval',
  'approved',
  'rejected',
  'expired',
  'executed',
  'execution_failed',
]);
export const approvalDecision = pgEnum('approval_decision', ['approved', 'rejected']);
/** Why a triage run ended. Anything but report_submitted means its report is partial. */
export const triageStopReason = pgEnum('triage_stop_reason', [
  'report_submitted',
  'tool_call_limit',
  'input_token_budget',
  'output_token_budget',
  'wall_clock',
  'invalid_output',
  'refusal',
]);
/** The agent's FAULT_CLASSES (packages/agent can't share code with this package). */
export const faultClass = pgEnum('fault_class', [
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
]);

/** One webhook delivery. Its id is the `ingest_id` returned in the 202. */
export const ingests = pgTable(
  'ingests',
  {
    id: id(),
    idempotencyKey: text().notNull(),
    bodyHash: text().notNull(),
    source: alertSource().notNull(),
    receivedAt: timestamptz().notNull(),
    alertCount: integer().notNull(),
  },
  (t) => [
    unique('ingests_idempotency_key_key').on(t.idempotencyKey),
    check('ingests_body_hash_sha256', sha256Hex(t.bodyHash)),
    check('ingests_alert_count_positive', sql`${t.alertCount} > 0`),
  ],
);

export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    ingestId: uuid()
      .notNull()
      .references(() => ingests.id),
    source: alertSource().notNull(),
    name: text().notNull(),
    status: alertStatus().notNull(),
    severity: severity().notNull(),
    service: text(),
    summary: text(),
    labels: jsonb().$type<Record<string, string>>().notNull(),
    /** v1: hash over every label, so each pod or instance is a distinct alert. */
    fingerprint: text().notNull(),
    /** v2: hash over identity labels only, so a storm across pods shares one fingerprint. */
    fingerprintV2: text('fingerprint_v2').notNull(),
    startsAt: timestamptz().notNull(),
    endsAt: timestamptz(),
    receivedAt: timestamptz().notNull(),
    /** The single alert exactly as received. */
    rawPayload: jsonb().$type<unknown>().notNull(),
  },
  (t) => [
    // Dedupe-window lookup: WHERE fingerprint_v2 = $1 AND received_at > $2.
    index('alerts_fingerprint_v2_received_at_idx').on(
      t.fingerprintV2,
      t.receivedAt.desc().nullsFirst(),
    ),
    index('alerts_ingest_id_idx').on(t.ingestId),
  ],
);

export const incidents = pgTable(
  'incidents',
  {
    id: id(),
    title: text().notNull(),
    status: incidentStatus().notNull().default('open'),
    severity: severity().notNull(),
    service: text(),
    firstSeen: timestamptz().notNull(),
    lastSeen: timestamptz().notNull(),
    alertCount: integer().notNull().default(0),
    /** Set asynchronously once the incident's text has been embedded. */
    embedding: vector({ dimensions: 1024 }),
    resolvedAt: timestamptz(),
    createdAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Keyset pagination: WHERE (last_seen, id) < ($1, $2) ORDER BY last_seen DESC, id DESC.
    index('incidents_last_seen_id_idx').on(
      t.lastSeen.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('incidents_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check('incidents_seen_order', sql`${t.lastSeen} >= ${t.firstSeen}`),
    check('incidents_alert_count_non_negative', sql`${t.alertCount} >= 0`),
  ],
);

export const incidentAlerts = pgTable(
  'incident_alerts',
  {
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    alertId: uuid()
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    /** How the alert was attached; feeds the dedupe evaluation. */
    match: alertMatch().notNull(),
    /** Cosine similarity when match = 'embedding'. */
    similarity: real(),
    attachedAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'incident_alerts_pkey', columns: [t.incidentId, t.alertId] }),
    unique('incident_alerts_alert_id_key').on(t.alertId),
    check(
      'incident_alerts_similarity_range',
      sql`${t.similarity} IS NULL OR ${t.similarity} BETWEEN -1 AND 1`,
    ),
  ],
);

export const triageRuns = pgTable(
  'triage_runs',
  {
    id: id(),
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id),
    status: triageStatus().notNull().default('queued'),
    /**
     * The BullMQ job this run belongs to. Retries and redeliveries of a job reuse its run, so one
     * job writes at most one report. Nullable only so 0005 could add it to a populated table.
     */
    jobKey: text(),
    attempts: integer().notNull().default(0),
    model: text().notNull(),
    tokensIn: integer().notNull().default(0),
    tokensOut: integer().notNull().default(0),
    toolCalls: integer().notNull().default(0),
    costUsdMicros: bigint({ mode: 'number' }).notNull().default(0),
    summary: text(),
    confidence: real(),
    failureReason: triageFailureReason(),
    /** Set with the report. Null for runs that failed, or finished before 0006. */
    stopReason: triageStopReason(),
    error: text(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    unique('triage_runs_job_key_key').on(t.jobKey),
    index('triage_runs_incident_id_created_at_idx').on(
      t.incidentId,
      t.createdAt.desc().nullsFirst(),
    ),
    check(
      'triage_runs_counters_non_negative',
      sql`${t.tokensIn} >= 0 AND ${t.tokensOut} >= 0 AND ${t.toolCalls} >= 0 AND ${t.costUsdMicros} >= 0`,
    ),
    check(
      'triage_runs_confidence_range',
      sql`${t.confidence} IS NULL OR ${t.confidence} BETWEEN 0 AND 1`,
    ),
    check(
      'triage_runs_failure_has_reason',
      sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`,
    ),
  ],
);

export const hypotheses = pgTable(
  'hypotheses',
  {
    id: id(),
    triageRunId: uuid()
      .notNull()
      .references(() => triageRuns.id, { onDelete: 'cascade' }),
    rank: integer().notNull(),
    title: text().notNull(),
    explanation: text().notNull(),
    confidence: real().notNull(),
    suspect: text(),
    /** Null when the hypothesis didn't come from the model (a fallback ranking). */
    faultClass: faultClass(),
  },
  (t) => [
    unique('hypotheses_triage_run_id_rank_key').on(t.triageRunId, t.rank),
    check('hypotheses_rank_positive', sql`${t.rank} >= 1`),
    check('hypotheses_confidence_range', sql`${t.confidence} BETWEEN 0 AND 1`),
  ],
);

export const evidence = pgTable(
  'evidence',
  {
    id: id(),
    triageRunId: uuid()
      .notNull()
      .references(() => triageRuns.id, { onDelete: 'cascade' }),
    /** Null for evidence the whole run tried and failed to gather. */
    hypothesisId: uuid().references(() => hypotheses.id, { onDelete: 'cascade' }),
    kind: evidenceKind().notNull(),
    sourceId: text().notNull(),
    excerpt: text(),
    available: boolean().notNull(),
    unavailableReason: text(),
    url: text(),
  },
  (t) => [
    index('evidence_triage_run_id_idx').on(t.triageRunId),
    index('evidence_hypothesis_id_idx').on(t.hypothesisId),
    check(
      'evidence_unavailable_has_reason',
      sql`${t.available} OR ${t.unavailableReason} IS NOT NULL`,
    ),
  ],
);

/** payload and payload_hash are immutable after insert (trigger in 0001_initial). */
export const proposedActions = pgTable(
  'proposed_actions',
  {
    id: id(),
    incidentId: uuid()
      .notNull()
      .references(() => incidents.id),
    triageRunId: uuid()
      .notNull()
      .references(() => triageRuns.id),
    kind: actionKind().notNull(),
    summary: text().notNull(),
    rationale: text().notNull(),
    payload: jsonb().$type<unknown>().notNull(),
    payloadHash: text().notNull(),
    status: actionStatus().notNull().default('pending_approval'),
    proposedAt: timestamptz().notNull().defaultNow(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Target of approvals' composite foreign key.
    unique('proposed_actions_id_payload_hash_key').on(t.id, t.payloadHash),
    index('proposed_actions_incident_id_idx').on(t.incidentId),
    index('proposed_actions_triage_run_id_idx').on(t.triageRunId),
    // An incident has at most one pending proposal per payload: a redriven triage that proposes
    // the same action again finds it already waiting for a person.
    uniqueIndex('proposed_actions_pending_payload_key')
      .on(t.incidentId, t.payloadHash)
      .where(sql`${t.status} = 'pending_approval'`),
    check('proposed_actions_payload_hash_sha256', sha256Hex(t.payloadHash)),
  ],
);

/**
 * One human decision per action. The composite foreign key means an approval can only reference
 * the payload hash the action actually has. Append-only apart from a single consumed_at write
 * (trigger in 0001_initial).
 */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    actionId: uuid().notNull(),
    actor: text().notNull(),
    decision: approvalDecision().notNull(),
    reason: text().notNull(),
    payloadHash: text().notNull(),
    decidedAt: timestamptz().notNull().defaultNow(),
    expiresAt: timestamptz(),
    consumedAt: timestamptz(),
  },
  (t) => [
    foreignKey({
      name: 'approvals_action_payload_fkey',
      columns: [t.actionId, t.payloadHash],
      foreignColumns: [proposedActions.id, proposedActions.payloadHash],
    }),
    unique('approvals_action_id_key').on(t.actionId),
    check('approvals_reason_not_blank', sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`),
    check(
      'approvals_expiry_iff_approved',
      sql`(${t.decision} = 'approved') = (${t.expiresAt} IS NOT NULL)`,
    ),
    check(
      'approvals_consumed_only_if_approved',
      sql`${t.consumedAt} IS NULL OR ${t.decision} = 'approved'`,
    ),
  ],
);

/**
 * Sections of the markdown runbooks in /runbooks, embedded for get_runbook's search. Synced from the
 * files by `just runbooks-index`. No HNSW index: a few hundred rows are searched exactly, and an
 * approximate index filtered by service could return fewer than k rows.
 */
export const runbookChunks = pgTable(
  'runbook_chunks',
  {
    id: id(),
    /** Relative to the runbooks directory, e.g. `payment.md`. */
    path: text().notNull(),
    /** The section's heading, slugged: `<path>#<anchor>` identifies it. */
    anchor: text().notNull(),
    title: text().notNull(),
    service: text(),
    content: text().notNull(),
    contentHash: text().notNull(),
    /** The embedder that produced `embedding`; a different one means re-embedding. */
    embedder: text().notNull(),
    embedding: vector({ dimensions: 1024 }).notNull(),
    updatedAt: timestamptz()
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('runbook_chunks_path_anchor_key').on(t.path, t.anchor),
    check('runbook_chunks_content_hash_sha256', sha256Hex(t.contentHash)),
  ],
);

/** Progress of resumable backfill jobs, written in the same transaction as each batch. */
export const backfillCheckpoints = pgTable('backfill_checkpoints', {
  name: text().primaryKey(),
  /** Keyset cursor: the last row id the job has finished. */
  lastId: uuid(),
  rowsDone: bigint({ mode: 'number' }).notNull().default(0),
  updatedAt: timestamptz().notNull().defaultNow(),
  completedAt: timestamptz(),
});
