import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import type { RawSeries } from '../cases.js';
import { toOpenMetrics } from '../openmetrics.js';

// A real Prometheus holding one case's captured samples, so query_metrics runs real PromQL in the
// evals. promtool (in the same image) turns the samples into TSDB blocks before Prometheus starts.
// One Prometheus per case: cases captured at different times must not see each other's metrics.

/** The demo's Prometheus (infra/otel-demo: 3.1.0 runs v3.13.1). */
export const PROMETHEUS_IMAGE = 'quay.io/prometheus/prometheus:v3.13.1';

// No scrape targets: nothing should land in the TSDB after the backfill.
const CONFIG = 'global:\n  scrape_interval: 1h\nscrape_configs: []\n';

const START = [
  'set -e',
  // A case without metrics has nothing to backfill (promtool refuses an empty file).
  "if grep -qv '^#' /tmp/case.om; then",
  '  promtool tsdb create-blocks-from openmetrics /tmp/case.om /prometheus > /tmp/backfill.log',
  'fi',
  'exec prometheus --config.file=/tmp/prometheus.yml --storage.tsdb.path=/prometheus ' +
    '--storage.tsdb.retention.time=100y --web.listen-address=:9090',
].join('\n');

export interface ReplayPrometheus {
  readonly url: string;
  readonly series: number;
  readonly samples: number;
  stop(): Promise<void>;
}

export async function replayPrometheus(series: readonly RawSeries[]): Promise<ReplayPrometheus> {
  const metrics = toOpenMetrics(series);
  const container: StartedTestContainer = await new GenericContainer(PROMETHEUS_IMAGE)
    .withCopyContentToContainer([
      { content: metrics.text, target: '/tmp/case.om', mode: 0o644 },
      { content: CONFIG, target: '/tmp/prometheus.yml', mode: 0o644 },
    ])
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand([START])
    .withExposedPorts(9090)
    .withWaitStrategy(Wait.forHttp('/-/ready', 9090))
    .withStartupTimeout(180_000)
    .start();
  return {
    url: `http://${container.getHost()}:${String(container.getMappedPort(9090))}`,
    series: metrics.series,
    samples: metrics.samples,
    async stop() {
      await container.stop();
    },
  };
}
