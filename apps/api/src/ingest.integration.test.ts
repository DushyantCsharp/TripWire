import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from '@jest/globals';
import { fromPublicId } from '@tripwire/contracts/ids';
import {
  DEAD_LETTER_QUEUES,
  jobIds,
  QUEUES,
  type IngestJob,
  type TriageDeadLetter,
} from '@tripwire/contracts/queues';
import { serviceUrl } from '@tripwire/jest-config/services';
import { MetricsTime, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { bullmqDeadLetters } from './dead-letters.js';
import { bullmqQueueStats, QueueDepthAdmission } from './ingest/admission.js';
import type { AdmissionControl } from './ingest/ports.js';
import { bullmqIngestQueue, redisIdempotencyStore } from './ingest/redis.js';
import { signatureHeader } from './ingest/signature.js';
import { buildServer } from './server.js';

const redisUrl = serviceUrl('redis');
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

/** Queues under a prefix of their own, so tests don't see each other's jobs. */
function queues() {
  const prefix = `test-${uuidv7()}`;
  const options = { connection: { url: redisUrl }, prefix };
  const make = (name: string) => {
    const queue = new Queue(name, options);
    cleanup.push(() => queue.obliterate({ force: true }).then(() => queue.close()));
    return queue;
  };
  return {
    prefix,
    options,
    ingest: make(QUEUES.ingest),
    triage: make(QUEUES.triage),
    deadLetter: make(DEAD_LETTER_QUEUES.triage),
  };
}

function redis() {
  const client = new Redis(redisUrl);
  cleanup.push(() => client.quit());
  return client;
}

const record = () => ({
  ingestId: uuidv7(),
  bodyHash: 'a'.repeat(64),
  receivedAt: new Date().toISOString(),
});

describe('Redis idempotency store', () => {
  it('claims a key once and returns the first record after that, for 24 hours', async () => {
    const client = redis();
    const store = redisIdempotencyStore(client);
    const key = `key-${uuidv7()}`;
    const first = record();

    expect(await store.claim(key, first)).toEqual({ ok: true, value: { claimed: true } });
    expect(await store.claim(key, record())).toEqual({
      ok: true,
      value: { claimed: false, existing: first },
    });
    const ttl = await client.ttl(`tripwire:idempotency:${key}`);
    expect(ttl).toBeGreaterThan(86_390);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it('lets exactly one of many concurrent claims win', async () => {
    const store = redisIdempotencyStore(redis());
    const key = `key-${uuidv7()}`;
    const claims = await Promise.all(Array.from({ length: 25 }, () => store.claim(key, record())));
    const winners = claims.filter((claim) => claim.ok && claim.value.claimed);
    expect(winners).toHaveLength(1);
  });

  it('forgets a released key', async () => {
    const store = redisIdempotencyStore(redis());
    const key = `key-${uuidv7()}`;
    await store.claim(key, record());
    await store.release(key);
    expect(await store.claim(key, record())).toEqual({ ok: true, value: { claimed: true } });
  });
});

describe('BullMQ ingest queue', () => {
  it('holds one job per ingest id however often it is offered', async () => {
    const q = queues();
    const queue = bullmqIngestQueue(q.ingest);
    const job: IngestJob = {
      ingestId: uuidv7(),
      idempotencyKey: 'k',
      bodyHash: 'a'.repeat(64),
      source: 'generic',
      receivedAt: new Date().toISOString(),
      payload: {},
    };
    await Promise.all([queue.enqueue(job), queue.enqueue(job), queue.enqueue(job)]);
    expect(await q.ingest.getWaitingCount()).toBe(1);
    expect((await q.ingest.getJob(job.ingestId))?.opts.attempts).toBe(8);
  });
});

describe('queue-depth admission control', () => {
  it('sheds above the high-water mark, with Retry-After from the measured drain rate', async () => {
    const q = queues();
    await q.ingest.addBulk(Array.from({ length: 60 }, (_, i) => ({ name: 'ingest', data: { i } })));
    const admission = new QueueDepthAdmission(bullmqQueueStats(q.ingest), {
      highWater: 10,
      random: () => 0,
    });

    // Nothing draining yet: the longest wait.
    await admission.sample();
    expect(admission.check()).toEqual({ retryAfterSeconds: 60 });

    // A worker draining ~40 jobs/s, recording the metrics admission control reads.
    const worker = new Worker(q.ingest.name, () => sleep(25), {
      ...q.options,
      concurrency: 1,
      metrics: { maxDataPoints: MetricsTime.ONE_WEEK },
    });
    cleanup.push(() => worker.close());
    await sleep(500);
    await admission.sample();

    const shed = admission.check();
    expect(shed).not.toBeNull();
    // ~30 over the mark at ~40/s: a second or two, nowhere near the 60 s ceiling.
    expect(shed?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(shed?.retryAfterSeconds).toBeLessThanOrEqual(5);

    await sleep(2_000);
    await admission.sample();
    expect(admission.check()).toBeNull();
  });
});

describe('dead-lettered triage jobs', () => {
  async function deadLettered(q: ReturnType<typeof queues>) {
    const incidentId = uuidv7();
    const jobId = jobIds.triage(incidentId);
    const attempts = [
      {
        attempt: 1,
        errorClass: 'FatalError',
        message: 'over budget',
        at: new Date().toISOString(),
      },
    ];
    const entry: TriageDeadLetter = {
      jobId,
      job: { incidentId, trigger: 'new_incident', attempts },
      errorClass: 'FatalError',
      failedReason: 'over budget',
      lastStack: 'FatalError: over budget',
      attempts,
      failedAt: new Date().toISOString(),
    };
    await q.deadLetter.add('triage-dead-letter', entry, { jobId: jobIds.deadLetter(jobId) });
    return { id: jobIds.deadLetter(jobId), incidentId };
  }

  it('lists entries and redrives one as a fresh job, exactly once', async () => {
    const q = queues();
    const deadLetters = bullmqDeadLetters(q.deadLetter, q.triage);
    const { id, incidentId } = await deadLettered(q);

    const listed = await deadLetters.list(50);
    expect(listed.ok && listed.value.map((entry) => entry.id)).toEqual([id]);

    // Concurrent redrives of one entry: one new job, whoever wins.
    const results = await Promise.all([deadLetters.redrive(id), deadLetters.redrive(id)]);
    expect(results.some((result) => result.ok)).toBe(true);
    expect(await q.triage.getJobCounts('waiting', 'delayed')).toEqual({ waiting: 1, delayed: 0 });

    const job = await q.triage.getJob(jobIds.redrive(id));
    expect(job?.data).toEqual({ incidentId, trigger: 'redrive', redrivenFrom: id, attempts: [] });
    expect(job?.opts).toMatchObject({ attempts: 5, backoff: { type: 'full-jitter' } });
    expect(await q.deadLetter.getWaitingCount()).toBe(0);
    expect(await deadLetters.redrive(id)).toEqual({ ok: false, error: { kind: 'not_found' } });
  });
});

const SECRET = 'integration-webhook-secret';

/** The real server over Redis: real idempotency store, ingest queue and dead-letter queue. */
async function server(q: ReturnType<typeof queues>, admission: AdmissionControl) {
  const app = await buildServer({
    ingest: {
      idempotency: redisIdempotencyStore(redis()),
      queue: bullmqIngestQueue(q.ingest),
      admission,
      secrets: [SECRET],
    },
    deadLetters: bullmqDeadLetters(q.deadLetter, q.triage),
  });
  cleanup.push(() => app.close());
  return {
    post: (key: string, payload: string, signed = true) =>
      app.inject({
        method: 'POST',
        url: '/v1/webhooks/generic',
        payload,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          ...(signed && {
            'x-tripwire-signature': signatureHeader(
              SECRET,
              Math.floor(Date.now() / 1000),
              key,
              payload,
            ),
          }),
        },
      }),
  };
}

const alertPayload = (source = 'k6') =>
  JSON.stringify({
    source,
    alerts: [
      {
        name: 'HighErrorRate',
        status: 'firing',
        severity: 'critical',
        starts_at: '2026-10-01T12:00:00Z',
      },
    ],
  });

describe('webhook ingest against Redis', () => {
  it('turns 50 concurrent deliveries of one key into one queued job', async () => {
    const q = queues();
    const { post } = await server(q, { check: () => null });
    const key = `delivery-${uuidv7()}`;
    const payload = alertPayload();

    const responses = await Promise.all(Array.from({ length: 50 }, () => post(key, payload)));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(50).fill(202));
    const ingestIds = new Set(responses.map((r) => r.json<{ ingest_id: string }>().ingest_id));
    expect(ingestIds.size).toBe(1);
    // One won the claim; the other 49 were told they are replays of it.
    expect(responses.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(49);

    expect(await q.ingest.getJobCounts('waiting', 'delayed', 'prioritized')).toEqual({
      waiting: 1,
      delayed: 0,
      prioritized: 0,
    });
    const [ingestId] = [...ingestIds];
    expect(await q.ingest.getJob(fromPublicId('ing', ingestId ?? '') ?? '')).toBeDefined();
    // Same key, different body: a conflict, not a 51st copy.
    expect((await post(key, alertPayload('k7'))).statusCode).toBe(409);
    expect(await q.ingest.getWaitingCount()).toBe(1);
  });

  it('sheds with 503 and Retry-After while the queue is above high water, then admits again', async () => {
    const q = queues();
    const admission = new QueueDepthAdmission(bullmqQueueStats(q.ingest), { highWater: 20 });
    const { post } = await server(q, admission);
    await q.ingest.addBulk(Array.from({ length: 25 }, (_, i) => ({ name: 'ingest', data: { i } })));
    await admission.sample();

    const key = `delivery-${uuidv7()}`;
    const payload = alertPayload();
    const shed = await post(key, payload);
    expect(shed.statusCode).toBe(503);
    // Nothing is draining this queue, so the longest wait.
    expect(shed.headers['retry-after']).toBe('60');
    expect(shed.headers['content-type']).toContain('application/problem+json');
    expect(shed.json()).toMatchObject({ type: '/problems/overloaded', status: 503 });
    // Shedding comes first: even an unsigned request gets 503, not 401, and costs no verification.
    expect((await post(key, payload, false)).statusCode).toBe(503);
    expect(await q.ingest.getWaitingCount()).toBe(25);

    // Back under the mark. The key was never claimed, so the retry is a first delivery.
    await q.ingest.drain();
    await admission.sample();
    const retried = await post(key, payload);
    expect(retried.statusCode).toBe(202);
    expect(retried.headers['idempotent-replayed']).toBeUndefined();
    expect(await q.ingest.getWaitingCount()).toBe(1);
  });
});
