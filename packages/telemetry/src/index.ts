// OpenTelemetry for Tripwire's code: tracer and meter handles, trace context through BullMQ, and
// the SDK's shutdown. Everything here uses only the OpenTelemetry API, so it is a no-op until
// `@tripwire/telemetry/register` (the apps' --import preload) starts an SDK.
export {
  activeTraceId,
  meter,
  registerSdk,
  shutdownTelemetry,
  type TelemetryShutdownError,
  tracer,
} from './api.js';
export { type TelemetryEnv, telemetryEnabled, telemetryEnv } from './env.js';
export {
  carrierOf,
  carrierSchema,
  enqueueing,
  enqueueingMany,
  linksFrom,
  type ProcessedJob,
  processing,
  type TraceCarrier,
} from './propagation.js';
