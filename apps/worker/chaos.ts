// Chaos test for ingest → cluster → triage. Runs real worker processes, SIGKILLs one mid-job again
// and again while alert storms arrive (with replays and redeliveries), lets the survivors recover
// the stalled jobs, then checks the database for duplicate incidents and duplicate triage reports.
//
//   just chaos [--rounds=12] [--workers=2] [--identities=12] [--keep]
//
// Needs Postgres and Redis from `just infra-up`. Works in a throwaway database and queue prefix,
// dropped afterwards unless --keep. Exits 1 if any check fails.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { baseEnv, loadEnvOrExit } from '@tripwire/config';
import {
  DEAD_LETTER_QUEUES,
  type IngestJob,
  jobIds,
  jobOptions,
  QUEUES,
} from '@tripwire/contracts/queues';
import { createDatabase } from '@tripwire/db';
import { migrateUp } from '@tripwire/db/migrator';
import { Queue, QueueEvents } from 'bullmq';
import { z } from 'zod';

const { values: args } = parseArgs({
  options: {
    rounds: { type: 'string', default: '12' },
    workers: { type: 'string', default: '2' },
    identities: { type: 'string', default: '12' },
    keep: { type: 'boolean', default: false },
  },
});
const ROUNDS = Number(args.rounds);
const WORKERS = Number(args.workers);
const DELIVERIES_PER_IDENTITY = 3;
const ALERTS_PER_DELIVERY = 30;

const env = loadEnvOrExit(baseEnv.extend({ DATABASE_URL: z.url(), REDIS_URL: z.url() }));
const runId = `chaos_${Date.now().toString(36)}`;
const prefix = runId.replace('_', '-');
const logDir = mkdtempSync(join(tmpdir(), `tripwire-${prefix}-`));
const say = (message: string) => process.stdout.write(`[chaos] ${message}\n`);

// Distinct words in each, so the embedding fallback never merges two of them.
const IDENTITIES = [
  ['KafkaConsumerLag', 'accounting'],
  ['PodCrashLooping', 'frontend'],
  ['TargetDown', 'quote'],
  ['CPUThrottlingHigh', 'recommendation'],
  ['HighErrorRate', 'checkout'],
  ['PaymentLatencySpike', 'payment'],
  ['CartRedisTimeouts', 'cart'],
  ['AdServiceFlagFailure', 'ad'],
  ['ShippingRatesMissing', 'shipping'],
  ['EmailQueueBacklog', 'email'],
  ['CurrencyConversionFailures', 'currency'],
  ['ImageProviderSlow', 'image-provider'],
].slice(0, Number(args.identities));

// ---------------------------------------------------------------------------------------------
// Setup: a database and queue prefix of our own.

const admin = createDatabase(env.DATABASE_URL).pool;
const databaseUrl = new URL(env.DATABASE_URL);
databaseUrl.pathname = `/${runId}`;
await admin.query(`CREATE DATABASE ${runId}`);
const { pool } = createDatabase(databaseUrl.toString());
const migrated = await migrateUp(pool);
if (!migrated.ok) throw new Error(`migrations failed: ${migrated.error.message}`);

const queueOptions = { connection: { url: env.REDIS_URL }, prefix };
const pipeline = [QUEUES.ingest, QUEUES.cluster, QUEUES.triage] as const;
const queues = Object.fromEntries(
  [...pipeline, QUEUES.backfill, DEAD_LETTER_QUEUES.triage].map((name) => [
    name,
    new Queue(name, queueOptions),
  ]),
);
const queue = (name: string) => {
  const found = queues[name];
  if (!found) throw new Error(`no queue ${name}`);
  return found;
};

// Stalled-job recoveries prove the kills landed mid-job.
const stalled: Record<string, number> = {};
const events = await Promise.all(
  pipeline.map(async (name) => {
    const queueEvents = new QueueEvents(name, queueOptions);
    queueEvents.on('stalled', () => {
      stalled[name] = (stalled[name] ?? 0) + 1;
    });
    await queueEvents.waitUntilReady();
    return queueEvents;
  }),
);

// ---------------------------------------------------------------------------------------------
// Workers: real processes, the same entrypoint as production.

interface WorkerProcess {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
}
let spawned = 0;
const workers: WorkerProcess[] = [];

/** The environment without the model provider's key, which .env may hold. */
function withoutModelKey(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ANTHROPIC_API_KEY: _key, ...rest } = environment;
  return rest;
}

function spawnWorker(): WorkerProcess {
  const generation = ++spawned;
  const log = createWriteStream(join(logDir, `worker-${String(generation)}.log`));
  const child = spawn(
    process.execPath,
    ['--conditions=@tripwire/source', '--import', 'tsx', 'src/main.ts'],
    {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...withoutModelKey(process.env),
        // The model-free triager: chaos tests the pipeline, and must never spend on a model.
        TRIAGER: 'baseline',
        DATABASE_URL: databaseUrl.toString(),
        REDIS_URL: env.REDIS_URL,
        QUEUE_PREFIX: prefix,
        // Slow enough that a kill usually lands while a triage is in flight.
        TRIAGE_SIMULATED_LATENCY_MS: '1500',
        TRIAGE_MAX_PER_MINUTE: '600',
        // Short locks, so the survivors notice a dead worker's jobs quickly.
        JOB_LOCK_MS: '3000',
        // Every kill stalls a job; it must be retried, never failed for stalling.
        MAX_STALLED_COUNT: '1000',
        FINGERPRINT_V2_WRITE: 'true',
        FINGERPRINT_V2_READ: 'true',
      },
    },
  );
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, exited };
}

process.once('exit', () => {
  for (const { child } of workers) child.kill('SIGKILL');
});

// ---------------------------------------------------------------------------------------------
// Workload: storms of pod-level alerts per identity, plus replays (same ingest job again, which
// BullMQ drops) and redeliveries (same idempotency key under a new ingest id, as if Redis had lost
// the key, which Postgres's unique key absorbs).

function delivery(identity: number, n: number): IngestJob {
  const [name = '', service = ''] = IDENTITIES[identity] ?? [];
  const payload = {
    source: 'chaos',
    alerts: Array.from({ length: ALERTS_PER_DELIVERY }, (_, i) => ({
      name,
      status: 'firing',
      severity: i % 5 === 0 ? 'critical' : 'warning',
      service,
      labels: { pod: `${service}-${String(n)}-${String(i)}` },
      starts_at: new Date().toISOString(),
    })),
  };
  return {
    ingestId: randomUUID(),
    idempotencyKey: `${runId}-${String(identity)}-${String(n)}`,
    bodyHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    source: 'generic',
    receivedAt: new Date().toISOString(),
    payload,
  };
}

const originals = IDENTITIES.flatMap((_, identity) =>
  Array.from({ length: DELIVERIES_PER_IDENTITY }, (_, n) => delivery(identity, n)),
);
const replays = originals.filter((_, i) => i % 3 === 0);
const redeliveries = originals
  .filter((_, i) => i % 4 === 1)
  .map((job) => ({ ...job, ingestId: randomUUID() }));
// Originals in random order; their replays and redeliveries some time after.
const stream = [...shuffle(originals), ...shuffle([...replays, ...redeliveries])];

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const enqueue = (jobs: readonly IngestJob[]) =>
  queue(QUEUES.ingest).addBulk(
    jobs.map((job) => ({
      name: 'ingest',
      data: job,
      opts: { ...jobOptions.ingest, jobId: jobIds.ingest(job.ingestId) },
    })),
  );

async function pendingJobs(): Promise<number> {
  const counts = await Promise.all(
    pipeline.map((name) =>
      queue(name).getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children'),
    ),
  );
  return counts.flatMap((count) => Object.values(count)).reduce((a, b) => a + b, 0);
}

async function waitUntilIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (Date.now() < deadline) {
    quiet = (await pendingJobs()) === 0 ? quiet + 1 : 0;
    // Idle across a lock period, so a dead worker's "active" jobs had time to show up as stalled.
    if (quiet >= 8) return true;
    await sleep(500);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Checks. Each query returns the rows that violate an invariant.

interface Check {
  readonly name: string;
  readonly sql: string;
}

const CHECKS: readonly Check[] = [
  {
    name: 'no fingerprint is split across incidents (no duplicate incidents)',
    sql: `SELECT a.fingerprint_v2, count(DISTINCT ia.incident_id) AS incidents
          FROM alerts a JOIN incident_alerts ia ON ia.alert_id = a.id
          GROUP BY a.fingerprint_v2 HAVING count(DISTINCT ia.incident_id) > 1`,
  },
  {
    name: 'every alert belongs to exactly one incident',
    sql: `SELECT a.id FROM alerts a LEFT JOIN incident_alerts ia ON ia.alert_id = a.id
          WHERE ia.alert_id IS NULL`,
  },
  {
    name: 'replays and redeliveries wrote no alerts',
    sql: `SELECT count(*) AS alerts FROM alerts HAVING count(*) <> ${String(originals.length * ALERTS_PER_DELIVERY)}
          UNION ALL
          SELECT count(*) FROM ingests HAVING count(*) <> ${String(originals.length)}`,
  },
  {
    name: 'incidents.alert_count matches the alerts linked',
    sql: `SELECT i.id, i.alert_count, count(ia.alert_id) AS linked
          FROM incidents i LEFT JOIN incident_alerts ia ON ia.incident_id = i.id
          GROUP BY i.id HAVING i.alert_count <> count(ia.alert_id)`,
  },
  {
    name: 'at most one incident per identity',
    sql: `SELECT count(*) AS incidents FROM incidents HAVING count(*) > ${String(IDENTITIES.length)}`,
  },
  {
    name: 'every incident has exactly one triage run, and it succeeded',
    sql: `SELECT i.id, i.status, count(tr.id) AS runs,
                 count(tr.id) FILTER (WHERE tr.status = 'succeeded') AS succeeded
          FROM incidents i LEFT JOIN triage_runs tr ON tr.incident_id = i.id
          GROUP BY i.id
          HAVING count(tr.id) <> 1 OR count(tr.id) FILTER (WHERE tr.status = 'succeeded') <> 1
              OR i.status <> 'triaged'`,
  },
  {
    name: 'every incident has exactly one triage report (no duplicate reports)',
    sql: `SELECT tr.incident_id, count(DISTINCT h.triage_run_id) AS reports
          FROM hypotheses h JOIN triage_runs tr ON tr.id = h.triage_run_id
          GROUP BY tr.incident_id HAVING count(DISTINCT h.triage_run_id) <> 1
          UNION ALL
          SELECT i.id, 0 FROM incidents i
          WHERE NOT EXISTS (SELECT 1 FROM triage_runs tr JOIN hypotheses h ON h.triage_run_id = tr.id
                            WHERE tr.incident_id = i.id)`,
  },
  {
    name: 'only succeeded runs have a report',
    sql: `SELECT DISTINCT tr.id, tr.status FROM triage_runs tr
          JOIN hypotheses h ON h.triage_run_id = tr.id WHERE tr.status <> 'succeeded'`,
  },
];

// ---------------------------------------------------------------------------------------------

const failures: string[] = [];
const fail = (message: string) => {
  failures.push(message);
  say(`FAIL ${message}`);
};

try {
  say(`database ${runId}, queue prefix ${prefix}, worker logs in ${logDir}`);
  say(
    `${String(IDENTITIES.length)} identities × ${String(DELIVERIES_PER_IDENTITY)} deliveries × ` +
      `${String(ALERTS_PER_DELIVERY)} alerts, plus ${String(replays.length)} replays and ` +
      `${String(redeliveries.length)} redeliveries; ${String(WORKERS)} workers, ${String(ROUNDS)} kills`,
  );
  for (let i = 0; i < WORKERS; i++) workers.push(spawnWorker());

  const perRound = Math.ceil(stream.length / ROUNDS);
  for (let round = 0; round < ROUNDS; round++) {
    await enqueue(stream.slice(round * perRound, (round + 1) * perRound));
    // Sometimes right away, while ingest and cluster are busy; sometimes later, mid-triage.
    await sleep(randomInt(25, 2_000));

    const active = await Promise.all(pipeline.map((name) => queue(name).getActiveCount()));
    const victim = randomInt(workers.length);
    const target = workers[victim];
    if (!target) throw new Error('no worker to kill');
    target.child.kill('SIGKILL');
    await target.exited;
    say(
      `round ${String(round + 1)}: SIGKILL worker ${String(target.child.pid)} with ` +
        `${pipeline.map((name, i) => `${name}=${String(active[i])}`).join(' ')} active`,
    );
    await sleep(randomInt(100, 1_000));
    workers[victim] = spawnWorker();
  }

  say('kills done; waiting for the survivors to finish every job');
  if (!(await waitUntilIdle(180_000))) fail('the pipeline did not drain within 3 minutes');

  // A stalled job is one a killed worker held mid-flight and a survivor picked up again.
  say(`jobs killed mid-flight and recovered: ${JSON.stringify(stalled)}`);
  if (!stalled[QUEUES.triage]) {
    fail('no kill interrupted a triage job, so this run proves nothing; try more --rounds');
  }
  const restarted = await pool.query<{ restarted: string }>(
    `SELECT count(*) AS restarted FROM triage_runs WHERE attempts > 1`,
  );
  say(`triage runs that restarted on their existing row: ${restarted.rows[0]?.restarted ?? '0'}`);

  for (const check of CHECKS) {
    const { rows } = await pool.query(check.sql);
    if (rows.length === 0) say(`ok   ${check.name}`);
    else fail(`${check.name}: ${JSON.stringify(rows.slice(0, 5))}`);
  }

  const leftovers = await Promise.all([
    queue(DEAD_LETTER_QUEUES.triage).getJobCounts('waiting'),
    ...pipeline.map((name) => queue(name).getJobCounts('failed')),
  ]);
  if (leftovers.some((counts) => Object.values(counts).some((n) => n > 0))) {
    fail(`jobs failed or were dead-lettered: ${JSON.stringify(leftovers)}`);
  } else {
    say('ok   nothing failed and the dead-letter queue is empty');
  }

  const summary = await pool.query<{ incidents: string; alerts: string; runs: string }>(
    `SELECT (SELECT count(*) FROM incidents) AS incidents, (SELECT count(*) FROM alerts) AS alerts,
            (SELECT count(*) FROM triage_runs) AS runs`,
  );
  say(`final state: ${JSON.stringify(summary.rows[0])}`);
} finally {
  // Graceful stop for the survivors: SIGTERM drains in-flight jobs within SHUTDOWN_TIMEOUT_MS.
  for (const { child } of workers) child.kill('SIGTERM');
  const codes = await Promise.race([
    Promise.all(workers.map(({ exited }) => exited)),
    sleep(40_000).then(() => null),
  ]);
  if (codes?.every((code) => code === 0)) say('ok   workers drained and exited cleanly on SIGTERM');
  else fail(`workers did not exit cleanly on SIGTERM: ${JSON.stringify(codes)}`);

  await Promise.all(events.map((queueEvents) => queueEvents.close()));
  if (!args.keep) {
    await Promise.all(Object.values(queues).map((q) => q.obliterate({ force: true })));
  }
  await Promise.all(Object.values(queues).map((q) => q.close()));
  await pool.end();
  if (args.keep) say(`kept database ${runId} and queue prefix ${prefix}`);
  else await admin.query(`DROP DATABASE IF EXISTS ${runId} WITH (FORCE)`);
  await admin.end();
}

say(failures.length > 0 ? `FAILED (${String(failures.length)} checks)` : 'PASSED');
process.exit(failures.length > 0 ? 1 : 0);
