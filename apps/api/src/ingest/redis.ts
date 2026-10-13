import { jobIds, jobOptions } from '@tripwire/contracts/queues';
import { attempt, err, ok, type Result } from '@tripwire/result';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type {
  ClaimOutcome,
  DependencyError,
  IdempotencyRecord,
  IdempotencyStore,
  IngestQueue,
} from './ports.js';

const TTL_SECONDS = 24 * 3600;
const recordSchema = z.object({ ingestId: z.uuid(), bodyHash: z.string(), receivedAt: z.string() });

const unavailable = (cause: unknown): DependencyError => ({
  kind: 'dependency_unavailable',
  message: cause instanceof Error ? cause.message : String(cause),
});

export function redisIdempotencyStore(redis: Redis): IdempotencyStore {
  const keyFor = (key: string) => `tripwire:idempotency:${key}`;

  async function claim(
    key: string,
    record: IdempotencyRecord,
    retries = 1,
  ): Promise<Result<ClaimOutcome, DependencyError>> {
    const set = await attempt(
      () => redis.set(keyFor(key), JSON.stringify(record), 'EX', TTL_SECONDS, 'NX'),
      unavailable,
    );
    if (!set.ok) return set;
    if (set.value === 'OK') return ok({ claimed: true });

    const stored = await attempt(() => redis.get(keyFor(key)), unavailable);
    if (!stored.ok) return stored;
    // Expired between SET and GET: claim again.
    if (stored.value === null) {
      return retries > 0
        ? claim(key, record, retries - 1)
        : err(unavailable('idempotency key kept expiring'));
    }
    const existing = recordSchema.safeParse(JSON.parse(stored.value));
    if (!existing.success) return err(unavailable(`corrupt idempotency record for ${key}`));
    return ok({ claimed: false, existing: existing.data });
  }

  return {
    claim: (key, record) => claim(key, record),
    release: (key) =>
      attempt(async () => {
        await redis.del(keyFor(key));
      }, unavailable),
  };
}

export function bullmqIngestQueue(queue: Queue): IngestQueue {
  return {
    enqueue: (job) =>
      attempt(async () => {
        await queue.add('ingest', job, {
          ...jobOptions.ingest,
          jobId: jobIds.ingest(job.ingestId),
        });
      }, unavailable),
  };
}
