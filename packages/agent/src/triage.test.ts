import { describe, expect, it } from '@jest/globals';
import { baselineTriager } from './baseline.js';
import {
  errorFromHttpStatus,
  isRetryable,
  type TriageAlert,
  type TriageError,
  type TriageInput,
} from './triage.js';

const budget = {
  maxInputTokens: 40_000,
  maxOutputTokens: 4_000,
  maxToolCalls: 8,
  maxWallClockMs: 60_000,
};
const runKey = 'triage-1';

function alert(service: string | null, name: string): TriageAlert {
  return {
    name,
    service,
    severity: 'critical',
    status: 'firing',
    summary: null,
    labels: {},
    startsAt: new Date('2026-10-01T00:00:00Z'),
    receivedAt: new Date('2026-10-01T00:00:00Z'),
  };
}

const input: TriageInput = {
  incidentId: '01928c4e-7b2a-7c3d-9e4f-5a6b7c8d9e0f',
  title: 'HighErrorRate on checkout',
  service: 'checkout',
  severity: 'critical',
  firstSeen: new Date('2026-10-01T00:00:00Z'),
  lastSeen: new Date('2026-10-01T00:05:00Z'),
  alertCount: 6,
  alerts: [
    alert('payment', 'GrpcServerErrors'),
    alert('checkout', 'HighErrorRate'),
    alert('payment', 'GrpcServerErrors'),
    alert('payment', 'HighLatencyP99'),
    alert('checkout', 'HighErrorRate'),
    alert(null, 'TargetDown'),
  ],
  earliestAlerts: [],
  alertGroups: [],
};

describe('error classification', () => {
  // 429 and 5xx (and 408) are worth another attempt; every other 4xx is our request's fault.
  it.each([
    [429, 'rate_limited', true],
    [408, 'timeout', true],
    [500, 'upstream_unavailable', true],
    [502, 'upstream_unavailable', true],
    [503, 'upstream_unavailable', true],
    [504, 'upstream_unavailable', true],
    [529, 'upstream_unavailable', true],
    [400, 'request_rejected', false],
    [401, 'request_rejected', false],
    [403, 'request_rejected', false],
    [404, 'request_rejected', false],
    [413, 'request_rejected', false],
    [422, 'request_rejected', false],
  ] as const)('HTTP %i is %s (retryable: %s)', (status, kind, retryable) => {
    const error = errorFromHttpStatus(status, 'upstream said no');
    expect(error.kind).toBe(kind);
    expect(isRetryable(error)).toBe(retryable);
  });

  it('carries a 429 Retry-After and a 5xx status', () => {
    expect(errorFromHttpStatus(429, 'slow down', 12_000)).toEqual({
      kind: 'rate_limited',
      message: 'slow down',
      retryAfterMs: 12_000,
    });
    expect(errorFromHttpStatus(503, 'down')).toMatchObject({ status: 503 });
  });

  it.each<[TriageError, boolean]>([
    [{ kind: 'rate_limited', message: '429' }, true],
    [{ kind: 'upstream_unavailable', message: '503' }, true],
    [{ kind: 'timeout', message: 'slow' }, true],
    [{ kind: 'request_rejected', message: '400', status: 400 }, false],
  ])('%o is retryable: %p', (error, retryable) => {
    expect(isRetryable(error)).toBe(retryable);
  });
});

describe('baseline triager', () => {
  it('ranks the services the alerts name most often', async () => {
    const result = await baselineTriager().triage(input, { budget, runKey });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.hypotheses.map((h) => [h.rank, h.title, h.suspect])).toEqual([
      [1, 'payment: GrpcServerErrors', 'payment'],
      [2, 'checkout: HighErrorRate', 'checkout'],
      [3, 'unknown: TargetDown', null],
    ]);
    expect(result.value.confidence).toBeLessThanOrEqual(0.3);
  });

  it('counts every alert of the incident when it has the groups', async () => {
    const grouped: TriageInput = {
      ...input,
      alertGroups: [
        {
          name: 'HighErrorRate',
          service: 'checkout',
          count: 40,
          firstStartsAt: new Date(0),
          lastReceivedAt: new Date(0),
        },
        {
          name: 'GrpcServerErrors',
          service: 'payment',
          count: 3,
          firstStartsAt: new Date(0),
          lastReceivedAt: new Date(0),
        },
      ],
    };
    const result = await baselineTriager().triage(grouped, { budget, runKey });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toMatchObject({ basis: 'alert_labels', stopReason: 'report_submitted' });
    expect(result.value.hypotheses.map((h) => [h.suspect, h.confidence])).toEqual([
      ['checkout', 0.279],
      ['payment', 0.021],
    ]);
  });

  it('is deterministic', async () => {
    const triager = baselineTriager();
    expect(await triager.triage(input, { budget, runKey })).toEqual(
      await triager.triage(input, { budget, runKey }),
    );
  });

  it('returns a retryable timeout when cancelled mid-run', async () => {
    const controller = new AbortController();
    const running = baselineTriager({ latencyMs: 5_000 }).triage(input, {
      budget,
      runKey,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;
    expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(!result.ok && isRetryable(result.error)).toBe(true);
  });
});
