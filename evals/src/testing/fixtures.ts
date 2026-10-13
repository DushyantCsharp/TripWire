// A small, hand-made case shaped like a capture (a paymentFailure incident), for testing the
// harness, scoring and injection without the demo. Not part of the golden set.
import type { LogLine, Trace } from '@tripwire/agent';
import { toWebhooks } from '../alertmanager.js';
import type { CaseData, CaseMeta, RawSeries } from '../cases.js';

export const FIXTURE_CAPTURED_AT = new Date('2026-10-01T12:10:00Z');
const at = (minutesBefore: number) =>
  new Date(FIXTURE_CAPTURED_AT.getTime() - minutesBefore * 60_000);

export const PAYMENT_ERROR =
  'Payment request failed. Invalid token. demo.user_context.loyalty_level=gold';

function alert(alertname: string, service: string, summary: string, minutesBefore: number) {
  return {
    labels: { alertname, service, service_name: service, severity: 'critical' },
    annotations: { summary },
    state: 'firing' as const,
    activeAt: at(minutesBefore).toISOString(),
  };
}

function logLine(
  id: string,
  minutesBefore: number,
  service: string,
  severityNumber: number,
  body: string,
): LogLine {
  return { id, at: at(minutesBefore), service, severityNumber, body };
}

const LOGS: LogLine[] = [
  logLine('p1', 6, 'payment', 17, `Charge failed: ${PAYMENT_ERROR}`),
  logLine('p2', 4, 'payment', 17, `Charge failed: ${PAYMENT_ERROR}`),
  logLine('p3', 2, 'payment', 17, `Charge failed: ${PAYMENT_ERROR}`),
  logLine('c1', 2, 'checkout', 17, `failed to charge card: ${PAYMENT_ERROR}`),
  logLine('f1', 2, 'frontend', 17, 'POST /api/checkout 500'),
  logLine('i1', 20, 'payment', 9, 'Charge request received'),
];

const TRACES: Trace[] = [
  {
    traceId: 'aa11',
    spans: [
      {
        spanId: 's1',
        parentSpanId: null,
        service: 'checkout',
        operation: 'PlaceOrder',
        startUs: at(3).getTime() * 1000,
        durationUs: 300_000,
        error: true,
        message: 'charge failed',
      },
      {
        spanId: 's2',
        parentSpanId: 's1',
        service: 'payment',
        operation: 'Charge',
        startUs: at(3).getTime() * 1000 + 50_000,
        durationUs: 80_000,
        error: true,
        message: PAYMENT_ERROR,
      },
    ],
  },
];

/** A counter of payment's failed Charge calls: flat, then climbing from the fault. */
function counter(service: string, perMinute: number): RawSeries {
  const samples: [number, string][] = [];
  let value = 0;
  for (let minute = 60; minute >= 0; minute--) {
    if (minute <= 8) value += perMinute;
    samples.push([at(minute).getTime() / 1000, String(value)]);
  }
  return {
    labels: {
      __name__: 'traces_span_metrics_calls_total',
      service_name: service,
      span_kind: 'SPAN_KIND_SERVER',
      status_code: 'STATUS_CODE_ERROR',
    },
    samples,
  };
}

export function fixtureCase(overrides: Partial<CaseMeta> = {}): CaseData {
  const alerts = [
    alert('HighErrorRate', 'payment', 'payment is failing 48% of the requests it serves', 7),
    alert('DependencyErrors', 'checkout', 'checkout sees 2 failed outbound calls per second', 6),
    alert('HighErrorRate', 'frontend', 'frontend is failing 12% of the requests it serves', 5),
  ];
  return {
    meta: {
      id: 'fixture-payment-failure',
      kind: 'golden',
      description: 'paymentFailure = 50% (hand-made fixture)',
      fault: { flag: 'paymentFailure', variant: '50%' },
      groundTruth: {
        service: 'payment',
        aliases: [],
        faultClass: 'application_error',
        alsoFaultClasses: [],
      },
      flippedAt: at(9).toISOString(),
      capturedAt: FIXTURE_CAPTURED_AT.toISOString(),
      window: { from: at(60).toISOString(), to: FIXTURE_CAPTURED_AT.toISOString() },
      changeHint: true,
      synthetic: ['everything: a test fixture'],
      demo: { version: '3.1.0', images: {}, prometheus: '3.13.1' },
      counts: { deliveries: 2, alerts: 3, logs: LOGS.length, traces: TRACES.length, series: 2 },
      ...overrides,
    },
    deliveries: [
      { receivedAt: at(6), body: toWebhooks(alerts.slice(0, 2))[0] },
      ...toWebhooks(alerts).map((body) => ({ receivedAt: at(4), body })),
    ],
    logs: LOGS,
    traces: TRACES,
    metrics: [counter('payment', 30), counter('checkout', 25)],
    changes: [
      {
        id: 'config-payment-20261001T120100000Z',
        service: 'payment',
        kind: 'config',
        description: 'payment: feature flag configuration updated',
        at: at(9),
      },
      {
        id: 'deploy-cart-1.4.2',
        service: 'cart',
        kind: 'deploy',
        description: 'cart 1.4.2 rolled out',
        at: at(120),
      },
    ],
  };
}
