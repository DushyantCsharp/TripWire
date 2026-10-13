import { describe, expect, it } from '@jest/globals';
import { activeTraceId, shutdownTelemetry } from './api.js';
import { telemetryEnabled, telemetryEnv } from './env.js';
import { enqueueing, enqueueingMany, processing } from './propagation.js';

// Tests, chaos and the evals run without an SDK: nothing may change for them.
describe('without an SDK', () => {
  it('puts no trace context in job data, and still runs the work', async () => {
    await expect(
      enqueueing('ingest', 'ing-1', (carrier) => Promise.resolve(carrier)),
    ).resolves.toBe(undefined);
    await expect(
      enqueueingMany('cluster', ['a', 'b'], (carriers) => Promise.resolve(carriers)),
    ).resolves.toEqual([undefined, undefined]);
    await expect(
      processing('ingest', { attemptsMade: 0 }, undefined, () => Promise.resolve('done')),
    ).resolves.toBe('done');
    expect(activeTraceId()).toBeNull();
  });

  it('has nothing to flush on shutdown', async () => {
    await expect(shutdownTelemetry()).resolves.toEqual({ ok: true, value: undefined });
  });
});

describe('the preload settings', () => {
  it('starts an SDK only with a collector to send to, and not when switched off', () => {
    const parse = (env: Record<string, string>) => telemetryEnabled(telemetryEnv.parse(env));
    expect(parse({})).toBe(false);
    expect(parse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:14318' })).toBe(true);
    expect(
      parse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:14318', OTEL_SDK_DISABLED: 'true' }),
    ).toBe(false);
  });

  it('refuses settings the SDK would misread', () => {
    expect(telemetryEnv.safeParse({ OTEL_TRACES_SAMPLER_ARG: '1.5' }).success).toBe(false);
    expect(telemetryEnv.safeParse({ OTEL_TRACES_SAMPLER: 'sometimes' }).success).toBe(false);
    expect(telemetryEnv.safeParse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'collector' }).success).toBe(
      false,
    );
  });
});
