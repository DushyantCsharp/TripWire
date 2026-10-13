// What a k6 storm run measured, against the brief's targets (infra/load/run.sh calls it):
//   pnpm --filter @tripwire/evals load-report --run <id> --from <iso> --to <iso> --summary <k6 json>
// Client side from k6's summary; server side from Prometheus (the api and worker's metrics);
// dedupe from Postgres (incidents against the problem each alert stood for); one sampled trace
// from Jaeger. Writes <summary dir>/<run>.report.{md,json} and prints the markdown.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadEnvOrExit } from '@tripwire/config';
import { createDatabase, loadRunAssignments } from '@tripwire/db';
import { z } from 'zod';
import { adjustedRandIndex } from './ari.js';
import { CLUSTER_SIMILARITY_THRESHOLD } from './replay/incident.js';
import { templateSimilarity } from './storm.js';

const env = loadEnvOrExit(
  z.object({
    DATABASE_URL: z.url(),
    PROMETHEUS_URL: z.url().default('http://localhost:19090'),
    JAEGER_URL: z.url().default('http://localhost:16687'),
  }),
);

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    summary: { type: 'string' },
    expect: { type: 'string', default: 'ack' },
    drained: { type: 'string' },
    'sample-ratio': { type: 'string', default: '0.01' },
  },
});
const args = z
  .object({
    run: z.string().min(1),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    /** When the worker's backlog was gone (default now): triage is read up to here. */
    drained: z.iso.datetime().optional(),
    summary: z.string().min(1),
    expect: z.enum(['ack', 'shed']),
    'sample-ratio': z.coerce.number().min(0).max(1),
  })
  .parse(values);

const from = new Date(args.from);
const to = new Date(args.to);
const windowSeconds = Math.max(1, Math.round((to.getTime() - from.getTime()) / 1000));

// k6's summary: only the parts read here.
const summary = z
  .object({
    metrics: z.record(z.string(), z.looseObject({ values: z.record(z.string(), z.number()) })),
  })
  .parse(JSON.parse(readFileSync(args.summary, 'utf8')));
const metric = (name: string) => summary.metrics[name]?.values ?? {};

async function promql(query: string, at: Date = to) {
  const url = new URL('/api/v1/query', env.PROMETHEUS_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('time', String(at.getTime() / 1000));
  const body = z
    .object({
      data: z.object({
        result: z.array(
          z.object({
            metric: z.record(z.string(), z.string()),
            value: z.tuple([z.number(), z.string()]),
          }),
        ),
      }),
    })
    .parse(await (await fetch(url)).json());
  return body.data.result.map((r) => ({ labels: r.metric, value: Number(r.value[1]) }));
}
// histogram_quantile of nothing is NaN.
const scalar = async (query: string, at?: Date) => {
  const value = (await promql(query, at))[0]?.value;
  return value === undefined || Number.isNaN(value) ? null : value;
};
const W = `${String(windowSeconds)}s`;

// run.sh starts a fresh api and worker for each run, so a counter's last value in the window is
// the run's total. increase() would lose whatever the first export already held: a series only
// appears when first recorded, and the baseline triager finishes its runs within one export.
const total = (metric: string, window = W) => `last_over_time(${metric}[${window}])`;
const quantile = (q: number, buckets: string, window = W) =>
  `histogram_quantile(${String(q)}, sum by (le) (${total(buckets, window)}))`;

const server = {
  ackP50: await scalar(quantile(0.5, 'ingest_ack_latency_seconds_bucket{status="202"}')),
  ackP99: await scalar(quantile(0.99, 'ingest_ack_latency_seconds_bucket{status="202"}')),
  responses: await promql(`sum by (status) (${total('ingest_ack_latency_seconds_count')})`),
  shed: await promql(`sum by (reason) (${total('shed_requests_total')})`),
  peakWaiting: await promql(`max by (queue) (max_over_time(queue_depth{state="waiting"}[${W}]))`),
  dlqMax: await scalar(`max(max_over_time(dlq_size[${W}]))`),
};

// Triage runs through the drain after the run.
const drained = args.drained === undefined ? new Date() : new Date(args.drained);
const drainWindow = `${String(Math.max(1, Math.round((drained.getTime() - from.getTime()) / 1000)))}s`;
const triage = {
  runs: await scalar(`sum(${total('triage_duration_seconds_count', drainWindow)})`, drained),
  p50: await scalar(quantile(0.5, 'triage_duration_seconds_bucket', drainWindow), drained),
  p95: await scalar(quantile(0.95, 'triage_duration_seconds_bucket', drainWindow), drained),
};

// Dedupe: every alert of the run, by the problem it stood for and the incident it joined.
const { db, pool } = createDatabase(env.DATABASE_URL);
const assignments = await loadRunAssignments(db, args.run);
await pool.end();
if (!assignments.ok) throw new Error(`reading the run's alerts: ${assignments.error.message}`);
// Scored over the alerts clustered so far: a backlog left after the drain is reported, not waited on.
const rows = assignments.value.flatMap((r) =>
  r.incidentId === null ? [] : [{ truth: r.truth, incidentId: r.incidentId }],
);
const ari = adjustedRandIndex(rows.map((r) => ({ truth: r.truth, cluster: r.incidentId })));
const incidentsPerProblem = new Map<string, Set<string>>();
for (const row of rows) {
  const set = incidentsPerProblem.get(row.truth) ?? new Set<string>();
  set.add(row.incidentId);
  incidentsPerProblem.set(row.truth, set);
}
const similarity = await templateSimilarity();

// A sampled trace from the run, and how far through the pipeline it reaches.
const STAGES = [
  'POST /v1/webhooks/alertmanager',
  'send ingest',
  'process ingest',
  'send cluster',
  'process cluster',
  'send triage',
  'process triage',
  'triage',
];
const tracesUrl = new URL('/api/traces', env.JAEGER_URL);
tracesUrl.searchParams.set('service', 'tripwire-api');
tracesUrl.searchParams.set('start', String(from.getTime() * 1000));
tracesUrl.searchParams.set('end', String(drained.getTime() * 1000));
tracesUrl.searchParams.set('limit', '200');
const traces = z
  .object({
    data: z.array(
      z.object({ traceID: z.string(), spans: z.array(z.object({ operationName: z.string() })) }),
    ),
  })
  .parse(await (await fetch(tracesUrl)).json()).data;
const reach = (spans: readonly { operationName: string }[]) => {
  const names = new Set(spans.map((s) => s.operationName));
  let reached = 0;
  for (const stage of STAGES) {
    if (!names.has(stage)) break;
    reached += 1;
  }
  return reached;
};
const furthest = traces
  .map((t) => ({ id: t.traceID, reached: reach(t.spans), spans: t.spans.length }))
  .sort((a, b) => b.reached - a.reached)[0];

// The report.
const ms = (seconds: number | null) =>
  seconds === null ? 'n/a' : `${(seconds * 1000).toFixed(1)} ms`;
const fixed = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? 'n/a' : n.toFixed(digits);
const accepted = metric('http_req_duration{status:202}');
const requests = metric('http_reqs');
const responseCount = (status: string) =>
  server.responses.find((r) => r.labels.status === status)?.value ?? 0;
const totalResponses = server.responses.reduce((sum, r) => sum + r.value, 0);

const report = {
  run: args.run,
  expect: args.expect,
  window: { from: args.from, to: args.to, seconds: windowSeconds },
  client: {
    requests: requests.count ?? 0,
    rate: requests.rate ?? 0,
    acceptedMs: {
      p50: accepted.med ?? null,
      p95: accepted['p(95)'] ?? null,
      p99: accepted['p(99)'] ?? null,
      max: accepted.max ?? null,
    },
    checks: metric('checks').rate ?? null,
    droppedIterations: metric('dropped_iterations').count ?? 0,
  },
  server: {
    ...server,
    shareShed: totalResponses === 0 ? null : responseCount('503') / totalResponses,
  },
  dedupe: {
    alerts: assignments.value.length,
    clustered: rows.length,
    incidents: new Set(rows.map((r) => r.incidentId)).size,
    problems: incidentsPerProblem.size,
    ari,
    incidentsPerProblem: Object.fromEntries(
      [...incidentsPerProblem].map(([truth, set]) => [truth, set.size]),
    ),
    similarityWithin: Object.fromEntries(similarity.within),
    similarityAcross: similarity.across,
    threshold: CLUSTER_SIMILARITY_THRESHOLD,
  },
  triage,
  trace: { sampled: traces.length, sampleRatio: args['sample-ratio'], furthest },
};

const { acceptedMs } = report.client;
const lines = [
  `## Storm run \`${args.run}\` (${args.expect === 'ack' ? 'high-water raised: nothing shed' : 'default high-water: shedding'})`,
  '',
  `${String(report.client.requests)} requests at ${fixed(report.client.rate, 0)}/s over ${String(windowSeconds)} s (a ramp, then the steady rate); dropped iterations ${String(report.client.droppedIterations)}; checks passed ${fixed((report.client.checks ?? 0) * 100, 3)}%.`,
  '',
  '| Measure | Value |',
  '| --- | --- |',
  `| 202 latency, client (k6) p50 / p95 / p99 / max | ${fixed(acceptedMs.p50)} / ${fixed(acceptedMs.p95)} / ${fixed(acceptedMs.p99)} / ${fixed(acceptedMs.max)} ms |`,
  `| 202 latency, server (ingest_ack_latency) p50 / p99 | ${ms(server.ackP50)} / ${ms(server.ackP99)} (interpolated within buckets) |`,
  `| Responses (server) | ${server.responses.map((r) => `${r.labels.status ?? '?'}: ${fixed(r.value, 0)}`).join(', ') || 'none'} |`,
  `| Shed (503) | ${report.server.shareShed === null ? 'n/a' : `${fixed(report.server.shareShed * 100, 1)}%`} (${server.shed.map((r) => `${r.labels.reason ?? '?'}: ${fixed(r.value, 0)}`).join(', ') || 'none'}) |`,
  `| Peak waiting jobs | ${server.peakWaiting.map((r) => `${r.labels.queue ?? '?'} ${fixed(r.value, 0)}`).join(', ') || 'n/a'} |`,
  `| Dead letters (max) | ${fixed(server.dlqMax, 0)} |`,
  `| Dedupe: alerts stored / clustered / incidents / problems | ${String(report.dedupe.alerts)} / ${String(report.dedupe.clustered)} / ${String(report.dedupe.incidents)} / ${String(report.dedupe.problems)} |`,
  `| Dedupe ARI | ${fixed(ari, 3)} |`,
  `| Triage (baseline triager) runs, p50 / p95 | ${fixed(triage.runs, 0)}, ${ms(triage.p50)} / ${ms(triage.p95)} |`,
  `| Sampled traces (ratio ${String(args['sample-ratio'])}) | ${String(traces.length)}; furthest reaches \`${furthest ? (STAGES[furthest.reached - 1] ?? 'nothing') : 'none'}\`${furthest ? ` (${furthest.id})` : ''} |`,
  '',
  `Incidents per problem: ${[...incidentsPerProblem].map(([truth, set]) => `${truth} ${String(set.size)}`).join(', ')}.`,
  `Similarity of each problem's two alert rules (they merge at ≥ ${String(CLUSTER_SIMILARITY_THRESHOLD)}): ${[...similarity.within].map(([truth, s]) => `${truth} ${s.toFixed(2)}`).join(', ')}; closest two problems ${similarity.across.toFixed(2)}.`,
  '',
];
const markdown = lines.join('\n');
const base = join(dirname(args.summary), `${args.run}.report`);
writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${base}.md`, `${markdown}\n`);
process.stdout.write(`${markdown}\n`);
