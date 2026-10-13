import { setTimeout as sleep } from 'node:timers/promises';
import { err, ok } from '@tripwire/result';
import type { AlertGroup, Hypothesis, TriageInput, Triager } from './triage.js';

const MODEL = 'baseline-v1';

export interface BaselineOptions {
  /** Simulated thinking time, so queue behaviour (shutdown, chaos tests) sees realistic jobs. */
  readonly latencyMs?: number;
}

/**
 * A deterministic, model-free triager that ranks the services an incident's alerts name most often.
 * It runs where no model is configured (chaos tests, local dev) and is the baseline the evals
 * compare against. It queries no telemetry, so it cites no evidence and keeps its confidence low.
 */
export function baselineTriager({ latencyMs = 0 }: BaselineOptions = {}): Triager {
  return {
    model: MODEL,
    async triage(input, { signal }) {
      if (latencyMs > 0) {
        try {
          await sleep(latencyMs, undefined, { signal });
        } catch (cause) {
          if (signal?.aborted) return err({ kind: 'timeout', message: 'triage was cancelled' });
          throw cause;
        }
      }
      const hypotheses = rankByAlertLabels(input);
      const [top] = hypotheses;
      return ok({
        model: MODEL,
        summary: top
          ? `Most likely ${top.title} (baseline: alert labels only).`
          : 'No alerts to rank.',
        confidence: top?.confidence ?? 0,
        basis: 'alert_labels',
        hypotheses,
        unavailableEvidence: [],
        stopReason: 'report_submitted',
        windDown: null,
        proposedActions: [],
        rejectedProposals: [],
        rejectedCitations: [],
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0, modelCalls: 0, costUsdMicros: 0 },
      });
    },
  };
}

/**
 * Up to three services, ranked by how many of the incident's alerts name them. The triage loop
 * falls back to this when the model produces no usable report before a limit.
 */
export function rankByAlertLabels(input: TriageInput): Hypothesis[] {
  const groups: readonly AlertGroup[] =
    input.alertGroups.length > 0
      ? input.alertGroups
      : input.alerts.map((alert) => ({
          name: alert.name,
          service: alert.service,
          count: 1,
          firstStartsAt: alert.startsAt,
          lastReceivedAt: alert.receivedAt,
        }));
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const byService = new Map<string, { count: number; names: Map<string, number> }>();
  for (const group of groups) {
    const service = group.service ?? 'unknown';
    const entry = byService.get(service) ?? { count: 0, names: new Map<string, number>() };
    entry.count += group.count;
    entry.names.set(group.name, (entry.names.get(group.name) ?? 0) + group.count);
    byService.set(service, entry);
  }
  return [...byService.entries()]
    .sort(([a, x], [b, y]) => y.count - x.count || a.localeCompare(b))
    .slice(0, 3)
    .map(([service, { count, names }], index) => {
      const alertname =
        [...names.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ??
        'unknown';
      return {
        rank: index + 1,
        title: `${service}: ${alertname}`,
        explanation:
          `${String(count)} of the incident's ${String(total)} alerts name ${service}, most often ` +
          `${alertname}. Inferred from alert labels only; no telemetry was read.`,
        confidence: round((count / total) * 0.3),
        suspect: service === 'unknown' ? null : service,
        faultClass: null,
        evidence: [],
      };
    });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
