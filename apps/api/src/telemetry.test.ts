import { describe, expect, it } from '@jest/globals';
import { testMeter } from '@tripwire/telemetry/testing';
import { signatureHeader } from './ingest/signature.js';
import { buildServer } from './server.js';
import { ingestMetrics, observeQueues } from './telemetry.js';
import {
  memoryDeadLetters,
  memoryIdempotency,
  memoryQueue,
  switchableAdmission,
} from './testing/fakes.js';

const secret = 'webhook-secret-for-tests';
const now = new Date('2026-10-11T12:00:00Z');
const payload = JSON.stringify({
  source: 'k6',
  alerts: [
    {
      name: 'HighErrorRate',
      status: 'firing',
      severity: 'critical',
      service: 'checkout',
      starts_at: '2026-10-11T11:59:00Z',
    },
  ],
});

describe('ingest metrics', () => {
  it('times every webhook response by route and status, and counts what is shed', async () => {
    const metrics = testMeter();
    const admission = switchableAdmission();
    const app = await buildServer({
      ingest: {
        idempotency: memoryIdempotency(),
        queue: memoryQueue(),
        admission,
        secrets: [secret],
        now: () => now,
        metrics: ingestMetrics(metrics.meter),
      },
      deadLetters: memoryDeadLetters([]),
    });
    const post = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/webhooks/generic',
        payload,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          'x-tripwire-signature': signatureHeader(secret, now.getTime() / 1000, key, payload),
        },
      });

    expect((await post('delivery-1')).statusCode).toBe(202);
    admission.shedFor = 3;
    // Refused in onRequest, before the body is read: still timed.
    expect((await post('delivery-2')).statusCode).toBe(503);
    await app.close();

    const points = await metrics.read();
    const latency = points.filter((p) => p.name === 'ingest_ack_latency');
    expect(
      latency.map((p) => [p.attributes, typeof p.value === 'object' ? p.value.count : null]),
    ).toEqual(
      expect.arrayContaining([
        [{ route: '/v1/webhooks/generic', status: '202' }, 1],
        [{ route: '/v1/webhooks/generic', status: '503' }, 1],
      ]),
    );
    expect(points.filter((p) => p.name === 'shed_requests_total')).toEqual([
      { name: 'shed_requests_total', attributes: { reason: 'overloaded' }, value: 1 },
    ]);
  });
});

describe('queue gauges', () => {
  it('reports each queue by state and the dead-letter size, skipping a queue it cannot read', async () => {
    const metrics = testMeter();
    const counts = (counts: Record<string, number>) => () => Promise.resolve(counts);
    observeQueues(
      [
        { name: 'ingest', getJobCounts: counts({ waiting: 12, active: 8, delayed: 0, failed: 1 }) },
        { name: 'cluster', getJobCounts: () => Promise.reject(new Error('redis down')) },
      ],
      { name: 'triage-dlq', getJobCounts: counts({ waiting: 2, delayed: 0, paused: 1 }) },
      metrics.meter,
    );
    const points = await metrics.read();
    expect(
      points
        .filter((p) => p.name === 'queue_depth')
        .map((p) => [p.attributes.queue, p.attributes.state, p.value]),
    ).toEqual([
      ['ingest', 'waiting', 12],
      ['ingest', 'active', 8],
      ['ingest', 'delayed', 0],
      ['ingest', 'failed', 1],
    ]);
    expect(points.filter((p) => p.name === 'dlq_size')).toEqual([
      { name: 'dlq_size', attributes: { queue: 'triage-dlq' }, value: 3 },
    ]);
  });
});
