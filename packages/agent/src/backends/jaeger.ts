import { ok } from '@tripwire/result';
import { z } from 'zod';
import type { Span, Trace, TraceStore } from '../tools/ports.js';
import { type BackendOptions, requestJson } from './http.js';

// Traces from Jaeger's query API (`/api/traces`; the OTel demo serves it under /jaeger/ui, so the
// configured URL includes that base path). A span failed when Jaeger marks it `error=true` or its
// OpenTelemetry status is ERROR; its message is the status description or an exception event's.

const tag = z.object({ key: z.string(), value: z.unknown() });

const tracesResponse = z.object({
  data: z
    .array(
      z.object({
        traceID: z.string(),
        spans: z.array(
          z.object({
            spanID: z.string(),
            operationName: z.string(),
            references: z.array(z.object({ refType: z.string(), spanID: z.string() })).nullish(),
            startTime: z.number(),
            duration: z.number(),
            tags: z.array(tag).nullish(),
            logs: z.array(z.object({ fields: z.array(tag).nullish() })).nullish(),
            processID: z.string(),
          }),
        ),
        processes: z.record(z.string(), z.object({ serviceName: z.string() })),
      }),
    )
    .nullish(),
  errors: z.array(z.object({ msg: z.string().optional() }).loose()).nullish(),
});

export function jaegerTraceStore(options: BackendOptions): TraceStore {
  return {
    async search(query, { signal }) {
      const url = new URL(`${options.url.replace(/\/+$/, '')}/api/traces`);
      url.searchParams.set('service', query.service);
      if (query.operation !== undefined) url.searchParams.set('operation', query.operation);
      url.searchParams.set('start', String(query.from.getTime() * 1000));
      url.searchParams.set('end', String(query.to.getTime() * 1000));
      // Jaeger returns the newest traces first; ask for more than needed when filtering here.
      url.searchParams.set('limit', String(query.errorsOnly ? query.limit * 4 : query.limit));
      if (query.minDurationMs !== undefined) {
        url.searchParams.set('minDuration', `${String(query.minDurationMs)}ms`);
      }
      if (query.errorsOnly) url.searchParams.set('tags', JSON.stringify({ error: 'true' }));

      const response = await requestJson({
        backend: 'Jaeger',
        url,
        schema: tracesResponse,
        describeError: (body) =>
          tracesResponse
            .safeParse(body)
            .data?.errors?.map((e) => e.msg)
            .filter(Boolean)
            .join('; '),
        signal,
        fetch: options.fetch,
      });
      if (!response.ok) return response;

      const traces = (response.value.data ?? []).map((trace): Trace => ({
        traceId: trace.traceID,
        spans: trace.spans.map((span): Span => {
          const tags = new Map((span.tags ?? []).map((t) => [t.key, t.value]));
          const error =
            tags.get('error') === true ||
            tags.get('error') === 'true' ||
            tags.get('otel.status_code') === 'ERROR';
          return {
            spanId: span.spanID,
            parentSpanId:
              span.references?.find((ref) => ref.refType === 'CHILD_OF')?.spanID ?? null,
            service: trace.processes[span.processID]?.serviceName ?? 'unknown',
            operation: span.operationName,
            startUs: span.startTime,
            durationUs: span.duration,
            error,
            message: error ? errorMessage(tags, span.logs ?? []) : null,
          };
        }),
      }));
      return ok(
        traces
          .filter((trace) => !query.errorsOnly || trace.spans.some((span) => span.error))
          .slice(0, query.limit),
      );
    },
  };
}

function errorMessage(
  tags: ReadonlyMap<string, unknown>,
  logs: readonly { readonly fields?: readonly z.output<typeof tag>[] | null | undefined }[],
): string | null {
  const description = tags.get('otel.status_description');
  if (typeof description === 'string' && description !== '') return description;
  for (const log of logs) {
    const fields = new Map((log.fields ?? []).map((f) => [f.key, f.value]));
    const message = fields.get('exception.message') ?? fields.get('message');
    if (typeof message === 'string' && message !== '') return message;
  }
  return null;
}
