import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { sql } from 'drizzle-orm';
import { listIncidents, type IncidentCursor, type IncidentSummary } from './incidents.js';
import { migrateUp } from './migrator.js';
import { incidents } from './schema.js';
import { createTestDatabase, type TestDatabase } from './testing/index.js';

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
});
afterAll(() => database.drop());

const start = new Date('2026-10-01T12:00:00Z');
const minutesBefore = (minutes: number) => new Date(start.getTime() - minutes * 60_000);

async function insert(lastSeen: readonly Date[], label: string): Promise<string[]> {
  const rows = await database.db
    .insert(incidents)
    .values(
      lastSeen.map((at, i) => ({
        title: `${label}-${String(i)}`,
        severity: 'warning' as const,
        service: 'checkout',
        firstSeen: at,
        lastSeen: at,
        alertCount: 1,
      })),
    )
    .returning({ id: incidents.id });
  return rows.map((row) => row.id);
}

/** Most recently active first; ties broken by id, newest first. */
function keysetOrder(rows: readonly { id: string; lastSeen: Date }[]): string[] {
  return [...rows]
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime() || (a.id < b.id ? 1 : -1))
    .map((row) => row.id);
}

describe('incident cursor pagination', () => {
  it('returns stable, non-overlapping pages while new incidents are inserted between fetches', async () => {
    await database.db.delete(incidents);
    // 45 incidents in groups of three sharing a last_seen, so the id tiebreak is exercised too.
    const times = Array.from({ length: 45 }, (_, i) => minutesBefore(Math.floor(i / 3)));
    const existingIds = await insert(times, 'existing');
    const existing = existingIds.map((id, i) => ({ id, lastSeen: times[i] ?? start }));

    const pages: IncidentSummary[][] = [];
    const arrivedNewer: string[] = [];
    let after: IncidentCursor | undefined;
    for (;;) {
      const page = await listIncidents(database.db, { limit: 10, after });
      if (!page.ok) throw new Error(page.error.message);
      pages.push([...page.value.items]);
      if (!page.value.next) break;
      after = page.value.next;
      // Between fetches: brand-new incidents, and one that ties with the cursor's last_seen. Both
      // sort ahead of the cursor (UUIDv7 ids grow over time), so a walk already past them can't
      // see them, and nothing behind the cursor shifts.
      arrivedNewer.push(
        ...(await insert([new Date(), new Date(Date.now() + 1)], 'arrived')),
        ...(await insert([after.lastSeen], 'arrived-tie')),
      );
    }

    const walked = pages.flat().map((row) => row.id);
    expect(pages.map((page) => page.length)).toEqual([10, 10, 10, 10, 5]);
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked).toEqual(keysetOrder(existing));
    expect(walked.filter((id) => arrivedNewer.includes(id))).toEqual([]);
    expect(arrivedNewer).toHaveLength(12);
  });

  it('includes, once and in order, an incident that arrives behind the cursor', async () => {
    await database.db.delete(incidents);
    const times = Array.from({ length: 20 }, (_, i) => minutesBefore(i * 2));
    const ids = await insert(times, 'existing');
    const first = await listIncidents(database.db, { limit: 5 });
    if (!first.ok || !first.value.next) throw new Error('expected a second page');
    // Late, but dated inside the part of the list not yet read (e.g. a backfilled incident).
    const [late] = await insert([minutesBefore(21)], 'late');

    const rest: string[] = [];
    let after: IncidentCursor | null = first.value.next;
    while (after) {
      const page = await listIncidents(database.db, { limit: 5, after });
      if (!page.ok) throw new Error(page.error.message);
      rest.push(...page.value.items.map((row) => row.id));
      after = page.value.next;
    }

    const walked = [...first.value.items.map((row) => row.id), ...rest];
    const all = [
      ...ids.map((id, i) => ({ id, lastSeen: times[i] ?? start })),
      { id: late ?? '', lastSeen: minutesBefore(21) },
    ];
    expect(walked).toEqual(keysetOrder(all));
  });

  it('control: OFFSET paging over the same inserts repeats rows', async () => {
    await database.db.delete(incidents);
    await insert(
      Array.from({ length: 20 }, (_, i) => minutesBefore(i)),
      'existing',
    );
    const page = (offset: number) =>
      database.db.execute<{ id: string }>(
        sql`SELECT id FROM incidents ORDER BY last_seen DESC, id DESC LIMIT 10 OFFSET ${offset}`,
      );
    const first = (await page(0)).rows.map((row) => row.id);
    await insert([new Date(), new Date()], 'arrived');
    const second = (await page(10)).rows.map((row) => row.id);
    // The two new rows pushed the list down: OFFSET re-reads the end of the first page.
    expect(second.filter((id) => first.includes(id))).toHaveLength(2);
  });
});
