// Applies the SQL that drizzle-kit generates. Drizzle's own migrator runs every pending migration in
// one transaction (so CREATE/DROP INDEX CONCURRENTLY can't run) and has no down migrations; this one
// runs each migration in its own transaction unless it opts out, and every migration has a rollback.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '@tripwire/result';
import type pg from 'pg';
import { toDatabaseError, type DatabaseError } from './errors.js';

/** The migrations shipped with this package (src/ and dist/ both sit one level below it). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const NO_TRANSACTION_MARKER = '-- tripwire:no-transaction';
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
// Session-level advisory lock: one migration run per database at a time.
const MIGRATION_LOCK_ID = 727_100_001;
const LOCK_TIMEOUT_FORMAT = /^\d+(ms|s)$/;

export type Direction = 'up' | 'down';

export interface MigrationScript {
  readonly statements: readonly string[];
  /** False when the file starts with `-- tripwire:no-transaction` (required for CONCURRENTLY). */
  readonly transactional: boolean;
}

export interface Migration {
  readonly idx: number;
  readonly tag: string;
  /** SHA-256 of the up script. An applied migration whose file has changed is refused. */
  readonly checksum: string;
  readonly up: MigrationScript;
  readonly down: MigrationScript;
}

export type MigrationError =
  | DatabaseError
  | { readonly kind: 'invalid_migrations'; readonly message: string }
  | { readonly kind: 'invalid_target'; readonly message: string }
  | { readonly kind: 'history_mismatch'; readonly message: string }
  | {
      readonly kind: 'statement_failed';
      readonly message: string;
      readonly migration: string;
      readonly direction: Direction;
      readonly statement: string;
    };

export interface MigrateOptions {
  readonly dir?: string;
  /** Session lock_timeout, so DDL can't queue behind a long transaction and stall all writes. */
  readonly lockTimeout?: string;
  readonly log?: (line: string) => void;
}

export interface MigrationStatus {
  readonly idx: number;
  readonly tag: string;
  readonly appliedAt: Date | null;
}

/** Splits on drizzle's breakpoints (never on `;`, which would break dollar-quoted bodies). */
export function parseScript(sql: string): MigrationScript {
  const statements = sql
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) =>
      chunk.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('--')),
    );
  return { statements, transactional: !sql.trimStart().startsWith(NO_TRANSACTION_MARKER) };
}

export function loadMigrations(dir = MIGRATIONS_DIR): Result<Migration[], MigrationError> {
  const journalPath = join(dir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) {
    return err({ kind: 'invalid_migrations', message: `no drizzle journal at ${journalPath}` });
  }
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const migrations: Migration[] = [];
  for (const [position, { idx, tag }] of journal.entries.entries()) {
    const upPath = join(dir, `${tag}.sql`);
    const downPath = join(dir, `${tag}.down.sql`);
    if (idx !== position) {
      return err({ kind: 'invalid_migrations', message: `journal is out of order at ${tag}` });
    }
    if (!existsSync(upPath) || !existsSync(downPath)) {
      return err({
        kind: 'invalid_migrations',
        message: `${tag} needs both ${tag}.sql and ${tag}.down.sql; every migration has a rollback`,
      });
    }
    const up = readFileSync(upPath, 'utf8');
    migrations.push({
      idx,
      tag,
      checksum: createHash('sha256').update(up).digest('hex'),
      up: parseScript(up),
      down: parseScript(readFileSync(downPath, 'utf8')),
    });
  }
  return ok(migrations);
}

/** Applies pending migrations up to and including `to` (default: all). Returns the tags applied. */
export async function migrateUp(
  pool: pg.Pool,
  options: MigrateOptions & { readonly to?: number } = {},
): Promise<Result<string[], MigrationError>> {
  const loaded = loadMigrations(options.dir);
  if (!loaded.ok) return loaded;
  const migrations = loaded.value;
  const to = options.to ?? migrations.length - 1;
  if (!Number.isInteger(to) || to < -1 || to >= migrations.length) {
    return err({
      kind: 'invalid_target',
      message: `--to must be between -1 and ${migrations.length - 1}`,
    });
  }
  return withMigrationSession(pool, options, async (client) => {
    const history = await readHistory(client, migrations);
    if (!history.ok) return history;
    const applied: string[] = [];
    for (const migration of migrations.slice(history.value.length, to + 1)) {
      const result = await run(client, migration, 'up', options.log);
      if (!result.ok) return result;
      applied.push(migration.tag);
    }
    return ok(applied);
  });
}

/** Rolls back applied migrations above `to`, newest first (-1 rolls back everything). */
export async function migrateDown(
  pool: pg.Pool,
  options: MigrateOptions & { readonly to: number },
): Promise<Result<string[], MigrationError>> {
  const loaded = loadMigrations(options.dir);
  if (!loaded.ok) return loaded;
  const migrations = loaded.value;
  if (!Number.isInteger(options.to) || options.to < -1 || options.to >= migrations.length) {
    return err({
      kind: 'invalid_target',
      message: `--to must be between -1 and ${migrations.length - 1}`,
    });
  }
  return withMigrationSession(pool, options, async (client) => {
    const history = await readHistory(client, migrations);
    if (!history.ok) return history;
    const reverted: string[] = [];
    for (const migration of migrations.slice(options.to + 1, history.value.length).reverse()) {
      const result = await run(client, migration, 'down', options.log);
      if (!result.ok) return result;
      reverted.push(migration.tag);
    }
    return ok(reverted);
  });
}

export async function migrationStatus(
  pool: pg.Pool,
  options: MigrateOptions = {},
): Promise<Result<MigrationStatus[], MigrationError>> {
  const loaded = loadMigrations(options.dir);
  if (!loaded.ok) return loaded;
  const migrations = loaded.value;
  return withMigrationSession(pool, options, async (client) => {
    const history = await readHistory(client, migrations);
    if (!history.ok) return history;
    return ok(
      migrations.map(({ idx, tag }) => ({
        idx,
        tag,
        appliedAt: history.value[idx]?.appliedAt ?? null,
      })),
    );
  });
}

async function withMigrationSession<T>(
  pool: pg.Pool,
  options: MigrateOptions,
  body: (client: pg.PoolClient) => Promise<Result<T, MigrationError>>,
): Promise<Result<T, MigrationError>> {
  const lockTimeout = options.lockTimeout ?? '10s';
  if (!LOCK_TIMEOUT_FORMAT.test(lockTimeout))
    throw new Error(`invalid lockTimeout: ${lockTimeout}`);
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (cause) {
    return err(toDatabaseError(cause));
  }
  try {
    const setup = await query(client, [
      `SET lock_timeout = '${lockTimeout}'`,
      `SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`,
      `CREATE TABLE IF NOT EXISTS tripwire_migrations (
         idx integer PRIMARY KEY,
         tag text NOT NULL,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    ]);
    if (!setup.ok) return setup;
    return await body(client);
  } finally {
    // Destroy the connection rather than pooling it: it holds the advisory lock and any session
    // settings a no-transaction migration made.
    client.release(true);
  }
}

interface AppliedMigration {
  readonly tag: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

/** Applied migrations, checked to be an unedited prefix of the migrations on disk. */
async function readHistory(
  client: pg.PoolClient,
  migrations: readonly Migration[],
): Promise<Result<AppliedMigration[], MigrationError>> {
  let rows: { idx: number; tag: string; checksum: string; applied_at: Date }[];
  try {
    ({ rows } = await client.query(
      'SELECT idx, tag, checksum, applied_at FROM tripwire_migrations ORDER BY idx',
    ));
  } catch (cause) {
    return err(toDatabaseError(cause));
  }
  for (const [position, row] of rows.entries()) {
    const migration = migrations[position];
    if (row.idx !== position || !migration || migration.tag !== row.tag) {
      return err({
        kind: 'history_mismatch',
        message: `applied migration ${row.idx} (${row.tag}) does not match migration ${position} on disk`,
      });
    }
    if (migration.checksum !== row.checksum) {
      return err({
        kind: 'history_mismatch',
        message: `${row.tag} was edited after it was applied; add a new migration instead`,
      });
    }
  }
  return ok(
    rows.map((row) => ({ tag: row.tag, checksum: row.checksum, appliedAt: row.applied_at })),
  );
}

async function run(
  client: pg.PoolClient,
  migration: Migration,
  direction: Direction,
  log: ((line: string) => void) | undefined,
): Promise<Result<void, MigrationError>> {
  const script = migration[direction];
  const record =
    direction === 'up'
      ? {
          text: 'INSERT INTO tripwire_migrations (idx, tag, checksum) VALUES ($1, $2, $3)',
          values: [migration.idx, migration.tag, migration.checksum],
        }
      : { text: 'DELETE FROM tripwire_migrations WHERE idx = $1', values: [migration.idx] };

  if (script.transactional) {
    const begin = await query(client, ['BEGIN']);
    if (!begin.ok) return begin;
  }
  for (const statement of script.statements) {
    try {
      await client.query(statement);
    } catch (cause) {
      // The original failure is what matters; a failed ROLLBACK means the connection is gone, and
      // the session is destroyed afterwards anyway.
      if (script.transactional) await query(client, ['ROLLBACK']);
      return err({
        kind: 'statement_failed',
        message: toDatabaseError(cause).message,
        migration: migration.tag,
        direction,
        statement: statement.split('\n').find((line) => !line.trim().startsWith('--')) ?? statement,
      });
    }
  }
  try {
    await client.query(record.text, record.values);
    if (script.transactional) await client.query('COMMIT');
  } catch (cause) {
    return err(toDatabaseError(cause));
  }
  log?.(`${direction === 'up' ? 'applied ' : 'reverted'} ${migration.tag}`);
  return ok(undefined);
}

async function query(
  client: pg.PoolClient,
  statements: readonly string[],
): Promise<Result<void, MigrationError>> {
  try {
    for (const statement of statements) await client.query(statement);
    return ok(undefined);
  } catch (cause) {
    return err(toDatabaseError(cause));
  }
}
