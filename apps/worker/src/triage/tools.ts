import {
  httpChangeSource,
  jaegerTraceStore,
  opensearchLogStore,
  prometheusMetricStore,
  type TelemetryPorts,
} from '@tripwire/agent';
import type { Database } from '@tripwire/db';
import { type Embedder, pgvectorRunbookIndex } from '@tripwire/pipeline';
import { err } from '@tripwire/result';
import type { WorkerConfig } from '../config.js';

type BackendConfig = Pick<
  WorkerConfig,
  'LOGS_OPENSEARCH_URL' | 'TRACES_JAEGER_URL' | 'METRICS_PROMETHEUS_URL' | 'DEPLOYS_URL'
>;

/** A port for a backend the deployment hasn't configured: its evidence is unavailable. */
const notConfigured = (backend: string, variable: string) => () =>
  Promise.resolve(
    err({ kind: 'unavailable' as const, message: `${backend} is not configured (${variable})` }),
  );

/**
 * The telemetry behind the triage tools, from config. A backend without a URL is reported as
 * unavailable evidence; without a change feed, list_deploys isn't offered at all (there may simply
 * be no deploy system to ask, which shouldn't count against every report). Runbooks are searched
 * in Postgres.
 */
export function telemetryPorts(
  config: BackendConfig,
  { db, embedder }: { readonly db: Database; readonly embedder: Embedder },
): TelemetryPorts {
  return {
    logs: config.LOGS_OPENSEARCH_URL
      ? opensearchLogStore({ url: config.LOGS_OPENSEARCH_URL })
      : { search: notConfigured('the log backend', 'LOGS_OPENSEARCH_URL') },
    traces: config.TRACES_JAEGER_URL
      ? jaegerTraceStore({ url: config.TRACES_JAEGER_URL })
      : { search: notConfigured('the trace backend', 'TRACES_JAEGER_URL') },
    metrics: config.METRICS_PROMETHEUS_URL
      ? prometheusMetricStore({ url: config.METRICS_PROMETHEUS_URL })
      : { queryRange: notConfigured('the metrics backend', 'METRICS_PROMETHEUS_URL') },
    changes: config.DEPLOYS_URL ? httpChangeSource({ url: config.DEPLOYS_URL }) : undefined,
    runbooks: pgvectorRunbookIndex(db, embedder),
  };
}
