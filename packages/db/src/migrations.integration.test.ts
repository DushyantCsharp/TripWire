import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { eq } from 'drizzle-orm';
import { dbCall } from './errors.js';
import { MIGRATIONS_DIR, migrateDown, migrateUp, migrationStatus } from './migrator.js';
import { approvals, incidents, proposedActions, triageRuns } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/index.js';

const TAGS = [
  '0000_extensions',
  '0001_initial',
  '0002_fingerprint_v2_expand',
  '0003_fingerprint_v2_index',
  '0004_fingerprint_v2_contract',
  '0005_triage_job_key',
  '0006_runbooks_partial_reports',
];

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
});
afterAll(() => database.drop());

async function column<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await database.pool.query<Record<string, T>>(sql, params);
  return rows.map((row) => Object.values(row)[0] as T);
}

const publicTables = () =>
  column<string>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
const alertIndexes = () =>
  column<string>(`SELECT indexname FROM pg_indexes WHERE tablename = 'alerts' ORDER BY indexname`);

describe('migrations', () => {
  it('apply to a fresh database, roll back completely, and apply again', async () => {
    expect(await migrateUp(database.pool)).toEqual({ ok: true, value: TAGS });
    expect(await publicTables()).toEqual([
      'alerts',
      'approvals',
      'backfill_checkpoints',
      'evidence',
      'hypotheses',
      'incident_alerts',
      'incidents',
      'ingests',
      'proposed_actions',
      'runbook_chunks',
      'triage_runs',
      'tripwire_migrations',
    ]);

    expect(await migrateDown(database.pool, { to: -1 })).toEqual({
      ok: true,
      value: TAGS.toReversed(),
    });
    expect(await publicTables()).toEqual(['tripwire_migrations']);
    const leftovers = await column<string>(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typtype = 'e'
       UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
       UNION ALL SELECT extname FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(leftovers).toEqual([]);

    expect(await migrateUp(database.pool)).toEqual({ ok: true, value: TAGS });
  });

  it('do nothing when already up to date', async () => {
    expect(await migrateUp(database.pool)).toEqual({ ok: true, value: [] });
    const status = await migrationStatus(database.pool);
    expect(status.ok && status.value.every((migration) => migration.appliedAt !== null)).toBe(true);
  });

  it('end in the contracted schema, with every index valid', async () => {
    expect(
      await column<string>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_name = 'alerts' AND column_name = 'fingerprint_v2'`,
      ),
    ).toEqual(['NO']);
    const indexes = await alertIndexes();
    expect(indexes).toContain('alerts_fingerprint_v2_received_at_idx');
    expect(indexes).not.toContain('alerts_fingerprint_received_at_idx');
    expect(
      await column<string>(`SELECT indexrelid::regclass::text FROM pg_index WHERE NOT indisvalid`),
    ).toEqual([]);
  });

  it('refuse to run once an applied migration has been edited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-migrations-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      appendFileSync(join(dir, '0001_initial.sql'), '\n-- edited after it was applied\n');
      expect(await migrateUp(database.pool, { dir })).toMatchObject({
        ok: false,
        error: { kind: 'history_mismatch' },
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('the approval invariant, held by the database itself', () => {
  const payloadHash = 'a'.repeat(64);
  let actionId = '';

  beforeAll(async () => {
    const now = new Date();
    const [incident] = await database.db
      .insert(incidents)
      .values({ title: 'payment errors', severity: 'critical', firstSeen: now, lastSeen: now })
      .returning({ id: incidents.id });
    if (!incident) throw new Error('incident not inserted');
    const [run] = await database.db
      .insert(triageRuns)
      .values({ incidentId: incident.id, model: 'test' })
      .returning({ id: triageRuns.id });
    if (!run) throw new Error('triage run not inserted');
    const [action] = await database.db
      .insert(proposedActions)
      .values({
        incidentId: incident.id,
        triageRunId: run.id,
        kind: 'rollback',
        summary: 'Roll back payment from 2.4.1 to 2.4.0',
        rationale: 'Errors started with the 2.4.1 deploy.',
        payload: { service: 'payment', from: '2.4.1', to: '2.4.0' },
        payloadHash,
      })
      .returning({ id: proposedActions.id });
    if (!action) throw new Error('action not inserted');
    actionId = action.id;
  });

  const approve = (overrides: Partial<typeof approvals.$inferInsert> = {}) =>
    dbCall(() =>
      database.db
        .insert(approvals)
        .values({
          actionId,
          actor: 'oncall@example.com',
          decision: 'approved',
          reason: 'Error rate tracks the 2.4.1 rollout.',
          payloadHash,
          expiresAt: new Date(Date.now() + 15 * 60_000),
          ...overrides,
        })
        .returning({ id: approvals.id }),
    );

  it('rejects an approval for a payload hash the action does not have', async () => {
    expect(await approve({ payloadHash: 'b'.repeat(64) })).toMatchObject({
      ok: false,
      error: { code: '23503' },
    });
  });

  it('rejects an approval with a blank reason or no expiry', async () => {
    expect(await approve({ reason: '   ' })).toMatchObject({ ok: false, error: { code: '23514' } });
    expect(await approve({ expiresAt: null })).toMatchObject({
      ok: false,
      error: { code: '23514' },
    });
  });

  it('never lets an action payload change after it is proposed', async () => {
    const changed = await dbCall(() =>
      database.db
        .update(proposedActions)
        .set({ payload: { service: 'payment', from: '2.4.1', to: '1.0.0' } })
        .where(eq(proposedActions.id, actionId)),
    );
    expect(changed).toMatchObject({ ok: false, error: { code: '23000' } });
  });

  it('lets an approval be consumed once, and never edited or deleted', async () => {
    const created = await approve();
    if (!created.ok) throw new Error(created.error.message);
    const approvalId = created.value[0]?.id ?? '';
    const where = eq(approvals.id, approvalId);
    const consume = () =>
      dbCall(() => database.db.update(approvals).set({ consumedAt: new Date() }).where(where));

    expect((await consume()).ok).toBe(true);
    expect(await consume()).toMatchObject({ ok: false, error: { code: '23000' } });
    expect(
      await dbCall(() => database.db.update(approvals).set({ reason: 'rewritten' }).where(where)),
    ).toMatchObject({ ok: false, error: { code: '23000' } });
    expect(await dbCall(() => database.db.delete(approvals).where(where))).toMatchObject({
      ok: false,
      error: { code: '23000' },
    });
  });

  it('allows a single decision per action', async () => {
    expect(await approve()).toMatchObject({ ok: false, error: { code: '23505' } });
  });
});
