import { isSpanContextValid, type Meter, metrics, trace, type Tracer } from '@opentelemetry/api';
import { attempt, ok, type Result } from '@tripwire/result';

// Tripwire's handles on the OpenTelemetry API. With no SDK registered (tests, chaos, the evals)
// they are no-ops; `@tripwire/telemetry/register` starts one for the apps.

const SCOPE = 'tripwire';

export const tracer = (): Tracer => trace.getTracer(SCOPE);

/**
 * Tripwire's meter. Create instruments from it when a server, processor or triager is built, not
 * at module load: the metrics API has no proxy provider, so an instrument made before a provider
 * is registered stays a no-op.
 */
export const meter = (): Meter => metrics.getMeter(SCOPE);

/** The active span's trace id, for error responses; null when nothing is being traced. */
export function activeTraceId(): string | null {
  const context = trace.getActiveSpan()?.spanContext();
  return context && isSpanContextValid(context) ? context.traceId : null;
}

interface Stoppable {
  shutdown(): Promise<unknown>;
}

// The SDK the preload started, shared through a global: the preload and the app can load this
// module twice (source and dist), and both must find the same SDK.
const SDK = Symbol.for('tripwire.telemetry.sdk');
type Registry = Record<symbol, Stoppable | undefined>;

/** Called by the preload with the SDK it started. */
export function registerSdk(sdk: Stoppable): void {
  (globalThis as unknown as Registry)[SDK] = sdk;
}

export interface TelemetryShutdownError {
  readonly kind: 'telemetry_flush_failed';
  readonly message: string;
}

/**
 * Flushes and stops the SDK, if one was started: call it last on shutdown, so the final spans
 * and metrics leave the process. A collector that can't be reached is an Err, not a crash.
 */
export async function shutdownTelemetry(): Promise<Result<void, TelemetryShutdownError>> {
  const sdk = (globalThis as unknown as Registry)[SDK];
  if (!sdk) return ok(undefined);
  return attempt(
    async () => {
      await sdk.shutdown();
    },
    (cause) => ({
      kind: 'telemetry_flush_failed',
      message: cause instanceof Error ? cause.message : JSON.stringify(cause),
    }),
  );
}
