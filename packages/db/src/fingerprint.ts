// Fingerprints are derived columns. They live next to the schema so the ingest writer and the
// backfill job compute exactly the same value.
import { createHash } from 'node:crypto';

export type Labels = Readonly<Record<string, string>>;

/**
 * Labels that differ per replica, pod or host, plus severity (which can escalate mid-incident).
 * fingerprint_v2 ignores them, so one problem across many pods has one identity.
 */
export const VOLATILE_LABELS: ReadonlySet<string> = new Set([
  'container',
  'container_id',
  'host',
  'hostname',
  'instance',
  'ip',
  'node',
  'node_name',
  'pod',
  'pod_name',
  'replica',
  'severity',
  'uid',
]);

function hashLabels(labels: Labels, keep: (name: string) => boolean): string {
  const canonical = Object.keys(labels)
    .filter(keep)
    .sort()
    .map((name) => [name, labels[name]]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** v1: a hash over every label, so each pod or instance is a distinct alert. */
export function fingerprintV1(labels: Labels): string {
  return hashLabels(labels, () => true);
}

/** v2: a hash over identity labels only (all labels minus VOLATILE_LABELS). */
export function fingerprintV2(labels: Labels): string {
  return hashLabels(labels, (name) => !VOLATILE_LABELS.has(name));
}
