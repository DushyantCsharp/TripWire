import { describe, expect, it } from '@jest/globals';
import { memoryChangeSource, memoryLogStore, memoryTraceStore } from './memory.js';
import type { LogLine, Span } from './tools/ports.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s));
const from = at(0);
const to = at(59);

describe('memoryLogStore', () => {
  const lines: LogLine[] = [
    { id: 'b', at: at(10), service: 'payment', severityNumber: 17, body: 'Invalid Token' },
    { id: 'a', at: at(10), service: 'payment', severityNumber: 9, body: 'ok' },
    { id: 'c', at: at(30), service: 'cart', severityNumber: 13, body: 'slow' },
    { id: 'd', at: at(59), service: 'cart', severityNumber: 17, body: 'at the window end' },
  ];

  it('searches newest first, ties by id, within [from, to)', async () => {
    const result = await memoryLogStore(lines).search(
      { from, to, offset: 0, limit: 10, sampleSize: 2 },
      {},
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        total: 3,
        bySeverity: { error: 1, info: 1, warn: 1 },
        byService: { payment: 2, cart: 1 },
      },
    });
    expect(result.ok && result.value.lines.map((l) => l.id)).toEqual(['c', 'a', 'b']);
    expect(result.ok && result.value.sample.map((l) => l.id)).toEqual(['c', 'a']);
  });

  it('filters by service, minimum severity and a case-insensitive phrase, and pages', async () => {
    const store = memoryLogStore(lines);
    const filtered = await store.search(
      {
        service: 'payment',
        minSeverityNumber: 13,
        contains: 'invalid token',
        from,
        to,
        offset: 0,
        limit: 10,
        sampleSize: 0,
      },
      {},
    );
    expect(filtered.ok && filtered.value.lines.map((l) => l.id)).toEqual(['b']);
    const second = await store.search({ from, to, offset: 1, limit: 1, sampleSize: 0 }, {});
    expect(second.ok && second.value.lines.map((l) => l.id)).toEqual(['a']);
  });
});

describe('memoryTraceStore', () => {
  const span = (traceStart: number, service: string, error: boolean, durationS = 1): Span => ({
    spanId: `${service}-${String(traceStart)}`,
    parentSpanId: null,
    service,
    operation: 'op',
    startUs: at(traceStart).getTime() * 1000,
    durationUs: durationS * 1_000_000,
    error,
    message: null,
  });
  const traces = [
    { traceId: 't1', spans: [span(5, 'checkout', false)] },
    { traceId: 't2', spans: [span(20, 'checkout', true, 3)] },
    { traceId: 't3', spans: [span(40, 'payment', true)] },
    { traceId: 'empty', spans: [] },
  ];

  it('finds traces through a service, newest first, with the filters applied', async () => {
    const store = memoryTraceStore(traces);
    const all = await store.search(
      { service: 'checkout', errorsOnly: false, from, to, limit: 10 },
      {},
    );
    expect(all.ok && all.value.map((t) => t.traceId)).toEqual(['t2', 't1']);
    const failing = await store.search(
      { service: 'checkout', errorsOnly: true, from, to, limit: 10 },
      {},
    );
    expect(failing.ok && failing.value.map((t) => t.traceId)).toEqual(['t2']);
    const slow = await store.search(
      { service: 'checkout', errorsOnly: false, minDurationMs: 2_000, from, to, limit: 10 },
      {},
    );
    expect(slow.ok && slow.value.map((t) => t.traceId)).toEqual(['t2']);
    const named = await store.search(
      { service: 'checkout', operation: 'other', errorsOnly: false, from, to, limit: 10 },
      {},
    );
    expect(named.ok && named.value).toEqual([]);
  });
});

describe('memoryChangeSource', () => {
  it('lists changes in the window, for a service', async () => {
    const changes = [
      { id: 'a', service: 'cart', kind: 'deploy' as const, description: '', at: at(1) },
      { id: 'b', service: 'payment', kind: 'config' as const, description: '', at: at(2) },
      { id: 'c', service: 'cart', kind: 'deploy' as const, description: '', at: at(59) },
    ];
    const result = await memoryChangeSource(changes).list({ service: 'cart', from, to }, {});
    expect(result.ok && result.value.map((c) => c.id)).toEqual(['a']);
  });
});
