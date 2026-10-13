import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jaegerTraceStore, type LogLine, opensearchLogStore, type Trace } from '@tripwire/agent';
import { z } from 'zod';
import { type PromAlert, promAlertsSchema } from '../alertmanager.js';
import type { RawSeries } from '../cases.js';
import { type FlagdConfig, flagdConfigSchema } from '../flags.js';

// The running OpenTelemetry Demo, as the capture script uses it: flagd (through flagd-ui's API),
// its Prometheus, OpenSearch and Jaeger, and Docker for image digests and restarts. A capture is
// a supervised script, so a failure here throws with a message and stops it.

const exec = promisify(execFile);

export interface DemoUrls {
  /** The storefront's proxy, which also serves flagd-ui at /feature. */
  readonly demo: string;
  readonly prometheus: string;
  /** Jaeger's query API, base path included. */
  readonly jaeger: string;
  readonly opensearch: string;
}

async function getJson<T>(url: URL | string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${String(url)} answered ${String(response.status)}: ${text.slice(0, 300)}`);
  return schema.parse(text === '' ? null : JSON.parse(text));
}

const matrixSchema = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        values: z.array(z.tuple([z.number(), z.string()])),
      }),
    ),
  }),
});

export function demoClient(urls: DemoUrls) {
  const logs = opensearchLogStore({ url: urls.opensearch });
  const traces = jaegerTraceStore({ url: urls.jaeger });

  return {
    async readFlags(): Promise<FlagdConfig> {
      // flagd-ui answers with the file, or the file under `data`.
      const body = await getJson(`${urls.demo}/feature/api/read`, z.unknown());
      const direct = flagdConfigSchema.safeParse(body);
      if (direct.success) return direct.data;
      return z.object({ data: flagdConfigSchema }).parse(body).data;
    },

    async writeFlags(config: FlagdConfig): Promise<void> {
      const response = await fetch(`${urls.demo}/feature/api/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: config }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          `flagd-ui refused the write: ${String(response.status)} ${await response.text()}`,
        );
      }
    },

    async alerts(): Promise<PromAlert[]> {
      const body = await getJson(`${urls.prometheus}/api/v1/alerts`, promAlertsSchema);
      return body.data.alerts;
    },

    async prometheusVersion(): Promise<string> {
      const body = await getJson(
        `${urls.prometheus}/api/v1/status/buildinfo`,
        z.object({ data: z.object({ version: z.string() }) }),
      );
      return body.data.version;
    },

    async metricNames(): Promise<string[]> {
      const body = await getJson(
        `${urls.prometheus}/api/v1/label/__name__/values`,
        z.object({ data: z.array(z.string()) }),
      );
      return body.data;
    },

    /**
     * The raw samples of every series named `name` in the `seconds` before `end`: a range selector
     * evaluated at one instant, so Prometheus returns them as stored, not resampled.
     */
    async rawSeries(name: string, seconds: number, end: Date): Promise<RawSeries[]> {
      const url = new URL(`${urls.prometheus}/api/v1/query`);
      url.searchParams.set('query', `${name}[${String(seconds)}s]`);
      url.searchParams.set('time', String(end.getTime() / 1000));
      const body = await getJson(url, matrixSchema);
      return body.data.result.map((series) => ({ labels: series.metric, samples: series.values }));
    },

    /** Every warning and error in the window (up to `maxErrors`), plus a sample of the rest. */
    async logs(from: Date, to: Date, maxErrors: number, maxOther: number): Promise<LogLine[]> {
      const severe = await logs.search(
        { minSeverityNumber: 13, from, to, offset: 0, limit: maxErrors, sampleSize: 0 },
        {},
      );
      if (!severe.ok) throw new Error(`OpenSearch: ${severe.error.message}`);
      const all = await logs.search(
        { from, to, offset: 0, limit: maxOther * 3, sampleSize: 0 },
        {},
      );
      if (!all.ok) throw new Error(`OpenSearch: ${all.error.message}`);
      const seen = new Set(severe.value.lines.map((line) => line.id));
      const other = all.value.lines.filter(
        (line) => !seen.has(line.id) && line.severityNumber < 13,
      );
      // An even sample across the window, not just its newest lines.
      const step = Math.max(1, Math.floor(other.length / maxOther));
      return [...severe.value.lines, ...other.filter((_, i) => i % step === 0).slice(0, maxOther)];
    },

    /** Failing and recent traces through every service in the window. */
    async traces(from: Date, to: Date, perService: number): Promise<Trace[]> {
      const services = await getJson(
        `${urls.jaeger}/api/services`,
        z.object({ data: z.array(z.string()).nullable() }),
      );
      const found = new Map<string, Trace>();
      for (const service of services.data ?? []) {
        if (service === 'jaeger') continue;
        for (const errorsOnly of [true, false]) {
          const result = await traces.search(
            {
              service,
              errorsOnly,
              from,
              to,
              limit: errorsOnly ? perService : Math.ceil(perService / 2),
            },
            {},
          );
          if (!result.ok) throw new Error(`Jaeger (${service}): ${result.error.message}`);
          for (const trace of result.value) {
            // Very large traces are trimmed: the tools summarise, and storage isn't free.
            found.set(trace.traceId, { ...trace, spans: trace.spans.slice(0, 200) });
          }
        }
      }
      return [...found.values()];
    },

    /** The image digest of each running demo service. */
    async imageDigests(): Promise<Record<string, string>> {
      const { stdout } = await exec('docker', [
        'ps',
        '--filter',
        'label=com.docker.compose.project=otel-demo',
        '--format',
        '{{.Label "com.docker.compose.service"}}\t{{.Image}}',
      ]);
      const digests: Record<string, string> = {};
      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const [service, image] = line.split('\t');
        if (!service || !image) continue;
        const { stdout: inspected } = await exec('docker', [
          'image',
          'inspect',
          '--format',
          '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}',
          image,
        ]);
        digests[service] = inspected.trim();
      }
      return digests;
    },

    async restart(service: string): Promise<void> {
      const { stdout } = await exec('docker', [
        'ps',
        '--filter',
        'label=com.docker.compose.project=otel-demo',
        '--filter',
        `label=com.docker.compose.service=${service}`,
        '--format',
        '{{.ID}}',
      ]);
      const id = stdout.trim().split('\n')[0];
      if (!id) throw new Error(`no running demo container for ${service}`);
      await exec('docker', ['restart', id]);
    },
  };
}

export type DemoClient = ReturnType<typeof demoClient>;
