import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  END,
  latestEval,
  latestLoadRun,
  renderResults,
  replaceBlock,
  START,
} from './readme-results.mjs';

const dir = mkdtempSync(join(tmpdir(), 'readme-results-'));
after(() => rmSync(dir, { recursive: true }));
const write = (path, value) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(value));
};

const loadReport = (run, overrides = {}) => ({
  run,
  commit: 'a2f0cfb',
  generatedAt: '2026-10-13T10:03:45.557Z',
  client: {
    requests: 138240,
    rate: 1728.2,
    acceptedMs: { p50: 1.15, p95: 35.59, p99: 165.08, max: 1104.84 },
    checks: 1,
    droppedIterations: 1755,
  },
  server: {
    ackP99: 0.0781,
    shareShed: 0,
    peakWaiting: [{ labels: { queue: 'ingest' }, value: 67537 }],
  },
  dedupe: { alerts: 138240, incidents: 16, problems: 8, ari: 0.636 },
  clustering: { perSecond: 640.2, waitP50Seconds: 90.4, waitMaxSeconds: 136 },
  ...overrides,
});
const shedReport = (run) =>
  loadReport(run, {
    server: {
      ackP99: 0.0356,
      shareShed: 0.494,
      peakWaiting: [{ labels: { queue: 'ingest' }, value: 10148 }],
    },
    clustering: { perSecond: 448, waitP50Seconds: 25, waitMaxSeconds: 50 },
  });

const distribution = (mean, p95, max) => ({ mean, p50: mean, p95, max });
const evalReport = ({ n, generatedAt, mode = 'live', triager = 'claude-opus-5-5' }) => ({
  generatedAt,
  triager,
  settings: { mode, commit: 'b1c2d3e', 'price sheet': '2026-10-12' },
  summary: {
    golden: {
      n: 40,
      top1: { hits: 30, n: 40, rate: 0.75, ci: [0.6, 0.86] },
      top3: { hits: 37, n: 40, rate: 0.925, ci: [0.8, 0.97] },
    },
    all: {
      n,
      citations: { total: 200, precision: 0.93 },
      unsafe: { acceptedRate: 0, acceptedRuns: 0, attempted: 3 },
      partial: { rate: 0.04, count: 2 },
      latencyMs: distribution(21000, 48000, 59000),
      inputTokens: distribution(14000, 26000, 31000),
      outputTokens: distribution(700, 1500, 2100),
      toolCalls: distribution(4, 6, 7),
      costUsd: { ...distribution(0.05, 0.09, 0.12), total: 2.5 },
    },
  },
});
const thresholds = {
  golden: { top1: 0.7, top3: 0.9 },
  all: {
    citationPrecision: 0.9,
    maxUnsafeActionRate: 0,
    maxPartialRate: 0.1,
    maxLatencyP50Ms: 25000,
    maxLatencyP95Ms: 60000,
    maxInputTokens: 40000,
    maxOutputTokens: 4000,
    maxToolCalls: 8,
  },
};

describe('the latest reports', () => {
  it('takes the newest load run that left both its reports', () => {
    write('load/storm-20261013-084552-ack.report.json', loadReport('storm-20261013-084552-ack'));
    write('load/storm-20261013-084552-shed.report.json', shedReport('storm-20261013-084552-shed'));
    // Newer, but only half a run; and an experiment that isn't a run.sh run.
    write('load/storm-20261014-090000-ack.report.json', loadReport('storm-20261014-090000-ack'));
    write('load/storm-20261014-094423-nopersist.report.json', loadReport('nopersist'));
    const run = latestLoadRun(join(dir, 'load'));
    assert.equal(run.ack.run, 'storm-20261013-084552-ack');
    assert.equal(run.shed.run, 'storm-20261013-084552-shed');
    assert.equal(latestLoadRun(join(dir, 'nowhere')), null);
  });

  it('publishes the newest of the most complete model evals, never a replay or the baseline', () => {
    write('evals/a/report.json', evalReport({ n: 50, generatedAt: '2026-10-14T08:00:00Z' }));
    write('evals/b/report.json', evalReport({ n: 50, generatedAt: '2026-10-15T08:00:00Z' }));
    write('evals/c/report.json', evalReport({ n: 2, generatedAt: '2026-10-16T08:00:00Z' }));
    write(
      'evals/d/report.json',
      evalReport({ n: 50, generatedAt: '2026-10-17T08:00:00Z', mode: 'replay' }),
    );
    write(
      'evals/e/report.json',
      evalReport({ n: 50, generatedAt: '2026-10-18T08:00:00Z', triager: 'baseline-v1' }),
    );
    assert.equal(latestEval(join(dir, 'evals')).name, 'b');
  });
});

describe('renderResults', () => {
  const load = {
    ack: loadReport('storm-20261013-084552-ack'),
    shed: shedReport('storm-20261013-084552-shed'),
  };
  const now = new Date('2026-10-13T12:00:00Z');

  it('puts every target next to what was measured, whether it was met, and its source', () => {
    const block = renderResults({
      load,
      evaluation: { name: 'b', report: evalReport({ n: 50, generatedAt: '2026-10-15T08:00:00Z' }) },
      thresholds,
      now,
    });
    const row = (target) => block.split('\n').find((line) => line.startsWith(`| ${target} |`));
    assert.match(
      row('Ingest ack p99 at 2k req/s'),
      /165 ms at the client .* 78 ms in the api; .* \| ❌ \| load `storm-20261013-084552-ack` · `a2f0cfb` · 2026-10-13 \|$/,
    );
    assert.match(row('Shedding past the high-water mark'), /49\.4% shed.* 10,148 waiting \| ✅ \|/);
    assert.match(
      row('Dedupe ARI'),
      /0\.636: 138,240 alerts → 16 incidents for 8 problems \| ❌ \|/,
    );
    assert.match(
      row('RCA top-1 / top-3 (golden cases)'),
      /75\.0% \(95% CI 60\.0%–86\.0%\) \/ 92\.5%; n = 40 \| ✅ \| eval `b` · `b1c2d3e` · 2026-10-15 · 50 cases \|$/,
    );
    assert.match(row('Triage latency p50 / p95'), /21\.0 s \/ 48\.0 s \| ✅/);
    assert.match(row('Per-run budget (worst run)'), /31,000 in \/ 2,100 out, 7 tool calls \| ✅/);
    assert.match(
      block,
      /\| One incident triaged by `claude-opus-5-5` \| 14,000 \/ 26,000 \| 700 \/ 1,500 \| \$0\.0500 \/ \$0\.0900 \/ \$0\.12 \|/,
    );
    assert.match(block, /price sheet on 2026-10-12/);
    assert.match(block, /138,240 alerts became 16 incidents: \$0\.80 of triage/);
    assert.ok(block.startsWith(START) && block.endsWith(END));
  });

  it('marks what no report has measured yet as pending, not as met or missed', () => {
    const block = renderResults({ load, evaluation: null, thresholds, now });
    const pending = block.split('\n').filter((line) => line.includes('pending: no live eval'));
    assert.equal(pending.length, 6);
    for (const line of pending) assert.match(line, /\| – \| – \|$/);
    assert.doesNotMatch(block, /One incident triaged/);
  });
});

describe('replaceBlock', () => {
  it('replaces only what lies between the markers', () => {
    const readme = `# Title\n\n${START}\nold\n${END}\n\n## After\n`;
    assert.equal(
      replaceBlock(readme, `${START}\nnew\n${END}`),
      `# Title\n\n${START}\nnew\n${END}\n\n## After\n`,
    );
  });

  it('refuses a README without the block', () => {
    assert.throws(() => replaceBlock('# Title\n', 'x'), /no <!-- results:start -->/);
  });
});
