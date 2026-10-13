// Deterministic demo data (`just db-seed`). The faker seed and reference date are fixed, so every
// run produces the same ids, timestamps, labels and embeddings.
import { createHash } from 'node:crypto';
import { en, Faker } from '@faker-js/faker';
import type { Result } from '@tripwire/result';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from './client.js';
import { dbCall, type DatabaseError } from './errors.js';
import { fingerprintV1, fingerprintV2 } from './fingerprint.js';
import { alerts, incidentAlerts, incidents, ingests } from './schema.js';

export const SEED = 42;
export const SEED_REFERENCE_DATE = new Date('2026-10-01T00:00:00.000Z');

const INCIDENTS = 50;
const ALERTS = 5_000;
const MIN_ALERTS_PER_INCIDENT = 20;
const STORM_ALERTS = 3_000;
const STORM_PODS = 500;
const EMBEDDING_DIMENSIONS = 1024;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// OpenTelemetry Demo services, with their ports from the demo's .env.
const CHECKOUT = { name: 'checkout', team: 'commerce', port: 5050 };
const SERVICES = [
  { name: 'frontend', team: 'web', port: 8080 },
  { name: 'frontend-proxy', team: 'platform', port: 8080 },
  { name: 'cart', team: 'commerce', port: 7070 },
  CHECKOUT,
  { name: 'currency', team: 'commerce', port: 7001 },
  { name: 'email', team: 'growth', port: 6060 },
  { name: 'payment', team: 'payments', port: 50051 },
  { name: 'product-catalog', team: 'catalog', port: 3550 },
  { name: 'quote', team: 'shipping', port: 8090 },
  { name: 'recommendation', team: 'catalog', port: 9001 },
  { name: 'shipping', team: 'shipping', port: 50050 },
  { name: 'ad', team: 'growth', port: 9555 },
] as const;
type Service = (typeof SERVICES)[number];

type Severity = 'critical' | 'warning' | 'info';
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

interface Rule {
  readonly alertname: string;
  readonly severity: Severity;
  readonly summary: string;
  readonly description: string;
}

const HIGH_ERROR_RATE: Rule = {
  alertname: 'HighErrorRate',
  severity: 'critical',
  summary: 'more than 5% of requests are failing',
  description: 'The ratio of 5xx responses to all requests has been above 5% for 5 minutes.',
};
const RULES: readonly Rule[] = [
  HIGH_ERROR_RATE,
  {
    alertname: 'HighLatencyP99',
    severity: 'warning',
    summary: 'p99 latency is above 1s',
    description: 'The 99th percentile request latency has been above 1s for 10 minutes.',
  },
  {
    alertname: 'GrpcServerErrors',
    severity: 'critical',
    summary: 'gRPC UNAVAILABLE and INTERNAL responses are rising',
    description: 'More than 2% of gRPC calls ended in UNAVAILABLE or INTERNAL over 5 minutes.',
  },
  {
    alertname: 'PodCrashLooping',
    severity: 'critical',
    summary: 'a pod is restarting repeatedly',
    description: 'A container restarted more than 3 times in 15 minutes.',
  },
  {
    alertname: 'CPUThrottlingHigh',
    severity: 'warning',
    summary: 'CPU is being throttled',
    description: 'More than 25% of CPU periods were throttled over 10 minutes.',
  },
  {
    alertname: 'MemoryUsageHigh',
    severity: 'warning',
    summary: 'memory usage is above 90% of the limit',
    description: 'Working-set memory has been above 90% of the container limit for 10 minutes.',
  },
  {
    alertname: 'KafkaConsumerLag',
    severity: 'warning',
    summary: 'Kafka consumer lag is growing',
    description: 'Consumer group lag has grown continuously for 10 minutes.',
  },
  {
    alertname: 'TargetDown',
    severity: 'info',
    summary: 'a scrape target is down',
    description: 'Prometheus could not scrape a target for 5 minutes.',
  },
];

type IngestRow = typeof ingests.$inferInsert & { id: string };
type AlertRow = typeof alerts.$inferInsert & { id: string; fingerprintV2: string };
type IncidentRow = typeof incidents.$inferInsert & { id: string };
type IncidentAlertRow = typeof incidentAlerts.$inferInsert;
type IncidentStatus = NonNullable<IncidentRow['status']>;

export interface SeedData {
  readonly ingests: IngestRow[];
  readonly incidents: IncidentRow[];
  readonly alerts: AlertRow[];
  readonly incidentAlerts: IncidentAlertRow[];
  stormIncidentId: string;
}

interface Pod {
  readonly name: string;
  readonly instance: string;
}

interface AlertSpec {
  readonly rule: Rule;
  readonly pod: Pod;
  readonly startsAt: Date;
  readonly resolved: boolean;
}

interface IncidentPlan {
  readonly service: Service;
  readonly rule: Rule;
  readonly status: IncidentStatus;
  readonly specs: readonly AlertSpec[];
  /** Alerts per webhook delivery, as Alertmanager batches a group's notifications. */
  readonly deliverySize: number;
}

/** 50 incidents holding 5,000 alerts, plus a 51st incident: a 3,000-alert storm on checkout. */
export function generateSeedData(): SeedData {
  const faker = new Faker({ locale: [en] });
  faker.seed(SEED);
  faker.setDefaultRefDate(SEED_REFERENCE_DATE);
  const data: SeedData = {
    ingests: [],
    incidents: [],
    alerts: [],
    incidentAlerts: [],
    stormIncidentId: '',
  };

  // UUIDv7 like production, but with seeded random bits so ids are reproducible.
  const idAt = (at: Date) =>
    uuidv7({
      msecs: at.getTime(),
      random: Uint8Array.from({ length: 16 }, () => faker.number.int(255)),
    });
  // Each service gets a direction in embedding space; its incidents sit near it, so nearest
  // neighbours come back from the same service.
  const unitVector = (around?: readonly number[]) => {
    const raw = Array.from(
      { length: EMBEDDING_DIMENSIONS },
      (_, i) => (around?.[i] ?? 0) + faker.number.float({ min: -1, max: 1 }) * (around ? 0.35 : 1),
    );
    const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0));
    return raw.map((x) => x / norm);
  };
  const centroids = new Map(SERVICES.map((service) => [service.name, unitVector()]));
  const podsFor = (service: Service, count: number): Pod[] => {
    const replicaSet = faker.string.alphanumeric({ length: 10, casing: 'lower' });
    return Array.from({ length: count }, () => ({
      name: `${service.name}-${replicaSet}-${faker.string.alphanumeric({ length: 5, casing: 'lower' })}`,
      instance: `10.244.${faker.number.int({ min: 0, max: 15 })}.${faker.number.int({ min: 2, max: 254 })}:${service.port}`,
    }));
  };

  const toAlert = (
    service: Service,
    spec: AlertSpec,
    ingestId: string,
    receivedAt: Date,
    source: AlertRow['source'],
  ): AlertRow => {
    const { rule, pod, startsAt, resolved } = spec;
    const labels = {
      alertname: rule.alertname,
      service: service.name,
      severity: rule.severity,
      namespace: 'otel-demo',
      cluster: 'kind-tripwire',
      job: `otel-demo/${service.name}`,
      pod: pod.name,
      instance: pod.instance,
      team: service.team,
    };
    const summary = `${service.name}: ${rule.summary}`;
    const status = resolved ? 'resolved' : 'firing';
    const endsAt = resolved
      ? new Date(startsAt.getTime() + faker.number.int({ min: 1, max: 30 }) * MINUTE)
      : undefined;
    const rawPayload =
      source === 'alertmanager'
        ? {
            status,
            labels,
            annotations: {
              summary,
              description: rule.description,
              runbook_url: `https://runbooks.tripwire.local/${rule.alertname}`,
            },
            startsAt: startsAt.toISOString(),
            endsAt: endsAt?.toISOString() ?? '0001-01-01T00:00:00Z',
            generatorURL: `http://prometheus:9090/graph?g0.expr=${encodeURIComponent(`ALERTS{alertname="${rule.alertname}",service="${service.name}"}`)}`,
            fingerprint: fingerprintV1(labels).slice(0, 16),
          }
        : {
            name: rule.alertname,
            status,
            severity: rule.severity,
            service: service.name,
            summary,
            labels,
            starts_at: startsAt.toISOString(),
            ...(endsAt && { ends_at: endsAt.toISOString() }),
          };
    return {
      id: idAt(receivedAt),
      ingestId,
      source,
      name: rule.alertname,
      status,
      severity: rule.severity,
      service: service.name,
      summary,
      labels,
      fingerprint: fingerprintV1(labels),
      fingerprintV2: fingerprintV2(labels),
      startsAt,
      endsAt: endsAt ?? null,
      receivedAt,
      rawPayload,
    };
  };

  const addIncident = ({ service, rule, status, specs, deliverySize }: IncidentPlan): string => {
    const incidentAlertRows: AlertRow[] = [];
    for (let start = 0; start < specs.length; start += deliverySize) {
      const chunk = specs.slice(start, start + deliverySize);
      const lastStart = chunk.at(-1)?.startsAt ?? SEED_REFERENCE_DATE;
      const receivedAt = new Date(lastStart.getTime() + faker.number.int({ min: 50, max: 3000 }));
      const source = faker.number.float() < 0.9 ? 'alertmanager' : 'generic';
      const ingestId = idAt(receivedAt);
      const rows = chunk.map((spec) => toAlert(service, spec, ingestId, receivedAt, source));
      data.ingests.push({
        id: ingestId,
        idempotencyKey: `seed-${data.ingests.length}`,
        bodyHash: createHash('sha256')
          .update(JSON.stringify(rows.map((row) => row.rawPayload)))
          .digest('hex'),
        source,
        receivedAt,
        alertCount: rows.length,
      });
      incidentAlertRows.push(...rows);
    }

    const [first] = incidentAlertRows;
    const last = incidentAlertRows.at(-1);
    if (!first || !last) throw new Error('an incident needs at least one alert');
    const severity = incidentAlertRows.reduce<Severity>(
      (worst, alert) =>
        SEVERITY_RANK[alert.severity] < SEVERITY_RANK[worst] ? alert.severity : worst,
      'info',
    );
    const id = idAt(first.receivedAt);
    data.incidents.push({
      id,
      title: `${rule.alertname} on ${service.name}`,
      status,
      severity,
      service: service.name,
      firstSeen: first.receivedAt,
      lastSeen: last.receivedAt,
      alertCount: incidentAlertRows.length,
      embedding: unitVector(centroids.get(service.name)),
      resolvedAt: status === 'resolved' ? new Date(last.receivedAt.getTime() + 10 * MINUTE) : null,
      createdAt: first.receivedAt,
      updatedAt: last.receivedAt,
    });
    for (const alert of incidentAlertRows) {
      const sameIdentity = alert.fingerprintV2 === first.fingerprintV2;
      data.incidentAlerts.push({
        incidentId: id,
        alertId: alert.id,
        match: alert === first ? 'new_incident' : sameIdentity ? 'fingerprint' : 'embedding',
        similarity: sameIdentity
          ? null
          : faker.number.float({ min: 0.8, max: 0.95, fractionDigits: 3 }),
        attachedAt: alert.receivedAt,
      });
    }
    data.alerts.push(...incidentAlertRows);
    return id;
  };

  // At least MIN_ALERTS_PER_INCIDENT each, the remainder spread at random.
  const counts = Array.from({ length: INCIDENTS }, () => MIN_ALERTS_PER_INCIDENT);
  for (let i = 0; i < ALERTS - MIN_ALERTS_PER_INCIDENT * INCIDENTS; i++) {
    const index = faker.number.int(INCIDENTS - 1);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  for (const count of counts) {
    const service = faker.helpers.arrayElement(SERVICES);
    const primary = faker.helpers.arrayElement(RULES);
    const secondary = faker.helpers.arrayElement(RULES.filter((rule) => rule !== primary));
    const lastSeen = faker.date.recent({ days: 30 });
    const firstSeen = new Date(
      lastSeen.getTime() - faker.number.int({ min: 5, max: 240 }) * MINUTE,
    );
    const resolved = lastSeen.getTime() < SEED_REFERENCE_DATE.getTime() - 2 * DAY;
    const pods = podsFor(service, faker.number.int({ min: 2, max: 12 }));
    const specs = Array.from({ length: count }, () =>
      faker.date.between({ from: firstSeen, to: lastSeen }),
    )
      .sort((a, b) => a.getTime() - b.getTime())
      .map((startsAt) => ({
        rule: faker.number.float() < 0.2 ? secondary : primary,
        pod: faker.helpers.arrayElement(pods),
        startsAt,
        resolved,
      }));
    addIncident({
      service,
      rule: primary,
      status: resolved
        ? 'resolved'
        : faker.helpers.arrayElement(['open', 'triaging', 'triaged'] as const),
      specs,
      deliverySize: 25,
    });
  }

  // The storm: checkout's error rate fires on 500 pods, each notification repeated, inside two
  // minutes. 3,000 alerts with 500 v1 fingerprints but a single v2 fingerprint.
  const stormEnd = SEED_REFERENCE_DATE.getTime() - 60 * MINUTE;
  const stormPods = podsFor(CHECKOUT, STORM_PODS);
  data.stormIncidentId = addIncident({
    service: CHECKOUT,
    rule: HIGH_ERROR_RATE,
    status: 'open',
    specs: Array.from({ length: STORM_ALERTS }, (_, i) => ({
      rule: HIGH_ERROR_RATE,
      pod: stormPods[i % STORM_PODS] ?? { name: 'checkout', instance: 'checkout' },
      startsAt: new Date(stormEnd - 2 * MINUTE + Math.floor((i * 2 * MINUTE) / STORM_ALERTS)),
      resolved: false,
    })),
    deliverySize: 100,
  });

  return data;
}

export interface SeedSummary {
  readonly incidents: number;
  readonly alerts: number;
  readonly ingests: number;
  readonly stormIncidentId: string;
}

/** Replaces every row in the database with the demo data set, in one transaction. */
export async function seed(db: Database): Promise<Result<SeedSummary, DatabaseError>> {
  const data = generateSeedData();
  return dbCall(() =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`TRUNCATE ingests, alerts, incidents, incident_alerts, triage_runs, hypotheses, evidence, proposed_actions, approvals, backfill_checkpoints`,
      );
      for (const rows of chunks(data.ingests)) await tx.insert(ingests).values(rows);
      for (const rows of chunks(data.incidents)) await tx.insert(incidents).values(rows);
      for (const rows of chunks(data.alerts)) await tx.insert(alerts).values(rows);
      for (const rows of chunks(data.incidentAlerts)) await tx.insert(incidentAlerts).values(rows);
      return {
        incidents: data.incidents.length,
        alerts: data.alerts.length,
        ingests: data.ingests.length,
        stormIncidentId: data.stormIncidentId,
      };
    }),
  );
}

function* chunks<T>(rows: readonly T[], size = 1000): Generator<T[]> {
  for (let start = 0; start < rows.length; start += size) yield rows.slice(start, start + size);
}
