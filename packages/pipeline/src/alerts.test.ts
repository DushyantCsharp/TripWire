import { describe, expect, it } from '@jest/globals';
import { normalizeAlerts } from './alerts.js';

const alertmanager = {
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
      labels: {
        alertname: 'HighErrorRate',
        service: 'checkout',
        severity: 'page',
        pod: 'checkout-1',
      },
      annotations: { summary: 'checkout is failing' },
      startsAt: '2026-10-01T12:00:00.123456789+02:00',
      endsAt: '0001-01-01T00:00:00Z',
      fingerprint: 'abc',
    },
    {
      status: 'resolved',
      labels: { alertname: 'TargetDown', job: 'otel-demo/cart', severity: 'whatever' },
      annotations: { description: 'cart scrape failed' },
      startsAt: '2026-10-01T12:00:00Z',
      endsAt: '2026-10-01T12:05:00Z',
      fingerprint: 'def',
    },
  ],
};

describe('normalizeAlerts', () => {
  it('reads Alertmanager alerts: name, service, severity and the zero endsAt', () => {
    const result = normalizeAlerts('alertmanager', alertmanager);
    if (!result.ok) throw new Error(result.error.message);
    expect(
      result.value.map((a) => [a.name, a.service, a.severity, a.status, a.summary, a.endsAt]),
    ).toEqual([
      ['HighErrorRate', 'checkout', 'critical', 'firing', 'checkout is failing', undefined],
      [
        'TargetDown',
        'otel-demo/cart',
        'warning',
        'resolved',
        'cart scrape failed',
        new Date('2026-10-01T12:05:00Z'),
      ],
    ]);
    expect(result.value[0]?.startsAt).toEqual(new Date('2026-10-01T10:00:00.123Z'));
  });

  it("folds generic alerts' typed fields into their labels, so they fingerprint like Alertmanager", () => {
    const result = normalizeAlerts('generic', {
      source: 'k6',
      alerts: [
        {
          name: 'HighErrorRate',
          status: 'firing',
          severity: 'critical',
          service: 'checkout',
          labels: { region: 'local' },
          starts_at: '2026-10-01T12:00:00Z',
        },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      value: [
        {
          name: 'HighErrorRate',
          labels: {
            region: 'local',
            alertname: 'HighErrorRate',
            severity: 'critical',
            service: 'checkout',
          },
        },
      ],
    });
  });

  it('rejects a payload that does not match its source', () => {
    expect(normalizeAlerts('generic', alertmanager)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_payload' },
    });
  });
});
