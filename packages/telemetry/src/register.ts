// Starts OpenTelemetry for a Tripwire app, before the app loads anything it instruments:
//   node --import @tripwire/telemetry/register dist/main.js
// Traces and metrics go over OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (the collector). Without it,
// or with OTEL_SDK_DISABLED=true, nothing starts and the app runs untraced.
import { register } from 'node:module';
import { FastifyOtelInstrumentation } from '@fastify/otel';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { loadEnvOrExit } from '@tripwire/config';
import { registerSdk } from './api.js';
import { telemetryEnabled, telemetryEnv } from './env.js';

const HEALTH = '/v1/healthz';

const env = loadEnvOrExit(telemetryEnv);

if (telemetryEnabled(env)) {
  // ESM imports are only patched through this loader. Only pg and ioredis need it (Fastify and
  // undici report through diagnostics channels, http through require), and an unscoped hook would
  // wrap every module, tsx's TypeScript included.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url, {
    data: { include: ['pg', 'pg-pool', 'ioredis'] },
  });

  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME,
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: env.OTEL_METRIC_EXPORT_INTERVAL,
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url === HEALTH,
      }),
      new UndiciInstrumentation(),
      // A span per request and handler; none per hook, none for health checks.
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        instrumentHooks: false,
        ignorePaths: HEALTH,
      }),
      // Only inside traced work: BullMQ's polling and the pool's housekeeping start no traces.
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
  registerSdk(sdk);
}
