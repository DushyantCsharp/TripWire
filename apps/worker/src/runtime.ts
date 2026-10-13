import { setTimeout as sleep } from 'node:timers/promises';
import type { Triager } from '@tripwire/agent';
import { DEAD_LETTER_QUEUES, QUEUES, triageJobSchema } from '@tripwire/contracts/queues';
import type { Database } from '@tripwire/db';
import { MetricsTime, Queue, type QueueOptions, Worker, type WorkerOptions } from 'bullmq';
import { backfillProcessor } from './backfill.js';
import { backoffStrategy } from './backoff.js';
import type { Embedder } from '@tripwire/pipeline';
import { clusterProcessor } from './cluster/processor.js';
import type { WorkerConfig } from './config.js';
import { ingestProcessor } from './ingest/processor.js';
import { deadLetterTriage, isFinalFailure } from './triage/dead-letter.js';
import { triageProcessor } from './triage/processor.js';

export interface Log {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RuntimeDeps {
  readonly db: Database;
  readonly triager: Triager;
  readonly embedder: Embedder;
  readonly log: Log;
}

export interface Runtime {
  readonly workers: readonly Worker[];
  /**
   * Stops taking jobs and waits for in-flight ones. At the deadline it cancels what's left (their
   * jobs retry later) and forces the workers closed.
   */
  shutdown(timeoutMs?: number): Promise<'drained' | 'forced'>;
}

export function startRuntime(
  config: WorkerConfig,
  { db, triager, embedder, log }: RuntimeDeps,
): Runtime {
  const queueOptions: QueueOptions = {
    connection: { url: config.REDIS_URL },
    prefix: config.QUEUE_PREFIX,
  };
  const clusterQueue = new Queue(QUEUES.cluster, queueOptions);
  const triageQueue = new Queue(QUEUES.triage, queueOptions);
  const deadLetterQueue = new Queue(DEAD_LETTER_QUEUES.triage, queueOptions);

  const common: WorkerOptions = {
    ...queueOptions,
    lockDuration: config.JOB_LOCK_MS,
    stalledInterval: config.JOB_LOCK_MS,
    maxStalledCount: config.MAX_STALLED_COUNT,
  };
  const ingest = new Worker(
    QUEUES.ingest,
    ingestProcessor({ db, clusterQueue, writeFingerprintV2: config.FINGERPRINT_V2_WRITE }),
    // The API's admission control reads the ingest drain rate from these metrics.
    {
      ...common,
      concurrency: config.INGEST_CONCURRENCY,
      metrics: { maxDataPoints: MetricsTime.ONE_WEEK },
    },
  );
  const cluster = new Worker(
    QUEUES.cluster,
    clusterProcessor({
      db,
      embedder,
      triageQueue,
      windowMs: config.CLUSTER_WINDOW_MINUTES * 60_000,
      similarityThreshold: config.CLUSTER_SIMILARITY_THRESHOLD,
      fingerprintVersion: config.FINGERPRINT_V2_READ ? 'v2' : 'v1',
    }),
    { ...common, concurrency: config.CLUSTER_CONCURRENCY },
  );
  const triage = new Worker(
    QUEUES.triage,
    triageProcessor({
      db,
      triager,
      deadLetterQueue,
      budget: {
        maxInputTokens: config.TRIAGE_MAX_INPUT_TOKENS,
        maxOutputTokens: config.TRIAGE_MAX_OUTPUT_TOKENS,
        maxToolCalls: config.TRIAGE_MAX_TOOL_CALLS,
        maxWallClockMs: config.TRIAGE_WALL_CLOCK_MS,
      },
    }),
    {
      ...common,
      concurrency: config.TRIAGE_CONCURRENCY,
      limiter: { max: config.TRIAGE_MAX_PER_MINUTE, duration: 60_000 },
      settings: {
        backoffStrategy: backoffStrategy({
          baseMs: config.TRIAGE_BACKOFF_BASE_MS,
          capMs: config.TRIAGE_BACKOFF_CAP_MS,
        }),
      },
    },
  );
  const backfill = new Worker(QUEUES.backfill, backfillProcessor(db), {
    ...common,
    concurrency: 1,
  });
  const workers = [ingest, cluster, triage, backfill];

  // Backup route to the dead-letter queue for failures the processor never saw: a job that stalled
  // more than MAX_STALLED_COUNT times because its workers kept dying. Duplicates are no-ops.
  triage.on('failed', (job, error) => {
    if (!job || !isFinalFailure(error, job.attemptsMade, job)) return;
    const parsed = triageJobSchema.safeParse(job.data);
    deadLetterTriage(
      { db, deadLetterQueue },
      job,
      error,
      parsed.success ? parsed.data.attempts : [],
    ).then(
      (outcome) => {
        if (outcome === 'already_succeeded') {
          log.info('not dead-lettering: its triage run succeeded', { jobId: job.id });
        }
      },
      (cause: unknown) => {
        log.error('dead-lettering failed', { jobId: job.id, error: String(cause) });
      },
    );
  });
  for (const worker of workers) {
    worker.on('error', (error) => {
      log.error('worker error', { queue: worker.name, error: error.message });
    });
  }

  return {
    workers,
    async shutdown(timeoutMs = config.SHUTDOWN_TIMEOUT_MS) {
      const draining = Promise.all(workers.map((worker) => worker.close()));
      const outcome = await Promise.race([
        draining.then(() => 'drained' as const),
        sleep(timeoutMs, 'forced' as const, { ref: false }),
      ]);
      if (outcome === 'forced') {
        log.info('shutdown deadline reached; cancelling in-flight jobs');
        for (const worker of workers) worker.cancelAllJobs('worker shutdown deadline');
        await Promise.race([draining, sleep(2_000, undefined, { ref: false })]);
        await Promise.all(workers.map((worker) => worker.close(true)));
      }
      await Promise.all([clusterQueue, triageQueue, deadLetterQueue].map((queue) => queue.close()));
      return outcome;
    },
  };
}
