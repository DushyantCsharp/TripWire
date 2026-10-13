import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { activeTraceId, tracer } from './api.js';
import {
  carrierOf,
  carrierSchema,
  enqueueing,
  enqueueingMany,
  linksFrom,
  processing,
} from './propagation.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  // Registered once for the file: the API refuses a second global provider.
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(() => {
  exporter.reset();
});

const span = (name: string) => {
  const found = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!found) throw new Error(`no ${name} span`);
  return found;
};

/** A job's data the way BullMQ keeps it: through JSON. */
const stored = <T>(data: T): T => JSON.parse(JSON.stringify(data)) as T;

describe('trace context through BullMQ', () => {
  it('makes the processing span a child of the enqueue span, linked to it, in one trace', async () => {
    const request = tracer().startSpan('POST /v1/webhooks/alertmanager');
    const job = await context.with(trace.setSpan(context.active(), request), () =>
      enqueueing('ingest', 'ing-1', (carrier) =>
        Promise.resolve(stored({ id: 'ing-1', trace: carrier })),
      ),
    );
    request.end();
    expect(carrierSchema.parse(job.trace).traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    // As runtime.ts does: the carrier read back out of the stored job data.
    const inside = await processing(
      'ingest',
      { id: 'ing-1', attemptsMade: 2 },
      carrierOf(job),
      () => Promise.resolve(activeTraceId()),
    );

    const [send, process] = [span('send ingest'), span('process ingest')];
    expect(send.kind).toBe(SpanKind.PRODUCER);
    expect(process.kind).toBe(SpanKind.CONSUMER);
    // One trace, from the request through the job.
    const traceId = request.spanContext().traceId;
    expect([send.spanContext().traceId, process.spanContext().traceId, inside]).toEqual([
      traceId,
      traceId,
      traceId,
    ]);
    expect(send.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(process.parentSpanContext?.spanId).toBe(send.spanContext().spanId);
    expect(process.links.map((link) => link.context.spanId)).toEqual([send.spanContext().spanId]);
    expect(process.attributes).toMatchObject({
      'messaging.system': 'bullmq',
      'messaging.destination.name': 'ingest',
      'messaging.message.id': 'ing-1',
      'tripwire.job.attempt': 3,
    });
  });

  it('gives each job of a bulk add its own enqueue span and context', async () => {
    const parent = tracer().startSpan('process ingest');
    const carriers = await context.with(trace.setSpan(context.active(), parent), () =>
      enqueueingMany('cluster', ['cluster-a', 'cluster-b'], (cs) => Promise.resolve(cs)),
    );
    parent.end();
    const sends = exporter.getFinishedSpans().filter((s) => s.name === 'send cluster');
    expect(sends.map((s) => s.attributes['messaging.message.id'])).toEqual([
      'cluster-a',
      'cluster-b',
    ]);
    expect(new Set(carriers.map((c) => c?.traceparent)).size).toBe(2);
    for (const send of sends) {
      expect(send.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    }
  });

  it('starts a new trace for a job that carries none, or a malformed one', async () => {
    await processing('triage', { attemptsMade: 0 }, undefined, () => Promise.resolve());
    await processing('triage', { attemptsMade: 0 }, { traceparent: 'not-a-traceparent' }, () =>
      Promise.resolve(),
    );
    for (const s of exporter.getFinishedSpans()) {
      expect(s.parentSpanContext).toBeUndefined();
      expect(s.links).toEqual([]);
    }
    expect(linksFrom({ traceparent: 'not-a-traceparent' })).toEqual([]);
    expect([carrierOf({ alertId: 'a-1' }), carrierOf({ trace: 7 }), carrierOf(null)]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('marks the processing span failed and rethrows when the processor throws', async () => {
    await expect(
      processing('cluster', { id: 'c-1', attemptsMade: 0 }, undefined, () =>
        Promise.reject(new Error('database unavailable')),
      ),
    ).rejects.toThrow('database unavailable');
    const failed = span('process cluster');
    expect(failed.status).toEqual({ code: SpanStatusCode.ERROR, message: 'database unavailable' });
    expect(failed.events.map((e) => e.name)).toEqual(['exception']);
  });

  it('links an enqueue to another trace when asked (a redrive to its original job)', async () => {
    const original = await enqueueing('triage', 'triage-1', (carrier) => Promise.resolve(carrier));
    exporter.reset();
    await enqueueing('triage', 'redrive-1', () => Promise.resolve(), {
      links: linksFrom(original),
    });
    const redrive = span('send triage');
    expect(redrive.links.map((link) => link.context.traceId)).toEqual([
      carrierSchema.parse(original).traceparent.split('-')[1],
    ]);
  });
});
