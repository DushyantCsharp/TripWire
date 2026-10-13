import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** node-postgres rather than postgres.js: it has OpenTelemetry auto-instrumentation. */
export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle({ client: pool, schema, casing: 'snake_case' }), pool };
}

export type Database = ReturnType<typeof createDatabase>['db'];
