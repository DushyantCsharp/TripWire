import { loadEnvOrExit } from '@tripwire/config';
import { DEAD_LETTER_QUEUES, QUEUES } from '@tripwire/contracts/queues';
import { shutdownTelemetry } from '@tripwire/telemetry';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { apiEnv } from './config.js';
import { bullmqDeadLetters } from './dead-letters.js';
import { bullmqQueueStats, QueueDepthAdmission } from './ingest/admission.js';
import { bullmqIngestQueue, redisIdempotencyStore } from './ingest/redis.js';
import { buildServer } from './server.js';
import { observeQueues } from './telemetry.js';

const env = loadEnvOrExit(apiEnv);

const queueOptions = { connection: { url: env.REDIS_URL }, prefix: env.QUEUE_PREFIX };
const ingestQueue = new Queue(QUEUES.ingest, queueOptions);
const triageQueue = new Queue(QUEUES.triage, queueOptions);
const deadLetterQueue = new Queue(DEAD_LETTER_QUEUES.triage, queueOptions);
// Read only, for the queue-depth gauges: the API is up when the workers may not be.
const clusterQueue = new Queue(QUEUES.cluster, queueOptions);
const backfillQueue = new Queue(QUEUES.backfill, queueOptions);
const redis = new Redis(env.REDIS_URL);
observeQueues([ingestQueue, clusterQueue, triageQueue, backfillQueue], deadLetterQueue);

const admission = new QueueDepthAdmission(bullmqQueueStats(ingestQueue), {
  highWater: env.INGEST_HIGH_WATER,
  onError: (error) => {
    app.log.warn({ err: error }, 'admission control cannot read the ingest queue');
  },
});

const app = await buildServer(
  {
    ingest: {
      idempotency: redisIdempotencyStore(redis),
      queue: bullmqIngestQueue(ingestQueue),
      admission,
      secrets: env.WEBHOOK_SECRETS,
    },
    deadLetters: bullmqDeadLetters(deadLetterQueue, triageQueue),
  },
  { logger: { level: env.LOG_LEVEL } },
);
admission.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    admission.stop();
    app
      .close()
      .then(() =>
        Promise.all([
          ingestQueue.close(),
          triageQueue.close(),
          deadLetterQueue.close(),
          clusterQueue.close(),
          backfillQueue.close(),
          redis.quit(),
        ]),
      )
      // Last, so the final spans and metrics leave the process.
      .then(shutdownTelemetry)
      .then(
        (flushed) => {
          if (!flushed.ok) app.log.warn({ err: flushed.error }, 'telemetry was not flushed');
          process.exit(0);
        },
        (error: unknown) => {
          app.log.error(error, 'shutdown failed');
          process.exit(1);
        },
      );
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
