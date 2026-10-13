import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { eq } from 'drizzle-orm';
import { recordIngest } from './alerts.js';
import { clusterAlert } from './clustering.js';
import { migrateUp } from './migrator.js';
import { approvals, hypotheses, proposedActions, triageRuns } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/index.js';
import {
  beginTriageRun,
  completeTriageRun,
  loadIncidentForTriage,
  type TriageReportRecord,
} from './triage-runs.js';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
});
afterAll(() => database.drop());

const base = new Date('2026-10-01T12:00:00Z');
let axes = 0;
/** A unit vector along a new axis each call, so incidents never merge by similarity. */
const nextAxis = () => {
  const i = axes++;
  return Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0));
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** One incident with `counts` alerts per [service, name], each alert starting a second later. */
async function incidentWith(counts: readonly [string, string, number][]): Promise<string> {
  let offset = 0;
  const key = randomUUID();
  const alerts = counts.flatMap(([service, name, n]) =>
    Array.from({ length: n }, (_, i) => {
      offset += 1;
      const at = new Date(base.getTime() + offset * 1_000);
      return {
        source: 'alertmanager' as const,
        name,
        status: 'firing' as const,
        severity: 'critical' as const,
        service,
        // One fingerprint per incident: the `incident` label identifies it; pods are volatile.
        labels: { alertname: 'Storm', incident: key, pod: `${service}-${String(i)}` },
        startsAt: at,
        rawPayload: {},
      };
    }),
  );
  const recorded = await recordIngest(
    database.db,
    { idempotencyKey: key, bodyHash: hash(key), source: 'alertmanager', receivedAt: base, alerts },
    { writeFingerprintV2: true },
  );
  if (!recorded.ok || recorded.value.status !== 'recorded') throw new Error('not recorded');
  let incidentId = '';
  const embedding = nextAxis();
  for (const alertId of recorded.value.alertIds) {
    const clustered = await clusterAlert(database.db, {
      alertId,
      embedding,
      windowMs: 3_600_000,
      similarityThreshold: 0.85,
      fingerprintVersion: 'v2',
    });
    if (!clustered.ok) throw new Error('not clustered');
    incidentId = clustered.value.incidentId;
  }
  return incidentId;
}

async function startedRun(incidentId: string, jobKey: string): Promise<string> {
  const run = await beginTriageRun(database.db, { incidentId, jobKey, model: 'claude-opus-5-5' });
  if (!run.ok || run.value.status !== 'started') throw new Error('run not started');
  return run.value.runId;
}

const payload = { kind: 'rollback', service: 'payment', changeId: 'change:config-payment-1' };

function report(overrides: Partial<TriageReportRecord> = {}): TriageReportRecord {
  return {
    model: 'claude-opus-5-5',
    summary: 'payment Charge rejects tokens.',
    confidence: 0.64,
    stopReason: 'wall_clock',
    hypotheses: [
      {
        rank: 1,
        title: 'payment Charge rejects tokens',
        explanation: 'logs',
        confidence: 0.64,
        suspect: 'payment',
        faultClass: 'application_error',
        evidence: [],
      },
    ],
    unavailableEvidence: [],
    proposedActions: [
      {
        id: randomUUID(),
        kind: 'rollback',
        summary: 'Roll back payment change change:config-payment-1',
        rationale: 'Failures began with the change.',
        payload,
        payloadHash: hash(JSON.stringify(payload)),
      },
    ],
    usage: { inputTokens: 30_000, outputTokens: 2_000, toolCalls: 6, costUsdMicros: 160_000 },
    ...overrides,
  };
}

describe('loadIncidentForTriage', () => {
  it('reads the newest alerts, the earliest, and every alert counted by name and service', async () => {
    const incidentId = await incidentWith([
      ['payment', 'GrpcServerErrors', 3],
      ['checkout', 'HighErrorRate', 60],
      ['frontend', 'HighErrorRate', 2],
    ]);
    const loaded = await loadIncidentForTriage(database.db, incidentId);
    if (!loaded.ok || !loaded.value) throw new Error('not loaded');

    expect(loaded.value.alerts).toHaveLength(50);
    expect(loaded.value.earliestAlerts.map((a) => a.service)).toEqual([
      'payment',
      'payment',
      'payment',
    ]);
    expect(loaded.value.earliestAlerts[0]?.startsAt).toEqual(new Date(base.getTime() + 1_000));
    expect(loaded.value.alertGroups).toEqual([
      expect.objectContaining({ service: 'checkout', name: 'HighErrorRate', count: 60 }),
      expect.objectContaining({ service: 'payment', name: 'GrpcServerErrors', count: 3 }),
      expect.objectContaining({ service: 'frontend', name: 'HighErrorRate', count: 2 }),
    ]);
    expect(loaded.value.alertGroups[1]?.firstStartsAt).toEqual(new Date(base.getTime() + 1_000));
  });
});

describe('completeTriageRun', () => {
  it('stores why the run stopped, fault classes, and proposals waiting for a person', async () => {
    const incidentId = await incidentWith([['payment', 'GrpcServerErrors', 1]]);
    const runId = await startedRun(incidentId, `triage-${incidentId}`);
    const written = report();
    expect(await completeTriageRun(database.db, runId, written)).toEqual({
      ok: true,
      value: { written: true },
    });

    const [run] = await database.db.select().from(triageRuns).where(eq(triageRuns.id, runId));
    expect(run).toMatchObject({ status: 'succeeded', stopReason: 'wall_clock', toolCalls: 6 });
    const [hypothesis] = await database.db
      .select()
      .from(hypotheses)
      .where(eq(hypotheses.triageRunId, runId));
    expect(hypothesis?.faultClass).toBe('application_error');

    const actions = await database.db
      .select()
      .from(proposedActions)
      .where(eq(proposedActions.triageRunId, runId));
    expect(actions).toEqual([
      expect.objectContaining({
        id: written.proposedActions[0]?.id,
        incidentId,
        kind: 'rollback',
        status: 'pending_approval',
        payload,
        payloadHash: written.proposedActions[0]?.payloadHash,
      }),
    ]);
    // Proposed, not approved: nothing has decided on it, so nothing can execute it.
    expect(await database.db.select().from(approvals)).toEqual([]);
  });

  it("doesn't duplicate a proposal still pending from an earlier run of the same incident", async () => {
    const incidentId = await incidentWith([['payment', 'GrpcServerErrors', 1]]);
    const first = await startedRun(incidentId, `triage-${incidentId}`);
    expect(await completeTriageRun(database.db, first, report())).toMatchObject({ ok: true });
    // A redrive: a new job, a new run, proposing the same payload under a new id.
    const redriven = await startedRun(incidentId, `redrive-${incidentId}`);
    expect(await completeTriageRun(database.db, redriven, report())).toEqual({
      ok: true,
      value: { written: true },
    });
    const pending = await database.db
      .select()
      .from(proposedActions)
      .where(eq(proposedActions.incidentId, incidentId));
    expect(pending.map((action) => [action.triageRunId, action.status])).toEqual([
      [first, 'pending_approval'],
    ]);
  });

  it('writes none of the report when a proposal fails to insert, leaving the run to retry', async () => {
    const incidentId = await incidentWith([['payment', 'GrpcServerErrors', 1]]);
    const runId = await startedRun(incidentId, `triage-${incidentId}`);
    const broken = report({
      proposedActions: report().proposedActions.map((action) => ({
        ...action,
        payloadHash: 'not-a-sha256',
      })),
    });
    const result = await completeTriageRun(database.db, runId, broken);
    expect(result).toMatchObject({ ok: false, error: { kind: 'database_error', code: '23514' } });

    const [run] = await database.db.select().from(triageRuns).where(eq(triageRuns.id, runId));
    expect(run?.status).toBe('running');
    expect(
      await database.db.select().from(hypotheses).where(eq(hypotheses.triageRunId, runId)),
    ).toEqual([]);
  });
});
