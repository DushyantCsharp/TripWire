import { describe, expect, it } from '@jest/globals';
import { baselineTriager, pricingFor, type Triager } from '@tripwire/agent';
import { PAYMENT_INCIDENT, SCENARIO_BUDGET } from '@tripwire/agent/testing';
import { err } from '@tripwire/result';
import { testMeter } from '@tripwire/telemetry/testing';
import { workerMetrics } from './telemetry.js';
import { measuredTriage } from './triage/processor.js';
import { recordUsage } from './triage/triager.js';

describe('model usage metrics', () => {
  it('counts tokens by type and dollars by model for each model call', async () => {
    const test = testMeter();
    recordUsage(workerMetrics(test.meter), 'claude-opus-5-5', pricingFor('claude-opus-5-5'), {
      inputTokens: 10_000,
      outputTokens: 800,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 0,
    });
    const points = await test.read();
    expect(
      points
        .filter((p) => p.name === 'tokens_total')
        .map((p) => [p.attributes.type, p.value])
        .sort(),
    ).toEqual([
      ['cache_read', 6_000],
      ['input', 10_000],
      ['output', 800],
    ]);
    // 4,000 uncached at $4, 6,000 cache reads at $0.20 and 800 output at $20 per million.
    const cost = points.find((p) => p.name === 'cost_usd_total');
    expect(cost?.attributes).toEqual({ model: 'claude-opus-5-5' });
    expect(cost?.value).toBeCloseTo(0.016 + 0.0012 + 0.016, 6);
  });
});

describe('triage duration', () => {
  it('times each run by model, stop reason and outcome, failed runs included', async () => {
    const test = testMeter();
    const metrics = workerMetrics(test.meter);
    const options = { budget: SCENARIO_BUDGET, runKey: 'run-1' };
    const baseline = baselineTriager();
    await measuredTriage(metrics, baseline, 'incident-1', () =>
      baseline.triage(PAYMENT_INCIDENT, options),
    );
    const failing: Triager = {
      model: 'claude-opus-5-5',
      triage: () => Promise.resolve(err({ kind: 'upstream_unavailable', message: 'API down' })),
    };
    await measuredTriage(metrics, failing, 'incident-2', () =>
      failing.triage(PAYMENT_INCIDENT, options),
    );

    const runs = (await test.read()).filter((p) => p.name === 'triage_duration');
    expect(
      runs.map((p) => [p.attributes, typeof p.value === 'object' ? p.value.count : null]),
    ).toEqual(
      expect.arrayContaining([
        [{ model: 'baseline-v1', stop_reason: 'report_submitted', outcome: 'complete' }, 1],
        [{ model: 'claude-opus-5-5', stop_reason: 'upstream_unavailable', outcome: 'failed' }, 1],
      ]),
    );
  });
});
