import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  baselineTriager,
  claudeTriager,
  payloadHash,
  type Triager,
  type TriageError,
} from '@tripwire/agent';
import { answer, paymentTelemetry, scriptedModel, toolUse } from '@tripwire/agent/testing';
import {
  DEAD_LETTER_QUEUES,
  jobIds,
  jobOptions,
  QUEUES,
  triageDeadLetterSchema,
  triageJobSchema,
  type IngestJob,
} from '@tripwire/contracts/queues';
import { migrateUp } from '@tripwire/db/migrator';
import { createTestDatabase, type TestDatabase } from '@tripwire/db/testing';
import { serviceUrl } from '@tripwire/jest-config/services';
import { err } from '@tripwire/result';
import { Queue } from 'bullmq';
import { hashingEmbedder } from '@tripwire/pipeline';
import { workerEnv } from './config.js';
import { startRuntime } from './runtime.js';
import { deadLetterTriage } from './triage/dead-letter.js';

const silent = { info: () => undefined, error: () => undefined };

let database: TestDatabase;
beforeAll(async () => {
  database = await createTestDatabase(serviceUrl('postgres'));
  expect(await migrateUp(database.pool)).toMatchObject({ ok: true });
});
afterAll(() => database.drop());

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await database.pool.query(sql, params)).rows as T[];
}

/** A generic-webhook delivery: one alert per pod, all with the same identity. */
function delivery(alertname: string, service: string, pods: number, firstPod = 0): IngestJob {
  const payload = {
    source: 'test',
    alerts: Array.from({ length: pods }, (_, i) => ({
      name: alertname,
      status: 'firing',
      severity: 'critical',
      service,
      labels: { pod: `${service}-${String(firstPod + i)}` },
      starts_at: new Date().toISOString(),
    })),
  };
  return {
    ingestId: randomUUID(),
    idempotencyKey: `key-${randomUUID()}`,
    bodyHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    source: 'generic',
    receivedAt: new Date().toISOString(),
    payload,
  };
}

/** A worker runtime on its own queue prefix, plus producer queues to drive it. */
function harness(triager: Triager, overrides: Record<string, string> = {}) {
  const config = workerEnv.parse({
    REDIS_URL: serviceUrl('redis'),
    DATABASE_URL: database.url,
    QUEUE_PREFIX: `test-${randomUUID().slice(0, 8)}`,
    TRIAGE_BACKOFF_BASE_MS: '20',
    TRIAGE_BACKOFF_CAP_MS: '100',
    ...overrides,
  });
  const runtime = startRuntime(config, {
    db: database.db,
    triager,
    embedder: hashingEmbedder(),
    log: silent,
  });
  const queues = new Map<string, Queue>();
  const queue = (name: string) => {
    const existing = queues.get(name);
    if (existing) return existing;
    const created = new Queue(name, {
      connection: { url: config.REDIS_URL },
      prefix: config.QUEUE_PREFIX,
    });
    queues.set(name, created);
    return created;
  };
  return {
    runtime,
    queue,
    enqueue: (job: IngestJob, jobId = jobIds.ingest(job.ingestId)) =>
      queue(QUEUES.ingest).add('ingest', job, { ...jobOptions.ingest, jobId }),
    /** Waits until no pipeline job is waiting, active or delayed, twice in a row. */
    async idle(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      let quiet = 0;
      while (quiet < 2) {
        if (Date.now() > deadline) throw new Error('pipeline did not go idle');
        const counts = await Promise.all(
          [QUEUES.ingest, QUEUES.cluster, QUEUES.triage].map((name) =>
            queue(name).getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
          ),
        );
        const busy = counts.flatMap((c) => Object.values(c)).reduce((a, b) => a + b, 0);
        quiet = busy === 0 ? quiet + 1 : 0;
        await sleep(200);
      }
    },
    async closeQueues() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

function failing(error: TriageError) {
  const calls = { count: 0 };
  const triager: Triager = {
    model: 'failing-test-triager',
    triage: () => {
      calls.count += 1;
      return Promise.resolve(err(error));
    },
  };
  return { triager, calls };
}

/** Fails with `failures` in turn, then triages like the baseline. */
function flaky(failures: TriageError[]) {
  const calls = { count: 0 };
  const baseline = baselineTriager();
  const triager: Triager = {
    model: baseline.model,
    triage: (input, options) => {
      const failure = failures[calls.count];
      calls.count += 1;
      return failure ? Promise.resolve(err(failure)) : baseline.triage(input, options);
    },
  };
  return { triager, calls };
}

describe('ingest → cluster → triage', () => {
  it('turns a storm into one incident with one triage report, even when a delivery replays', async () => {
    const h = harness(baselineTriager());
    const storm = delivery('HighErrorRate', 'checkout-storm', 50);
    await h.enqueue(storm);
    await h.enqueue(delivery('HighErrorRate', 'checkout-storm', 50, 50));
    await h.enqueue(delivery('KafkaConsumerLag', 'accounting-storm', 1));
    await h.idle();
    // The same delivery again, as if its first job had already been cleaned up: Postgres's unique
    // idempotency key turns it into a no-op.
    await h.enqueue(storm, `replay-${storm.ingestId}`);
    await h.idle();

    const incidents = await rows<{ service: string; alert_count: number; status: string }>(
      `SELECT service, alert_count, status FROM incidents WHERE service LIKE '%-storm' ORDER BY service`,
    );
    expect(incidents).toEqual([
      { service: 'accounting-storm', alert_count: 1, status: 'triaged' },
      { service: 'checkout-storm', alert_count: 100, status: 'triaged' },
    ]);
    const reports = await rows<{ service: string; runs: string; hypotheses: string }>(
      `SELECT i.service, count(DISTINCT r.id) AS runs, count(h.id) AS hypotheses
       FROM incidents i JOIN triage_runs r ON r.incident_id = i.id AND r.status = 'succeeded'
       LEFT JOIN hypotheses h ON h.triage_run_id = r.id
       WHERE i.service LIKE '%-storm' GROUP BY i.service ORDER BY i.service`,
    );
    expect(reports).toEqual([
      { service: 'accounting-storm', runs: '1', hypotheses: '1' },
      { service: 'checkout-storm', runs: '1', hypotheses: '1' },
    ]);

    // A late final failure for a job whose report committed (its worker lost the lock mid-commit,
    // so BullMQ failed it as stalled) must not dead-letter it: a redrive would write a second report.
    const [storm1] = await rows<{ id: string }>(
      `SELECT id FROM incidents WHERE service = 'checkout-storm'`,
    );
    const triaged = await h.queue(QUEUES.triage).getJob(jobIds.triage(storm1?.id ?? ''));
    if (!triaged) throw new Error('the completed triage job is missing');
    const deadLetterQueue = h.queue(DEAD_LETTER_QUEUES.triage);
    expect(
      await deadLetterTriage(
        { db: database.db, deadLetterQueue },
        triaged,
        new Error('job stalled more than allowable limit'),
        [],
      ),
    ).toBe('already_succeeded');
    expect(await deadLetterQueue.getWaitingCount()).toBe(0);

    await h.runtime.shutdown();
    await h.closeQueues();
  });

  it('retries a retryable triage failure 5 times, then dead-letters it with its history', async () => {
    const { triager, calls } = failing({
      kind: 'upstream_unavailable',
      message: 'model provider returned 503',
      status: 503,
    });
    const h = harness(triager);
    await h.enqueue(delivery('GrpcServerErrors', 'payment-retry', 1));
    await h.idle();

    expect(calls.count).toBe(5);
    const entries = await h.queue(DEAD_LETTER_QUEUES.triage).getJobs(['waiting']);
    expect(entries).toHaveLength(1);
    const deadLetter = triageDeadLetterSchema.parse(entries[0]?.data);
    expect(deadLetter).toMatchObject({
      errorClass: 'RetryableError',
      failedReason: 'model provider returned 503',
      job: { trigger: 'new_incident' },
    });
    // The whole history: every attempt, in order, with what failed and when.
    expect(deadLetter.attempts.map((a) => [a.attempt, a.errorClass, a.message])).toEqual(
      [1, 2, 3, 4, 5].map((n) => [n, 'RetryableError', 'model provider returned 503']),
    );
    const times = deadLetter.attempts.map((a) => Date.parse(a.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(deadLetter.job.attempts).toEqual(deadLetter.attempts);
    expect(deadLetter.lastStack).toContain('RetryableError');

    const [run] = await rows<{
      status: string;
      failure_reason: string;
      attempts: number;
      incident: string;
    }>(
      `SELECT r.status, r.failure_reason, r.attempts, i.status AS incident
       FROM triage_runs r JOIN incidents i ON i.id = r.incident_id WHERE i.service = 'payment-retry'`,
    );
    expect(run).toEqual({
      status: 'failed',
      failure_reason: 'model_unavailable',
      attempts: 5,
      incident: 'open',
    });
    await h.runtime.shutdown();
    await h.closeQueues();
  });

  it("retries a job that fails 4 times, and keeps the 5th attempt's success", async () => {
    const { triager, calls } = flaky([
      { kind: 'rate_limited', message: 'model provider returned 429', retryAfterMs: 50 },
      { kind: 'upstream_unavailable', message: 'model provider returned 503', status: 503 },
      { kind: 'timeout', message: 'model call timed out' },
      { kind: 'upstream_unavailable', message: 'model provider returned 529', status: 529 },
    ]);
    const h = harness(triager);
    await h.enqueue(delivery('CPUThrottlingHigh', 'ad-flaky', 1));
    await h.idle();

    expect(calls.count).toBe(5);
    const [incident] = await rows<{ id: string; status: string }>(
      `SELECT id, status FROM incidents WHERE service = 'ad-flaky'`,
    );
    expect(incident?.status).toBe('triaged');
    const runs = await rows(
      `SELECT r.status, r.attempts, r.failure_reason, count(h.id) AS hypotheses
       FROM triage_runs r LEFT JOIN hypotheses h ON h.triage_run_id = r.id
       WHERE r.incident_id = $1 GROUP BY r.id`,
      [incident?.id],
    );
    // One run across all five attempts, one report, no failure left behind.
    expect(runs).toEqual([
      { status: 'succeeded', attempts: 5, failure_reason: null, hypotheses: '1' },
    ]);

    const job = await h.queue(QUEUES.triage).getJob(jobIds.triage(incident?.id ?? ''));
    expect(await job?.getState()).toBe('completed');
    expect(
      triageJobSchema.parse(job?.data).attempts.map((a) => [a.attempt, a.errorClass, a.message]),
    ).toEqual([
      [1, 'RetryableError', 'model provider returned 429'],
      [2, 'RetryableError', 'model provider returned 503'],
      [3, 'RetryableError', 'model call timed out'],
      [4, 'RetryableError', 'model provider returned 529'],
    ]);
    expect(await h.queue(DEAD_LETTER_QUEUES.triage).getWaitingCount()).toBe(0);
    await h.runtime.shutdown();
    await h.closeQueues();
  });

  it('turns 50 concurrent redeliveries Redis has forgotten into one ingest', async () => {
    // Past the 24-hour Redis key (or after a Redis loss) each redelivery gets a fresh ingest id, so
    // neither the API nor BullMQ can tell them apart. The unique idempotency key in Postgres can.
    const h = harness(baselineTriager(), { INGEST_CONCURRENCY: '16' });
    const original = delivery('PodCrashLooping', 'frontend-backstop', 3);
    await Promise.all(
      Array.from({ length: 50 }, () => h.enqueue({ ...original, ingestId: randomUUID() })),
    );
    await h.idle();

    const [ingests] = await rows<{ count: string }>(
      `SELECT count(*) FROM ingests WHERE idempotency_key = $1`,
      [original.idempotencyKey],
    );
    expect(ingests?.count).toBe('1');
    const [alerts] = await rows<{ count: string }>(
      `SELECT count(*) FROM alerts a JOIN ingests i ON i.id = a.ingest_id
       WHERE i.idempotency_key = $1`,
      [original.idempotencyKey],
    );
    expect(alerts?.count).toBe('3');
    expect(
      await rows(
        `SELECT i.alert_count, count(r.id) AS runs FROM incidents i
         LEFT JOIN triage_runs r ON r.incident_id = i.id
         WHERE i.service = 'frontend-backstop' GROUP BY i.id`,
      ),
    ).toEqual([{ alert_count: 3, runs: '1' }]);

    const completed = await h.queue(QUEUES.ingest).getJobs(['completed'], 0, -1);
    const outcomes = completed.map((job) => (job.returnvalue as { duplicate: boolean }).duplicate);
    expect(outcomes.filter((duplicate) => !duplicate)).toHaveLength(1);
    expect(outcomes.filter(Boolean)).toHaveLength(49);
    await h.runtime.shutdown();
    await h.closeQueues();
  });

  it('stores the actions a triage proposes as pending, for a person: nothing executes', async () => {
    const change = 'change:config-payment-2026-10-01T11:59:30Z';
    const model = scriptedModel([
      toolUse([
        { name: 'query_logs', input: { service: 'payment' } },
        { name: 'list_deploys', input: {} },
      ]),
      toolUse([
        {
          name: 'propose_action',
          input: {
            action: { kind: 'rollback', service: 'payment', changeId: change },
            rationale: 'Charge failures began with this config change.',
            evidence: ['log:pay-7f3a', change],
          },
        },
      ]),
      answer({
        summary: 'payment Charge rejects tokens since a config change.',
        hypotheses: [
          {
            title: 'payment Charge rejects tokens',
            explanation: 'payment logs show Invalid token after the change.',
            confidence: 0.8,
            suspect: 'payment',
            faultClass: 'application_error',
            evidence: ['log:pay-7f3a', change],
          },
        ],
      }),
    ]);
    const triager = claudeTriager({
      model: 'claude-opus-5-5',
      client: model,
      tools: paymentTelemetry().handlers,
    });
    const h = harness(triager);
    // Its own service, so the alert opens a new incident rather than joining another test's.
    await h.enqueue(delivery('GrpcServerErrors', 'payment-proposals', 1));
    await h.idle();

    const actions = await rows<{
      kind: string;
      status: string;
      payload: unknown;
      payload_hash: string;
    }>(
      `SELECT a.kind, a.status, a.payload, a.payload_hash FROM proposed_actions a
       JOIN incidents i ON i.id = a.incident_id WHERE i.service = 'payment-proposals'`,
    );
    expect(actions).toEqual([
      {
        kind: 'rollback',
        status: 'pending_approval',
        payload: { kind: 'rollback', service: 'payment', changeId: change },
        payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      },
    ]);
    // The hash the executor will check still matches the payload after a round trip through jsonb.
    expect(payloadHash(actions[0]?.payload)).toBe(actions[0]?.payload_hash);
    expect(await rows('SELECT * FROM approvals')).toEqual([]);
    const [run] = await rows<{ stop_reason: string; fault_class: string; tool_calls: number }>(
      `SELECT r.stop_reason, h.fault_class, r.tool_calls FROM triage_runs r
       JOIN incidents i ON i.id = r.incident_id JOIN hypotheses h ON h.triage_run_id = r.id
       WHERE i.service = 'payment-proposals'`,
    );
    expect(run).toEqual({
      stop_reason: 'report_submitted',
      fault_class: 'application_error',
      tool_calls: 3,
    });
    await h.runtime.shutdown();
    await h.closeQueues();
  });

  it('dead-letters a fatal triage failure after one attempt', async () => {
    const { triager, calls } = failing({
      kind: 'request_rejected',
      message: 'invalid_request_error: prompt is malformed',
      status: 400,
    });
    const h = harness(triager);
    await h.enqueue(delivery('MemoryUsageHigh', 'cart-fatal', 1));
    await h.idle();

    expect(calls.count).toBe(1);
    const [entry] = await h.queue(DEAD_LETTER_QUEUES.triage).getJobs(['waiting']);
    expect(triageDeadLetterSchema.parse(entry?.data)).toMatchObject({
      errorClass: 'FatalError',
      attempts: [{ attempt: 1, errorClass: 'FatalError' }],
    });
    const [run] = await rows<{ failure_reason: string }>(
      `SELECT r.failure_reason FROM triage_runs r JOIN incidents i ON i.id = r.incident_id
       WHERE i.service = 'cart-fatal'`,
    );
    expect(run?.failure_reason).toBe('request_rejected');
    await h.runtime.shutdown();
    await h.closeQueues();
  });

  it('drains an in-flight triage job on shutdown instead of abandoning it', async () => {
    const h = harness(baselineTriager({ latencyMs: 1_500 }));
    await h.enqueue(delivery('HighLatencyP99', 'shipping-drain', 1));
    const deadline = Date.now() + 15_000;
    while ((await h.queue(QUEUES.triage).getActiveCount()) === 0) {
      if (Date.now() > deadline) throw new Error('triage never started');
      await sleep(50);
    }

    expect(await h.runtime.shutdown(30_000)).toBe('drained');
    const [run] = await rows<{ status: string }>(
      `SELECT r.status FROM triage_runs r JOIN incidents i ON i.id = r.incident_id
       WHERE i.service = 'shipping-drain'`,
    );
    expect(run?.status).toBe('succeeded');
    await h.closeQueues();
  });

  it('caps triage throughput with the rate limiter', async () => {
    const h = harness(baselineTriager(), { TRIAGE_MAX_PER_MINUTE: '2' });
    // Four unrelated alerts, so neither fingerprint nor similarity merges them: four triage jobs.
    for (const [alertname, service] of [
      ['KafkaConsumerLag', 'limit-accounting'],
      ['PodCrashLooping', 'limit-frontend'],
      ['TargetDown', 'limit-quote'],
      ['CPUThrottlingHigh', 'limit-recommendation'],
    ] as const) {
      await h.enqueue(delivery(alertname, service, 1));
    }
    await sleep(4_000);

    const [triaged] = await rows<{ count: string }>(
      `SELECT count(*) FROM triage_runs r JOIN incidents i ON i.id = r.incident_id
       WHERE i.service LIKE 'limit-%' AND r.status = 'succeeded'`,
    );
    expect(triaged?.count).toBe('2');
    const held = await h.queue(QUEUES.triage).getJobCounts('waiting', 'delayed', 'prioritized');
    expect(Object.values(held).reduce((a, b) => a + b, 0)).toBe(2);
    await h.runtime.shutdown();
    await h.closeQueues();
  });
});
