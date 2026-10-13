import { describe, expect, it } from '@jest/globals';
import { err } from '@tripwire/result';
import { httpChangeSource } from './changes.js';
import { jaegerTraceStore } from './jaeger.js';
import { field, opensearchLogStore } from './opensearch.js';
import { prometheusMetricStore, sampleValue } from './prometheus.js';

interface Sent {
  readonly url: URL;
  readonly method: string;
  readonly body: unknown;
}

/** A fetch that answers every request with `response`, recording what was sent. */
function backend(response: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fake: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    sent.push({
      url: new URL(request.url),
      method: request.method,
      body: text ? JSON.parse(text) : undefined,
    });
    return response();
  };
  return { fetch: fake, sent };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const from = new Date('2026-10-01T12:00:00Z');
const to = new Date('2026-10-01T12:30:00Z');

describe('opensearchLogStore', () => {
  const hits = {
    hits: {
      total: { value: 1204 },
      hits: [
        {
          _id: 'Ab3x',
          _source: {
            observedTimestamp: '2026-10-01T12:05:12.000Z',
            body: 'Charge failed: Invalid token',
            severity: { number: 17, text: 'ERROR' },
            resource: { 'service.name': 'payment' },
          },
        },
        {
          _id: 'Cd4y',
          _source: {
            '@timestamp': '2026-10-01T12:05:10.000Z',
            body: { message: 'structured' },
            'severity.text': 'Information',
            'resource.service.name': 'checkout',
          },
        },
      ],
    },
    aggregations: {
      severity: {
        buckets: [
          { key: 'error', doc_count: 900 },
          { key: 'debug', doc_count: 0 },
          { key: 'info', doc_count: 304 },
        ],
      },
      service: {
        buckets: [
          { key: 'payment', doc_count: 1000 },
          { key: 'checkout', doc_count: 204 },
        ],
      },
    },
  };

  it('asks with filters, a phrase match and aggregations, and reads either field mapping', async () => {
    const { fetch, sent } = backend(() => json(200, hits));
    const store = opensearchLogStore({ url: 'http://opensearch:9200/', fetch });
    const result = await store.search(
      {
        service: 'payment',
        minSeverityNumber: 17,
        contains: 'Invalid token',
        from,
        to,
        offset: 0,
        limit: 1,
        sampleSize: 500,
      },
      {},
    );

    expect(sent[0]?.url.href).toBe('http://opensearch:9200/otel-logs-*/_search');
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body).toMatchObject({
      track_total_hits: true,
      from: 0,
      size: 500,
      sort: [{ observedTimestamp: { order: 'desc' } }],
      query: {
        bool: {
          filter: [
            { range: { observedTimestamp: { gte: from.toISOString(), lt: to.toISOString() } } },
            { term: { 'resource.service.name.keyword': 'payment' } },
            { range: { 'severity.number': { gte: 17 } } },
          ],
          must: [{ match_phrase: { body: 'Invalid token' } }],
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      value: {
        total: 1204,
        bySeverity: { error: 900, info: 304 },
        byService: { payment: 1000, checkout: 204 },
        lines: [
          {
            id: 'Ab3x',
            at: new Date('2026-10-01T12:05:12.000Z'),
            service: 'payment',
            severityNumber: 17,
            body: 'Charge failed: Invalid token',
          },
        ],
        sample: [
          {
            id: 'Ab3x',
            at: new Date('2026-10-01T12:05:12.000Z'),
            service: 'payment',
            severityNumber: 17,
            body: 'Charge failed: Invalid token',
          },
          {
            id: 'Cd4y',
            at: new Date('2026-10-01T12:05:10.000Z'),
            service: 'checkout',
            severityNumber: 9,
            body: '{"message":"structured"}',
          },
        ],
      },
    });
  });

  it('pages without a sample after the first page', async () => {
    const { fetch, sent } = backend(() => json(200, hits));
    const result = await opensearchLogStore({ url: 'http://os', fetch }).search(
      { from, to, offset: 100, limit: 50, sampleSize: 0 },
      {},
    );
    expect(sent[0]?.body).toMatchObject({ from: 100, size: 50 });
    expect(sent[0]?.body).not.toHaveProperty('query.bool.must');
    expect(result.ok && result.value.sample).toEqual([]);
  });

  it.each([
    [
      400,
      { error: { reason: 'failed to parse date field' } },
      err({
        kind: 'invalid_query',
        message: 'OpenSearch answered 400: failed to parse date field',
      }),
    ],
    [
      503,
      { error: 'cluster unavailable' },
      err({ kind: 'unavailable', message: 'OpenSearch answered 503: cluster unavailable' }),
    ],
    [
      200,
      { unexpected: true },
      err({ kind: 'unavailable', message: 'OpenSearch sent a response in an unexpected shape' }),
    ],
  ])('maps a %i to a tool error', async (status, body, expected) => {
    const { fetch } = backend(() => json(status, body));
    expect(
      await opensearchLogStore({ url: 'http://os', fetch }).search(
        { from, to, offset: 0, limit: 1, sampleSize: 0 },
        {},
      ),
    ).toEqual(expected);
  });

  it('reads nested, flattened and mixed field paths', () => {
    expect(field({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(field({ 'a.b.c': 2 }, 'a.b.c')).toBe(2);
    expect(field({ a: { 'b.c': 3 } }, 'a.b.c')).toBe(3);
    expect(field({ a: 1 }, 'a.b')).toBeUndefined();
  });
});

describe('jaegerTraceStore', () => {
  const traces = {
    data: [
      {
        traceID: 't1',
        processes: { p1: { serviceName: 'checkout' }, p2: { serviceName: 'payment' } },
        spans: [
          {
            spanID: 's1',
            operationName: 'PlaceOrder',
            references: [],
            startTime: 1_000,
            duration: 400,
            tags: [
              { key: 'error', value: true },
              { key: 'otel.status_description', value: 'charge failed' },
            ],
            processID: 'p1',
          },
          {
            spanID: 's2',
            operationName: 'Charge',
            references: [{ refType: 'CHILD_OF', spanID: 's1' }],
            startTime: 1_100,
            duration: 90,
            tags: [{ key: 'otel.status_code', value: 'ERROR' }],
            logs: [
              {
                fields: [
                  { key: 'event', value: 'exception' },
                  { key: 'exception.message', value: 'Invalid token' },
                ],
              },
            ],
            processID: 'p2',
          },
        ],
      },
      {
        traceID: 't2',
        processes: { p1: { serviceName: 'checkout' } },
        spans: [
          {
            spanID: 'x',
            operationName: 'PlaceOrder',
            startTime: 2_000,
            duration: 10,
            tags: [],
            processID: 'p1',
          },
        ],
      },
    ],
  };

  it('queries the search API and reads failures from tags and exception events', async () => {
    const { fetch, sent } = backend(() => json(200, traces));
    const result = await jaegerTraceStore({ url: 'http://jaeger:16686/jaeger/ui', fetch }).search(
      {
        service: 'checkout',
        operation: 'PlaceOrder',
        errorsOnly: true,
        minDurationMs: 100,
        from,
        to,
        limit: 5,
      },
      {},
    );
    const params = Object.fromEntries(sent[0]?.url.searchParams ?? []);
    expect(sent[0]?.url.pathname).toBe('/jaeger/ui/api/traces');
    expect(params).toEqual({
      service: 'checkout',
      operation: 'PlaceOrder',
      start: String(from.getTime() * 1000),
      end: String(to.getTime() * 1000),
      limit: '20',
      minDuration: '100ms',
      tags: '{"error":"true"}',
    });
    // Only the failing trace: errorsOnly is checked here too.
    expect(result).toEqual({
      ok: true,
      value: [
        {
          traceId: 't1',
          spans: [
            {
              spanId: 's1',
              parentSpanId: null,
              service: 'checkout',
              operation: 'PlaceOrder',
              startUs: 1_000,
              durationUs: 400,
              error: true,
              message: 'charge failed',
            },
            {
              spanId: 's2',
              parentSpanId: 's1',
              service: 'payment',
              operation: 'Charge',
              startUs: 1_100,
              durationUs: 90,
              error: true,
              message: 'Invalid token',
            },
          ],
        },
      ],
    });
  });

  it('treats a network failure as the backend being unavailable', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
    expect(
      await jaegerTraceStore({ url: 'http://jaeger', fetch }).search(
        { service: 'x', errorsOnly: false, from, to, limit: 1 },
        {},
      ),
    ).toEqual(err({ kind: 'unavailable', message: 'Jaeger is unreachable: fetch failed' }));
  });

  it('says it timed out when its signal fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch: typeof globalThis.fetch = () =>
      Promise.reject(new DOMException('aborted', 'AbortError'));
    expect(
      await jaegerTraceStore({ url: 'http://jaeger', fetch }).search(
        { service: 'x', errorsOnly: false, from, to, limit: 1 },
        { signal: controller.signal },
      ),
    ).toEqual(err({ kind: 'unavailable', message: 'Jaeger timed out' }));
  });
});

describe('prometheusMetricStore', () => {
  it('evaluates a range query and reads sample values, NaN and infinities included', async () => {
    const { fetch, sent } = backend(() =>
      json(200, {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { service_name: 'payment' },
              values: [
                [1_759_320_000, '0.5'],
                [1_759_320_060, 'NaN'],
                [1_759_320_120, '+Inf'],
              ],
            },
          ],
        },
      }),
    );
    const result = await prometheusMetricStore({ url: 'http://prometheus:9090', fetch }).queryRange(
      { promql: 'sum by (service_name) (rate(x[5m]))', start: from, end: to, stepSeconds: 30 },
      {},
    );
    expect(Object.fromEntries(sent[0]?.url.searchParams ?? [])).toEqual({
      query: 'sum by (service_name) (rate(x[5m]))',
      start: String(from.getTime() / 1000),
      end: String(to.getTime() / 1000),
      step: '30',
    });
    expect(result.ok && result.value[0]?.points.map(([, v]) => v)).toEqual([
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]);
  });

  it("passes on Prometheus's own explanation of a bad query", async () => {
    const { fetch } = backend(() =>
      json(400, {
        status: 'error',
        errorType: 'bad_data',
        error: '1:6: parse error: unclosed left parenthesis',
      }),
    );
    expect(
      await prometheusMetricStore({ url: 'http://p', fetch }).queryRange(
        { promql: 'rate(', start: from, end: to, stepSeconds: 60 },
        {},
      ),
    ).toEqual(
      err({
        kind: 'invalid_query',
        message: 'Prometheus answered 400: 1:6: parse error: unclosed left parenthesis',
      }),
    );
  });

  it('asks for aggregation when a query returns too many series', async () => {
    const result = Array.from({ length: 501 }, (_, i) => ({
      metric: { i: String(i) },
      values: [],
    }));
    const { fetch } = backend(() =>
      json(200, { status: 'success', data: { resultType: 'matrix', result } }),
    );
    expect(
      await prometheusMetricStore({ url: 'http://p', fetch }).queryRange(
        { promql: 'up', start: from, end: to, stepSeconds: 60 },
        {},
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_query' } });
  });

  it.each([
    ['1.5', 1.5],
    ['-Inf', Number.NEGATIVE_INFINITY],
    ['Inf', Number.POSITIVE_INFINITY],
  ])('reads %s', (value, expected) => {
    expect(sampleValue(value)).toBe(expected);
  });
});

describe('httpChangeSource', () => {
  it('reads a change feed', async () => {
    const { fetch, sent } = backend(() =>
      json(200, {
        changes: [
          {
            id: 'd1',
            service: 'cart',
            kind: 'deploy',
            description: 'cart 2.0',
            at: '2026-10-01T11:00:00Z',
          },
        ],
      }),
    );
    const result = await httpChangeSource({ url: 'http://cd/changes', fetch }).list(
      { service: 'cart', from, to },
      {},
    );
    expect(Object.fromEntries(sent[0]?.url.searchParams ?? [])).toEqual({
      since: from.toISOString(),
      until: to.toISOString(),
      service: 'cart',
    });
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 'd1',
          service: 'cart',
          kind: 'deploy',
          description: 'cart 2.0',
          at: new Date('2026-10-01T11:00:00Z'),
        },
      ],
    });
  });

  it('treats a page that is not JSON as the feed being down', async () => {
    const { fetch } = backend(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    expect(await httpChangeSource({ url: 'http://cd', fetch }).list({ from, to }, {})).toEqual(
      err({ kind: 'unavailable', message: 'the change feed answered 502' }),
    );
  });
});
