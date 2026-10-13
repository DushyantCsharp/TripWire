import { zIngestAlertmanagerWebhookBody, zIngestGenericWebhookBody } from '@tripwire/contracts/zod';
import { type NewAlert, VOLATILE_LABELS } from '@tripwire/db';
import { err, ok, type Result } from '@tripwire/result';
import type { z } from 'zod';

type Severity = NewAlert['severity'];

/** Severity label values seen in the wild, mapped onto ours. Anything else counts as a warning. */
const SEVERITIES: Readonly<Record<string, Severity>> = {
  critical: 'critical',
  page: 'critical',
  error: 'critical',
  high: 'critical',
  warning: 'warning',
  warn: 'warning',
  medium: 'warning',
  info: 'info',
  low: 'info',
  none: 'info',
};

export interface InvalidPayload {
  readonly kind: 'invalid_payload';
  readonly message: string;
}

/**
 * Turns a webhook body into alerts. The API validated it before enqueueing; parsing again guards
 * the queue boundary, since job data comes from outside this process.
 */
export function normalizeAlerts(
  source: 'alertmanager' | 'generic',
  payload: unknown,
): Result<NewAlert[], InvalidPayload> {
  if (source === 'alertmanager') {
    const parsed = zIngestAlertmanagerWebhookBody.safeParse(payload);
    if (!parsed.success) return err(invalid(parsed.error));
    return ok(
      parsed.data.alerts.map((alert) => ({
        source,
        name: alert.labels.alertname ?? 'unnamed',
        status: alert.status,
        severity: severityOf(alert.labels.severity),
        service: alert.labels.service ?? alert.labels.app ?? alert.labels.job,
        summary: alert.annotations.summary ?? alert.annotations.description,
        labels: alert.labels,
        startsAt: new Date(alert.startsAt),
        // Alertmanager sends the zero time while an alert is still firing.
        endsAt: alert.endsAt.startsWith('0001-') ? undefined : new Date(alert.endsAt),
        rawPayload: alert,
      })),
    );
  }

  const parsed = zIngestGenericWebhookBody.safeParse(payload);
  if (!parsed.success) return err(invalid(parsed.error));
  return ok(
    parsed.data.alerts.map((alert) => ({
      source,
      name: alert.name,
      status: alert.status,
      severity: alert.severity,
      service: alert.service,
      summary: alert.summary,
      // Fold the typed fields into the labels, so both sources fingerprint the same way.
      labels: {
        ...alert.labels,
        alertname: alert.name,
        severity: alert.severity,
        ...(alert.service !== undefined && { service: alert.service }),
      },
      startsAt: new Date(alert.starts_at),
      endsAt: alert.ends_at === undefined ? undefined : new Date(alert.ends_at),
      rawPayload: alert,
    })),
  );
}

function severityOf(label: string | undefined): Severity {
  return SEVERITIES[label?.toLowerCase() ?? ''] ?? 'warning';
}

function invalid(error: z.ZodError): InvalidPayload {
  const issues = error.issues.map(
    (issue) => `${issue.path.map(String).join('.')}: ${issue.message}`,
  );
  return { kind: 'invalid_payload', message: issues.join('; ') };
}

/** The text an alert is embedded from: identity labels only, so every replica embeds the same. */
export function alertText(alert: {
  readonly name: string;
  readonly service: string | null;
  readonly summary: string | null;
  readonly labels: Readonly<Record<string, string>>;
}): string {
  const labels = Object.entries(alert.labels)
    .filter(([name]) => !VOLATILE_LABELS.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name} ${value}`);
  return [alert.name, alert.service ?? '', alert.summary ?? '', ...labels].join(' ');
}
