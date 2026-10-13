import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { asc } from 'drizzle-orm';
import { migrateUp } from './migrator.js';
import {
  type RunbookChunk,
  runbookIndexSize,
  searchRunbooks,
  syncRunbookChunks,
} from './runbooks.js';
import { runbookChunks } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/index.js';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
});
afterAll(() => database.drop());

/** A unit vector mostly along `i`, a little along `j`: similarity to axis i is high, to j low. */
function vector(i: number, j = (i + 1) % 1024, lean = 0): number[] {
  const v = Array.from({ length: 1024 }, () => 0);
  v[i] = Math.sqrt(1 - lean * lean);
  v[j] = lean;
  return v;
}

function chunk(
  path: string,
  anchor: string,
  service: string | null,
  embedding: number[],
  content = anchor,
): RunbookChunk {
  return {
    path,
    anchor,
    title: `${path} ${anchor}`,
    service,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
    embedder: 'feature-hashing-v1',
    embedding,
  };
}

const rows = () =>
  database.db
    .select({
      path: runbookChunks.path,
      anchor: runbookChunks.anchor,
      content: runbookChunks.content,
      updatedAt: runbookChunks.updatedAt,
    })
    .from(runbookChunks)
    .orderBy(asc(runbookChunks.path), asc(runbookChunks.anchor));

describe('runbook chunks', () => {
  it('syncs to exactly the sections given: new written, unchanged kept, missing deleted', async () => {
    const first = [
      chunk('payment.md', 'charge-failures', 'payment', vector(1)),
      chunk('payment.md', 'latency', 'payment', vector(2)),
      chunk('cart.md', 'valkey-down', 'cart', vector(3)),
    ];
    expect(await syncRunbookChunks(database.db, first)).toEqual({
      ok: true,
      value: { written: 3, deleted: 0 },
    });
    const before = await rows();

    const second = [
      chunk('payment.md', 'charge-failures', 'payment', vector(1)),
      chunk('payment.md', 'latency', 'payment', vector(2), 'latency, rewritten'),
      chunk('general.md', 'triage', null, vector(4)),
    ];
    expect(await syncRunbookChunks(database.db, second)).toEqual({
      ok: true,
      value: { written: 2, deleted: 1 },
    });
    const after = await rows();
    expect(after.map((r) => `${r.path}#${r.anchor}:${r.content}`)).toEqual([
      'general.md#triage:triage',
      'payment.md#charge-failures:charge-failures',
      'payment.md#latency:latency, rewritten',
    ]);
    // The unchanged section wasn't rewritten.
    expect(after.find((r) => r.anchor === 'charge-failures')?.updatedAt).toEqual(
      before.find((r) => r.anchor === 'charge-failures')?.updatedAt,
    );
    expect(await runbookIndexSize(database.db)).toEqual({
      ok: true,
      value: [{ embedder: 'feature-hashing-v1', count: 3 }],
    });
  });

  it('finds the nearest sections, and filters by service keeping the general ones', async () => {
    // New content, so every section is re-embedded (an unchanged section keeps its embedding).
    await syncRunbookChunks(database.db, [
      chunk('payment.md', 'charge-failures', 'payment', vector(10, 11, 0.1), 'charge v2'),
      chunk('payment.md', 'latency', 'payment', vector(11, 10, 0.1), 'latency v2'),
      chunk('cart.md', 'valkey-down', 'cart', vector(10, 12, 0.3), 'valkey v2'),
      chunk('general.md', 'triage', null, vector(10, 13, 0.5), 'triage v2'),
    ]);

    const nearest = await searchRunbooks(database.db, vector(10), { k: 3 });
    expect(nearest.ok && nearest.value.map((m) => m.anchor)).toEqual([
      'charge-failures',
      'valkey-down',
      'triage',
    ]);
    expect(nearest.ok && nearest.value[0]?.score).toBeCloseTo(Math.sqrt(1 - 0.01), 5);

    const payment = await searchRunbooks(database.db, vector(10), { service: 'payment', k: 3 });
    expect(payment.ok && payment.value.map((m) => `${m.path}#${m.anchor}`)).toEqual([
      'payment.md#charge-failures',
      'general.md#triage',
      'payment.md#latency',
    ]);
  });
});
