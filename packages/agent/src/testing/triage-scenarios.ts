// The incident and telemetry the triage tests run against: the OTel demo's `paymentFailure` fault
// (payment's Charge throws for loyalty-level-gold users), as in demo 3.1.0. Changing anything here
// changes the model requests, so the recordings in src/__recordings__ must be re-made (see
// recorded-fetch.ts).
import { err, ok } from '@tripwire/result';
import { memoryChangeSource, memoryLogStore, memoryTraceStore } from '../memory.js';
import {
  READ_TOOLS,
  type ReadToolName,
  type ToolHandler,
  type ToolHandlers,
  type ToolRecord,
} from '../tools/definitions.js';
import type { LogLine, MetricStore, RunbookIndex, Span, Trace } from '../tools/ports.js';
import { telemetryTools } from '../tools/telemetry.js';
import type { TriageAlert, TriageBudget, TriageInput } from '../triage.js';

export const SCENARIO_MODEL = 'claude-opus-5-5';

export const SCENARIO_BUDGET: TriageBudget = {
  maxInputTokens: 40_000,
  maxOutputTokens: 4_000,
  maxToolCalls: 8,
  maxWallClockMs: 60_000,
};

/** When the scenario's telemetry was "read": a few minutes into the incident. */
export const SCENARIO_NOW = new Date('2026-10-01T12:07:00Z');

export const PAYMENT_ERROR =
  'Payment request failed. Invalid token. demo.user_context.loyalty_level=gold';

function alert(service: string, name: string, summary: string, at: string): TriageAlert {
  return {
    name,
    service,
    severity: 'critical',
    status: 'firing',
    summary,
    labels: { alertname: name, service, namespace: 'otel-demo' },
    startsAt: new Date(at),
    receivedAt: new Date(at),
  };
}

const ALERTS = [
  alert(
    'checkout',
    'HighErrorRate',
    'checkout PlaceOrder failing on 41% of calls',
    '2026-10-01T12:06:00Z',
  ),
  alert(
    'payment',
    'GrpcServerErrors',
    'payment Charge failing on 48% of calls',
    '2026-10-01T12:03:00Z',
  ),
  alert('frontend', 'HighErrorRate', 'HTTP 500 on POST /api/checkout', '2026-10-01T12:02:00Z'),
];

export const PAYMENT_INCIDENT: TriageInput = {
  incidentId: '01928c4e-7b2a-7c3d-9e4f-5a6b7c8d9e0f',
  title: 'HighErrorRate on checkout',
  service: 'checkout',
  severity: 'critical',
  firstSeen: new Date('2026-10-01T12:02:00Z'),
  lastSeen: new Date('2026-10-01T12:06:00Z'),
  alertCount: 9,
  alerts: ALERTS,
  earliestAlerts: [...ALERTS].reverse(),
  alertGroups: [
    group('checkout', 'HighErrorRate', 4, '2026-10-01T12:04:00Z', '2026-10-01T12:06:00Z'),
    group('payment', 'GrpcServerErrors', 3, '2026-10-01T12:03:00Z', '2026-10-01T12:05:30Z'),
    group('frontend', 'HighErrorRate', 2, '2026-10-01T12:02:00Z', '2026-10-01T12:05:00Z'),
  ],
};

function group(service: string, name: string, count: number, first: string, last: string) {
  return { name, service, count, firstStartsAt: new Date(first), lastReceivedAt: new Date(last) };
}

const at = (time: string) => new Date(`2026-10-01T${time}Z`);

function log(
  id: string,
  time: string,
  service: string,
  severityNumber: number,
  body: string,
): LogLine {
  return { id, at: at(time), service, severityNumber, body };
}

const LOGS: LogLine[] = [
  log('pay-7f3a', '12:05:12', 'payment', 17, `Charge failed: ${PAYMENT_ERROR}`),
  log('pay-7f3b', '12:05:40', 'payment', 17, `Charge failed: ${PAYMENT_ERROR}`),
  log('pay-7f3c', '12:04:02', 'payment', 17, `Charge failed: ${PAYMENT_ERROR}`),
  log('pay-1b20', '12:04:30', 'payment', 9, 'Charge request received. amount=129.99 currency=USD'),
  log(
    'chk-21c0',
    '12:05:13',
    'checkout',
    17,
    `failed to charge card: could not charge the card: rpc error: code = Unknown desc = ${PAYMENT_ERROR}`,
  ),
  log('fe-9d01', '12:05:14', 'frontend', 17, 'POST /api/checkout 500: checkout failed'),
];

function span(
  spanId: string,
  parentSpanId: string | null,
  service: string,
  operation: string,
  offsetMs: number,
  durationMs: number,
  message: string | null = null,
): Span {
  return {
    spanId,
    parentSpanId,
    service,
    operation,
    startUs: (at('12:05:13').getTime() + offsetMs) * 1000,
    durationUs: durationMs * 1000,
    error: message !== null,
    message,
  };
}

const TRACES: Trace[] = [
  {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spans: [
      span('a1', null, 'frontend', 'POST /api/checkout', 0, 412, 'checkout failed'),
      span('a2', 'a1', 'checkout', 'oteldemo.CheckoutService/PlaceOrder', 5, 398, PAYMENT_ERROR),
      span('a3', 'a2', 'payment', 'oteldemo.PaymentService/Charge', 300, 90, PAYMENT_ERROR),
    ],
  },
];

/** Answers any PromQL with error rates by service: payment's climbs from the fault's start. */
const METRICS: MetricStore = {
  queryRange(query) {
    const end = Math.floor(query.end.getTime() / 1000);
    const start = Math.floor(query.start.getTime() / 1000);
    const points = (service: string, peak: number) => {
      const series: [number, number][] = [];
      for (let t = start; t <= end; t += query.stepSeconds) {
        const faulty = t >= Math.floor(at('12:00:00').getTime() / 1000);
        series.push([t, faulty ? peak : 0]);
      }
      return {
        labels: { service_name: service, job: `opentelemetry-demo/${service}` },
        points: series,
      };
    };
    return Promise.resolve(
      ok([points('payment', 0.48), points('checkout', 0.41), points('frontend', 0.12)]),
    );
  },
};

const RUNBOOKS: RunbookIndex = {
  search() {
    return Promise.resolve(
      ok([
        {
          id: 'payment.md#charge-failures',
          title: 'Payment: Charge failures',
          service: 'payment',
          content:
            'Symptoms: Charge returns errors and checkout fails to place orders. Check payment ' +
            'logs for the failure message, then recent deploys and feature-flag changes to ' +
            'payment. Mitigation: roll back the change; page the payment on-call if errors persist.',
          score: 0.82,
        },
      ]),
    );
  },
};

export interface ScenarioTelemetry {
  readonly handlers: ToolHandlers;
  /** Tool calls the loop made, in order. */
  readonly calls: ReadToolName[];
  /** Every record the tools returned: all a report may cite. */
  readonly returned: Map<string, ToolRecord>;
}

export interface ScenarioOptions {
  /** The trace backend times out. */
  readonly tracesDown?: boolean | undefined;
  /** Log lines (payment, errors) that try to instruct the model. */
  readonly injected?: readonly string[] | undefined;
}

/** The payment incident's telemetry, through the real tools over in-memory backends. */
export function paymentTelemetry({
  tracesDown = false,
  injected = [],
}: ScenarioOptions = {}): ScenarioTelemetry {
  const logs = [
    ...LOGS,
    ...injected.map((body, index) =>
      log(
        `inj-${String(index)}`,
        `12:06:${String(10 + index).padStart(2, '0')}`,
        'payment',
        17,
        body,
      ),
    ),
  ];
  const handlers = telemetryTools(
    {
      logs: memoryLogStore(logs),
      traces: tracesDown
        ? {
            search: () =>
              Promise.resolve(err({ kind: 'unavailable', message: 'Jaeger timed out after 10s' })),
          }
        : memoryTraceStore(TRACES),
      metrics: METRICS,
      changes: memoryChangeSource([
        {
          id: 'config-payment-2026-10-01T11:59:30Z',
          service: 'payment',
          kind: 'config',
          description: 'payment: feature flag configuration updated',
          at: at('11:59:30'),
        },
        {
          id: 'deploy-frontend-2.1.0',
          service: 'frontend',
          kind: 'deploy',
          description: 'frontend 2.1.0 rolled out',
          at: at('09:14:00'),
        },
      ]),
      runbooks: RUNBOOKS,
    },
    { now: () => SCENARIO_NOW },
  );
  return observe(handlers);
}

/** Wraps handlers to record which ran and what they returned. */
export function observe(handlers: ToolHandlers): ScenarioTelemetry {
  const calls: ReadToolName[] = [];
  const returned = new Map<string, ToolRecord>();
  const wrap = <K extends ReadToolName>(name: K, handler: ToolHandler<K> | undefined) =>
    handler &&
    (async (input: Parameters<ToolHandler<K>>[0], options: Parameters<ToolHandler<K>>[1]) => {
      calls.push(name);
      const result = await handler(input, options);
      if (result.ok) {
        for (const record of READ_TOOLS[name].records(result.value))
          returned.set(record.id, record);
      }
      return result;
    });
  return {
    calls,
    returned,
    handlers: {
      query_logs: wrap('query_logs', handlers.query_logs),
      query_traces: wrap('query_traces', handlers.query_traces),
      query_metrics: wrap('query_metrics', handlers.query_metrics),
      list_deploys: wrap('list_deploys', handlers.list_deploys),
      get_runbook: wrap('get_runbook', handlers.get_runbook),
    },
  };
}
