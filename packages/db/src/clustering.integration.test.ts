import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { eq, sql } from 'drizzle-orm';
import { recordIngest } from './alerts.js';
import { clusterAlert, type ClusterAlertArgs } from './clustering.js';
import { migrateUp } from './migrator.js';
import { hypotheses, incidentAlerts, incidents, triageRuns } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import { beginTriageRun, completeTriageRun, failTriageRun } from './triage-runs.js';

const WINDOW_MS = 10 * 60_000;
const base = new Date('2026-10-01T12:00:00Z');

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
});
afterAll(() => database.drop());

/** A unit vector along axis `i`: identical axes have similarity 1, different ones 0. */
function axis(i: number): number[] {
  return Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
}

async function deliver(alertname: string, pods: number, receivedAt: Date): Promise<string[]> {
  const key = `${alertname}-${randomUUID()}`;
  const recorded = await recordIngest(
    database.db,
    {
      idempotencyKey: key,
      bodyHash: createHash('sha256').update(key).digest('hex'),
      source: 'alertmanager',
      receivedAt,
      alerts: Array.from({ length: pods }, (_, i) => ({
        source: 'alertmanager',
        name: alertname,
        status: 'firing',
        severity: i === 0 ? 'warning' : 'critical',
        service: 'checkout',
        labels: { alertname, service: 'checkout', pod: `checkout-${alertname}-${i}` },
        startsAt: receivedAt,
        rawPayload: {},
      })),
    },
    { writeFingerprintV2: true },
  );
  if (!recorded.ok || recorded.value.status !== 'recorded')
    throw new Error('delivery not recorded');
  return [...recorded.value.alertIds];
}

const cluster = (alertId: string, embedding: number[], overrides: Partial<ClusterAlertArgs> = {}) =>
  clusterAlert(database.db, {
    alertId,
    embedding,
    windowMs: WINDOW_MS,
    similarityThreshold: 0.85,
    fingerprintVersion: 'v2',
    ...overrides,
  });

async function incidentRow(id: string) {
  const [row] = await database.db.select().from(incidents).where(eq(incidents.id, id));
  return row;
}

describe('clusterAlert', () => {
  let stormIncident = '';

  it('collapses a storm into one incident even when every alert is clustered at once', async () => {
    const ids = await deliver('HighErrorRate', 40, base);
    const outcomes = await Promise.all(ids.map((id) => cluster(id, axis(1))));
    const incidentIds = new Set(outcomes.map((o) => (o.ok ? o.value.incidentId : 'failed')));
    expect([...incidentIds]).toHaveLength(1);
    stormIncident = [...incidentIds][0] ?? '';
    expect(outcomes.filter((o) => o.ok && o.value.match === 'new_incident')).toHaveLength(1);

    const row = await incidentRow(stormIncident);
    expect(row).toMatchObject({ alertCount: 40, severity: 'critical' });
  });

  it('changes nothing when a clustered alert is clustered again', async () => {
    const [id] = await deliver('HighErrorRate', 1, new Date(base.getTime() + 60_000));
    const first = await cluster(id ?? '', axis(1));
    const again = await cluster(id ?? '', axis(1));
    expect(first).toMatchObject({
      ok: true,
      value: { match: 'fingerprint', alreadyClustered: false },
    });
    expect(again).toMatchObject({
      ok: true,
      value: { incidentId: stormIncident, alreadyClustered: true },
    });
    expect((await incidentRow(stormIncident))?.alertCount).toBe(41);
    const links = await database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(incidentAlerts)
      .where(eq(incidentAlerts.incidentId, stormIncident));
    expect(links[0]?.count).toBe(41);
  });

  it('attaches a different alert to an open incident by embedding similarity', async () => {
    const [id] = await deliver('HighLatencyP99', 1, new Date(base.getTime() + 2 * 60_000));
    expect(await cluster(id ?? '', axis(1))).toMatchObject({
      ok: true,
      value: { incidentId: stormIncident, match: 'embedding', similarity: 1 },
    });
  });

  it('opens a new incident for a dissimilar alert', async () => {
    const [id] = await deliver('KafkaConsumerLag', 1, new Date(base.getTime() + 3 * 60_000));
    const outcome = await cluster(id ?? '', axis(2));
    expect(outcome).toMatchObject({ ok: true, value: { match: 'new_incident' } });
    expect(outcome.ok && outcome.value.incidentId).not.toBe(stormIncident);
  });

  it('opens a new incident once the same fingerprint falls outside the window', async () => {
    const [id] = await deliver('HighErrorRate', 1, new Date(base.getTime() + 25 * 60_000));
    const outcome = await cluster(id ?? '', axis(3));
    expect(outcome).toMatchObject({ ok: true, value: { match: 'new_incident' } });
  });

  it('never attaches to a resolved incident', async () => {
    await database.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, stormIncident));
    const [id] = await deliver('HighErrorRate', 1, new Date(base.getTime() + 4 * 60_000));
    const outcome = await cluster(id ?? '', axis(1));
    expect(outcome.ok && outcome.value.incidentId).not.toBe(stormIncident);
  });

  it('reports an alert that does not exist', async () => {
    expect(await cluster(randomUUID(), axis(1))).toMatchObject({
      ok: false,
      error: { kind: 'alert_not_found' },
    });
  });
});

describe('triage runs', () => {
  const report = {
    model: 'baseline-v1',
    summary: 'Most likely checkout',
    confidence: 0.3,
    hypotheses: [
      {
        rank: 1,
        title: 'checkout: HighErrorRate',
        explanation: 'x',
        confidence: 0.3,
        suspect: 'checkout',
        faultClass: null,
        evidence: [],
      },
      {
        rank: 2,
        title: 'payment: GrpcServerErrors',
        explanation: 'y',
        confidence: 0.1,
        suspect: 'payment',
        faultClass: null,
        evidence: [],
      },
    ],
    stopReason: 'report_submitted' as const,
    unavailableEvidence: [],
    proposedActions: [],
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, costUsdMicros: 0 },
  };

  it('write at most one report per job, across retries and redeliveries', async () => {
    const [id] = await deliver('GrpcServerErrors', 1, new Date(base.getTime() + 30 * 60_000));
    const clustered = await cluster(id ?? '', axis(4));
    if (!clustered.ok) throw new Error('not clustered');
    const run = {
      incidentId: clustered.value.incidentId,
      jobKey: `triage-${clustered.value.incidentId}`,
      model: 'baseline-v1',
    };

    const first = await beginTriageRun(database.db, run);
    const retry = await beginTriageRun(database.db, run);
    expect(first).toMatchObject({ ok: true, value: { status: 'started', attempt: 1 } });
    expect(retry).toMatchObject({ ok: true, value: { status: 'started', attempt: 2 } });
    const runId = retry.ok && retry.value.status === 'started' ? retry.value.runId : '';
    expect((await incidentRow(run.incidentId))?.status).toBe('triaging');

    expect(await completeTriageRun(database.db, runId, report)).toEqual({
      ok: true,
      value: { written: true },
    });
    // A racing attempt of the same job finishes second: it writes nothing.
    expect(await completeTriageRun(database.db, runId, report)).toEqual({
      ok: true,
      value: { written: false },
    });
    // A redelivered job sees the success and doesn't run.
    expect(await beginTriageRun(database.db, run)).toMatchObject({
      ok: true,
      value: { status: 'already_succeeded', runId },
    });
    // A late dead-letter for the same job can't undo the success.
    expect(
      await failTriageRun(database.db, {
        jobKey: run.jobKey,
        reason: 'internal_error',
        error: 'late',
      }),
    ).toEqual({
      ok: true,
      value: { outcome: 'already_succeeded' },
    });

    const rows = await database.db
      .select()
      .from(hypotheses)
      .where(eq(hypotheses.triageRunId, runId));
    expect(rows).toHaveLength(2);
    expect((await incidentRow(run.incidentId))?.status).toBe('triaged');
  });

  it('mark a dead-lettered run failed and reopen its incident', async () => {
    const [id] = await deliver('PodCrashLooping', 1, new Date(base.getTime() + 40 * 60_000));
    const clustered = await cluster(id ?? '', axis(5));
    if (!clustered.ok) throw new Error('not clustered');
    const jobKey = `triage-${clustered.value.incidentId}`;
    await beginTriageRun(database.db, {
      incidentId: clustered.value.incidentId,
      jobKey,
      model: 'baseline-v1',
    });

    expect(
      await failTriageRun(database.db, {
        jobKey,
        reason: 'model_unavailable',
        error: '503 after 5 attempts',
      }),
    ).toEqual({ ok: true, value: { outcome: 'marked' } });
    // A job that failed before it ever started a run.
    expect(
      await failTriageRun(database.db, {
        jobKey: 'triage-never-ran',
        reason: 'internal_error',
        error: 'x',
      }),
    ).toEqual({ ok: true, value: { outcome: 'no_run' } });
    const [run] = await database.db.select().from(triageRuns).where(eq(triageRuns.jobKey, jobKey));
    expect(run).toMatchObject({ status: 'failed', failureReason: 'model_unavailable' });
    expect((await incidentRow(clustered.value.incidentId))?.status).toBe('open');
  });
});
