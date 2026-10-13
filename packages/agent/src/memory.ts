import { ok } from '@tripwire/result';
import { severityName } from './tools/telemetry.js';
import type { Change, ChangeSource, LogLine, LogStore, Trace, TraceStore } from './tools/ports.js';

// In-memory backends over captured telemetry: the evals replay golden-set snapshots through these,
// with the same query semantics as the live adapters. (PromQL needs a real Prometheus.)

const byNewest =
  <T extends { readonly id: string }>(at: (item: T) => number) =>
  (a: T, b: T) =>
    at(b) - at(a) || a.id.localeCompare(b.id);

export function memoryLogStore(lines: readonly LogLine[]): LogStore {
  const sorted = [...lines].sort(byNewest((line) => line.at.getTime()));
  return {
    search(query) {
      const phrase = query.contains?.toLowerCase();
      const matching = sorted.filter(
        (line) =>
          line.at >= query.from &&
          line.at < query.to &&
          (query.service === undefined || line.service === query.service) &&
          (query.minSeverityNumber === undefined ||
            line.severityNumber >= query.minSeverityNumber) &&
          (phrase === undefined || line.body.toLowerCase().includes(phrase)),
      );
      const bySeverity: Record<string, number> = {};
      const byService: Record<string, number> = {};
      for (const line of matching) {
        const severity = severityName(line.severityNumber);
        bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
        byService[line.service] = (byService[line.service] ?? 0) + 1;
      }
      return Promise.resolve(
        ok({
          total: matching.length,
          bySeverity,
          byService,
          lines: matching.slice(query.offset, query.offset + query.limit),
          sample: matching.slice(0, query.sampleSize),
        }),
      );
    },
  };
}

export function memoryTraceStore(traces: readonly Trace[]): TraceStore {
  const start = (trace: Trace) => Math.min(...trace.spans.map((span) => span.startUs));
  const rootDurationUs = (trace: Trace) => {
    const ids = new Set(trace.spans.map((span) => span.spanId));
    const root = trace.spans.find((s) => s.parentSpanId === null || !ids.has(s.parentSpanId));
    return root?.durationUs ?? 0;
  };
  const sorted = [...traces]
    .filter((trace) => trace.spans.length > 0)
    .sort((a, b) => start(b) - start(a) || a.traceId.localeCompare(b.traceId));
  return {
    search(query) {
      const fromUs = query.from.getTime() * 1000;
      const toUs = query.to.getTime() * 1000;
      const matching = sorted.filter((trace) => {
        const at = start(trace);
        return (
          at >= fromUs &&
          at < toUs &&
          trace.spans.some(
            (span) =>
              span.service === query.service &&
              (query.operation === undefined || span.operation === query.operation),
          ) &&
          (!query.errorsOnly || trace.spans.some((span) => span.error)) &&
          (query.minDurationMs === undefined || rootDurationUs(trace) >= query.minDurationMs * 1000)
        );
      });
      return Promise.resolve(ok(matching.slice(0, query.limit)));
    },
  };
}

export function memoryChangeSource(changes: readonly Change[]): ChangeSource {
  return {
    list(query) {
      return Promise.resolve(
        ok(
          changes.filter(
            (change) =>
              change.at >= query.from &&
              change.at < query.to &&
              (query.service === undefined || change.service === query.service),
          ),
        ),
      );
    },
  };
}
