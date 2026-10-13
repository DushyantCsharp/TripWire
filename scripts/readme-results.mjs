// Rewrites README.md's results block from the latest reports (`just readme`): the k6 storm's
// (infra/load/results/, written by infra/load/run.sh) and the latest live eval's (evals/reports/,
// `just eval`). Both directories are gitignored, so the block names the report, commit and date
// behind every number. The eval's targets are evals/thresholds.json; the load test's are below.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const START = '<!-- results:start -->';
export const END = '<!-- results:end -->';

/** The brief's load targets: ack p99 under 50 ms at 2k req/s, dedupe ARI of 0.9 or more. */
export const LOAD_TARGETS = { ackP99Ms: 50, rate: 2000, ari: 0.9 };

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** The newest run.sh run that left both reports: `storm-<stamp>-ack` and `storm-<stamp>-shed`. */
export function latestLoadRun(dir) {
  if (!existsSync(dir)) return null;
  const runs = new Map();
  for (const name of readdirSync(dir)) {
    const match = /^storm-(\d{8}-\d{6})-(ack|shed)\.report\.json$/.exec(name);
    if (!match) continue;
    const run = runs.get(match[1]) ?? {};
    run[match[2]] = readJson(join(dir, name));
    runs.set(match[1], run);
  }
  const complete = [...runs]
    .filter(([, run]) => run.ack && run.shed)
    .sort(([a], [b]) => b.localeCompare(a));
  return complete[0]?.[1] ?? null;
}

/**
 * The eval to publish: of the runs that measured the model (not replays, not the baseline triager),
 * the newest of those with the most cases, so a two-case debugging run never replaces a full one.
 */
export function latestEval(dir) {
  if (!existsSync(dir)) return null;
  const evals = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'report.json')))
    .map((entry) => ({ name: entry.name, report: readJson(join(dir, entry.name, 'report.json')) }))
    .filter(({ report }) => report.settings?.mode !== 'replay' && report.triager !== 'baseline-v1')
    .sort(
      (a, b) =>
        (b.report.summary.all.n ?? 0) - (a.report.summary.all.n ?? 0) ||
        b.report.generatedAt.localeCompare(a.report.generatedAt),
    );
  return evals[0] ?? null;
}

const missing = (value) => value === null || value === undefined || Number.isNaN(value);
const pct = (rate) => (missing(rate) ? 'n/a' : `${(rate * 100).toFixed(1)}%`);
const fixed = (value, digits = 0) =>
  missing(value)
    ? 'n/a'
    : value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const seconds = (ms) => (missing(ms) ? 'n/a' : `${(ms / 1000).toFixed(1)} s`);
// Targets read as written: 70%, 25 s.
const goalPct = (rate) => `${String(Math.round(rate * 1000) / 10)}%`;
const goalSeconds = (ms) => `${String(ms / 1000)} s`;
const usd = (value) => (missing(value) ? 'n/a' : `$${value.toFixed(value < 0.1 ? 4 : 2)}`);
const status = (passed) => (passed === null ? '–' : passed ? '✅' : '❌');
const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown date');
const all = (...checks) => (checks.some((c) => c === null) ? null : checks.every(Boolean));
const atMost = (value, limit) => (missing(value) ? null : value <= limit);
const atLeast = (value, limit) => (missing(value) ? null : value >= limit);
const below = (value, limit) => (missing(value) ? null : value < limit);

function loadRows(load) {
  if (!load) {
    const pending = 'pending: no load report (`just load-storm`)';
    return [
      ['Ingest ack p99 at 2k req/s', '< 50 ms', pending, null, '–'],
      ['Dedupe ARI', '≥ 0.9', pending, null, '–'],
    ];
  }
  const { ack, shed } = load;
  const source = (report) =>
    `load \`${report.run}\` · \`${report.commit}\` · ${day(report.generatedAt)}`;
  const peakIngest = shed.server.peakWaiting.find((row) => row.labels.queue === 'ingest')?.value;
  return [
    [
      'Ingest ack p99 at 2k req/s',
      '< 50 ms',
      `${fixed(ack.client.acceptedMs.p99)} ms at the client (k6), ` +
        `${fixed((ack.server.ackP99 ?? NaN) * 1000)} ms in the api; ${fixed(ack.client.requests)} ` +
        `requests, ${fixed(ack.client.rate)}/s overall, ${fixed(ack.client.droppedIterations)} ` +
        "that k6 couldn't send on time",
      below(ack.client.acceptedMs.p99, LOAD_TARGETS.ackP99Ms),
      source(ack),
    ],
    [
      'Shedding past the high-water mark',
      '503 with Retry-After',
      `${pct(shed.server.shareShed)} shed, every 503 with Retry-After (k6 checks ` +
        `${pct(shed.client.checks)}); the ingest queue peaked at ${fixed(peakIngest)} waiting`,
      all(atLeast(shed.server.shareShed, 0.0001), atLeast(shed.client.checks, 1)),
      source(shed),
    ],
    [
      'Dedupe ARI',
      '≥ 0.9',
      `${fixed(ack.dedupe.ari, 3)}: ${fixed(ack.dedupe.alerts)} alerts → ` +
        `${fixed(ack.dedupe.incidents)} incidents for ${fixed(ack.dedupe.problems)} problems`,
      atLeast(ack.dedupe.ari, LOAD_TARGETS.ari),
      source(ack),
    ],
    [
      'Ack to incident under the storm (one worker)',
      'no target',
      `${fixed(ack.clustering.perSecond)} alerts clustered/s; an alert waited ` +
        `${fixed(ack.clustering.waitP50Seconds)} s median, ${fixed(ack.clustering.waitMaxSeconds)} s ` +
        `max (${fixed(shed.clustering.waitP50Seconds)} s / ${fixed(shed.clustering.waitMaxSeconds)} s ` +
        'while shedding)',
      null,
      source(ack),
    ],
  ];
}

function evalRows(evaluation, thresholds) {
  const g = thresholds.golden;
  const t = thresholds.all;
  const targets = [
    ['RCA top-1 / top-3 (golden cases)', `≥ ${goalPct(g.top1)} / ≥ ${goalPct(g.top3)}`],
    ['Citation precision', `≥ ${goalPct(t.citationPrecision)}`],
    [
      'Unsafe proposals accepted',
      t.maxUnsafeActionRate === 0 ? 'none' : `≤ ${goalPct(t.maxUnsafeActionRate)} of runs`,
    ],
    ['Partial reports', `≤ ${goalPct(t.maxPartialRate)}`],
    [
      'Triage latency p50 / p95',
      `< ${goalSeconds(t.maxLatencyP50Ms)} / < ${goalSeconds(t.maxLatencyP95Ms)}`,
    ],
    [
      'Per-run budget (worst run)',
      `≤ ${fixed(t.maxInputTokens)} in / ${fixed(t.maxOutputTokens)} out tokens, ` +
        `≤ ${String(t.maxToolCalls)} tool calls`,
    ],
  ];
  if (!evaluation) {
    const pending = 'pending: no live eval report (`just eval`)';
    return targets.map(([target, goal]) => [target, goal, pending, null, '–']);
  }
  const { report, name } = evaluation;
  const { golden, all: every } = report.summary;
  const source =
    `eval \`${name}\` · \`${report.settings.commit ?? 'unknown'}\` · ` +
    `${day(report.generatedAt)} · ${String(every.n)} cases`;
  const ci = (p) => (p.ci ? ` (95% CI ${pct(p.ci[0])}–${pct(p.ci[1])})` : '');
  const measured = [
    [
      `${pct(golden.top1.rate)}${ci(golden.top1)} / ${pct(golden.top3.rate)}; n = ${String(golden.n)}`,
      all(atLeast(golden.top1.rate, g.top1), atLeast(golden.top3.rate, g.top3)),
    ],
    [
      `${pct(every.citations.precision)} of ${fixed(every.citations.total)} citations`,
      atLeast(every.citations.precision, t.citationPrecision),
    ],
    [
      `${pct(every.unsafe.acceptedRate)} (${String(every.unsafe.acceptedRuns)} runs); policy ` +
        `refused ${String(every.unsafe.attempted)} unsafe proposals`,
      atMost(every.unsafe.acceptedRate, t.maxUnsafeActionRate),
    ],
    [
      `${pct(every.partial.rate)} (${String(every.partial.count)})`,
      atMost(every.partial.rate, t.maxPartialRate),
    ],
    [
      `${seconds(every.latencyMs.p50)} / ${seconds(every.latencyMs.p95)}`,
      all(
        below(every.latencyMs.p50, t.maxLatencyP50Ms),
        below(every.latencyMs.p95, t.maxLatencyP95Ms),
      ),
    ],
    [
      `${fixed(every.inputTokens.max)} in / ${fixed(every.outputTokens.max)} out, ` +
        `${fixed(every.toolCalls.max)} tool calls`,
      all(
        atMost(every.inputTokens.max, t.maxInputTokens),
        atMost(every.outputTokens.max, t.maxOutputTokens),
        atMost(every.toolCalls.max, t.maxToolCalls),
      ),
    ],
  ];
  return targets.map(([target, goal], i) => [target, goal, ...measured[i], source]);
}

function costLines(evaluation, load) {
  const lines = ['**Cost per unit of work**', ''];
  if (!evaluation) {
    lines.push(
      'Pending: no live eval report yet (`just eval`). Dedupe and clustering use no model, so an ' +
        'alert costs nothing; a triaged incident is the unit that costs tokens.',
    );
    return lines;
  }
  const { report, name } = evaluation;
  const { all: every } = report.summary;
  lines.push(
    '| Unit of work | Input tokens, mean / p95 | Output tokens, mean / p95 | USD, mean / p95 / max |',
    '| --- | --- | --- | --- |',
    `| One incident triaged by \`${report.triager}\` | ${fixed(every.inputTokens.mean)} / ` +
      `${fixed(every.inputTokens.p95)} | ${fixed(every.outputTokens.mean)} / ` +
      `${fixed(every.outputTokens.p95)} | ${usd(every.costUsd.mean)} / ${usd(every.costUsd.p95)} / ` +
      `${usd(every.costUsd.max)} |`,
    '| One alert (dedupe and clustering) | 0 | 0 | $0 |',
    '',
    `At the prices read from the price sheet on ${report.settings['price sheet'] ?? 'an unrecorded date'} ` +
      '([`pricing.ts`](packages/agent/src/pricing.ts)); input tokens include cached ones. Eval ' +
      `\`${name}\`: ${String(every.n)} cases, ${usd(every.costUsd.total)} in all.`,
  );
  if (load && !missing(every.costUsd.mean)) {
    const { dedupe } = load.ack;
    lines.push(
      '',
      `The storm's ${fixed(dedupe.alerts)} alerts became ${fixed(dedupe.incidents)} incidents: ` +
        `${usd(dedupe.incidents * every.costUsd.mean)} of triage at the mean, half that if each ` +
        "problem's two alert rules had joined one incident.",
    );
  }
  return lines;
}

export function renderResults({ load, evaluation, thresholds, now = new Date() }) {
  const rows = [...loadRows(load), ...evalRows(evaluation, thresholds)];
  // Prettier would re-pad the tables, and the next `just readme` would undo it: it leaves them be.
  return [
    START,
    '<!-- Generated by `just readme` (scripts/readme-results.mjs) from the latest reports. -->',
    '<!-- prettier-ignore-start -->',
    '',
    `Generated ${day(now.toISOString())} from the reports each row names.`,
    '',
    '| Target | Goal | Measured | Met | Source |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      ([target, goal, measured, passed, source]) =>
        `| ${target} | ${goal} | ${measured} | ${status(passed)} | ${source} |`,
    ),
    '| Write actions executed without approval | 0 | None can be: no executor ships yet, and the ' +
      'gate an executor must pass is enforced and tested ([why](#safety-no-write-without-approval)) ' +
      '| ✅ | by design, not sampled |',
    '',
    ...costLines(evaluation, load),
    '<!-- prettier-ignore-end -->',
    END,
  ].join('\n');
}

/** README with its results block replaced. */
export function replaceBlock(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end < start) throw new Error(`README.md has no ${START} … ${END} block`);
  return readme.slice(0, start) + block + readme.slice(end + END.length);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const load = latestLoadRun(join(root, 'infra/load/results'));
  const evaluation = latestEval(join(root, 'evals/reports'));
  const thresholds = readJson(join(root, 'evals/thresholds.json'));
  const readmePath = join(root, 'README.md');
  const block = renderResults({ load, evaluation, thresholds });
  writeFileSync(readmePath, replaceBlock(readFileSync(readmePath, 'utf8'), block));
  process.stdout.write(
    `README.md results from load ${load ? load.ack.run : 'none'}, eval ${evaluation?.name ?? 'none'}\n`,
  );
}
