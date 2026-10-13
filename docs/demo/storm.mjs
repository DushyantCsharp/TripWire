// The README demo's alert storm (docs/demo/demo.tape, `just demo-gif`): two alert rules firing on
// 60 pods each, sent as signed Alertmanager deliveries faster than one worker drains them. A 503 is
// retried after its Retry-After with the same Idempotency-Key, as a well-behaved sender does, until
// every delivery is in. Usage: node --env-file=.env docs/demo/storm.mjs [deliveries] [concurrency]
import { createHash, createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const api = process.env.DEMO_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '4000'}`;
const secret = process.env.WEBHOOK_SECRETS?.split(',')[0];
if (!secret) throw new Error('WEBHOOK_SECRETS is not set: run with --env-file=.env');
const total = Number(process.argv[2] ?? 6000);
const concurrency = Number(process.argv[3] ?? 200);
const run = `demo-${Date.now().toString(36)}`;
const startsAt = new Date().toISOString();
const PODS = 60;
const RULES = [
  { alertname: 'PaymentErrorRate', service: 'payment', summary: 'payment fails 40% of charges' },
  { alertname: 'CartLatencyHigh', service: 'cart', summary: 'cart p99 latency is above 2 s' },
];

function delivery(n) {
  const rule = RULES[n % RULES.length];
  const pod = `${rule.service}-${String(Math.floor(n / RULES.length) % PODS)}`;
  const labels = { alertname: rule.alertname, service: rule.service, severity: 'critical', pod };
  const body = JSON.stringify({
    version: '4',
    groupKey: `{}:{alertname="${rule.alertname}"}`,
    status: 'firing',
    receiver: 'tripwire',
    groupLabels: { alertname: rule.alertname },
    commonLabels: { alertname: rule.alertname, service: rule.service },
    commonAnnotations: {},
    externalURL: 'http://alertmanager.demo',
    alerts: [
      {
        status: 'firing',
        labels,
        annotations: { summary: rule.summary, demo_run: run },
        startsAt,
        endsAt: '0001-01-01T00:00:00Z',
        fingerprint: createHash('sha256')
          .update(`${rule.alertname}/${pod}`)
          .digest('hex')
          .slice(0, 16),
      },
    ],
  });
  return { key: `${run}-${String(n)}`, body };
}

async function send({ key, body }) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret)
    .update(`${String(t)}.${key}.${body}`)
    .digest('hex');
  const response = await fetch(`${api}/v1/webhooks/alertmanager`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-tripwire-signature': `t=${String(t)},v1=${v1}`,
    },
    body,
  });
  await response.arrayBuffer();
  return { status: response.status, retryAfter: Number(response.headers.get('retry-after') ?? 1) };
}

const stats = { accepted: 0, shed: 0, everShed: 0, other: 0, minWait: Infinity, maxWait: 0 };
const retries = [];
let fresh = 0;

async function sender() {
  for (;;) {
    const now = performance.now();
    const due = retries.findIndex((item) => item.notBefore <= now);
    let item;
    if (due !== -1) item = retries.splice(due, 1)[0];
    else if (fresh < total) item = { n: fresh++, attempt: 0 };
    else if (retries.length > 0) {
      const soonest = retries.reduce((min, r) => Math.min(min, r.notBefore), Infinity);
      await sleep(Math.min(100, Math.max(5, soonest - now)));
      continue;
    } else return;
    const { status, retryAfter } = await send(delivery(item.n));
    if (status === 202) stats.accepted++;
    else if (status === 503) {
      stats.shed++;
      if (item.attempt === 0) stats.everShed++;
      stats.minWait = Math.min(stats.minWait, retryAfter);
      stats.maxWait = Math.max(stats.maxWait, retryAfter);
      retries.push({
        ...item,
        attempt: item.attempt + 1,
        notBefore: performance.now() + retryAfter * 1000,
      });
    } else {
      stats.other++;
      process.stderr.write(`\ndelivery ${String(item.n)}: unexpected ${String(status)}\n`);
    }
  }
}

const fmt = (n) => n.toLocaleString('en-US');
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const waits = () =>
  stats.maxWait === 0 ? '' : ` (Retry-After ${String(stats.minWait)}–${String(stats.maxWait)} s)`;
const progress = () =>
  process.stdout.write(
    `\r\x1b[2K  sent ${fmt(fresh)}/${fmt(total)} · ${green(`202 accepted ${fmt(stats.accepted)}`)} · ` +
      `${yellow(`503 shed ${fmt(stats.shed)}`)}${waits()} · waiting to retry ${fmt(retries.length)}`,
  );

const started = performance.now();
const ticker = setInterval(progress, 200);
await Promise.all(Array.from({ length: concurrency }, sender));
clearInterval(ticker);
progress();
const seconds = ((performance.now() - started) / 1000).toFixed(1);
const accepted = `${stats.accepted === total ? 'all ' : ''}${fmt(stats.accepted)} accepted`;
process.stdout.write(
  `\n\n${fmt(total)} deliveries in ${seconds} s: ${green(accepted)}.\n` +
    `${fmt(stats.everShed)} were shed first${waits()} and got in on a retry with the same ` +
    'Idempotency-Key.\n' +
    (stats.other > 0 ? `${fmt(stats.other)} failed with another status.\n` : ''),
);
