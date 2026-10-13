import type { Result } from '@tripwire/result';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { dbCall, type DatabaseError } from './errors.js';
import { fingerprintV1, fingerprintV2, type Labels } from './fingerprint.js';
import { alerts, incidentAlerts, ingests } from './schema.js';

type AlertInsert = typeof alerts.$inferInsert;

/** One alert, normalised from a webhook payload. */
export interface NewAlert {
  readonly source: AlertInsert['source'];
  readonly name: string;
  readonly status: AlertInsert['status'];
  readonly severity: AlertInsert['severity'];
  readonly service?: string | undefined;
  readonly summary?: string | undefined;
  readonly labels: Labels;
  readonly startsAt: Date;
  readonly endsAt?: Date | undefined;
  /** The alert exactly as received. */
  readonly rawPayload: unknown;
}

/** One webhook delivery: what a single Idempotency-Key covers. */
export interface Delivery {
  /** Defaults to a new UUIDv7. The API assigns it up front so the 202's ingest_id is the row id. */
  readonly id?: string | undefined;
  readonly idempotencyKey: string;
  /** Hex SHA-256 of the raw request body. */
  readonly bodyHash: string;
  readonly source: AlertInsert['source'];
  readonly receivedAt: Date;
  readonly alerts: readonly NewAlert[];
}

export type RecordIngestOutcome =
  | {
      readonly status: 'recorded';
      readonly ingestId: string;
      readonly alertIds: readonly string[];
    }
  // The idempotency key was already recorded, so nothing was written.
  | {
      readonly status: 'duplicate';
      readonly ingestId: string;
      readonly bodyHashMatches: boolean;
    };

export interface RecordIngestOptions {
  /**
   * The fingerprint_v2 dual-write flag (FINGERPRINT_V2_WRITE). It must be on before 0004 makes the
   * column NOT NULL; see MIGRATIONS.md.
   */
  readonly writeFingerprintV2: boolean;
}

/** Writes a delivery and its alerts in one transaction. A repeated idempotency key writes nothing. */
export function recordIngest(
  db: Database,
  delivery: Delivery,
  options: RecordIngestOptions,
): Promise<Result<RecordIngestOutcome, DatabaseError>> {
  return dbCall(() =>
    db.transaction(async (tx): Promise<RecordIngestOutcome> => {
      const [ingest] = await tx
        .insert(ingests)
        .values({
          id: delivery.id,
          idempotencyKey: delivery.idempotencyKey,
          bodyHash: delivery.bodyHash,
          source: delivery.source,
          receivedAt: delivery.receivedAt,
          alertCount: delivery.alerts.length,
        })
        .onConflictDoNothing({ target: ingests.idempotencyKey })
        .returning({ id: ingests.id });

      if (!ingest) {
        const [existing] = await tx
          .select({ id: ingests.id, bodyHash: ingests.bodyHash })
          .from(ingests)
          .where(eq(ingests.idempotencyKey, delivery.idempotencyKey));
        if (!existing)
          throw new Error(`ingest ${delivery.idempotencyKey} conflicted but is missing`);
        return {
          status: 'duplicate',
          ingestId: existing.id,
          bodyHashMatches: existing.bodyHash === delivery.bodyHash,
        };
      }

      const inserted = await tx
        .insert(alerts)
        .values(
          delivery.alerts.map((alert) => ({
            ...alert,
            ingestId: ingest.id,
            receivedAt: delivery.receivedAt,
            fingerprint: fingerprintV1(alert.labels),
            fingerprintV2: options.writeFingerprintV2 ? fingerprintV2(alert.labels) : sql`NULL`,
          })),
        )
        .returning({ id: alerts.id });
      return { status: 'recorded', ingestId: ingest.id, alertIds: inserted.map((row) => row.id) };
    }),
  );
}

export type FingerprintVersion = 'v1' | 'v2';

export interface RecentAlertsArgs {
  readonly fingerprint: string;
  readonly since: Date;
  /** The fingerprint_v2 read flag (FINGERPRINT_V2_READ): which column dedupe matches on. */
  readonly version: FingerprintVersion;
  readonly limit?: number;
}

/** The dedupe-window lookup, newest first. Exported separately so tests can EXPLAIN it. */
export function recentAlertsByFingerprintQuery(db: Database, args: RecentAlertsArgs) {
  const column = args.version === 'v2' ? alerts.fingerprintV2 : alerts.fingerprint;
  return db
    .select({
      alertId: alerts.id,
      incidentId: incidentAlerts.incidentId,
      receivedAt: alerts.receivedAt,
    })
    .from(alerts)
    .leftJoin(incidentAlerts, eq(incidentAlerts.alertId, alerts.id))
    .where(and(eq(column, args.fingerprint), gt(alerts.receivedAt, args.since)))
    .orderBy(desc(alerts.receivedAt))
    .limit(args.limit ?? 50);
}

export function findRecentAlertsByFingerprint(db: Database, args: RecentAlertsArgs) {
  return dbCall(() => recentAlertsByFingerprintQuery(db, args));
}

/**
 * For the load test's dedupe score (evals load-report): every alert a k6 storm run sent, by the
 * problem it stood for and the incident it joined (null until it is clustered), with when the api
 * accepted it and when it was clustered. The run and the
 * problem travel in annotations (load_run, load_truth), which neither the fingerprint nor the
 * embedding reads.
 */
export function loadRunAssignments(db: Database, runId: string) {
  return dbCall(() =>
    db
      .select({
        truth: sql<string>`${alerts.rawPayload} -> 'annotations' ->> 'load_truth'`,
        incidentId: incidentAlerts.incidentId,
        receivedAt: alerts.receivedAt,
        attachedAt: incidentAlerts.attachedAt,
      })
      .from(alerts)
      .leftJoin(incidentAlerts, eq(incidentAlerts.alertId, alerts.id))
      .where(sql`${alerts.rawPayload} -> 'annotations' ->> 'load_run' = ${runId}`),
  );
}

/** A delivery's alert ids, so a retried ingest job can re-enqueue cluster jobs for all of them. */
export function alertIdsForIngest(db: Database, ingestId: string) {
  return dbCall(async () => {
    const rows = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(eq(alerts.ingestId, ingestId))
      .orderBy(asc(alerts.id));
    return rows.map((row) => row.id);
  });
}
