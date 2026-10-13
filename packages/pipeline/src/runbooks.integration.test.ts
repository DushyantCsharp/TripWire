import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { serviceUrl } from '@tripwire/jest-config/services';
import { migrateUp } from '@tripwire/db/migrator';
import { createTestDatabase, type TestDatabase } from '@tripwire/db/testing';
import { hashingEmbedder } from './embedding.js';
import { pgvectorRunbookIndex, syncRunbooks } from './runbooks.js';

let database: TestDatabase;
let dir: string;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
  dir = mkdtempSync(join(tmpdir(), 'tripwire-runbooks-'));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await database.drop();
});

const write = (file: string, text: string) => {
  writeFileSync(join(dir, file), text);
};

describe('runbook search over pgvector', () => {
  it('indexes the runbooks, then finds the section a query is about', async () => {
    write(
      'payment.md',
      '---\nservice: payment\n---\n# Payment\n\n## Charge failures\nCharge errors such as invalid token or card declined.\n\n## Latency\nSlow charges, timeouts to the card processor.\n',
    );
    write(
      'cart.md',
      '---\nservice: cart\n---\n# Cart\n\n## Valkey unavailable\nCart cannot reach valkey; add item fails.\n',
    );
    const embedder = hashingEmbedder();
    expect(await syncRunbooks(database.db, dir, embedder)).toEqual({
      ok: true,
      value: { sections: 3, written: 3, deleted: 0 },
    });

    const index = pgvectorRunbookIndex(database.db, embedder);
    const found = await index.search({ text: 'payment charge invalid token errors', k: 2 }, {});
    expect(found.ok && found.value.map((s) => s.id)).toEqual([
      'payment.md#charge-failures',
      'payment.md#latency',
    ]);
    expect(found.ok && found.value[0]).toMatchObject({
      title: 'Payment: Charge failures',
      service: 'payment',
    });

    const cart = await index.search({ text: 'charge errors', service: 'cart', k: 2 }, {});
    expect(cart.ok && cart.value.map((s) => s.id)).toEqual(['cart.md#valkey-unavailable']);
  });

  it('re-indexes only what changed, and drops sections that are gone', async () => {
    write('cart.md', '---\nservice: cart\n---\n# Cart\n\n## Valkey unavailable\nRewritten.\n');
    rmSync(join(dir, 'payment.md'));
    expect(await syncRunbooks(database.db, dir, hashingEmbedder())).toEqual({
      ok: true,
      value: { sections: 1, written: 1, deleted: 2 },
    });
  });

  it('reports a runbooks directory that is missing', async () => {
    expect(await syncRunbooks(database.db, join(dir, 'nope'), hashingEmbedder())).toMatchObject({
      ok: false,
      error: { kind: 'read_failed' },
    });
  });
});
