import { describe, expect, it } from '@jest/globals';
import { comparableReport, compareReports, regressions, renderComparison } from './compare.js';
import { buildReport } from './report.js';
import type { CaseScore } from './score.js';

function score(caseId: string, overrides: Partial<CaseScore> = {}): CaseScore {
  return {
    caseId,
    kind: 'golden',
    flag: 'paymentFailure',
    groundTruth: 'payment',
    suspects: ['payment'],
    top1: true,
    top3: true,
    faultClassTop1: true,
    citations: { total: 4, existing: 4, supporting: 4 },
    unsafeAccepted: [],
    unsafeAttempted: [],
    stopReason: 'report_submitted',
    basis: 'model',
    changeHint: true,
    incidents: 1,
    latencyMs: 20_000,
    inputTokens: 30_000,
    outputTokens: 2_000,
    toolCalls: 5,
    costUsdMicros: 160_000,
    error: null,
    ...overrides,
  };
}

const report = (scores: CaseScore[]) =>
  comparableReport.parse(
    // Through JSON, as a baseline is read from report.json.
    JSON.parse(
      JSON.stringify(
        buildReport(scores, { triager: 'claude-opus-5-5', settings: {}, thresholds: () => [] }),
      ),
    ),
  );

const baseline = report([score('a'), score('b')]);

describe('compareReports', () => {
  it('finds nothing worse in an identical run', () => {
    const comparison = compareReports(report([score('a'), score('b')]), baseline, {
      latency: false,
    });
    expect(comparison.sameCases).toBe(true);
    expect(regressions(comparison)).toEqual([]);
    expect(comparison.rows.map((r) => r.metric)).not.toContain('latency p50 (ms)');
  });

  it.each<[string, Partial<CaseScore>]>([
    ['top-1 root cause accuracy', { top1: false, suspects: ['cart'] }],
    ['citation precision', { citations: { total: 4, existing: 4, supporting: 3 } }],
    ['unsafe action rate', { unsafeAccepted: ['rollback cart: not the service at fault'] }],
    ['partial report rate', { stopReason: 'tool_call_limit' }],
    ['input tokens, worst run', { inputTokens: 31_000 }],
    ['tool calls, worst run', { toolCalls: 6 }],
  ])('flags %s getting worse', (metric, change) => {
    const comparison = compareReports(report([score('a'), score('b', change)]), baseline);
    expect(regressions(comparison).map((r) => r.metric)).toContain(metric);
  });

  it('never calls an improvement a regression', () => {
    const comparison = compareReports(report([score('a'), score('b', { toolCalls: 3 })]), baseline);
    expect(regressions(comparison)).toEqual([]);
  });

  it('counts a metric that is no longer measured as worse', () => {
    const noGolden = report([score('a', { kind: 'storm' }), score('b', { kind: 'storm' })]);
    expect(regressions(compareReports(noGolden, baseline)).map((r) => r.metric)).toContain(
      'top-1 root cause accuracy',
    );
  });

  it("doesn't gate when the case sets differ, and says so", () => {
    const comparison = compareReports(report([score('a'), score('c', { top1: false })]), baseline);
    expect(comparison).toMatchObject({ sameCases: false, added: ['c'], removed: ['b'] });
    expect(regressions(comparison)).toEqual([]);
    expect(renderComparison(comparison, { gated: true })).toContain('The case sets differ');
  });

  it('renders the deltas, marking what got worse', () => {
    const comparison = compareReports(
      report([score('a'), score('b', { top1: false, toolCalls: 7 })]),
      baseline,
      { latency: false },
    );
    const markdown = renderComparison(comparison, { gated: true });
    expect(markdown).toContain(
      '| top-1 root cause accuracy | golden cases | 100.0% | 50.0% | −50.0 pts **worse** |',
    );
    expect(markdown).toContain('| tool calls, worst run | all cases | 5 | 7 | +2 **worse** |');
    expect(markdown).toContain('| citation precision | all cases | 100.0% | 100.0% | = |');
  });
});
