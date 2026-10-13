import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { eq } from 'drizzle-orm';
import { findRecentAlertsByFingerprint, recordIngest, type Delivery } from './alerts.js';
import { backfillFingerprintV2, FINGERPRINT_V2_BACKFILL } from './backfill.js';
import { fingerprintV1, fingerprintV2 } from './fingerprint.js';
import { migrateDown, migrateUp } from './migrator.js';
import { alerts, backfillCheckpoints } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/index.js';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  // Stop after 0003: the column and its index exist, the contract has not happened yet.
  expect(await migrateUp(database.pool, { to: 3 })).toMatchObject({ ok: true });
});
afterAll(() => database.drop());

function delivery(
  key: string,
  count: number,
  firstPod: number,
  alertname = 'HighErrorRate',
): Delivery {
  return {
    idempotencyKey: key,
    bodyHash: createHash('sha256').update(key).digest('hex'),
    source: 'alertmanager',
    receivedAt: new Date(),
    alerts: Array.from({ length: count }, (_, i) => ({
      source: 'alertmanager',
      name: alertname,
      status: 'firing',
      severity: 'critical',
      service: 'checkout',
      labels: {
        alertname,
        service: 'checkout',
        namespace: 'otel-demo',
        severity: 'critical',
        pod: `checkout-7d9f8-${firstPod + i}`,
        instance: `10.244.${(firstPod + i) % 250}.7:5050`,
      },
      startsAt: new Date(),
      rawPayload: {},
    })),
  };
}

async function count(where: string): Promise<number> {
  const { rows } = await database.pool.query<{ count: string }>(
    `SELECT count(*) FROM alerts WHERE ${where}`,
  );
  return Number(rows[0]?.count);
}

async function catalog(sql: string): Promise<string[]> {
  const { rows } = await database.pool.query<{ name: string }>(sql);
  return rows.map((row) => row.name);
}

const fingerprintV2Nullable = () =>
  catalog(`SELECT is_nullable AS name FROM information_schema.columns
           WHERE table_name = 'alerts' AND column_name = 'fingerprint_v2'`);
const alertIndexes = () =>
  catalog(`SELECT indexname AS name FROM pg_indexes WHERE tablename = 'alerts' ORDER BY indexname`);

describe('fingerprint_v2 expand/contract', () => {
  it('before dual-write, new alerts have no fingerprint_v2', async () => {
    for (const [i, key] of ['before-1', 'before-2', 'before-3'].entries()) {
      const recorded = await recordIngest(database.db, delivery(key, 800, i * 800), {
        writeFingerprintV2: false,
      });
      expect(recorded).toMatchObject({ ok: true, value: { status: 'recorded' } });
    }
    expect(await count('fingerprint_v2 IS NULL')).toBe(2400);
  });

  it('with dual-write on, new alerts carry the same fingerprint_v2 the backfill computes', async () => {
    const during = delivery('during-1', 100, 5000);
    const recorded = await recordIngest(database.db, during, { writeFingerprintV2: true });
    if (!recorded.ok || recorded.value.status !== 'recorded') throw new Error('not recorded');

    const rows = await database.db
      .select({ labels: alerts.labels, fingerprintV2: alerts.fingerprintV2 })
      .from(alerts)
      .where(eq(alerts.ingestId, recorded.value.ingestId));
    expect(rows).toHaveLength(100);
    for (const row of rows) expect(row.fingerprintV2).toBe(fingerprintV2(row.labels));
    expect(await count('fingerprint_v2 IS NULL')).toBe(2400);
  });

  it('writes nothing for a repeated idempotency key', async () => {
    const again = await recordIngest(database.db, delivery('during-1', 100, 5000), {
      writeFingerprintV2: true,
    });
    expect(again).toMatchObject({
      ok: true,
      value: { status: 'duplicate', bodyHashMatches: true },
    });
    expect(await count('true')).toBe(2500);
  });

  it('refuses to contract while any row still lacks fingerprint_v2', async () => {
    const blocked = await migrateUp(database.pool, { to: 4 });
    expect(blocked).toMatchObject({
      ok: false,
      error: { kind: 'statement_failed', migration: '0004_fingerprint_v2_contract' },
    });
    expect(!blocked.ok && blocked.error.message).toContain('still has NULL rows');
    // It failed before changing anything.
    expect(await fingerprintV2Nullable()).toEqual(['YES']);
    expect(
      await catalog(
        `SELECT conname AS name FROM pg_constraint WHERE conname = 'alerts_fingerprint_v2_not_null'`,
      ),
    ).toEqual([]);
  });

  it('backfills in throttled batches of 1,000 and resumes from its checkpoint', async () => {
    const interrupted = await backfillFingerprintV2(database.db, {
      batchSize: 1000,
      maxBatches: 1,
      throttleMs: 0,
    });
    expect(interrupted).toEqual({
      ok: true,
      value: { batches: 1, rowsScanned: 1000, rowsUpdated: 1000, completed: false },
    });
    expect(await count('fingerprint_v2 IS NULL')).toBe(1400);
    const [checkpoint] = await database.db
      .select()
      .from(backfillCheckpoints)
      .where(eq(backfillCheckpoints.name, FINGERPRINT_V2_BACKFILL));
    expect(checkpoint).toMatchObject({ rowsDone: 1000, completedAt: null });

    const started = performance.now();
    const resumed = await backfillFingerprintV2(database.db, { batchSize: 1000, throttleMs: 50 });
    // 1,500 rows left, in two batches. The 100 dual-written rows are scanned but not rewritten.
    expect(resumed).toEqual({
      ok: true,
      value: { batches: 2, rowsScanned: 1500, rowsUpdated: 1400, completed: true },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(await count('fingerprint_v2 IS NULL')).toBe(0);

    // The backfill and the dual-writing ingest path agree on every row.
    const rows = await database.db
      .select({ labels: alerts.labels, fingerprintV2: alerts.fingerprintV2 })
      .from(alerts);
    expect(rows.filter((row) => row.fingerprintV2 !== fingerprintV2(row.labels))).toEqual([]);
  });

  it('treats a finished backfill as a no-op', async () => {
    expect(await backfillFingerprintV2(database.db, { throttleMs: 0 })).toEqual({
      ok: true,
      value: { batches: 0, rowsScanned: 0, rowsUpdated: 0, completed: true },
    });
  });

  it('contracts once every row has fingerprint_v2', async () => {
    expect(await migrateUp(database.pool, { to: 4 })).toEqual({
      ok: true,
      value: ['0004_fingerprint_v2_contract'],
    });
    expect(await fingerprintV2Nullable()).toEqual(['NO']);
    expect(await alertIndexes()).not.toContain('alerts_fingerprint_received_at_idx');
  });

  it('after the contract, ingest that skips fingerprint_v2 fails', async () => {
    const skipped = await recordIngest(database.db, delivery('after-1', 1, 9000), {
      writeFingerprintV2: false,
    });
    expect(skipped).toMatchObject({ ok: false, error: { kind: 'database_error', code: '23502' } });
  });

  it('dedupes a storm on v2 that v1 would split per pod', async () => {
    const storm = delivery('storm-1', 30, 20_000, 'GrpcServerErrors');
    expect(await recordIngest(database.db, storm, { writeFingerprintV2: true })).toMatchObject({
      ok: true,
    });
    const labels = storm.alerts[0]?.labels ?? {};
    const since = new Date(Date.now() - 60_000);
    const byV1 = await findRecentAlertsByFingerprint(database.db, {
      fingerprint: fingerprintV1(labels),
      since,
      version: 'v1',
    });
    const byV2 = await findRecentAlertsByFingerprint(database.db, {
      fingerprint: fingerprintV2(labels),
      since,
      version: 'v2',
    });
    expect(byV1.ok && byV1.value).toHaveLength(1);
    expect(byV2.ok && byV2.value).toHaveLength(30);
  });

  it('rolls the contract back: column nullable again, v1 index restored', async () => {
    expect(await migrateDown(database.pool, { to: 3 })).toEqual({
      ok: true,
      value: ['0004_fingerprint_v2_contract'],
    });
    expect(await fingerprintV2Nullable()).toEqual(['YES']);
    expect(await alertIndexes()).toContain('alerts_fingerprint_received_at_idx');
  });
});
