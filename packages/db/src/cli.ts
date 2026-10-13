// The db:* scripts: migrations, seeding and backfills against DATABASE_URL.
import { parseArgs } from 'node:util';
import { baseEnv, loadEnvOrExit } from '@tripwire/config';
import { z } from 'zod';
import { backfillFingerprintV2 } from './backfill.js';
import { createDatabase } from './client.js';
import { migrateDown, migrateUp, migrationStatus, type MigrationError } from './migrator.js';

const USAGE = `usage: cli.ts <command>
  up [--to N]                                 apply pending migrations, all or up to N
  down --to N                                 roll back migrations above N (-1: all)
  status                                      list migrations and when each was applied
  seed                                        replace all data with the demo data set
  backfill [--batch-size N] [--throttle-ms N] fill alerts.fingerprint_v2 (MIGRATIONS.md)`;

const env = loadEnvOrExit(baseEnv.extend({ DATABASE_URL: z.url() }));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to: { type: 'string' },
    'batch-size': { type: 'string' },
    'throttle-ms': { type: 'string' },
  },
});

function usageError(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(1);
}

function integerOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) usageError(`not an integer: ${raw}`);
  return value;
}

function describe(
  error: MigrationError | { readonly kind: string; readonly message: string },
): string {
  const where =
    'migration' in error ? ` in ${error.migration} (${error.direction}): ${error.statement}` : '';
  return `${error.kind}${where}\n  ${error.message}`;
}

const log = (line: string) => {
  console.log(line);
};
const { db, pool } = createDatabase(env.DATABASE_URL);

async function main(): Promise<string | undefined> {
  const command = positionals[0] ?? '';
  switch (command) {
    case 'up': {
      const result = await migrateUp(pool, { to: integerOption(values.to), log });
      if (!result.ok) return describe(result.error);
      if (result.value.length === 0) log('already up to date');
      return undefined;
    }
    case 'down': {
      const to = integerOption(values.to) ?? usageError('down needs --to N');
      const result = await migrateDown(pool, { to, log });
      if (!result.ok) return describe(result.error);
      if (result.value.length === 0) log('nothing to roll back');
      return undefined;
    }
    case 'status': {
      const result = await migrationStatus(pool);
      if (!result.ok) return describe(result.error);
      for (const { idx, tag, appliedAt } of result.value) {
        log(
          `${String(idx).padStart(4, '0')}  ${tag.padEnd(32)}  ${appliedAt?.toISOString() ?? 'pending'}`,
        );
      }
      return undefined;
    }
    case 'seed': {
      if (env.NODE_ENV === 'production') return 'refusing to seed with NODE_ENV=production';
      // Imported on demand: faker is a dev dependency.
      const { seed } = await import('./seed.js');
      const result = await seed(db);
      if (!result.ok) return describe(result.error);
      log(
        `seeded ${result.value.incidents} incidents, ${result.value.alerts} alerts in ${result.value.ingests} deliveries`,
      );
      return undefined;
    }
    case 'backfill': {
      const result = await backfillFingerprintV2(db, {
        batchSize: integerOption(values['batch-size']),
        throttleMs: integerOption(values['throttle-ms']),
        onBatch: (progress) => {
          log(
            `batch ${progress.batches}: ${progress.rowsUpdated}/${progress.rowsScanned} rows updated`,
          );
        },
      });
      if (!result.ok) return describe(result.error);
      log(result.value.completed ? 'backfill complete' : 'backfill stopped; rerun to resume');
      return undefined;
    }
    default:
      return usageError(command ? `unknown command: ${command}` : 'missing command');
  }
}

try {
  const failure = await main();
  if (failure) {
    process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
