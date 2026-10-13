import { and, asc, count, desc, eq, inArray, max, min, ne, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { dbCall } from './errors.js';
import {
  alerts,
  evidence,
  type faultClass,
  hypotheses,
  incidentAlerts,
  incidents,
  proposedActions,
  triageRuns,
  type triageFailureReason,
  type triageStopReason,
} from './schema.js';

export type TriageFailureReason = (typeof triageFailureReason.enumValues)[number];
export type TriageStopReason = (typeof triageStopReason.enumValues)[number];
export type FaultClass = (typeof faultClass.enumValues)[number];

const alertColumns = {
  name: alerts.name,
  service: alerts.service,
  severity: alerts.severity,
  status: alerts.status,
  summary: alerts.summary,
  labels: alerts.labels,
  startsAt: alerts.startsAt,
  receivedAt: alerts.receivedAt,
};

/** Every alert of an incident, counted by name and service, the commonest first. */
export function alertGroupsQuery(db: Database, incidentId: string, limit: number) {
  return db
    .select({
      name: alerts.name,
      service: alerts.service,
      count: count(),
      firstStartsAt: min(alerts.startsAt),
      lastReceivedAt: max(alerts.receivedAt),
    })
    .from(incidentAlerts)
    .innerJoin(alerts, eq(alerts.id, incidentAlerts.alertId))
    .where(eq(incidentAlerts.incidentId, incidentId))
    .groupBy(alerts.name, alerts.service)
    .orderBy(desc(count()), asc(alerts.name), asc(alerts.service))
    .limit(limit);
}

/**
 * The input to a triage run: the incident, its most recent alerts (newest first), its earliest
 * (in a cascade, the nearest the root), and every alert counted by name and service, so a storm's
 * shape survives the cap on how many alerts are read in full.
 */
export function loadIncidentForTriage(db: Database, incidentId: string, alertLimit = 50) {
  return dbCall(async () => {
    const [incident] = await db
      .select({
        id: incidents.id,
        title: incidents.title,
        service: incidents.service,
        severity: incidents.severity,
        firstSeen: incidents.firstSeen,
        lastSeen: incidents.lastSeen,
        alertCount: incidents.alertCount,
      })
      .from(incidents)
      .where(eq(incidents.id, incidentId));
    if (!incident) return undefined;
    const ofIncident = eq(incidentAlerts.incidentId, incidentId);
    const [recent, earliest, groups] = await Promise.all([
      db
        .select(alertColumns)
        .from(incidentAlerts)
        .innerJoin(alerts, eq(alerts.id, incidentAlerts.alertId))
        .where(ofIncident)
        // Alerts of one delivery share receivedAt: the tie-breakers keep the order (and so what
        // the model reads) the same every time.
        .orderBy(desc(alerts.receivedAt), asc(alerts.fingerprint), asc(alerts.id))
        .limit(alertLimit),
      db
        .select(alertColumns)
        .from(incidentAlerts)
        .innerJoin(alerts, eq(alerts.id, incidentAlerts.alertId))
        .where(ofIncident)
        .orderBy(
          asc(alerts.startsAt),
          asc(alerts.receivedAt),
          asc(alerts.fingerprint),
          asc(alerts.id),
        )
        .limit(3),
      alertGroupsQuery(db, incidentId, 20),
    ]);
    return {
      ...incident,
      alerts: recent,
      earliestAlerts: earliest,
      alertGroups: groups.map((group) => {
        // min/max over a non-empty group are never null.
        if (!group.firstStartsAt || !group.lastReceivedAt) {
          throw new Error(`alert group ${group.name} of incident ${incidentId} has no times`);
        }
        return {
          ...group,
          firstStartsAt: group.firstStartsAt,
          lastReceivedAt: group.lastReceivedAt,
        };
      }),
    };
  });
}

export type BeginTriageOutcome =
  | { readonly status: 'started'; readonly runId: string; readonly attempt: number }
  | { readonly status: 'already_succeeded'; readonly runId: string };

/**
 * Starts the run for a BullMQ job, or restarts it on a retry or redelivery. A job whose run already
 * succeeded is not run again: that is what keeps one job to one report.
 */
export function beginTriageRun(
  db: Database,
  run: { readonly incidentId: string; readonly jobKey: string; readonly model: string },
) {
  return dbCall(() =>
    db.transaction(async (tx): Promise<BeginTriageOutcome> => {
      const now = new Date();
      const [started] = await tx
        .insert(triageRuns)
        .values({ ...run, status: 'running', attempts: 1, startedAt: now })
        .onConflictDoUpdate({
          target: triageRuns.jobKey,
          set: {
            status: 'running',
            attempts: sql`${triageRuns.attempts} + 1`,
            model: run.model,
            startedAt: now,
            finishedAt: null,
            error: null,
            failureReason: null,
          },
          setWhere: ne(triageRuns.status, 'succeeded'),
        })
        .returning({ id: triageRuns.id, attempts: triageRuns.attempts });
      if (!started) {
        const [done] = await tx
          .select({ id: triageRuns.id })
          .from(triageRuns)
          .where(eq(triageRuns.jobKey, run.jobKey));
        if (!done) throw new Error(`triage run ${run.jobKey} conflicted but is missing`);
        return { status: 'already_succeeded', runId: done.id };
      }
      await tx
        .update(incidents)
        .set({ status: 'triaging' })
        .where(and(eq(incidents.id, run.incidentId), eq(incidents.status, 'open')));
      return { status: 'started', runId: started.id, attempt: started.attempts };
    }),
  );
}

export interface EvidenceRecord {
  readonly kind: (typeof evidence.$inferInsert)['kind'];
  readonly sourceId: string;
  readonly excerpt: string | null;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly url: string | null;
}

export interface ProposedActionRecord {
  /** Derived from the run and payload by the agent, so a retried attempt proposes the same row. */
  readonly id: string;
  readonly kind: (typeof proposedActions.$inferInsert)['kind'];
  readonly summary: string;
  readonly rationale: string;
  readonly payload: unknown;
  readonly payloadHash: string;
}

/** A finished report. Structurally the agent's TriageReport, so the worker passes it straight in. */
export interface TriageReportRecord {
  readonly model: string;
  readonly summary: string;
  readonly confidence: number;
  readonly stopReason: TriageStopReason;
  readonly hypotheses: readonly {
    readonly rank: number;
    readonly title: string;
    readonly explanation: string;
    readonly confidence: number;
    readonly suspect: string | null;
    readonly faultClass: FaultClass | null;
    readonly evidence: readonly EvidenceRecord[];
  }[];
  readonly unavailableEvidence: readonly EvidenceRecord[];
  /** Write actions the agent proposed. Stored as pending_approval: nothing here executes them. */
  readonly proposedActions: readonly ProposedActionRecord[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number;
    readonly costUsdMicros: number;
  };
}

/**
 * Writes the report, with the actions it proposes, and marks the run succeeded in one transaction.
 * Writes nothing and returns `written: false` if the run is no longer running: a racing attempt of
 * the same job won. A proposal already pending for the incident (from an earlier run) isn't
 * duplicated.
 */
export function completeTriageRun(db: Database, runId: string, report: TriageReportRecord) {
  return dbCall(() =>
    db.transaction(async (tx) => {
      const [run] = await tx
        .update(triageRuns)
        .set({
          status: 'succeeded',
          model: report.model,
          summary: report.summary,
          confidence: report.confidence,
          stopReason: report.stopReason,
          tokensIn: report.usage.inputTokens,
          tokensOut: report.usage.outputTokens,
          toolCalls: report.usage.toolCalls,
          costUsdMicros: report.usage.costUsdMicros,
          finishedAt: new Date(),
        })
        .where(and(eq(triageRuns.id, runId), eq(triageRuns.status, 'running')))
        .returning({ incidentId: triageRuns.incidentId });
      if (!run) return { written: false };

      for (const hypothesis of report.hypotheses) {
        const [row] = await tx
          .insert(hypotheses)
          .values({
            triageRunId: runId,
            rank: hypothesis.rank,
            title: hypothesis.title,
            explanation: hypothesis.explanation,
            confidence: hypothesis.confidence,
            suspect: hypothesis.suspect,
            faultClass: hypothesis.faultClass,
          })
          .returning({ id: hypotheses.id });
        if (row && hypothesis.evidence.length > 0) {
          await tx.insert(evidence).values(
            hypothesis.evidence.map((item) => ({
              ...item,
              triageRunId: runId,
              hypothesisId: row.id,
            })),
          );
        }
      }
      if (report.unavailableEvidence.length > 0) {
        await tx
          .insert(evidence)
          .values(report.unavailableEvidence.map((item) => ({ ...item, triageRunId: runId })));
      }
      if (report.proposedActions.length > 0) {
        await tx
          .insert(proposedActions)
          .values(
            report.proposedActions.map((action) => ({
              id: action.id,
              incidentId: run.incidentId,
              triageRunId: runId,
              kind: action.kind,
              summary: action.summary,
              rationale: action.rationale,
              payload: action.payload,
              payloadHash: action.payloadHash,
              status: 'pending_approval' as const,
            })),
          )
          .onConflictDoNothing();
      }
      await tx
        .update(incidents)
        .set({ status: 'triaged' })
        .where(
          and(eq(incidents.id, run.incidentId), inArray(incidents.status, ['open', 'triaging'])),
        );
      return { written: true };
    }),
  );
}

/**
 * Marks a job's run failed as it goes to the dead-letter queue, and reopens its incident. Changes
 * nothing if the run already succeeded (a late failure must not dead-letter a job whose report
 * committed) or never started; the outcome says which.
 */
export function failTriageRun(
  db: Database,
  failure: {
    readonly jobKey: string;
    readonly reason: TriageFailureReason;
    readonly error: string;
  },
) {
  return dbCall(() =>
    db.transaction(async (tx) => {
      const [run] = await tx
        .update(triageRuns)
        .set({
          status: 'failed',
          failureReason: failure.reason,
          error: failure.error,
          finishedAt: new Date(),
        })
        .where(and(eq(triageRuns.jobKey, failure.jobKey), ne(triageRuns.status, 'succeeded')))
        .returning({ incidentId: triageRuns.incidentId });
      if (!run) {
        const [existing] = await tx
          .select({ status: triageRuns.status })
          .from(triageRuns)
          .where(eq(triageRuns.jobKey, failure.jobKey));
        return { outcome: existing ? ('already_succeeded' as const) : ('no_run' as const) };
      }
      await tx
        .update(incidents)
        .set({ status: 'open' })
        .where(and(eq(incidents.id, run.incidentId), eq(incidents.status, 'triaging')));
      return { outcome: 'marked' as const };
    }),
  );
}
