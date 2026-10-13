import { loadEnvOrExit } from '@tripwire/config';
import { createDatabase } from '@tripwire/db';
import { hashingEmbedder } from '@tripwire/pipeline';
import { workerEnv } from './config.js';
import { startRuntime, type Log } from './runtime.js';
import { createTriager } from './triage/triager.js';

const config = loadEnvOrExit(workerEnv);

const write = (level: string, message: string, fields: Record<string, unknown> = {}) => {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields })}\n`,
  );
};
const log: Log = {
  info: (message, fields) => {
    write('info', message, fields);
  },
  error: (message, fields) => {
    write('error', message, fields);
  },
};

const { db, pool } = createDatabase(config.DATABASE_URL);
const embedder = hashingEmbedder();
const triager = createTriager(config, { db, embedder, log });
const runtime = startRuntime(config, { db, triager, embedder, log });
log.info('worker started', { prefix: config.QUEUE_PREFIX, triager: triager.model });

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) {
      log.info(`second ${signal}: exiting without waiting`);
      process.exit(1);
    }
    stopping = true;
    log.info(`${signal}: draining in-flight jobs`, { timeoutMs: config.SHUTDOWN_TIMEOUT_MS });
    runtime
      .shutdown()
      .then(async (outcome) => {
        await pool.end();
        log.info('worker stopped', { outcome });
        process.exit(0);
      })
      .catch((error: unknown) => {
        log.error('shutdown failed', { error: String(error) });
        process.exit(1);
      });
  });
}
