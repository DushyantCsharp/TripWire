import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from '@jest/globals';
import { fromPublicId } from '@tripwire/contracts/ids';
import { signatureHeader } from './ingest/signature.js';
import { buildServer } from './server.js';
import {
  memoryDeadLetters,
  memoryIdempotency,
  memoryQueue,
  switchableAdmission,
} from './testing/fakes.js';

const secret = 'webhook-secret-for-tests';
const now = new Date('2026-10-11T12:00:00Z');
const t = now.getTime() / 1000;
const ingestUuid = '0199d3a1-2b3c-7d4e-8f50-6a7b8c9d0e1f';

const alert = {
  name: 'HighErrorRate',
  status: 'firing',
  severity: 'critical',
  service: 'checkout',
  starts_at: '2026-10-11T11:59:00Z',
};
const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ source: 'k6', alerts: [alert], ...overrides });

async function harness() {
  const idempotency = memoryIdempotency();
  const queue = memoryQueue();
  const admission = switchableAdmission();
  let ids = 0;
  const app = await buildServer({
    ingest: {
      idempotency,
      queue,
      admission,
      secrets: [secret],
      now: () => now,
      newId: () => `${ingestUuid.slice(0, -2)}${String(ids++).padStart(2, '0')}`,
    },
    deadLetters: memoryDeadLetters([]),
  });

  const post = (
    payload: string,
    {
      key = 'delivery-1',
      signature = signatureHeader(secret, t, key ?? '', payload),
      contentType = 'application/json',
      path = '/v1/webhooks/generic',
    }: { key?: string | null; signature?: string | null; contentType?: string; path?: string } = {},
  ) =>
    app.inject({
      method: 'POST',
      url: path,
      payload,
      headers: {
        'content-type': contentType,
        ...(key === null ? {} : { 'idempotency-key': key }),
        ...(signature === null ? {} : { 'x-tripwire-signature': signature }),
      },
    });

  return { app, post, idempotency, queue, admission };
}

describe('POST /v1/webhooks/*', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
    return () => h.app.close();
  });

  it('verifies, enqueues and returns 202 with the ingest id', async () => {
    const payload = body();
    const response = await h.post(payload);

    expect(response.statusCode).toBe(202);
    const accepted = response.json<{
      ingest_id: string;
      received_at: string;
      alert_count: number;
    }>();
    expect(accepted).toMatchObject({ received_at: now.toISOString(), alert_count: 1 });
    expect(response.headers['idempotent-replayed']).toBeUndefined();
    expect(h.queue.jobs).toEqual([
      {
        ingestId: fromPublicId('ing', accepted.ingest_id),
        idempotencyKey: 'delivery-1',
        bodyHash: createHash('sha256').update(payload).digest('hex'),
        source: 'generic',
        receivedAt: now.toISOString(),
        payload: JSON.parse(payload) as unknown,
      },
    ]);
  });

  it('accepts Alertmanager payloads on their own route', async () => {
    const payload = JSON.stringify({
      version: '4',
      groupKey: '{}:{alertname="HighErrorRate"}',
      status: 'firing',
      receiver: 'tripwire',
      groupLabels: {},
      commonLabels: {},
      commonAnnotations: {},
      externalURL: 'http://alertmanager:9093',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'HighErrorRate', service: 'checkout' },
          annotations: {},
          startsAt: '2026-10-11T11:59:00Z',
          endsAt: '0001-01-01T00:00:00Z',
          fingerprint: 'abc',
        },
      ],
    });
    const response = await h.post(payload, { path: '/v1/webhooks/alertmanager' });
    expect({ status: response.statusCode, body: response.body }).toMatchObject({ status: 202 });
    expect(h.queue.jobs[0]?.source).toBe('alertmanager');
  });

  it('replays a retry with the same key and body: same ingest id, and the job is re-offered', async () => {
    const payload = body();
    const first = await h.post(payload);
    const retry = await h.post(payload);

    expect(retry.statusCode).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    // The same job twice: BullMQ drops the second (same job id), and Postgres backstops it after that.
    expect(h.queue.jobs).toHaveLength(2);
    expect(h.queue.jobs[1]).toEqual(h.queue.jobs[0]);
  });

  it('gives concurrent deliveries of one key a single ingest id', async () => {
    const payload = body();
    const responses = await Promise.all(Array.from({ length: 10 }, () => h.post(payload)));
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([202]));
    expect(new Set(responses.map((r) => r.json<{ ingest_id: string }>().ingest_id)).size).toBe(1);
    expect(new Set(h.queue.jobs.map((job) => job.ingestId)).size).toBe(1);
  });

  it('rejects a reused key with a different body (409), pointing at the first delivery', async () => {
    const first = await h.post(body());
    const reused = await h.post(body({ source: 'other' }));

    expect(reused.statusCode).toBe(409);
    expect(reused.headers['content-type']).toContain('application/problem+json');
    expect(reused.json()).toMatchObject({
      type: '/problems/idempotency-key-reused',
      status: 409,
      idempotency_key: 'delivery-1',
      first_ingest_id: first.json<{ ingest_id: string }>().ingest_id,
      first_received_at: now.toISOString(),
      instance: '/v1/webhooks/generic',
    });
    expect(h.queue.jobs).toHaveLength(1);
  });

  it.each([
    ['missing', { signature: null }],
    ['malformed', { signature: 'sha256=deadbeef' }],
    ['expired', { signature: signatureHeader(secret, t - 600, 'delivery-1', body()) }],
    ['mismatch', { signature: signatureHeader('not-the-right-secret', t, 'delivery-1', body()) }],
  ] as const)('rejects a %s signature with 401 and records nothing', async (reason, options) => {
    const response = await h.post(body(), options);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ type: '/problems/invalid-signature', reason });
    expect(h.queue.jobs).toEqual([]);
    expect(h.idempotency.records.size).toBe(0);
  });

  it('requires an Idempotency-Key', async () => {
    const response = await h.post(body(), {
      key: null,
      signature: signatureHeader(secret, t, '', body()),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: '/problems/validation-failed',
      errors: [{ pointer: '#/header/Idempotency-Key' }],
    });
  });

  it('points at each invalid field', async () => {
    const response = await h.post(body({ alerts: [{ ...alert, severity: 'sev1' }] }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      type: '/problems/validation-failed',
      errors: [{ pointer: '#/alerts/0/severity' }],
    });
  });

  it('enforces the 64-label limit the generated validators drop', async () => {
    const labels = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`l${String(i)}`, 'v']));
    const response = await h.post(body({ alerts: [{ ...alert, labels }] }));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ pointer: '#/alerts/0/labels' }] });
  });

  it('rejects bodies that are not JSON (400), too large (413) or another media type (415)', async () => {
    expect((await h.post('{"source":')).statusCode).toBe(400);

    const large = await h.post(body({ padding: 'x'.repeat(1024 * 1024) }));
    expect(large.statusCode).toBe(413);
    expect(large.json()).toMatchObject({ type: '/problems/payload-too-large' });

    const text = await h.post(body(), { contentType: 'text/plain' });
    expect(text.statusCode).toBe(415);
    expect(text.json()).toMatchObject({ type: '/problems/unsupported-media-type' });
  });

  it('sheds load with 503 and Retry-After before looking at the request', async () => {
    h.admission.shedFor = 17;
    const response = await h.post('not even json', { signature: null, key: null });

    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('17');
    expect(response.json()).toMatchObject({ type: '/problems/overloaded', status: 503 });
    expect(h.idempotency.records.size).toBe(0);
  });

  it('releases the key when the job cannot be enqueued, so the retry goes through', async () => {
    h.queue.down = true;
    const failed = await h.post(body());
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['retry-after']).toBe('5');
    expect(h.idempotency.records.size).toBe(0);

    h.queue.down = false;
    const retry = await h.post(body());
    expect(retry.statusCode).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(h.queue.jobs).toHaveLength(1);
  });

  it('returns 503 when the idempotency store is unavailable', async () => {
    h.idempotency.down = true;
    const response = await h.post(body());
    expect(response.statusCode).toBe(503);
    expect(h.queue.jobs).toEqual([]);
  });
});
