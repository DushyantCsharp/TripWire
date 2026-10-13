import { err, ok } from '@tripwire/result';
import { z } from 'zod';
import type { MetricStore } from '../tools/ports.js';
import { type BackendOptions, requestJson } from './http.js';

// PromQL over Prometheus's HTTP API (`/api/v1/query_range`). A query Prometheus rejects (bad
// syntax, a bad function call) comes back as invalid_query with Prometheus's own error, so the
// model can correct it.

/** More series than this means the query needs aggregating before anything can be read from it. */
const MAX_SERIES = 500;

const rangeResponse = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.string(),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        values: z.array(z.tuple([z.number(), z.string()])).optional(),
        value: z.tuple([z.number(), z.string()]).optional(),
      }),
    ),
  }),
});

const errorResponse = z.object({ error: z.string(), errorType: z.string().optional() });

export function prometheusMetricStore(options: BackendOptions): MetricStore {
  return {
    async queryRange(query, { signal }) {
      const url = new URL(`${options.url.replace(/\/+$/, '')}/api/v1/query_range`);
      url.searchParams.set('query', query.promql);
      url.searchParams.set('start', String(query.start.getTime() / 1000));
      url.searchParams.set('end', String(query.end.getTime() / 1000));
      url.searchParams.set('step', String(query.stepSeconds));
      const response = await requestJson({
        backend: 'Prometheus',
        url,
        schema: rangeResponse,
        describeError: (body) => errorResponse.safeParse(body).data?.error,
        signal,
        fetch: options.fetch,
      });
      if (!response.ok) return response;
      const { result } = response.value.data;
      if (result.length > MAX_SERIES) {
        return err({
          kind: 'invalid_query',
          message:
            `the query returned ${String(result.length)} series: aggregate it, e.g. ` +
            'sum by (service_name) (...)',
        });
      }
      return ok(
        result.map((series) => ({
          labels: series.metric,
          points: (series.values ?? (series.value ? [series.value] : [])).map(
            ([at, value]): [number, number] => [at, sampleValue(value)],
          ),
        })),
      );
    },
  };
}

/** Prometheus sends sample values as strings, including NaN and ±Inf. */
export function sampleValue(value: string): number {
  if (value === '+Inf' || value === 'Inf') return Number.POSITIVE_INFINITY;
  if (value === '-Inf') return Number.NEGATIVE_INFINITY;
  return Number(value);
}
