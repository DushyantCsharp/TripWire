import { z } from 'zod';

// Input and output of each read-only tool. Outputs are compact on purpose: every result is re-sent
// with the rest of the conversation on each later turn, and the whole run has 40k input tokens.
// Every record a report can cite carries an `id`, prefixed by kind (log:, trace:, metric:, change:,
// runbook:).

const minutes = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .default(fallback)
    .describe('How far back from now to look, in minutes.');

const service = z.string().min(1).max(100);

const window = z.strictObject({ from: z.string(), to: z.string() });

export const SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;

export const queryLogsInput = z.strictObject({
  service: service
    .optional()
    .describe('Only this service, e.g. "payment". Omit for every service.'),
  minSeverity: z.enum(SEVERITIES).optional().describe('Only lines at this severity or above.'),
  contains: z.string().min(1).max(200).optional().describe('Only lines containing this phrase.'),
  minutes: minutes(30),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(10)
    .describe('Lines to return. The result is also cut to a size budget: page on with cursor.'),
  cursor: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe('nextCursor from the previous call with the same filters, for the next page.'),
});

export const queryLogsOutput = z.strictObject({
  window,
  total: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  byService: z.record(z.string(), z.number().int().nonnegative()),
  /** The commonest line shapes (numbers and ids masked), on the first page only. */
  patterns: z.array(
    z.strictObject({
      template: z.string(),
      count: z.number().int().positive(),
      service: z.string(),
      severity: z.string(),
      exampleId: z.string(),
    }),
  ),
  lines: z.array(
    z.strictObject({
      id: z.string(),
      at: z.string(),
      service: z.string(),
      severity: z.string(),
      body: z.string(),
    }),
  ),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const queryTracesInput = z.strictObject({
  service: service.describe('Traces that pass through this service.'),
  operation: z.string().min(1).max(200).optional().describe('Only this span name.'),
  errorsOnly: z.boolean().default(true).describe('Only traces with a failed span.'),
  minDurationMs: z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .optional()
    .describe('Only traces at least this slow.'),
  minutes: minutes(30),
  limit: z.number().int().min(1).max(20).default(5),
});

export const queryTracesOutput = z.strictObject({
  window,
  summary: z.strictObject({
    traces: z.number().int().nonnegative(),
    withErrors: z.number().int().nonnegative(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
  }),
  traces: z.array(
    z.strictObject({
      id: z.string(),
      root: z.string(),
      startedAt: z.string(),
      durationMs: z.number(),
      spanCount: z.number().int(),
      services: z.array(z.string()),
      errors: z.array(
        z.strictObject({
          service: z.string(),
          operation: z.string(),
          message: z.string().nullable(),
        }),
      ),
    }),
  ),
  truncated: z.boolean(),
});

export const queryMetricsInput = z.strictObject({
  promql: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'A PromQL expression, evaluated as a range over the window. Metrics arrive about every 60s, ' +
        'so use rate windows of [5m] or more.',
    ),
  minutes: minutes(30),
  stepSeconds: z
    .number()
    .int()
    .min(15)
    .max(3_600)
    .optional()
    .describe('Resolution. Defaults to about 60 points over the window.'),
});

const statistic = z.number().nullable();

export const queryMetricsOutput = z.strictObject({
  window,
  stepSeconds: z.number().int(),
  /** Labels every series shares, stated once. */
  commonLabels: z.record(z.string(), z.string()),
  series: z.array(
    z.strictObject({
      id: z.string(),
      labels: z.record(z.string(), z.string()),
      min: statistic,
      max: statistic,
      mean: statistic,
      first: statistic,
      last: statistic,
      /** [minutes before the window's end, value], at most 12, oldest first. */
      points: z.array(z.tuple([z.number(), z.number()])),
    }),
  ),
  totalSeries: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const listDeploysInput = z.strictObject({
  service: service.optional().describe('Only changes to this service. Omit for every service.'),
  minutes: minutes(360),
});

export const listDeploysOutput = z.strictObject({
  window,
  changes: z.array(
    z.strictObject({
      id: z.string(),
      service: z.string(),
      kind: z.enum(['deploy', 'config']),
      description: z.string(),
      at: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

export const getRunbookInput = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(300)
    .describe('What you are looking for, e.g. "payment charge errors invalid token".'),
  service: service.optional().describe('Only runbooks for this service.'),
  k: z.number().int().min(1).max(3).default(2).describe('Sections to return.'),
});

export const getRunbookOutput = z.strictObject({
  sections: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      service: z.string().nullable(),
      excerpt: z.string(),
      score: z.number(),
    }),
  ),
  truncated: z.boolean(),
});
