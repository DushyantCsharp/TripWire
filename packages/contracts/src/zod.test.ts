import { describe, expect, it } from '@jest/globals';
import {
  selectHeaders,
  zIngestAlertmanagerWebhookBody,
  zIngestGenericWebhookBody,
  zIngestGenericWebhookHeaders,
  zListIncidentsQuery,
} from './zod.js';

const alertmanagerPayload = {
  version: '4',
  groupKey: '{}:{alertname="PaymentFailures"}',
  truncatedAlerts: 0,
  status: 'firing',
  receiver: 'tripwire',
  groupLabels: { alertname: 'PaymentFailures' },
  commonLabels: { alertname: 'PaymentFailures', service: 'payment', severity: 'critical' },
  commonAnnotations: { summary: 'Payment failure rate above 5%' },
  externalURL: 'http://alertmanager:9093',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'PaymentFailures', service: 'payment', severity: 'critical' },
      annotations: { summary: 'Payment failure rate above 5%' },
      // Go's RFC3339Nano with a zone offset, and the zero time Alertmanager sends while firing.
      startsAt: '2026-10-11T20:05:48.780123456+02:00',
      endsAt: '0001-01-01T00:00:00Z',
      generatorURL: 'http://prometheus:9090/graph?g0.expr=rate%28payment_failures%5B1m%5D%29',
      fingerprint: 'a3f1c2d4e5b6a7c8',
    },
  ],
};

const genericPayload = {
  source: 'k6',
  alerts: [
    {
      name: 'HighErrorRate',
      status: 'firing',
      severity: 'critical',
      service: 'checkout',
      labels: { region: 'local' },
      starts_at: '2026-10-11T18:05:48Z',
    },
  ],
};

describe('webhook bodies', () => {
  it('accepts a real Alertmanager payload', () => {
    expect(zIngestAlertmanagerWebhookBody.safeParse(alertmanagerPayload).success).toBe(true);
  });

  it('tolerates fields a future Alertmanager may add', () => {
    const future = { ...alertmanagerPayload, groupId: 'new-in-v5' };
    expect(zIngestAlertmanagerWebhookBody.safeParse(future).success).toBe(true);
  });

  it('accepts a generic payload', () => {
    expect(zIngestGenericWebhookBody.safeParse(genericPayload).success).toBe(true);
  });

  it('rejects unknown fields in the generic format instead of dropping them', () => {
    const [alert] = genericPayload.alerts;
    const typo = { ...genericPayload, alerts: [{ ...alert, sevrity: 'warning' }] };
    const result = zIngestGenericWebhookBody.safeParse(typo);
    expect(result.error?.issues).toMatchObject([
      { code: 'unrecognized_keys', keys: ['sevrity'], path: ['alerts', 0] },
    ]);
  });

  it('rejects an empty batch', () => {
    expect(zIngestGenericWebhookBody.safeParse({ ...genericPayload, alerts: [] }).success).toBe(
      false,
    );
  });
});

describe('webhook headers', () => {
  const signature = `t=1791741772,v1=${'a'.repeat(64)}`;
  const parseHeaders = (headers: Record<string, string>) =>
    zIngestGenericWebhookHeaders.safeParse(selectHeaders(zIngestGenericWebhookHeaders, headers));

  it('reads the lower-cased names Node delivers', () => {
    const result = parseHeaders({ 'x-tripwire-signature': signature, 'idempotency-key': 'k6-1' });
    expect(result.data).toEqual({ 'X-Tripwire-Signature': signature, 'Idempotency-Key': 'k6-1' });
  });

  it('accepts several v1 signatures during secret rotation', () => {
    const rotating = `${signature},v1=${'b'.repeat(64)}`;
    const result = parseHeaders({ 'x-tripwire-signature': rotating, 'idempotency-key': 'k6-1' });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a missing idempotency key', { 'x-tripwire-signature': signature }],
    [
      'an idempotency key with a space',
      { 'x-tripwire-signature': signature, 'idempotency-key': 'a b' },
    ],
    [
      'a signature without a timestamp',
      { 'x-tripwire-signature': `v1=${'a'.repeat(64)}`, 'idempotency-key': 'k' },
    ],
  ])('rejects %s', (_case, headers) => {
    expect(parseHeaders(headers).success).toBe(false);
  });
});

describe('listIncidents query', () => {
  it('coerces limit from the query string and defaults it', () => {
    expect(zListIncidentsQuery.parse({ limit: '50', cursor: 'abc' })).toEqual({
      limit: 50,
      cursor: 'abc',
    });
    expect(zListIncidentsQuery.parse({})).toEqual({ limit: 20 });
  });

  it.each(['0', '101', '2.5', 'ten', ''])('rejects limit=%j', (limit) => {
    expect(zListIncidentsQuery.safeParse({ limit }).success).toBe(false);
  });
});
