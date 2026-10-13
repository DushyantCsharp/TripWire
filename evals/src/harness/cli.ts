// Runs the golden set and reports: `just eval [--triager claude|baseline] [--cases a,b |
// --subset nightly] [--kinds golden,storm,injection] [--repeat 1] [--concurrency 4] [--model …]
// [--effort low]`. Writes evals/reports/<time>-<mode>/report.{json,md} and exits 1 if a threshold
// fails, or, replaying against a baseline, if any metric got worse.
//
// Replay (free, no key, no model calls): `--replay evals/replay --subset nightly --baseline
// evals/replay/baseline.json`. Re-record the subset after changing what the model sees:
// `--record evals/replay --subset nightly`, then `--replay … --write-baseline
// evals/replay/baseline.json`, and commit both.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { loadEnvOrExit } from '@tripwire/config';
import { z } from 'zod';
import { GOLDEN_DIR, listCases, readCase } from '../cases.js';
import { SUBSETS } from '../catalog.js';
import { comparableReport, compareReports, regressions, renderComparison } from '../compare.js';
import { buildReport, renderMarkdown } from '../report.js';
import { scoreRun, type CaseScore } from '../score.js';
import { checkThresholds, loadThresholds, THRESHOLDS_FILE } from '../thresholds.js';
import { type Recordings, runCase } from './run.js';

const env = loadEnvOrExit(
  z.object({
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    /** A Postgres server with pgvector to use instead of starting one (e.g. `just infra-up`'s). */
    EVAL_DATABASE_URL: z.url().optional(),
    /** Where pnpm was run from: `pnpm --filter … eval` itself runs in evals/. */
    INIT_CWD: z.string().optional(),
  }),
);

/** A path from the command line, relative to where the command was run. */
const at = (path: string) => resolve(env.INIT_CWD ?? process.cwd(), path);

const { values } = parseArgs({
  options: {
    triager: { type: 'string', default: 'claude' },
    model: { type: 'string', default: 'claude-opus-5-5' },
    effort: { type: 'string', default: 'low' },
    cases: { type: 'string' },
    subset: { type: 'string' },
    kinds: { type: 'string', default: 'golden,storm,injection' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    golden: { type: 'string', default: GOLDEN_DIR },
    out: { type: 'string', default: fileURLToPath(new URL('../../reports', import.meta.url)) },
    replay: { type: 'string' },
    record: { type: 'string' },
    thresholds: { type: 'string', default: THRESHOLDS_FILE },
    baseline: { type: 'string' },
    'write-baseline': { type: 'string' },
  },
});

const args = z
  .object({
    triager: z.enum(['claude', 'baseline']),
    model: z.string().min(1),
    effort: z.enum(['low', 'medium', 'high']),
    cases: z.string().optional(),
    subset: z.string().optional(),
    kinds: z.string(),
    repeat: z.coerce.number().int().min(1).max(10),
    concurrency: z.coerce.number().int().min(1).max(16),
    golden: z.string().transform(at),
    out: z.string().transform(at),
    replay: z.string().transform(at).optional(),
    record: z.string().transform(at).optional(),
    thresholds: z.string().transform(at),
    baseline: z.string().transform(at).optional(),
    'write-baseline': z.string().transform(at).optional(),
  })
  .parse(values);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (args.replay && args.record) fail('--replay and --record exclude each other');
if (args.cases && args.subset) fail('--cases and --subset exclude each other');
const recordings: Recordings | undefined = args.replay
  ? { mode: 'replay', dir: args.replay }
  : args.record
    ? { mode: 'record', dir: args.record }
    : undefined;
const mode = recordings?.mode ?? 'live';
if (recordings && args.triager !== 'claude') fail(`--${mode} records the claude triager's model`);
if (recordings && args.repeat !== 1) fail(`--${mode} runs each case once`);
if (args.replay && !existsSync(args.replay)) {
  fail(`no replay subset recorded yet in ${args.replay}: record it with --record ${args.replay}`);
}

const subset = args.subset === undefined ? undefined : SUBSETS[args.subset];
if (args.subset !== undefined && !subset) {
  fail(`no subset ${args.subset}: there are ${Object.keys(SUBSETS).join(', ')}`);
}
const wanted = subset ? new Set(subset) : args.cases ? new Set(args.cases.split(',')) : undefined;
const captured = listCases(args.golden);
const notCaptured = [...(wanted ?? [])].filter((id) => !captured.includes(id));
if (notCaptured.length > 0) fail(`not in ${args.golden}: ${notCaptured.join(', ')}`);

const kinds = new Set(args.kinds.split(','));
const cases = captured
  .filter((id) => !wanted || wanted.has(id))
  .map((id) => readCase(join(args.golden, id)))
  .filter((data) => kinds.has(data.meta.kind));
if (cases.length === 0) {
  fail(`no cases in ${args.golden} match: capture the golden set with \`just eval-capture\``);
}
if (args.triager === 'claude' && mode !== 'replay' && !env.ANTHROPIC_API_KEY) {
  fail(
    `--triager claude needs ANTHROPIC_API_KEY (in .env)${mode === 'live' ? ', or --replay' : ''}`,
  );
}
// Read up front: a bad thresholds or baseline file shouldn't cost a run.
const thresholds = loadThresholds(args.thresholds);
const baseline = args.baseline
  ? comparableReport.parse(JSON.parse(readFileSync(args.baseline, 'utf8')))
  : undefined;

const runbooksDir = fileURLToPath(new URL('../../../runbooks', import.meta.url));
const postgres = env.EVAL_DATABASE_URL
  ? undefined
  : await new PostgreSqlContainer('pgvector/pgvector:0.8.7-pg16').start();
const databaseServerUrl = env.EVAL_DATABASE_URL ?? postgres?.getConnectionUri() ?? '';

const jobs = cases.flatMap((data) => Array.from({ length: args.repeat }, () => data));
const scores: CaseScore[] = [];
let next = 0;
const started = Date.now();
async function worker() {
  for (;;) {
    const data = jobs[next++];
    if (!data) return;
    try {
      const outcome = await runCase(data, {
        triager: args.triager,
        model: args.model,
        effort: args.effort,
        apiKey: env.ANTHROPIC_API_KEY,
        databaseServerUrl,
        runbooksDir,
        recordings,
      });
      const score = scoreRun(outcome);
      scores.push(score);
      process.stdout.write(
        `${score.caseId}: ${score.top1 ? 'top-1' : score.top3 ? 'top-3' : 'miss'} ` +
          `(suspects ${score.suspects.join(', ') || 'none'}; truth ${score.groundTruth}) ` +
          `${score.error ?? score.stopReason} ${String(score.latencyMs)}ms\n`,
      );
    } catch (cause) {
      // A harness failure (a container that didn't start, a bad case, a stale recording) is a
      // bug to fix, not a score.
      process.stderr.write(`${data.meta.id}: harness failure: ${String(cause)}\n`);
      throw cause;
    }
  }
}
try {
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
} finally {
  await postgres?.stop();
}

scores.sort((a, b) => a.caseId.localeCompare(b.caseId));
// A replay measures no latency worth gating on: no model call takes any time.
const latency = mode !== 'replay';
const report = buildReport(scores, {
  triager: args.triager === 'claude' ? args.model : 'baseline-v1',
  thresholds: (summary) => checkThresholds(summary, thresholds, { latency }),
  settings: {
    mode,
    effort: args.effort,
    repeat: args.repeat,
    cases: cases.length,
    'wall time (s)': Math.round((Date.now() - started) / 1000),
  },
});
const comparison = baseline ? compareReports(report, baseline, { latency }) : undefined;
const worse = comparison && mode === 'replay' ? regressions(comparison) : [];
const passed = report.passed && worse.length === 0;
const final = { ...report, passed, ...(comparison ? { comparison } : {}) };

const dir = join(args.out, `${report.generatedAt.replace(/[:.]/g, '-')}-${mode}-${args.triager}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'report.json'), `${JSON.stringify(final, null, 2)}\n`);
const markdown =
  renderMarkdown(final) +
  (comparison ? `\n${renderComparison(comparison, { gated: mode === 'replay' })}` : '');
writeFileSync(join(dir, 'report.md'), markdown);
if (args['write-baseline']) {
  writeFileSync(args['write-baseline'], `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`\n${markdown.split('\n## Summary')[0] ?? ''}\n`);
if (worse.length > 0) {
  process.stdout.write(`worse than the baseline: ${worse.map((row) => row.metric).join(', ')}\n`);
}
process.stdout.write(`report: ${dir}/report.md\n`);
process.exitCode = passed ? 0 : 1;
