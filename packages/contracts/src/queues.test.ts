import { describe, expect, it } from '@jest/globals';
import { clusterJobSchema, ingestJobSchema, triageJobSchema } from './queues.js';

const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const alertId = '019a1f2e-0000-7000-8000-000000000001';

describe('trace context in job data', () => {
  it('keeps a carrier, so processing joins the trace that added the job', () => {
    expect(clusterJobSchema.parse({ alertId, trace: { traceparent } })).toEqual({
      alertId,
      trace: { traceparent },
    });
    expect(
      triageJobSchema.parse({
        incidentId: alertId,
        trigger: 'new_incident',
        trace: { traceparent, tracestate: 'tw=1' },
      }).trace,
    ).toEqual({ traceparent, tracestate: 'tw=1' });
  });

  it('needs none, and drops a malformed one rather than rejecting the job', () => {
    expect(clusterJobSchema.parse({ alertId })).toEqual({ alertId });
    expect(clusterJobSchema.parse({ alertId, trace: { traceparent: 42 } })).toEqual({
      alertId,
      trace: undefined,
    });
    expect(
      ingestJobSchema.safeParse({
        ingestId: alertId,
        idempotencyKey: 'key-1',
        bodyHash: 'a'.repeat(64),
        source: 'generic',
        receivedAt: '2026-10-13T08:00:00Z',
        payload: {},
        trace: 'not a carrier',
      }).success,
    ).toBe(true);
  });
});
