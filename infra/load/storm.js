// k6 alert storm against the ingest endpoint (just load-storm runs it; infra/README.md "Load").
// Each request is one signed Alertmanager v4 delivery of one alert from storm-groups.json: 8
// problems, each raised by two alert rules, across many pods. Annotations carry the problem
// (load_truth) and the run (load_run) for the dedupe score; nothing that clusters reads them.
// Env: WEBHOOK_SECRET (required), API_URL, RUN_ID, RATE (req/s, default 2000), STEADY (60s), RAMP
// (20s), EXPECT (`ack`: every request must be accepted; `shed`: 503s with Retry-After are fine).
import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';

const groups = JSON.parse(open('./storm-groups.json'));
const templates = groups.flatMap((group) =>
  group.alerts.map((alert) => ({ ...alert, service: group.service, truth: group.truth })),
);

const SECRET = __ENV.WEBHOOK_SECRET;
const API_URL = __ENV.API_URL || 'http://api:4000';
const RUN_ID = __ENV.RUN_ID || `storm-${Date.now()}`;
const RATE = Number(__ENV.RATE || 2000);
const EXPECT = __ENV.EXPECT || 'ack';
const PODS = 50;

export const options = {
  discardResponseBodies: true,
  scenarios: {
    storm: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      // Enough for 2k/s at ~100 ms per request; more are started if latency grows.
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { target: RATE, duration: __ENV.RAMP || '20s' },
        { target: RATE, duration: __ENV.STEADY || '60s' },
      ],
    },
  },
  thresholds: {
    // The target: acknowledged at p99 within 50 ms at 2k req/s.
    'http_req_duration{status:202}': ['p(99)<50'],
    // A k6 that couldn't keep up would quietly send less than RATE: that must fail the run.
    dropped_iterations: ['count==0'],
    checks: ['rate>0.999'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const encoder = new TextEncoder();
let signingKey;
const key = () =>
  (signingKey ??= crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  ));

async function sign(text) {
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await key(), encoder.encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function setup() {
  if (!SECRET) throw new Error('WEBHOOK_SECRET is required');
  // One startsAt for the run: Alertmanager resends a firing alert with the same start.
  return { startsAt: new Date().toISOString() };
}

export default async function ({ startsAt }) {
  const n = exec.scenario.iterationInTest;
  const t = templates[n % templates.length];
  const pod = `${t.service}-${String(n % PODS)}`;
  const body = JSON.stringify({
    version: '4',
    groupKey: `{}:{alertname="${t.alertname}"}`,
    status: 'firing',
    receiver: 'tripwire',
    groupLabels: { alertname: t.alertname },
    commonLabels: { alertname: t.alertname, service: t.service },
    commonAnnotations: {},
    externalURL: 'http://alertmanager.load',
    alerts: [
      {
        status: 'firing',
        labels: { alertname: t.alertname, service: t.service, severity: 'critical', pod },
        annotations: { summary: t.summary, load_truth: t.truth, load_run: RUN_ID },
        startsAt,
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: (await sign(`${t.alertname}/${pod}`)).slice(0, 16),
      },
    ],
  });
  const idempotencyKey = `${RUN_ID}-${String(n)}`;
  const ts = Math.floor(Date.now() / 1000);
  const signature = await sign(`${String(ts)}.${idempotencyKey}.${body}`);
  const response = http.post(`${API_URL}/v1/webhooks/alertmanager`, body, {
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'x-tripwire-signature': `t=${String(ts)},v1=${signature}`,
    },
    tags: { name: 'webhook' },
  });
  check(response, {
    [EXPECT === 'shed' ? 'accepted, or shed with Retry-After' : 'accepted']: (r) =>
      r.status === 202 ||
      (EXPECT === 'shed' && r.status === 503 && r.headers['Retry-After'] !== undefined),
  });
}

/** The full summary as JSON for the load report, and a short one on stdout. */
export function handleSummary(data) {
  const trend = (name) => data.metrics[name]?.values ?? {};
  const counter = (name) => data.metrics[name]?.values?.count ?? 0;
  const accepted = trend('http_req_duration{status:202}');
  const lines = [
    `run ${RUN_ID}: ${String(counter('http_reqs'))} requests, ${(data.metrics.http_reqs?.values?.rate ?? 0).toFixed(0)}/s`,
    `202 latency ms: p50 ${(accepted.med ?? 0).toFixed(2)}, p95 ${(accepted['p(95)'] ?? 0).toFixed(2)}, p99 ${(accepted['p(99)'] ?? 0).toFixed(2)}, max ${(accepted.max ?? 0).toFixed(2)}`,
    `checks passed: ${((data.metrics.checks?.values?.rate ?? 0) * 100).toFixed(3)}%, dropped iterations: ${String(counter('dropped_iterations'))}`,
    ...Object.entries(data.metrics)
      .filter(([, metric]) => metric.thresholds)
      .flatMap(([name, metric]) =>
        Object.entries(metric.thresholds).map(
          ([rule, result]) => `threshold ${name} ${rule}: ${result.ok ? 'pass' : 'FAIL'}`,
        ),
      ),
  ];
  return {
    stdout: `${lines.join('\n')}\n`,
    [`/results/${RUN_ID}.json`]: JSON.stringify(data, null, 2),
  };
}
