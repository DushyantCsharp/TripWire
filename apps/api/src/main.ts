import { loadEnvOrExit } from '@tripwire/config';
import { DEAD_LETTER_QUEUES, QUEUES } from '@tripwire/contracts/queues';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { apiEnv } from './config.js';
import { bullmqDeadLetters } from './dead-letters.js';
import { bullmqQueueStats, QueueDepthAdmission } from './ingest/admission.js';
import { bullmqIngestQueue, redisIdempotencyStore } from './ingest/redis.js';
import { buildServer } from './server.js';

const env = loadEnvOrExit(apiEnv);

const queueOptions = { connection: { url: env.REDIS_URL }, prefix: env.QUEUE_PREFIX };
const ingestQueue = new Queue(QUEUES.ingest, queueOptions);
const triageQueue = new Queue(QUEUES.triage, queueOptions);
const deadLetterQueue = new Queue(DEAD_LETTER_QUEUES.triage, queueOptions);
const redis = new Redis(env.REDIS_URL);

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
          redis.quit(),
        ]),
      )
      .then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error(error, 'shutdown failed');
          process.exit(1);
        },
      );
  });
}

await app.listen({ host: env.API_HOST, port: env.API_PORT });
