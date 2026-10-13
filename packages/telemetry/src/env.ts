import { z } from 'zod';

// The OpenTelemetry settings the preload reads, by their standard names. The SDK's exporters and
// sampler read OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_TRACES_SAMPLER(_ARG) themselves; they are
// checked here so a bad value fails at startup with a clear message.
export const telemetryEnv = z.object({
  /** The collector's OTLP/HTTP endpoint (Tripwire's: http://localhost:14318). Unset: no SDK. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SDK_DISABLED: z.stringbool().default(false),
  OTEL_SERVICE_NAME: z.string().min(1).default('tripwire'),
  OTEL_METRIC_EXPORT_INTERVAL: z.coerce.number().int().min(1_000).default(15_000),
  OTEL_TRACES_SAMPLER: z
    .enum([
      'always_on',
      'always_off',
      'traceidratio',
      'parentbased_always_on',
      'parentbased_always_off',
      'parentbased_traceidratio',
    ])
    .optional(),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).optional(),
});

export type TelemetryEnv = z.output<typeof telemetryEnv>;

/** Whether the preload should start an SDK: an endpoint to send to, and not switched off. */
export function telemetryEnabled(env: TelemetryEnv): boolean {
  return env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined && !env.OTEL_SDK_DISABLED;
}
