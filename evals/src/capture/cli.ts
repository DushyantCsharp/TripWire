// Captures golden-set cases from the running OpenTelemetry Demo (`just demo-up`):
//   just eval-capture --pilot            the three pilot cases
//   just eval-capture --cases a,b        these cases (catalog ids)
//   just eval-capture --all              every catalog case not yet captured (resumable)
//   just eval-capture --inject           derive the injection cases from captured ones
// For each case: check the demo is healthy with every fault off, switch the fault on, poll the
// alerts it raises (as Alertmanager would deliver them) until they fire and then a while longer,
// snapshot logs, traces and metrics, switch the fault off and wait for the demo to recover.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { loadEnvOrExit } from '@tripwire/config';
import { z } from 'zod';
import { type PromAlert, toWebhooks } from '../alertmanager.js';
import { type CaseData, GOLDEN_DIR, readCase, type RawSeries, writeCase } from '../cases.js';
import { CATALOG, type CaseSpec, caseSpec, FAULTS, INJECTIONS, RESERVE } from '../catalog.js';
import { syntheticChanges } from '../changes.js';
import { flagsOn, setFlag } from '../flags.js';
import { deriveInjection } from '../inject.js';
import { type DemoClient, demoClient } from './demo.js';

const env = loadEnvOrExit(
  z.object({
    DEMO_URL: z.url().default('http://localhost:8080'),
    DEMO_PROMETHEUS_URL: z.url().default('http://localhost:9090'),
    DEMO_JAEGER_URL: z.url().default('http://localhost:26686/jaeger/ui'),
    DEMO_OPENSEARCH_URL: z.url().default('http://localhost:29200'),
  }),
);

const { values } = parseArgs({
  options: {
    pilot: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    inject: { type: 'boolean', default: false },
    cases: { type: 'string' },
    force: { type: 'boolean', default: false },
    golden: { type: 'string', default: GOLDEN_DIR },
    'poll-seconds': { type: 'string', default: '30' },
    'fire-timeout-seconds': { type: 'string', default: '480' },
    'hold-seconds': { type: 'string', default: '120' },
    'storm-hold-seconds': { type: 'string', default: '240' },
    'window-minutes': { type: 'string', default: '60' },
    'recover-timeout-seconds': { type: 'string', default: '600' },
  },
});

const args = z
  .object({
    pilot: z.boolean(),
    all: z.boolean(),
    inject: z.boolean(),
    cases: z.string().optional(),
    force: z.boolean(),
    golden: z.string(),
    'poll-seconds': z.coerce.number().int().min(5),
    'fire-timeout-seconds': z.coerce.number().int().min(30),
    'hold-seconds': z.coerce.number().int().min(0),
    'storm-hold-seconds': z.coerce.number().int().min(0),
    'window-minutes': z.coerce.number().int().min(10).max(180),
    'recover-timeout-seconds': z.coerce.number().int().min(30),
  })
  .parse(values);

const PILOT = ['payment-failure-50', 'cart-failure-50', 'ad-high-cpu'];

/** Metric families worth keeping: request, runtime, container and queue metrics. */
const METRIC_PREFIXES = [
  'traces_span_metrics_',
  'container_',
  'jvm_',
  'kafka_',
  'http_server_',
  'rpc_server_',
  'rpc_client_',
  'db_client_',
  'process_',
  'dotnet_',
  'nodejs_',
  'go_',
  'app_',
  'postgresql_',
  'redis_',
  'nginx_',
];

const log = (message: string) => {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
};

const demo = demoClient({
  demo: env.DEMO_URL,
  prometheus: env.DEMO_PROMETHEUS_URL,
  jaeger: env.DEMO_JAEGER_URL,
  opensearch: env.DEMO_OPENSEARCH_URL,
});

/** Firing alerts, without Prometheus's own housekeeping ones. */
async function firing(client: DemoClient): Promise<PromAlert[]> {
  return (await client.alerts()).filter((alert) => alert.state === 'firing');
}

async function setVariant(flag: string, variant: string): Promise<void> {
  const config = await demo.readFlags();
  const updated = setFlag(config, flag, variant);
  if (!updated.ok) throw new Error(updated.error.message);
  await demo.writeFlags(updated.value);
  // flagd-ui writes asynchronously: read back until the file says what we wrote.
  for (let i = 0; i < 20; i++) {
    const now = await demo.readFlags();
    const state = setFlag(now, flag, variant);
    if (state.ok && JSON.stringify(state.value.flags[flag]) === JSON.stringify(now.flags[flag]))
      return;
    await sleep(500);
  }
  throw new Error(`flagd still doesn't serve ${flag}=${variant}`);
}

/** The fault switched on right now, if any: an interrupt switches it off before exiting. */
let active: { flag: string; restart: readonly string[] } | null = null;
let interrupted = false;

function onSignal(signal: NodeJS.Signals): void {
  // A second signal exits at once, fault or not.
  if (interrupted) process.exit(1);
  interrupted = true;
  const fault = active;
  if (!fault) {
    log(`${signal}: exiting`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
  log(`${signal}: switching ${fault.flag} off, then exiting (signal again to exit now)`);
  setVariant(fault.flag, 'off').then(
    () => {
      if (fault.restart.length > 0) log(`restart ${fault.restart.join(', ')} by hand to recover`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    },
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : JSON.stringify(error);
      log(`could not switch ${fault.flag} off (${reason}): switch it off in flagd-ui`);
      process.exit(1);
    },
  );
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

async function waitUntilQuiet(timeoutSeconds: number): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const alerts = await firing(demo);
    if (alerts.length === 0) return true;
    if (Date.now() > deadline) {
      log(
        `still firing: ${alerts.map((a) => `${a.labels.alertname ?? '?'}/${a.labels.service ?? '?'}`).join(', ')}`,
      );
      return false;
    }
    await sleep(args['poll-seconds'] * 1000);
  }
}

/** A synthetic, unrelated alert that flaps through a storm: noise the agent must see past. */
function noiseAlert(at: Date): PromAlert {
  return {
    labels: {
      alertname: 'DiskSpaceLow',
      service: 'quote',
      severity: 'warning',
      device: '/dev/vda1',
    },
    annotations: { summary: 'quote: /dev/vda1 is 91% full' },
    state: 'firing',
    activeAt: at.toISOString(),
  };
}

async function capture(spec: CaseSpec): Promise<CaseData | 'no_alerts'> {
  const fault = FAULTS[spec.flag];
  if (!fault) throw new Error(`no fault spec for ${spec.flag}`);
  const flags = await demo.readFlags();
  const on = flagsOn(flags);
  if (on.length > 0) throw new Error(`faults already on: ${on.join(', ')}; switch them off first`);
  log(`${spec.id}: waiting for a quiet demo`);
  if (!(await waitUntilQuiet(args['recover-timeout-seconds']))) {
    throw new Error(
      'the demo has alerts firing with every fault off: investigate before capturing',
    );
  }

  const flippedAt = new Date();
  log(`${spec.id}: ${spec.flag} → ${spec.variant}`);
  active = { flag: spec.flag, restart: fault.restart ?? [] };
  await setVariant(spec.flag, spec.variant);
  const deliveries: { receivedAt: Date; body: unknown }[] = [];
  let firstFiring: Date | null = null;
  const hold = (spec.kind === 'storm' ? args['storm-hold-seconds'] : args['hold-seconds']) * 1000;
  try {
    for (let tick = 0; ; tick++) {
      await sleep(args['poll-seconds'] * 1000);
      const now = new Date();
      const alerts = await firing(demo);
      // Storms carry an unrelated alert that flaps: firing every other poll.
      const withNoise =
        spec.kind === 'storm' && tick % 2 === 0 ? [...alerts, noiseAlert(flippedAt)] : alerts;
      for (const body of toWebhooks(withNoise)) deliveries.push({ receivedAt: now, body });
      if (alerts.length > 0 && firstFiring === null) {
        firstFiring = now;
        log(
          `${spec.id}: firing after ${String(Math.round((now.getTime() - flippedAt.getTime()) / 1000))}s: ${alerts.map((a) => `${a.labels.alertname ?? '?'}/${a.labels.service ?? '?'}`).join(', ')}`,
        );
      }
      if (
        firstFiring === null &&
        now.getTime() - flippedAt.getTime() > args['fire-timeout-seconds'] * 1000
      ) {
        log(`${spec.id}: no alerts after ${String(args['fire-timeout-seconds'])}s: discarded`);
        return 'no_alerts';
      }
      if (firstFiring !== null && now.getTime() - firstFiring.getTime() >= hold) break;
    }

    const capturedAt = new Date();
    const from = new Date(capturedAt.getTime() - args['window-minutes'] * 60_000);
    log(`${spec.id}: snapshotting ${from.toISOString()} → ${capturedAt.toISOString()}`);
    const [logs, traces, metrics] = await Promise.all([
      demo.logs(from, capturedAt, 3_000, 2_000),
      demo.traces(from, capturedAt, 40),
      snapshotMetrics(capturedAt, args['window-minutes'] * 60),
    ]);
    const changes = syntheticChanges(spec.id, {
      exclude: [fault.groundTruth.service, ...(fault.groundTruth.aliases ?? [])],
      configuredIn: fault.configuredIn,
      flippedAt,
      hint: spec.changeHint,
    });
    const afterFlags = await demo.readFlags();
    const unexpected = flagsOn(afterFlags).filter((flag) => flag !== spec.flag);
    if (unexpected.length > 0)
      throw new Error(`other faults switched on during the capture: ${unexpected.join(', ')}`);

    const alertCount = deliveries.reduce(
      (n, d) => n + z.object({ alerts: z.array(z.unknown()) }).parse(d.body).alerts.length,
      0,
    );
    return {
      meta: {
        id: spec.id,
        kind: spec.kind,
        description: `${spec.flag} = ${spec.variant} in the OpenTelemetry Demo`,
        fault: { flag: spec.flag, variant: spec.variant },
        groundTruth: {
          service: fault.groundTruth.service,
          aliases: [...(fault.groundTruth.aliases ?? [])],
          faultClass: fault.groundTruth.faultClass,
          alsoFaultClasses: [...(fault.groundTruth.alsoFaultClasses ?? [])],
        },
        flippedAt: flippedAt.toISOString(),
        capturedAt: capturedAt.toISOString(),
        window: { from: from.toISOString(), to: capturedAt.toISOString() },
        changeHint: spec.changeHint,
        synthetic: [
          'decoy deploys in changes.json',
          ...(spec.changeHint ? ['config change hint in changes.json'] : []),
          ...(spec.kind === 'storm' ? ['flapping DiskSpaceLow alert on quote'] : []),
        ],
        demo: {
          version: '3.1.0',
          images: await demo.imageDigests(),
          prometheus: await demo.prometheusVersion(),
        },
        counts: {
          deliveries: deliveries.length,
          alerts: alertCount,
          logs: logs.length,
          traces: traces.length,
          series: metrics.length,
        },
      },
      deliveries,
      logs,
      traces,
      metrics,
      changes,
    };
  } finally {
    log(`${spec.id}: ${spec.flag} → off`);
    await setVariant(spec.flag, 'off');
    active = null;
    for (const service of fault.restart ?? []) {
      log(`${spec.id}: restarting ${service}`);
      await demo.restart(service);
    }
    if (!(await waitUntilQuiet(args['recover-timeout-seconds']))) {
      log(`${spec.id}: the demo hasn't recovered; the next case waits for it`);
    }
  }
}

async function snapshotMetrics(end: Date, seconds: number): Promise<RawSeries[]> {
  const names = (await demo.metricNames()).filter((name) =>
    METRIC_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  const series: RawSeries[] = [];
  for (const name of names) series.push(...(await demo.rawSeries(name, seconds, end)));
  return series;
}

async function main() {
  if (args.inject) {
    for (const spec of INJECTIONS) {
      const base = join(args.golden, spec.baseCase);
      if (!existsSync(join(base, 'case.json'))) {
        log(`${spec.id}: base case ${spec.baseCase} isn't captured yet: skipped`);
        continue;
      }
      writeCase(args.golden, deriveInjection(readCase(base), spec));
      log(`${spec.id}: written from ${spec.baseCase}`);
    }
    return;
  }

  const ids = args.pilot
    ? PILOT
    : args.cases
      ? args.cases.split(',')
      : args.all
        ? CATALOG.map((spec) => spec.id)
        : [];
  if (ids.length === 0) throw new Error('say which cases: --pilot, --cases a,b or --all');
  const reserve = [...RESERVE];
  const discarded: string[] = [];
  for (const id of ids) {
    let spec = caseSpec(id);
    if (!spec) throw new Error(`no case ${id} in the catalog`);
    while (spec) {
      if (!args.force && existsSync(join(args.golden, spec.id, 'case.json'))) {
        log(`${spec.id}: already captured`);
        break;
      }
      const started = Date.now();
      const result = await capture(spec);
      if (result !== 'no_alerts') {
        const dir = writeCase(args.golden, result);
        log(
          `${spec.id}: written to ${dir} in ${String(Math.round((Date.now() - started) / 1000))}s (${JSON.stringify(result.meta.counts)})`,
        );
        break;
      }
      discarded.push(spec.id);
      // A golden case that raises nothing is replaced from the reserve; a storm has no stand-in.
      spec = spec.kind === 'golden' && args.all ? reserve.shift() : undefined;
      if (spec) log(`replacing it with ${spec.id}`);
    }
  }
  if (discarded.length > 0) log(`discarded (no alerts): ${discarded.join(', ')}`);
}

await main();
