// Helpers for integration tests in any workspace: `@tripwire/db/testing`. Never shipped in dist/.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, type Database } from '../client.js';

export { generateSeedData, seed, SEED_REFERENCE_DATE } from '../seed.js';

export interface TestDatabase {
  readonly url: string;
  readonly db: Database;
  readonly pool: pg.Pool;
  drop(): Promise<void>;
}

/**
 * A fresh, empty database in the run's Postgres container (serviceUrl('postgres') from
 * `@tripwire/jest-config/services`). Give each test file its own.
 */
export async function createTestDatabase(serverUrl: string): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await withAdmin(serverUrl, (admin) => admin.query(`CREATE DATABASE "${name}"`));
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const { db, pool } = createDatabase(url.toString());
  return {
    url: url.toString(),
    db,
    pool,
    async drop() {
      await pool.end();
      await withAdmin(serverUrl, (admin) => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`));
    },
  };
}

async function withAdmin(serverUrl: string, fn: (admin: pg.Client) => Promise<unknown>) {
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await fn(admin);
  } finally {
    await admin.end();
  }
}
