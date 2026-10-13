import { err, ok, type Result } from '@tripwire/result';
import { and, cosineDistance, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import type { FingerprintVersion } from './alerts.js';
import type { Database } from './client.js';
import { decideCluster, dedupeWindowStart } from './dedupe.js';
import { dbCall, type DatabaseError } from './errors.js';
import { alerts, incidentAlerts, incidents } from './schema.js';

/** What the cluster job needs to embed an alert before clustering it. */
export function getAlertForClustering(db: Database, alertId: string) {
  return dbCall(async () => {
    const [alert] = await db
      .select({
        id: alerts.id,
        name: alerts.name,
        service: alerts.service,
        severity: alerts.severity,
        summary: alerts.summary,
        labels: alerts.labels,
      })
      .from(alerts)
      .where(eq(alerts.id, alertId));
    return alert;
  });
}

export interface ClusterAlertArgs {
  readonly alertId: string;
  /** The alert's embedding; a new incident starts with it. */
  readonly embedding: readonly number[];
  /** How long an open incident keeps attracting alerts: same-fingerprint alerts and activity. */
  readonly windowMs: number;
  /** Cosine similarity an alert must exceed to join an open incident with another fingerprint. */
  readonly similarityThreshold: number;
  /** The fingerprint_v2 read flag (FINGERPRINT_V2_READ): which fingerprint dedupes. */
  readonly fingerprintVersion: FingerprintVersion;
}

export interface ClusterOutcome {
  readonly incidentId: string;
  /** 'new_incident' means this alert opened the incident, so it is the one that queues triage. */
  readonly match: 'fingerprint' | 'embedding' | 'new_incident';
  readonly similarity: number | null;
  /** An earlier attempt already clustered this alert; this call changed nothing. */
  readonly alreadyClustered: boolean;
}

export type ClusterError =
  DatabaseError | { readonly kind: 'alert_not_found'; readonly message: string };

/**
 * Attaches an alert to an incident, by the rule in decideCluster (dedupe.ts):
 *  1. the open incident holding a same-fingerprint alert received within the window,
 *  2. the most similar open incident active within the window, if similar enough,
 *  3. a new incident.
 * Idempotent: a retry finds the alert already attached and changes nothing, so counters never
 * double. Alerts sharing a fingerprint are clustered one at a time (a transaction-scoped advisory
 * lock), so a storm opens exactly one incident.
 */
export async function clusterAlert(
  db: Database,
  args: ClusterAlertArgs,
): Promise<Result<ClusterOutcome, ClusterError>> {
  const result = await dbCall(() =>
    db.transaction(async (tx): Promise<ClusterOutcome | undefined> => {
      const [alert] = await tx
        .select({
          name: alerts.name,
          service: alerts.service,
          severity: alerts.severity,
          receivedAt: alerts.receivedAt,
          fingerprint: alerts.fingerprint,
          fingerprintV2: alerts.fingerprintV2,
        })
        .from(alerts)
        .where(eq(alerts.id, args.alertId));
      if (!alert) return undefined;

      const v2 = args.fingerprintVersion === 'v2';
      const fingerprint = v2 ? alert.fingerprintV2 : alert.fingerprint;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`);

      const [existing] = await tx
        .select({
          incidentId: incidentAlerts.incidentId,
          match: incidentAlerts.match,
          similarity: incidentAlerts.similarity,
        })
        .from(incidentAlerts)
        .where(eq(incidentAlerts.alertId, args.alertId));
      if (existing) return { ...existing, alreadyClustered: true };

      const since = dedupeWindowStart(alert.receivedAt, args.windowMs);
      const [sameFingerprint] = await tx
        .select({
          incidentId: incidentAlerts.incidentId,
          incidentStatus: incidents.status,
          receivedAt: alerts.receivedAt,
        })
        .from(alerts)
        .innerJoin(incidentAlerts, eq(incidentAlerts.alertId, alerts.id))
        .innerJoin(incidents, eq(incidents.id, incidentAlerts.incidentId))
        .where(
          and(
            eq(v2 ? alerts.fingerprintV2 : alerts.fingerprint, fingerprint),
            gte(alerts.receivedAt, since),
            ne(incidents.status, 'resolved'),
          ),
        )
        .orderBy(desc(alerts.receivedAt))
        .limit(1);

      let decision = decideCluster(alert.receivedAt, { sameFingerprint }, args);
      if (decision.match !== 'fingerprint') {
        const distance = cosineDistance(incidents.embedding, [...args.embedding]);
        const [nearest] = await tx
          .select({
            incidentId: incidents.id,
            incidentStatus: incidents.status,
            lastSeen: incidents.lastSeen,
            distance: distance.mapWith(Number),
          })
          .from(incidents)
          .where(
            and(
              ne(incidents.status, 'resolved'),
              gte(incidents.lastSeen, since),
              isNotNull(incidents.embedding),
            ),
          )
          .orderBy(distance)
          .limit(1);
        decision = decideCluster(
          alert.receivedAt,
          { sameFingerprint, nearest: nearest && { ...nearest, similarity: 1 - nearest.distance } },
          args,
        );
      }

      let target: Omit<ClusterOutcome, 'alreadyClustered'>;
      switch (decision.match) {
        case 'fingerprint':
          target = { incidentId: decision.incidentId, match: 'fingerprint', similarity: null };
          break;
        case 'embedding':
          target = {
            incidentId: decision.incidentId,
            match: 'embedding',
            similarity: Math.round(decision.similarity * 1000) / 1000,
          };
          break;
        case 'new_incident': {
          const [created] = await tx
            .insert(incidents)
            .values({
              title: `${alert.name} on ${alert.service ?? 'an unknown service'}`,
              severity: alert.severity,
              service: alert.service,
              firstSeen: alert.receivedAt,
              lastSeen: alert.receivedAt,
              alertCount: 0,
              embedding: [...args.embedding],
            })
            .returning({ id: incidents.id });
          if (!created) throw new Error('incident insert returned no row');
          target = { incidentId: created.id, match: 'new_incident', similarity: null };
        }
      }

      await tx.insert(incidentAlerts).values({
        incidentId: target.incidentId,
        alertId: args.alertId,
        match: target.match,
        similarity: target.similarity,
      });
      await tx
        .update(incidents)
        .set({
          alertCount: sql`${incidents.alertCount} + 1`,
          firstSeen: sql`least(${incidents.firstSeen}, ${alert.receivedAt})`,
          lastSeen: sql`greatest(${incidents.lastSeen}, ${alert.receivedAt})`,
          // Enum order is critical < warning < info, so least() keeps the most severe.
          severity: sql`least(${incidents.severity}, ${alert.severity}::severity)`,
        })
        .where(eq(incidents.id, target.incidentId));
      return { ...target, alreadyClustered: false };
    }),
  );
  if (!result.ok) return result;
  if (!result.value) {
    return err({ kind: 'alert_not_found', message: `alert ${args.alertId} does not exist` });
  }
  return ok(result.value);
}
