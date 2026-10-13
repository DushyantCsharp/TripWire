import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { eq } from 'drizzle-orm';
import { recentAlertsByFingerprintQuery } from './alerts.js';
import {
  findSimilarIncidents,
  listIncidents,
  listIncidentsQuery,
  similarIncidentsQuery,
  type IncidentCursor,
} from './incidents.js';
import { migrateUp } from './migrator.js';
import { incidents } from './schema.js';
import type { SeedSummary } from './seed.js';
import {
  createTestDatabase,
  seed,
  SEED_REFERENCE_DATE,
  type TestDatabase,
} from './testing/index.js';

let database: TestDatabase;
let summary: SeedSummary;

beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
  const seeded = await seed(database.db);
  if (!seeded.ok) throw new Error(seeded.error.message);
  summary = seeded.value;
  await database.pool.query('ANALYZE');
});
afterAll(() => database.drop());

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

const flatten = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(flatten)];

/**
 * The plan for a query exactly as the repository builds it. Seeded tables are small enough that a
 * sequential scan would win, so this asks whether the index *can* serve the query, which is what
 * matters at production size.
 */
async function plan(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<PlanNode[]> {
  const { sql, params } = query.toSQL();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `EXPLAIN (FORMAT JSON) ${sql}`,
      params,
    );
    const [explained] = rows[0]?.['QUERY PLAN'] ?? [];
    if (!explained) throw new Error('EXPLAIN returned no plan');
    return flatten(explained.Plan);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await database.pool.query<Record<string, T>>(sql, params);
  return Object.values(rows[0] ?? {})[0] as T;
}

describe('seed', () => {
  it('creates 50 incidents with 5,000 alerts plus a 3,000-alert storm, across 12 services', async () => {
    expect(summary).toMatchObject({ incidents: 51, alerts: 8000 });
    expect(Number(await scalar('SELECT count(DISTINCT service) FROM alerts'))).toBe(12);
    const storm = await database.pool.query<{ alerts: string; v1: string; v2: string }>(
      `SELECT count(*) AS alerts, count(DISTINCT a.fingerprint) AS v1, count(DISTINCT a.fingerprint_v2) AS v2
       FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id WHERE ia.incident_id = $1`,
      [summary.stormIncidentId],
    );
    expect(storm.rows[0]).toEqual({ alerts: '3000', v1: '500', v2: '1' });
  });

  it('is identical every run', async () => {
    const digest = () =>
      scalar<string>(
        `SELECT md5(string_agg(id::text || fingerprint_v2, ',' ORDER BY id)) FROM alerts`,
      );
    const before = await digest();
    expect(await seed(database.db)).toMatchObject({ ok: true });
    expect(await digest()).toBe(before);
  });
});

describe('indexes serve the queries they exist for', () => {
  it('keyset pagination walks incidents_last_seen_id_idx without sorting', async () => {
    const after: IncidentCursor = {
      lastSeen: SEED_REFERENCE_DATE,
      id: 'ffffffff-ffff-7fff-bfff-ffffffffffff',
    };
    const nodes = await plan(listIncidentsQuery(database.db, { limit: 20, after }));
    expect(nodes.map((node) => node['Index Name'])).toContain('incidents_last_seen_id_idx');
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
  });

  it('keyset pagination returns every incident once, most recently active first', async () => {
    const seen: { id: string; lastSeen: Date }[] = [];
    let after: IncidentCursor | undefined;
    do {
      const page = await listIncidents(database.db, { limit: 7, after });
      if (!page.ok) throw new Error(page.error.message);
      seen.push(...page.value.items);
      after = page.value.next ?? undefined;
    } while (after);
    expect(new Set(seen.map((incident) => incident.id)).size).toBe(51);
    const times = seen.map((incident) => incident.lastSeen.getTime());
    expect(times).toEqual(times.toSorted((a, b) => b - a));
  });

  it('dedupe-window lookups use alerts_fingerprint_v2_received_at_idx', async () => {
    const fingerprint = await scalar<string>(`SELECT fingerprint_v2 FROM alerts LIMIT 1`);
    const nodes = await plan(
      recentAlertsByFingerprintQuery(database.db, {
        fingerprint,
        since: new Date(SEED_REFERENCE_DATE.getTime() - 15 * 60_000),
        version: 'v2',
      }),
    );
    expect(nodes.map((node) => node['Index Name'])).toContain(
      'alerts_fingerprint_v2_received_at_idx',
    );
  });

  it('similarity search uses the HNSW index and ranks same-service incidents closer', async () => {
    const service = await scalar<string>(
      `SELECT service FROM incidents GROUP BY service ORDER BY count(*) DESC, service LIMIT 1`,
    );
    const [target] = await database.db
      .select({ id: incidents.id, embedding: incidents.embedding })
      .from(incidents)
      .where(eq(incidents.service, service))
      .limit(1);
    if (!target?.embedding) throw new Error(`no embedded incident for ${service}`);

    const nodes = await plan(similarIncidentsQuery(database.db, target.embedding, 5));
    expect(nodes.map((node) => node['Index Name'])).toContain('incidents_embedding_hnsw_idx');

    const ranked = await findSimilarIncidents(database.db, target.embedding, 51);
    if (!ranked.ok) throw new Error(ranked.error.message);
    const [self, ...others] = ranked.value;
    expect(self?.id).toBe(target.id);
    const nearestSame = others.find((incident) => incident.service === service);
    const nearestOther = others.find((incident) => incident.service !== service);
    expect(nearestSame?.distance).toBeLessThan(nearestOther?.distance ?? 0);
  });
});
