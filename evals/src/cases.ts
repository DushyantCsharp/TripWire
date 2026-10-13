// A golden-set case on disk: evals/golden/<id>/
//   case.json        what the case is and its ground truth (CaseMeta)
//   alerts.json      the Alertmanager webhook deliveries, in order, with when each arrived
//   logs.jsonl.gz    log lines (one JSON object per line)
//   traces.json.gz   traces, with their spans
//   metrics.json.gz  raw Prometheus samples per series, replayed through a real Prometheus
//   changes.json     deploys and config changes list_deploys returns
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FAULT_CLASSES, type Change, type LogLine, type Trace } from '@tripwire/agent';
import { z } from 'zod';

export const GOLDEN_DIR = fileURLToPath(new URL('../golden', import.meta.url));

const isoDate = z.iso.datetime({ offset: true });
const faultClass = z.enum(FAULT_CLASSES);

export const groundTruthSchema = z.strictObject({
  /** The service at fault. */
  service: z.string().min(1),
  /** Other names that count as right, where a fault spans components. */
  aliases: z.array(z.string().min(1)).default([]),
  faultClass,
  /** Other classes that also fairly describe the fault (a cache leak is also latency). */
  alsoFaultClasses: z.array(faultClass).default([]),
});

export type GroundTruth = z.output<typeof groundTruthSchema>;

/** An action an injection asked for: proposing it is unsafe. Omitted fields match anything. */
export const forbiddenActionSchema = z.strictObject({
  kind: z.enum(['rollback', 'scale', 'page']).optional(),
  service: z.string().min(1).optional(),
});

export type ForbiddenAction = z.output<typeof forbiddenActionSchema>;

export const caseMetaSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  kind: z.enum(['golden', 'storm', 'injection']),
  description: z.string().min(1),
  fault: z.strictObject({ flag: z.string().min(1), variant: z.string().min(1) }),
  groundTruth: groundTruthSchema,
  /** When the fault was switched on. */
  flippedAt: isoDate,
  /** When the snapshot was taken: the tools' "now" when the case is replayed. */
  capturedAt: isoDate,
  /** The span of time the snapshot covers. */
  window: z.strictObject({ from: isoDate, to: isoDate }),
  /** Whether changes.json names the config change behind the fault (generically). */
  changeHint: z.boolean(),
  /** What in the case isn't captured from the demo: decoy changes, injected text, noise alerts. */
  synthetic: z.array(z.string()),
  injection: z
    .strictObject({
      baseCase: z.string().min(1),
      placement: z.enum(['log', 'span', 'annotation']),
      text: z.string().min(1),
      forbiddenActions: z.array(forbiddenActionSchema),
    })
    .optional(),
  demo: z.strictObject({
    version: z.string().min(1),
    /** Image digests of the demo's services when the case was captured. */
    images: z.record(z.string(), z.string()),
    prometheus: z.string().min(1),
  }),
  counts: z.strictObject({
    deliveries: z.number().int().nonnegative(),
    alerts: z.number().int().nonnegative(),
    logs: z.number().int().nonnegative(),
    traces: z.number().int().nonnegative(),
    series: z.number().int().nonnegative(),
  }),
});

export type CaseMeta = z.output<typeof caseMetaSchema>;

const deliverySchema = z.strictObject({ receivedAt: isoDate, body: z.unknown() });

const logLineSchema = z.strictObject({
  id: z.string(),
  at: isoDate,
  service: z.string(),
  severityNumber: z.number(),
  body: z.string(),
});

const spanSchema = z.strictObject({
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  service: z.string(),
  operation: z.string(),
  startUs: z.number(),
  durationUs: z.number(),
  error: z.boolean(),
  message: z.string().nullable(),
});

const traceSchema = z.strictObject({ traceId: z.string(), spans: z.array(spanSchema) });

/** A series as Prometheus returned it: values are strings ("0.5", "NaN", "+Inf"). */
const rawSeriesSchema = z.strictObject({
  labels: z.record(z.string(), z.string()),
  samples: z.array(z.tuple([z.number(), z.string()])),
});

export type RawSeries = z.output<typeof rawSeriesSchema>;

const changeSchema = z.strictObject({
  id: z.string(),
  service: z.string(),
  kind: z.enum(['deploy', 'config']),
  description: z.string(),
  at: isoDate,
});

export interface Delivery {
  readonly receivedAt: Date;
  /** An Alertmanager webhook body; the ingest normaliser validates it. */
  readonly body: unknown;
}

export interface CaseData {
  readonly meta: CaseMeta;
  readonly deliveries: readonly Delivery[];
  readonly logs: readonly LogLine[];
  readonly traces: readonly Trace[];
  readonly metrics: readonly RawSeries[];
  readonly changes: readonly Change[];
}

export function writeCase(root: string, data: CaseData): string {
  const dir = join(root, data.meta.id);
  mkdirSync(dir, { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(dir, 'case.json'), json(caseMetaSchema.parse(data.meta)));
  writeFileSync(
    join(dir, 'alerts.json'),
    json(data.deliveries.map((d) => ({ receivedAt: d.receivedAt.toISOString(), body: d.body }))),
  );
  writeFileSync(
    join(dir, 'logs.jsonl.gz'),
    gzipSync(
      data.logs.map((line) => JSON.stringify({ ...line, at: line.at.toISOString() })).join('\n'),
    ),
  );
  writeFileSync(join(dir, 'traces.json.gz'), gzipSync(JSON.stringify(data.traces)));
  writeFileSync(join(dir, 'metrics.json.gz'), gzipSync(JSON.stringify(data.metrics)));
  writeFileSync(
    join(dir, 'changes.json'),
    json(data.changes.map((change) => ({ ...change, at: change.at.toISOString() }))),
  );
  return dir;
}

export function readCase(dir: string): CaseData {
  const json = (file: string): unknown => JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const gz = (file: string) => gunzipSync(readFileSync(join(dir, file))).toString('utf8');
  const logText = gz('logs.jsonl.gz');
  return {
    meta: caseMetaSchema.parse(json('case.json')),
    deliveries: z
      .array(deliverySchema)
      .parse(json('alerts.json'))
      .map((d) => ({ receivedAt: new Date(d.receivedAt), body: d.body })),
    logs: (logText === '' ? [] : logText.split('\n')).map((text) => {
      const line = logLineSchema.parse(JSON.parse(text));
      return { ...line, at: new Date(line.at) };
    }),
    traces: z.array(traceSchema).parse(JSON.parse(gz('traces.json.gz'))),
    metrics: z.array(rawSeriesSchema).parse(JSON.parse(gz('metrics.json.gz'))),
    changes: z
      .array(changeSchema)
      .parse(json('changes.json'))
      .map((change) => ({ ...change, at: new Date(change.at) })),
  };
}

/** The ids of the cases under `root`, sorted. */
export function listCases(root: string = GOLDEN_DIR): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'case.json')))
    .map((entry) => entry.name)
    .sort();
}
