import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Summary } from './report.js';

// The bar a run must clear (evals/thresholds.json). Accuracy is judged on the golden cases; the
// rest on every case. The limits a run can't exceed by construction (tool calls, tokens) are
// gated anyway: a breach would mean the loop's controls are broken.

const rate = z.number().min(0).max(1);

export const thresholdsSchema = z.strictObject({
  golden: z.strictObject({
    top1: rate,
    top3: rate,
  }),
  all: z.strictObject({
    citationPrecision: rate,
    maxUnsafeActionRate: rate,
    maxPartialRate: rate,
    maxLatencyP50Ms: z.number().positive(),
    maxLatencyP95Ms: z.number().positive(),
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
  }),
});

export type Thresholds = z.output<typeof thresholdsSchema>;

export const THRESHOLDS_FILE = fileURLToPath(new URL('../thresholds.json', import.meta.url));

export function loadThresholds(file: string = THRESHOLDS_FILE): Thresholds {
  return thresholdsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export interface ThresholdResult {
  readonly metric: string;
  readonly scope: 'golden' | 'all';
  readonly value: number | null;
  readonly comparison: '>=' | '<=';
  readonly threshold: number;
  readonly passed: boolean;
}

export function checkThresholds(
  summaries: { readonly golden: Summary; readonly all: Summary },
  thresholds: Thresholds,
  /** latency: false leaves out the latency limits, which a replayed run can't measure. */
  { latency = true }: { readonly latency?: boolean } = {},
): ThresholdResult[] {
  const atLeast = (
    metric: string,
    scope: 'golden' | 'all',
    value: number | null,
    threshold: number,
  ) => ({
    metric,
    scope,
    value,
    comparison: '>=' as const,
    threshold,
    // No cases to judge (or nothing cited) is not a pass.
    passed: value !== null && value >= threshold,
  });
  const atMost = (
    metric: string,
    scope: 'golden' | 'all',
    value: number | null,
    threshold: number,
  ) => ({
    metric,
    scope,
    value,
    comparison: '<=' as const,
    threshold,
    passed: value !== null && value <= threshold,
  });
  const { golden, all } = summaries;
  const t = thresholds;
  return [
    atLeast('top-1 root cause accuracy', 'golden', golden.top1.rate, t.golden.top1),
    atLeast('top-3 root cause accuracy', 'golden', golden.top3.rate, t.golden.top3),
    atLeast('citation precision', 'all', all.citations.precision, t.all.citationPrecision),
    atMost('unsafe action rate', 'all', all.unsafe.acceptedRate, t.all.maxUnsafeActionRate),
    atMost('partial report rate', 'all', all.partial.rate, t.all.maxPartialRate),
    ...(latency
      ? [
          atMost('latency p50 (ms)', 'all', all.latencyMs.p50, t.all.maxLatencyP50Ms),
          atMost('latency p95 (ms)', 'all', all.latencyMs.p95, t.all.maxLatencyP95Ms),
        ]
      : []),
    atMost('input tokens, worst run', 'all', all.inputTokens.max, t.all.maxInputTokens),
    atMost('output tokens, worst run', 'all', all.outputTokens.max, t.all.maxOutputTokens),
    atMost('tool calls, worst run', 'all', all.toolCalls.max, t.all.maxToolCalls),
  ];
}
