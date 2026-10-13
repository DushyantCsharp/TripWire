import { describe, expect, it } from '@jest/globals';
import { err, ok } from '@tripwire/result';
import { memoryChangeSource, memoryLogStore, memoryTraceStore } from '../memory.js';
import { modelTools, READ_TOOL_NAMES } from './definitions.js';
import type { LogLine, MetricSeries, RunbookSection, Span, TelemetryPorts } from './ports.js';
import {
  logPatterns,
  logTemplate,
  summariseSeries,
  summariseTrace,
  telemetryTools,
} from './telemetry.js';

const NOW = new Date('2026-10-01T12:30:00Z');

function line(i: number, service = 'payment', severityNumber = 17, body?: string): LogLine {
  return {
    id: `l${String(i).padStart(3, '0')}`,
    at: new Date(NOW.getTime() - (i + 1) * 1_000),
    service,
    severityNumber,
    body: body ?? `Charge failed for order ${String(1000 + i)}: Invalid token`,
  };
}

function ports(overrides: Partial<TelemetryPorts> = {}): TelemetryPorts {
  const unused = () => Promise.resolve(err({ kind: 'unavailable' as const, message: 'unused' }));
  return {
    logs: { search: unused },
    traces: { search: unused },
    metrics: { queryRange: unused },
    runbooks: { search: unused },
    ...overrides,
  };
}

const call = { signal: undefined };

describe('log summarising', () => {
  it.each([
    ['Charge failed for order 1234: Invalid token', 'Charge failed for order #: Invalid token'],
    ['user 3fa85f64-5717-4562-b3fc-2c963f66afa6 not found', 'user * not found'],
    ['span 4bf92f3577b34da6 failed after 12.5ms', 'span * failed after #ms'],
    ['product "OLJCESPC7Z" missing', 'product "*" missing'],
    ['  many   spaces\nand lines  ', 'many spaces and lines'],
  ])('templates %j as %j', (body, template) => {
    expect(logTemplate(body)).toBe(template);
  });

  it('counts the commonest shapes, by severity, with the service most of them came from', () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => line(i)),
      line(5, 'checkout'),
      line(6, 'payment', 9, 'Charge request received. amount=12.99'),
      line(7, 'payment', 9, 'Charge request received. amount=7.10'),
    ];
    expect(logPatterns(lines, 2)).toEqual([
      {
        template: 'Charge failed for order #: Invalid token',
        count: 6,
        service: 'payment',
        severity: 'error',
        exampleId: 'log:l000',
      },
      {
        template: 'Charge request received. amount=#',
        count: 2,
        service: 'payment',
        severity: 'info',
        exampleId: 'log:l006',
      },
    ]);
  });
});

describe('query_logs', () => {
  const lines = Array.from({ length: 250 }, (_, i) =>
    line(i, i % 5 === 0 ? 'checkout' : 'payment'),
  );

  it('summarises the window, then returns the newest lines, and a cursor for more', async () => {
    const tools = telemetryTools(ports({ logs: memoryLogStore(lines) }), { now: () => NOW });
    const page = await tools.query_logs?.({ minutes: 30, limit: 3 }, call);
    expect(page).toMatchObject({
      ok: true,
      value: {
        window: { from: '2026-10-01T12:00:00.000Z', to: '2026-10-01T12:30:00.000Z' },
        total: 250,
        bySeverity: { error: 250 },
        byService: { payment: 200, checkout: 50 },
        patterns: [{ count: 250, exampleId: 'log:l000' }],
        lines: [
          {
            id: 'log:l000',
            at: '2026-10-01T12:29:59.000Z',
            service: 'checkout',
            severity: 'error',
          },
          { id: 'log:l001' },
          { id: 'log:l002' },
        ],
        truncated: false,
        nextCursor: expect.any(String) as unknown,
      },
    });
  });

  it('pages on with the cursor over the same window, without repeating a line', async () => {
    let now = NOW;
    const tools = telemetryTools(ports({ logs: memoryLogStore(lines) }), { now: () => now });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await tools.query_logs?.({ minutes: 30, limit: 100, cursor }, call);
      if (!result?.ok) throw new Error('page failed');
      if (page > 0) expect(result.value.patterns).toEqual([]);
      seen.push(...result.value.lines.map((l) => l.id));
      cursor = result.value.nextCursor ?? undefined;
      // Time moves on between pages; the cursor keeps the first page's window.
      now = new Date(now.getTime() + 60_000);
    }
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    expect(cursor).toBeUndefined();
  });

  it('returns at most 200 lines, clipped', async () => {
    const long = Array.from({ length: 250 }, (_, i) =>
      line(i, 'payment', 17, `${'y'.repeat(300)} ${String(i)}`),
    );
    const tools = telemetryTools(ports({ logs: memoryLogStore(long) }), { now: () => NOW });
    const result = await tools.query_logs?.({ minutes: 30, limit: 200 }, call);
    if (!result?.ok) throw new Error('query failed');
    expect(result.value.lines).toHaveLength(200);
    expect(Math.max(...result.value.lines.map((l) => l.body.length))).toBe(160);
  });

  it('filters by service, severity and phrase', async () => {
    const mixed = [line(0, 'payment', 17), line(1, 'payment', 9, 'ok'), line(2, 'cart', 17)];
    const tools = telemetryTools(ports({ logs: memoryLogStore(mixed) }), { now: () => NOW });
    const result = await tools.query_logs?.(
      {
        service: 'payment',
        minSeverity: 'warn',
        contains: 'invalid TOKEN',
        minutes: 30,
        limit: 10,
      },
      call,
    );
    expect(result?.ok && result.value.lines.map((l) => l.id)).toEqual(['log:l000']);
  });

  it.each([
    ['one it did not issue', 'not-a-cursor'],
    [
      'one for other filters',
      Buffer.from(JSON.stringify({ from: 0, to: 1, offset: 10, filter: 'abc' })).toString(
        'base64url',
      ),
    ],
  ])('rejects a cursor that is %s', async (_case, cursor) => {
    const tools = telemetryTools(ports({ logs: memoryLogStore(lines) }), { now: () => NOW });
    const result = await tools.query_logs?.({ minutes: 30, limit: 10, cursor }, call);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_query' } });
  });

  it('passes on a backend that is down', async () => {
    const down = {
      search: () =>
        Promise.resolve(err({ kind: 'unavailable' as const, message: 'OpenSearch timed out' })),
    };
    const tools = telemetryTools(ports({ logs: down }), { now: () => NOW });
    expect(await tools.query_logs?.({ minutes: 30, limit: 10 }, call)).toEqual(
      err({ kind: 'unavailable', message: 'OpenSearch timed out' }),
    );
  });
});

function span(
  id: string,
  parent: string | null,
  service: string,
  startMs: number,
  durationMs: number,
  message?: string,
): Span {
  return {
    spanId: id,
    parentSpanId: parent,
    service,
    operation: `${service}.op`,
    startUs: (NOW.getTime() - 60_000 + startMs) * 1000,
    durationUs: durationMs * 1000,
    error: message !== undefined,
    message: message ?? null,
  };
}

describe('query_traces', () => {
  it('summarises a trace: its root, services, and failures from outermost to innermost', () => {
    expect(
      summariseTrace({
        traceId: 'abc',
        spans: [
          span('c', 'b', 'payment', 20, 30, 'Invalid token'),
          span('a', null, 'frontend', 0, 120, 'checkout failed'),
          span('b', 'a', 'checkout', 5, 100, 'charge failed'),
          span('d', 'a', 'cart', 2, 3),
        ],
      }),
    ).toEqual({
      id: 'trace:abc',
      root: 'frontend frontend.op',
      startedAt: '2026-10-01T12:29:00.000Z',
      durationMs: 120,
      spanCount: 4,
      services: ['payment', 'frontend', 'checkout', 'cart'],
      errors: [
        { service: 'frontend', operation: 'frontend.op', message: 'checkout failed' },
        { service: 'checkout', operation: 'checkout.op', message: 'charge failed' },
        { service: 'payment', operation: 'payment.op', message: 'Invalid token' },
      ],
    });
  });

  it('puts failing traces first, then the slowest, with percentiles over all of them', async () => {
    const traces = [
      { traceId: 'fast', spans: [span('a', null, 'checkout', 0, 10)] },
      { traceId: 'slow', spans: [span('a', null, 'checkout', 1, 900)] },
      { traceId: 'failed', spans: [span('a', null, 'checkout', 2, 50, 'boom')] },
    ];
    const tools = telemetryTools(ports({ traces: memoryTraceStore(traces) }), { now: () => NOW });
    const result = await tools.query_traces?.(
      { service: 'checkout', errorsOnly: false, minutes: 30, limit: 5 },
      call,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        summary: { traces: 3, withErrors: 1, p50Ms: 50, p95Ms: 900 },
        traces: [{ id: 'trace:failed' }, { id: 'trace:slow' }, { id: 'trace:fast' }],
      },
    });
  });
});

describe('query_metrics', () => {
  const end = new Date('2026-10-01T12:30:00Z');
  const t = (minutesAgo: number) => end.getTime() / 1000 - minutesAgo * 60;
  const series = (service: string, values: number[]): MetricSeries => ({
    labels: {
      service_name: service,
      job: 'opentelemetry-demo',
      instance: 'collector:1',
      service_instance_id: 'x',
    },
    points: values.map((value, i) => [t(values.length - 1 - i), value]),
  });

  it('states shared labels once, drops process labels, and keeps the busiest series first', () => {
    const summary = summariseSeries(
      'rate(errors[5m])',
      [series('cart', [0, 0.01]), series('payment', [0, 0.5, Number.NaN, 0.48])],
      end,
      8,
    );
    expect(summary.commonLabels).toEqual({ job: 'opentelemetry-demo' });
    expect(summary.series.map((s) => [s.labels, s.min, s.max, s.first, s.last])).toEqual([
      [{ service_name: 'payment' }, 0, 0.5, 0, 0.48],
      [{ service_name: 'cart' }, 0, 0.01, 0, 0.01],
    ]);
    // NaN is dropped; times are minutes before the window's end.
    expect(summary.series[0]?.points).toEqual([
      [-3, 0],
      [-2, 0.5],
      [0, 0.48],
    ]);
    expect(summary.series[0]?.id).toMatch(/^metric:[0-9a-f]{12}$/);
  });

  it('keeps at most 12 points and 8 series, to three significant figures', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      series(
        `svc${String(i)}`,
        Array.from({ length: 60 }, (_, j) => (i + 1) / 3 + j),
      ),
    );
    const summary = summariseSeries('up', many, end, 8);
    expect(summary.totalSeries).toBe(20);
    expect(summary.series).toHaveLength(8);
    expect(summary.series[0]?.points).toHaveLength(12);
    expect(summary.series[0]?.mean).toBe(36.2);
  });

  it('asks for about 60 points over the window, and passes on rejected PromQL', async () => {
    const asked: number[] = [];
    const tools = telemetryTools(
      ports({
        metrics: {
          queryRange: (query) => {
            asked.push(query.stepSeconds);
            return Promise.resolve(
              query.promql === 'rate('
                ? err({ kind: 'invalid_query', message: 'parse error' })
                : ok([]),
            );
          },
        },
      }),
      { now: () => NOW },
    );
    expect(await tools.query_metrics?.({ promql: 'up', minutes: 120 }, call)).toMatchObject({
      ok: true,
    });
    expect(asked).toEqual([120]);
    expect(await tools.query_metrics?.({ promql: 'rate(', minutes: 30 }, call)).toEqual(
      err({ kind: 'invalid_query', message: 'parse error' }),
    );
  });
});

describe('list_deploys and get_runbook', () => {
  it('lists changes newest first, at most 10', async () => {
    const changes = Array.from({ length: 12 }, (_, i) => ({
      id: `deploy-${String(i)}`,
      service: 'cart',
      kind: 'deploy' as const,
      description: `cart 1.${String(i)}`,
      at: new Date(NOW.getTime() - (12 - i) * 60_000),
    }));
    const tools = telemetryTools(ports({ changes: memoryChangeSource(changes) }), {
      now: () => NOW,
    });
    const result = await tools.list_deploys?.({ minutes: 360 }, call);
    if (!result?.ok) throw new Error('list failed');
    expect(result.value.changes).toHaveLength(10);
    expect(result.value.changes[0]).toEqual({
      id: 'change:deploy-11',
      service: 'cart',
      kind: 'deploy',
      description: 'cart 1.11',
      at: '2026-10-01T12:29:00.000Z',
    });
    expect(result.value.truncated).toBe(true);
  });

  it("isn't offered without a change source", () => {
    expect(telemetryTools(ports()).list_deploys).toBeUndefined();
  });

  it('returns runbook sections, clipped, with citable ids', async () => {
    const section: RunbookSection = {
      id: 'payment.md#charge-failures',
      title: 'Charge failures',
      service: 'payment',
      content: 'z'.repeat(2_000),
      score: 0.81234,
    };
    const tools = telemetryTools(
      ports({ runbooks: { search: () => Promise.resolve(ok([section, section, section])) } }),
    );
    const result = await tools.get_runbook?.({ query: 'charge errors', k: 2 }, call);
    if (!result?.ok) throw new Error('search failed');
    expect(result.value.sections).toHaveLength(2);
    expect(result.value.sections[0]).toMatchObject({
      id: 'runbook:payment.md#charge-failures',
      score: 0.812,
    });
    expect(result.value.sections[0]?.excerpt).toHaveLength(600);
  });
});

describe('the tools as offered to the model', () => {
  it('stay small: they are re-sent on every turn of a 40k-token run', () => {
    // A guard against schema creep: raise it knowingly, with the token budget in mind.
    expect(JSON.stringify(modelTools(READ_TOOL_NAMES)).length).toBeLessThan(9_000);
  });
});
