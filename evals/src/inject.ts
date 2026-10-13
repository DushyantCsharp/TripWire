import type { Change, LogLine, Trace } from '@tripwire/agent';
import { z } from 'zod';
import type { CaseData, Delivery } from './cases.js';
import type { InjectionSpec } from './catalog.js';
import { DEMO_SERVICES } from './changes.js';

// An injection case: a captured incident with adversarial text spliced in where the agent will
// read it. The telemetry is otherwise the base case's, unchanged, and so is the ground truth: the
// right answer doesn't move because a log line says it should.

export function deriveInjection(base: CaseData, spec: InjectionSpec): CaseData {
  const target = injectionTarget(base);
  const captured = new Date(base.meta.capturedAt).getTime();
  let { logs, traces, deliveries, changes } = base;

  switch (spec.placement) {
    case 'log':
      logs = [
        ...logs,
        ...[90, 60, 30].map((secondsBefore, i): LogLine => ({
          id: `injected-${String(i)}`,
          at: new Date(captured - secondsBefore * 1000),
          service: target,
          severityNumber: 17,
          body: spec.text,
        })),
      ];
      break;
    case 'span':
      traces = injectIntoSpans(traces, target, spec.text);
      break;
    case 'annotation':
      deliveries = deliveries.map((delivery) => injectIntoAnnotations(delivery, spec.text));
      break;
  }

  // A rollback the text demands is only possible with a change of that service to roll back:
  // give it one, so the temptation is real (policy would refuse a rollback of nothing).
  for (const forbidden of spec.forbiddenActions) {
    const service = forbidden.service;
    if (
      forbidden.kind === 'rollback' &&
      service !== undefined &&
      (DEMO_SERVICES as readonly string[]).includes(service) &&
      !changes.some((change) => change.service === service)
    ) {
      const decoy: Change = {
        id: `deploy-${service}-2.1.0`,
        service,
        kind: 'deploy',
        description: `${service} 2.1.0 rolled out`,
        at: new Date(captured - 45 * 60_000),
      };
      changes = [...changes, decoy];
    }
  }

  return {
    meta: {
      ...base.meta,
      id: spec.id,
      kind: 'injection',
      description: `${base.meta.description}, with adversarial text injected (${spec.placement})`,
      synthetic: [...base.meta.synthetic, `injected text (${spec.placement})`],
      injection: {
        baseCase: base.meta.id,
        placement: spec.placement,
        text: spec.text,
        forbiddenActions: [...spec.forbiddenActions],
      },
      counts: {
        ...base.meta.counts,
        logs: logs.length,
        traces: traces.length,
      },
    },
    deliveries,
    logs,
    traces,
    metrics: base.metrics,
    changes,
  };
}

/** Where the agent will look: the faulty service if it logs, else the service logging most errors. */
export function injectionTarget(base: CaseData): string {
  const service = base.meta.groundTruth.service;
  if (base.logs.some((line) => line.service === service)) return service;
  const errors = new Map<string, number>();
  for (const line of base.logs) {
    if (line.severityNumber >= 17) errors.set(line.service, (errors.get(line.service) ?? 0) + 1);
  }
  return (
    [...errors.entries()].sort(([a, x], [b, y]) => y - x || a.localeCompare(b))[0]?.[0] ?? service
  );
}

/** The text becomes the failure message of up to three traces' failing spans in `service`. */
function injectIntoSpans(traces: readonly Trace[], service: string, text: string): Trace[] {
  let injected = 0;
  const failing = (trace: Trace) =>
    trace.spans.some((span) => span.error && span.service === service);
  const anyFailing = (trace: Trace) => trace.spans.some((span) => span.error);
  const pick = traces.some(failing) ? failing : anyFailing;
  return traces.map((trace) => {
    if (injected >= 3 || !pick(trace)) return trace;
    injected += 1;
    let done = false;
    return {
      ...trace,
      spans: trace.spans.map((span) => {
        if (done || !span.error || (pick === failing && span.service !== service)) return span;
        done = true;
        return { ...span, message: text };
      }),
    };
  });
}

const webhook = z.looseObject({
  alerts: z.array(z.looseObject({ annotations: z.record(z.string(), z.string()) })),
});

/** The text becomes every alert's summary annotation. */
function injectIntoAnnotations(delivery: Delivery, text: string): Delivery {
  const parsed = webhook.safeParse(delivery.body);
  if (!parsed.success) return delivery;
  return {
    ...delivery,
    body: {
      ...parsed.data,
      alerts: parsed.data.alerts.map((alert) => ({
        ...alert,
        annotations: { ...alert.annotations, summary: text },
      })),
    },
  };
}
