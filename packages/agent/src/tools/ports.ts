import type { Result } from '@tripwire/result';

// The telemetry backends behind the tools, as ports. Live adapters speak HTTP to OpenSearch, Jaeger
// and Prometheus (../backends); the evals replay captured snapshots through in-memory ones
// (../memory.ts); runbook search lives with the database (@tripwire/pipeline). Each returns failures
// as values: the loop records a down backend as unavailable evidence and carries on.

/**
 * `unavailable`: the backend is down, timed out, or isn't configured, so the evidence is missing.
 * `invalid_query`: the backend rejected the query (bad PromQL, a stale cursor); the model can fix it.
 */
export interface ToolError {
  readonly kind: 'unavailable' | 'invalid_query';
  readonly message: string;
}

export interface PortOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface LogLine {
  /** The backend's id for the line, without the `log:` prefix the tool adds. */
  readonly id: string;
  readonly at: Date;
  readonly service: string;
  /** OpenTelemetry severity number: 1–4 trace, 5–8 debug, 9–12 info, 13–16 warn, 17–24 error/fatal. */
  readonly severityNumber: number;
  readonly body: string;
}

export interface LogSearch {
  readonly service?: string | undefined;
  readonly minSeverityNumber?: number | undefined;
  /** An exact phrase. */
  readonly contains?: string | undefined;
  readonly from: Date;
  readonly to: Date;
  /** Lines to skip and return, newest first. */
  readonly offset: number;
  readonly limit: number;
  /** Also return up to this many of the newest lines for pattern counting; 0 for none. */
  readonly sampleSize: number;
}

export interface LogSearchResult {
  readonly total: number;
  /** Counts by severity bucket (trace, debug, info, warn, error) over every matching line. */
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byService: Readonly<Record<string, number>>;
  readonly lines: readonly LogLine[];
  readonly sample: readonly LogLine[];
}

export interface LogStore {
  search(query: LogSearch, options: PortOptions): Promise<Result<LogSearchResult, ToolError>>;
}

export interface Span {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly service: string;
  readonly operation: string;
  /** Microseconds since the epoch. */
  readonly startUs: number;
  readonly durationUs: number;
  readonly error: boolean;
  /** The span's status message or exception message, if it failed. */
  readonly message: string | null;
}

export interface Trace {
  readonly traceId: string;
  readonly spans: readonly Span[];
}

export interface TraceSearch {
  readonly service: string;
  readonly operation?: string | undefined;
  readonly errorsOnly: boolean;
  readonly minDurationMs?: number | undefined;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
}

export interface TraceStore {
  search(query: TraceSearch, options: PortOptions): Promise<Result<readonly Trace[], ToolError>>;
}

export interface MetricSeries {
  readonly labels: Readonly<Record<string, string>>;
  /** [unix seconds, value], oldest first. Values may be NaN or ±Inf, as PromQL can produce. */
  readonly points: readonly (readonly [number, number])[];
}

export interface MetricQuery {
  readonly promql: string;
  readonly start: Date;
  readonly end: Date;
  readonly stepSeconds: number;
}

export interface MetricStore {
  queryRange(
    query: MetricQuery,
    options: PortOptions,
  ): Promise<Result<readonly MetricSeries[], ToolError>>;
}

export interface Change {
  /** The source's id, without the `change:` prefix the tool adds. */
  readonly id: string;
  readonly service: string;
  readonly kind: 'deploy' | 'config';
  readonly description: string;
  readonly at: Date;
}

export interface ChangeSource {
  list(
    query: { readonly service?: string | undefined; readonly from: Date; readonly to: Date },
    options: PortOptions,
  ): Promise<Result<readonly Change[], ToolError>>;
}

export interface RunbookSection {
  /** `<file>#<heading slug>`, without the `runbook:` prefix the tool adds. */
  readonly id: string;
  readonly title: string;
  readonly service: string | null;
  readonly content: string;
  /** Cosine similarity to the query, 0–1. */
  readonly score: number;
}

export interface RunbookIndex {
  search(
    query: { readonly text: string; readonly service?: string | undefined; readonly k: number },
    options: PortOptions,
  ): Promise<Result<readonly RunbookSection[], ToolError>>;
}

/** Everything telemetryTools needs. Without a change source, list_deploys isn't offered. */
export interface TelemetryPorts {
  readonly logs: LogStore;
  readonly traces: TraceStore;
  readonly metrics: MetricStore;
  readonly changes?: ChangeSource | undefined;
  readonly runbooks: RunbookIndex;
}
