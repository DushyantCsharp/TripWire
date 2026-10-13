import {
  context,
  isSpanContextValid,
  type Link,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { z } from 'zod';
import { tracer } from './api.js';

// W3C trace context through BullMQ, carried in job data: a PRODUCER span where a job is added, a
// CONSUMER span where it is processed, parented to the producer (so webhook → ingest → cluster →
// triage is one trace) and linked to it. Contexts are passed explicitly rather than read from a
// context manager, so this works the same with or without one.

/** Trace context as it travels in a job's `trace` field. */
export const carrierSchema = z.object({
  traceparent: z.string().min(1),
  tracestate: z.string().optional(),
});
export type TraceCarrier = z.output<typeof carrierSchema>;

const MESSAGING_SYSTEM = 'bullmq';

/** A job's trace context, read from its raw data before the processor parses it; else undefined. */
export function carrierOf(data: unknown): TraceCarrier | undefined {
  const parsed = z.object({ trace: carrierSchema }).safeParse(data);
  return parsed.success ? parsed.data.trace : undefined;
}

function inject(span: Span): TraceCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), carrier);
  // With no SDK, nothing is injected: the job then carries no trace field at all.
  const parsed = carrierSchema.safeParse(carrier);
  return parsed.success ? parsed.data : undefined;
}

/** Links to the span a carrier came from (none for no carrier or an invalid one). */
export function linksFrom(carrier: TraceCarrier | undefined): Link[] {
  if (!carrier) return [];
  const spanContext = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, carrier));
  return spanContext && isSpanContextValid(spanContext) ? [{ context: spanContext }] : [];
}

function fail(span: Span, cause: unknown): void {
  if (cause instanceof Error) span.recordException(cause);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: cause instanceof Error ? cause.message : undefined,
  });
}

function producerSpan(queue: string, jobId: string | undefined, links: Link[]): Span {
  return tracer().startSpan(
    `send ${queue}`,
    {
      kind: SpanKind.PRODUCER,
      links,
      attributes: {
        'messaging.system': MESSAGING_SYSTEM,
        'messaging.operation.type': 'send',
        'messaging.destination.name': queue,
        ...(jobId === undefined ? {} : { 'messaging.message.id': jobId }),
      },
    },
    context.active(),
  );
}

/**
 * Adds a job under a `send <queue>` span. `fn` gets the span's trace context to put in the job's
 * data, or undefined when nothing is traced. `links` relate it to other traces (a redrive's
 * original job).
 */
export async function enqueueing<T>(
  queue: string,
  jobId: string | undefined,
  fn: (carrier: TraceCarrier | undefined) => Promise<T>,
  { links = [] }: { readonly links?: Link[] } = {},
): Promise<T> {
  const span = producerSpan(queue, jobId, links);
  try {
    return await fn(inject(span));
  } catch (cause) {
    fail(span, cause);
    throw cause;
  } finally {
    span.end();
  }
}

/** As `enqueueing`, for a bulk add: one `send` span and carrier per job, one call to `fn`. */
export async function enqueueingMany<T>(
  queue: string,
  jobIds: readonly string[],
  fn: (carriers: (TraceCarrier | undefined)[]) => Promise<T>,
): Promise<T> {
  const spans = jobIds.map((jobId) => producerSpan(queue, jobId, []));
  try {
    return await fn(spans.map(inject));
  } catch (cause) {
    for (const span of spans) fail(span, cause);
    throw cause;
  } finally {
    for (const span of spans) span.end();
  }
}

export interface ProcessedJob {
  readonly id?: string | undefined;
  readonly attemptsMade: number;
}

/**
 * Runs a job's processor under a `process <queue>` span: a child of the span that added the job,
 * and linked to it. A processor that throws (BullMQ's retry signal) marks the span failed and
 * rethrows.
 */
export async function processing<T>(
  queue: string,
  job: ProcessedJob,
  carrier: TraceCarrier | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = carrier ? propagation.extract(ROOT_CONTEXT, carrier) : ROOT_CONTEXT;
  const span = tracer().startSpan(
    `process ${queue}`,
    {
      kind: SpanKind.CONSUMER,
      links: linksFrom(carrier),
      attributes: {
        'messaging.system': MESSAGING_SYSTEM,
        'messaging.operation.type': 'process',
        'messaging.destination.name': queue,
        'tripwire.job.attempt': job.attemptsMade + 1,
        ...(job.id === undefined ? {} : { 'messaging.message.id': job.id }),
      },
    },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), fn);
  } catch (cause) {
    fail(span, cause);
    throw cause;
  } finally {
    span.end();
  }
}
