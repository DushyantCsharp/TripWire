// Indexes the runbooks for get_runbook: every `##` section of runbooks/*.md, embedded into
// Postgres. Run after editing a runbook: `just runbooks-index`. Idempotent.
import { resolve } from 'node:path';
import { baseEnv, loadEnvOrExit } from '@tripwire/config';
import { createDatabase } from '@tripwire/db';
import { hashingEmbedder, syncRunbooks } from '@tripwire/pipeline';
import { z } from 'zod';

const env = loadEnvOrExit(
  baseEnv.extend({
    DATABASE_URL: z.url(),
    RUNBOOKS_DIR: z.string().min(1).default('../../runbooks'),
  }),
);

const dir = resolve(env.RUNBOOKS_DIR);
const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  const synced = await syncRunbooks(db, dir, hashingEmbedder());
  if (!synced.ok) {
    process.stderr.write(`could not index ${dir}: ${synced.error.kind}: ${synced.error.message}\n`);
    process.exitCode = 1;
  } else {
    const { sections, written, deleted } = synced.value;
    process.stdout.write(
      `indexed ${String(sections)} runbook sections from ${dir}: ${String(written)} written, ` +
        `${String(deleted)} deleted, the rest unchanged\n`,
    );
  }
} finally {
  await pool.end();
}
