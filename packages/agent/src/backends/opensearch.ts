import { ok } from '@tripwire/result';
import { z } from 'zod';
import type { LogLine, LogStore } from '../tools/ports.js';
import { type BackendOptions, requestJson } from './http.js';

// Logs in OpenSearch, as the OpenTelemetry collector's opensearch exporter writes them (the OTel
// demo: daily `otel-logs-*` indices). Counts come from OpenSearch aggregations over every matching
// line; lines and the pattern sample are the newest hits. Field names are configurable for other
// mappings.

export interface OpenSearchOptions extends BackendOptions {
  readonly index?: string | undefined;
  readonly fields?: Partial<LogFields> | undefined;
}

interface LogFields {
  readonly time: string;
  readonly body: string;
  readonly severityNumber: string;
  readonly severityText: string;
  /** A keyword field: exact match and aggregation. */
  readonly service: string;
}

const DEFAULT_FIELDS: LogFields = {
  time: 'observedTimestamp',
  body: 'body',
  severityNumber: 'severity.number',
  severityText: 'severity.text',
  service: 'resource.service.name.keyword',
};

const bucket = z.object({ key: z.union([z.string(), z.number()]), doc_count: z.number() });

const searchResponse = z.object({
  hits: z.object({
    total: z.object({ value: z.number() }),
    hits: z.array(z.object({ _id: z.string(), _source: z.record(z.string(), z.unknown()) })),
  }),
  aggregations: z
    .object({
      severity: z.object({ buckets: z.array(bucket) }),
      service: z.object({ buckets: z.array(bucket) }),
    })
    .optional(),
});

const errorBody = z.object({
  error: z.union([z.string(), z.object({ reason: z.string().optional() }).loose()]),
});

export function opensearchLogStore(options: OpenSearchOptions): LogStore {
  const fields = { ...DEFAULT_FIELDS, ...options.fields };
  const index = options.index ?? 'otel-logs-*';
  const sourceField = fields.service.replace(/\.keyword$/, '');
  return {
    async search(query, { signal }) {
      const filter: unknown[] = [
        {
          range: {
            [fields.time]: {
              gte: query.from.toISOString(),
              lt: query.to.toISOString(),
              format: 'strict_date_optional_time',
            },
          },
        },
      ];
      if (query.service !== undefined) filter.push({ term: { [fields.service]: query.service } });
      if (query.minSeverityNumber !== undefined) {
        filter.push({ range: { [fields.severityNumber]: { gte: query.minSeverityNumber } } });
      }
      const size = query.offset === 0 ? Math.max(query.limit, query.sampleSize) : query.limit;
      const response = await requestJson({
        backend: 'OpenSearch',
        url: new URL(`${trimSlash(options.url)}/${index}/_search`),
        method: 'POST',
        body: {
          track_total_hits: true,
          from: query.offset,
          size,
          sort: [{ [fields.time]: { order: 'desc' } }],
          query: {
            bool: {
              filter,
              // A phrase match, never query_string: the model's text is data, not query syntax.
              ...(query.contains !== undefined && {
                must: [{ match_phrase: { [fields.body]: query.contains } }],
              }),
            },
          },
          aggs: {
            severity: {
              range: {
                field: fields.severityNumber,
                ranges: [
                  { key: 'trace', to: 5 },
                  { key: 'debug', from: 5, to: 9 },
                  { key: 'info', from: 9, to: 13 },
                  { key: 'warn', from: 13, to: 17 },
                  { key: 'error', from: 17 },
                ],
              },
            },
            service: { terms: { field: fields.service, size: 20 } },
          },
        },
        schema: searchResponse,
        describeError: (body) => {
          const parsed = errorBody.safeParse(body);
          if (!parsed.success) return undefined;
          return typeof parsed.data.error === 'string'
            ? parsed.data.error
            : parsed.data.error.reason;
        },
        signal,
        fetch: options.fetch,
      });
      if (!response.ok) return response;

      const lines = response.value.hits.hits.map((hit): LogLine => {
        const source = hit._source;
        const at = Date.parse(
          asString(field(source, fields.time) ?? field(source, '@timestamp')) ?? '',
        );
        const number = Number(field(source, fields.severityNumber));
        return {
          id: hit._id,
          at: new Date(Number.isNaN(at) ? 0 : at),
          service: asString(field(source, sourceField)) ?? 'unknown',
          severityNumber:
            Number.isFinite(number) && number > 0
              ? number
              : severityFromText(field(source, fields.severityText)),
          body: text(field(source, fields.body)),
        };
      });
      const counts = (buckets: readonly z.output<typeof bucket>[] | undefined) =>
        Object.fromEntries(
          (buckets ?? []).filter((b) => b.doc_count > 0).map((b) => [String(b.key), b.doc_count]),
        );
      return ok({
        total: response.value.hits.total.value,
        bySeverity: counts(response.value.aggregations?.severity.buckets),
        byService: counts(response.value.aggregations?.service.buckets),
        lines: query.offset === 0 ? lines.slice(0, query.limit) : lines,
        sample: query.offset === 0 ? lines.slice(0, query.sampleSize) : [],
      });
    },
  };
}

/**
 * A dotted field from a document, whether the mapping nests it (`{resource: {service: {name}}}`),
 * flattens it (`{"resource.service.name": …}`), or mixes the two.
 */
export function field(source: unknown, path: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  if (path in record) return record[path];
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join('.');
    if (head in record) {
      const found = field(record[head], parts.slice(i).join('.'));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

const SEVERITY_TEXT: Readonly<Record<string, number>> = {
  trace: 1,
  debug: 5,
  info: 9,
  information: 9,
  notice: 10,
  warn: 13,
  warning: 13,
  error: 17,
  err: 17,
  critical: 21,
  fatal: 21,
};

function severityFromText(value: unknown): number {
  return typeof value === 'string' ? (SEVERITY_TEXT[value.toLowerCase()] ?? 9) : 9;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
