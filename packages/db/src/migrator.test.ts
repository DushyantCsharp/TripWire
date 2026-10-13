import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { loadMigrations, MIGRATIONS_DIR, parseScript } from './migrator.js';

describe('parseScript', () => {
  it('splits on drizzle breakpoints and keeps dollar-quoted bodies whole', () => {
    const script = parseScript(
      'CREATE TABLE a (id int);--> statement-breakpoint\n' +
        'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;',
    );
    expect(script.statements).toHaveLength(2);
    expect(script.statements[1]).toContain('BEGIN RETURN 1; END $$');
    expect(script.transactional).toBe(true);
  });

  it('runs a script outside a transaction when it starts with the marker', () => {
    const script = parseScript(
      '-- tripwire:no-transaction\nCREATE INDEX CONCURRENTLY i ON a (id);',
    );
    expect(script.transactional).toBe(false);
  });

  it('drops chunks that are only comments', () => {
    expect(parseScript('-- a note\n--> statement-breakpoint\nSELECT 1;').statements).toEqual([
      'SELECT 1;',
    ]);
  });
});

describe('shipped migrations', () => {
  const loaded = loadMigrations();
  const migrations = loaded.ok ? loaded.value : [];

  it('load in order, each with a rollback', () => {
    expect(loaded.ok).toBe(true);
    expect(migrations.map((migration) => migration.tag)).toEqual([
      '0000_extensions',
      '0001_initial',
      '0002_fingerprint_v2_expand',
      '0003_fingerprint_v2_index',
      '0004_fingerprint_v2_contract',
      '0005_triage_job_key',
      '0006_runbooks_partial_reports',
    ]);
  });

  it('use CONCURRENTLY only outside a transaction, where Postgres allows it', () => {
    const concurrentInTransaction = migrations.flatMap((migration) =>
      (['up', 'down'] as const)
        .filter((direction) => {
          const script = migration[direction];
          return (
            script.transactional &&
            script.statements.some((statement) => /\bCONCURRENTLY\b/.test(statement))
          );
        })
        .map((direction) => `${migration.tag} ${direction}`),
    );
    expect(concurrentInTransaction).toEqual([]);
  });

  it('refuse to load when a migration has no rollback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-migrations-'));
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      rmSync(join(dir, '0003_fingerprint_v2_index.down.sql'));
      expect(loadMigrations(dir)).toMatchObject({
        ok: false,
        error: { kind: 'invalid_migrations' },
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
