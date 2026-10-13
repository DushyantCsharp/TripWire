import { createHash } from 'node:crypto';
import { canonicalJson } from '@tripwire/agent';
import { z } from 'zod';

// The demo has no Alertmanager: the capture polls Prometheus's alerts API and sends what an
// Alertmanager with a webhook receiver would have, one notification per alert group (alertname),
// again at each poll while the group fires, as Alertmanager repeats them.

export const promAlertsSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    alerts: z.array(
      z.object({
        labels: z.record(z.string(), z.string()),
        annotations: z.record(z.string(), z.string()).default({}),
        state: z.enum(['firing', 'pending', 'inactive']),
        activeAt: z.string().optional(),
        value: z.string().optional(),
      }),
    ),
  }),
});

export type PromAlert = z.output<typeof promAlertsSchema>['data']['alerts'][number];

/** Alertmanager's alert fingerprint: a hash of the label set. */
export function fingerprint(labels: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(canonicalJson(labels)).digest('hex').slice(0, 16);
}

const ZERO_TIME = '0001-01-01T00:00:00Z';

/** Webhook bodies (Alertmanager v4) for the firing alerts, one per alertname, sorted by name. */
export function toWebhooks(
  alerts: readonly PromAlert[],
  { receiver = 'tripwire', externalURL = 'http://alertmanager:9093' } = {},
): unknown[] {
  const groups = new Map<string, PromAlert[]>();
  for (const alert of alerts) {
    if (alert.state !== 'firing') continue;
    const name = alert.labels.alertname ?? 'unnamed';
    groups.set(name, [...(groups.get(name) ?? []), alert]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([alertname, members]) => ({
      version: '4',
      groupKey: `{}:{alertname="${alertname}"}`,
      truncatedAlerts: 0,
      status: 'firing',
      receiver,
      groupLabels: { alertname },
      commonLabels: commonOf(members.map((m) => m.labels)),
      commonAnnotations: commonOf(members.map((m) => m.annotations)),
      externalURL,
      alerts: members
        .map((alert) => ({
          status: 'firing',
          labels: alert.labels,
          annotations: alert.annotations,
          startsAt: alert.activeAt ?? ZERO_TIME,
          endsAt: ZERO_TIME,
          generatorURL: `${externalURL}/graph`,
          fingerprint: fingerprint(alert.labels),
        }))
        .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    }));
}

function commonOf(sets: readonly Readonly<Record<string, string>>[]): Record<string, string> {
  const [first, ...rest] = sets;
  if (!first) return {};
  return Object.fromEntries(
    Object.entries(first).filter(([key, value]) => rest.every((set) => set[key] === value)),
  );
}
