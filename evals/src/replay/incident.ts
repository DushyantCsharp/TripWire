import { createHash } from 'node:crypto';
import type { TriageInput } from '@tripwire/agent';
import {
  clusterAlert,
  type Database,
  getAlertForClustering,
  loadIncidentForTriage,
  recordIngest,
} from '@tripwire/db';
import { migrateUp } from '@tripwire/db/migrator';
import { createTestDatabase, type TestDatabase } from '@tripwire/db/testing';
import { alertText, type Embedder, normalizeAlerts, syncRunbooks } from '@tripwire/pipeline';
import type { CaseData } from '../cases.js';

// A case's incident, formed the way production forms it: each Alertmanager delivery normalised and
// recorded, each alert embedded and clustered (fingerprint, then similarity, within the window),
// then loaded for triage. Each case gets a fresh database, so cases never share incidents.

/** The worker's defaults (apps/worker config): the same dedupe as production. */
export const CLUSTER_WINDOW_MS = 10 * 60_000;
export const CLUSTER_SIMILARITY_THRESHOLD = 0.85;

export type ReplayDatabase = TestDatabase;

/** A migrated database with the runbooks indexed, on the Postgres server at `serverUrl`. */
export async function replayDatabase(
  serverUrl: string,
  runbooksDir: string,
  embedder: Embedder,
): Promise<ReplayDatabase> {
  const database = await createTestDatabase(serverUrl);
  const migrated = await migrateUp(database.pool);
  if (!migrated.ok) {
    await database.drop();
    throw new Error(`could not migrate the eval database: ${migrated.error.message}`);
  }
  const indexed = await syncRunbooks(database.db, runbooksDir, embedder);
  if (!indexed.ok) {
    await database.drop();
    throw new Error(`could not index the runbooks: ${indexed.error.message}`);
  }
  return database;
}

export interface IngestedCase {
  readonly input: TriageInput;
  /** Incidents the case's alerts formed. A storm ideally forms one. */
  readonly incidents: number;
}

/** Ingests and clusters a case's alerts, then loads the largest incident for triage. */
export async function ingestCase(
  db: Database,
  data: CaseData,
  embedder: Embedder,
): Promise<IngestedCase> {
  const alertCounts = new Map<string, number>();
  for (const [index, delivery] of data.deliveries.entries()) {
    const alerts = normalizeAlerts('alertmanager', delivery.body);
    if (!alerts.ok)
      throw new Error(`delivery ${String(index)} of ${data.meta.id}: ${alerts.error.message}`);
    const body = JSON.stringify(delivery.body);
    const recorded = await recordIngest(
      db,
      {
        idempotencyKey: `${data.meta.id}-${String(index)}`,
        bodyHash: createHash('sha256').update(body).digest('hex'),
        source: 'alertmanager',
        receivedAt: delivery.receivedAt,
        alerts: alerts.value,
      },
      { writeFingerprintV2: true },
    );
    if (!recorded.ok) throw new Error(recorded.error.message);
    if (recorded.value.status !== 'recorded') continue;
    for (const alertId of recorded.value.alertIds) {
      const alert = await getAlertForClustering(db, alertId);
      if (!alert.ok || !alert.value) throw new Error(`alert ${alertId} was not recorded`);
      const embedding = await embedder.embed(alertText(alert.value));
      if (!embedding.ok) throw new Error(embedding.error.message);
      const clustered = await clusterAlert(db, {
        alertId,
        embedding: embedding.value,
        windowMs: CLUSTER_WINDOW_MS,
        similarityThreshold: CLUSTER_SIMILARITY_THRESHOLD,
        fingerprintVersion: 'v2',
      });
      if (!clustered.ok) throw new Error(clustered.error.message);
      const id = clustered.value.incidentId;
      alertCounts.set(id, (alertCounts.get(id) ?? 0) + 1);
    }
  }
  const [largest] = [...alertCounts.entries()].sort(
    ([a, x], [b, y]) => y - x || a.localeCompare(b),
  );
  if (!largest) throw new Error(`${data.meta.id} has no alerts to triage`);
  const loaded = await loadIncidentForTriage(db, largest[0]);
  if (!loaded.ok || !loaded.value) throw new Error(`incident ${largest[0]} did not load`);
  const { id, ...incident } = loaded.value;
  return { input: { ...incident, incidentId: id }, incidents: alertCounts.size };
}
