import { z } from 'zod';

// A run's report next to a baseline's (main's), metric by metric. A replayed run is
// deterministic, so there any metric that got worse is a regression and fails the run; a live run
// shows the comparison without gating on it (the model varies from run to run).

const proportion = z.object({ rate: z.number().nullable() });
const distribution = z.object({
  mean: z.number().nullable(),
  p50: z.number().nullable(),
  p95: z.number().nullable(),
  max: z.number().nullable(),
});
const summary = z.object({
  n: z.number(),
  top1: proportion,
  top3: proportion,
  faultClassTop1: proportion,
  citations: z.object({ precision: z.number().nullable() }),
  unsafe: z.object({ acceptedRate: z.number().nullable() }),
  partial: z.object({ rate: z.number().nullable() }),
  errors: z.number(),
  latencyMs: distribution,
  inputTokens: distribution,
  outputTokens: distribution,
  toolCalls: distribution,
  costUsd: distribution,
});

/** What a comparison reads of a report (report.json): the eval report has all of it. */
export const comparableReport = z.object({
  triager: z.string(),
  summary: z.object({ all: summary, golden: summary }),
  cases: z.array(z.object({ caseId: z.string() })),
});
type ComparableSummary = z.output<typeof summary>;
/** A parsed baseline or a fresh EvalReport: both have what the comparison reads. */
export interface ComparableReport {
  readonly triager: string;
  readonly summary: { readonly all: ComparableSummary; readonly golden: ComparableSummary };
  readonly cases: readonly { readonly caseId: string }[];
}

interface Metric {
  readonly metric: string;
  readonly scope: 'golden' | 'all';
  readonly better: 'higher' | 'lower';
  readonly kind: 'rate' | 'count' | 'usd';
  readonly latency?: boolean;
  readonly value: (s: ComparableSummary) => number | null;
}

const METRICS: readonly Metric[] = [
  {
    metric: 'top-1 root cause accuracy',
    scope: 'golden',
    better: 'higher',
    kind: 'rate',
    value: (s) => s.top1.rate,
  },
  {
    metric: 'top-3 root cause accuracy',
    scope: 'golden',
    better: 'higher',
    kind: 'rate',
    value: (s) => s.top3.rate,
  },
  {
    metric: 'fault class right (top-1)',
    scope: 'golden',
    better: 'higher',
    kind: 'rate',
    value: (s) => s.faultClassTop1.rate,
  },
  {
    metric: 'citation precision',
    scope: 'all',
    better: 'higher',
    kind: 'rate',
    value: (s) => s.citations.precision,
  },
  {
    metric: 'unsafe action rate',
    scope: 'all',
    better: 'lower',
    kind: 'rate',
    value: (s) => s.unsafe.acceptedRate,
  },
  {
    metric: 'partial report rate',
    scope: 'all',
    better: 'lower',
    kind: 'rate',
    value: (s) => s.partial.rate,
  },
  { metric: 'errored runs', scope: 'all', better: 'lower', kind: 'count', value: (s) => s.errors },
  {
    metric: 'input tokens, mean',
    scope: 'all',
    better: 'lower',
    kind: 'count',
    value: (s) => s.inputTokens.mean,
  },
  {
    metric: 'input tokens, worst run',
    scope: 'all',
    better: 'lower',
    kind: 'count',
    value: (s) => s.inputTokens.max,
  },
  {
    metric: 'output tokens, worst run',
    scope: 'all',
    better: 'lower',
    kind: 'count',
    value: (s) => s.outputTokens.max,
  },
  {
    metric: 'tool calls, worst run',
    scope: 'all',
    better: 'lower',
    kind: 'count',
    value: (s) => s.toolCalls.max,
  },
  {
    metric: 'USD per run, mean',
    scope: 'all',
    better: 'lower',
    kind: 'usd',
    value: (s) => s.costUsd.mean,
  },
  {
    metric: 'latency p50 (ms)',
    scope: 'all',
    better: 'lower',
    kind: 'count',
    latency: true,
    value: (s) => s.latencyMs.p50,
  },
  {
    metric: 'latency p95 (ms)',
    scope: 'all',
    better: 'lower',
    kind: 'count',
    latency: true,
    value: (s) => s.latencyMs.p95,
  },
];

export interface ComparisonRow {
  readonly metric: string;
  readonly scope: 'golden' | 'all';
  readonly kind: Metric['kind'];
  readonly baseline: number | null;
  readonly current: number | null;
  /** Worse than the baseline, or no longer measured at all. */
  readonly regressed: boolean;
}

export interface Comparison {
  readonly baselineTriager: string;
  /** Whether both ran the same cases: only then do the numbers compare like for like. */
  readonly sameCases: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly rows: readonly ComparisonRow[];
}

function worse(metric: Metric, baseline: number | null, current: number | null): boolean {
  if (baseline === null) return false;
  if (current === null) return true;
  return metric.better === 'higher' ? current < baseline : current > baseline;
}

/** Compares `current` with `baseline`. `latency: false` leaves latency out (replayed runs). */
export function compareReports(
  current: ComparableReport,
  baseline: ComparableReport,
  { latency = true }: { readonly latency?: boolean } = {},
): Comparison {
  const now = new Set(current.cases.map((c) => c.caseId));
  const before = new Set(baseline.cases.map((c) => c.caseId));
  const added = [...now].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !now.has(id)).sort();
  return {
    baselineTriager: baseline.triager,
    sameCases: added.length === 0 && removed.length === 0,
    added,
    removed,
    rows: METRICS.filter((m) => latency || !m.latency).map((metric) => {
      const b = metric.value(baseline.summary[metric.scope]);
      const c = metric.value(current.summary[metric.scope]);
      return {
        metric: metric.metric,
        scope: metric.scope,
        kind: metric.kind,
        baseline: b,
        current: c,
        regressed: worse(metric, b, c),
      };
    }),
  };
}

/** The rows that got worse, when the comparison is like for like; otherwise none. */
export function regressions(comparison: Comparison): readonly ComparisonRow[] {
  return comparison.sameCases ? comparison.rows.filter((row) => row.regressed) : [];
}

function show(kind: ComparisonRow['kind'], value: number | null): string {
  if (value === null) return 'n/a';
  if (kind === 'rate') return `${(value * 100).toFixed(1)}%`;
  if (kind === 'usd') return `$${value.toFixed(3)}`;
  return String(Math.round(value * 10) / 10);
}

function change(row: ComparisonRow): string {
  if (row.baseline === null || row.current === null) return '–';
  const delta = row.current - row.baseline;
  if (delta === 0) return '=';
  const sign = delta > 0 ? '+' : '−';
  const size = Math.abs(delta);
  if (row.kind === 'rate') return `${sign}${(size * 100).toFixed(1)} pts`;
  if (row.kind === 'usd') return `${sign}$${size.toFixed(3)}`;
  return `${sign}${String(Math.round(size * 10) / 10)}`;
}

/** The comparison as a markdown section. `gated` says whether regressions fail the run. */
export function renderComparison(comparison: Comparison, { gated }: { readonly gated: boolean }) {
  const lines = ['## Compared with the baseline', ''];
  lines.push(
    `Baseline triager \`${comparison.baselineTriager}\`. ` +
      (gated
        ? 'This run is replayed, so any metric that got worse fails it.'
        : 'Live runs vary, so this is shown, not gated.'),
    '',
  );
  if (!comparison.sameCases) {
    lines.push(
      `The case sets differ (added: ${comparison.added.join(', ') || 'none'}; removed: ` +
        `${comparison.removed.join(', ') || 'none'}), so the numbers don't compare like for like ` +
        'and nothing here gates the run.',
      '',
    );
  }
  lines.push('| Metric | Over | Baseline | This run | Change |', '| --- | --- | --- | --- | --- |');
  for (const row of comparison.rows) {
    const flag = row.regressed && comparison.sameCases ? ' **worse**' : '';
    lines.push(
      `| ${row.metric} | ${row.scope} cases | ${show(row.kind, row.baseline)} | ` +
        `${show(row.kind, row.current)} | ${change(row)}${flag} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
