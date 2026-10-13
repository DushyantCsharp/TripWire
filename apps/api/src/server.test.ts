import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { toPublicId } from '@tripwire/contracts/ids';
import type { DeadLetter } from './dead-letters.js';
import { buildServer } from './server.js';
import {
  memoryDeadLetters,
  memoryIdempotency,
  memoryQueue,
  switchableAdmission,
} from './testing/fakes.js';

const incidentId = '0199d3a1-2b3c-7d4e-8f50-6a7b8c9d0e1f';
const attempts = [1, 2, 3, 4, 5].map((attempt) => ({
  attempt,
  errorClass: 'RetryableError',
  message: 'model unavailable (529)',
  at: `2026-10-11T12:0${String(attempt)}:00.000Z`,
}));
const deadLetter: DeadLetter = {
  id: `dlq-triage-${incidentId}`,
  jobId: `triage-${incidentId}`,
  job: { incidentId, trigger: 'new_incident', attempts },
  errorClass: 'RetryableError',
  failedReason: 'model unavailable (529)',
  lastStack: 'RetryableError: model unavailable (529)\n    at triage',
  attempts,
  failedAt: '2026-10-11T12:05:00.000Z',
};

describe('api server', () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const deadLetters = memoryDeadLetters([deadLetter]);

  beforeAll(async () => {
    app = await buildServer({
      ingest: {
        idempotency: memoryIdempotency(),
        queue: memoryQueue(),
        admission: switchableAdmission(),
        secrets: ['webhook-secret-for-tests'],
      },
      deadLetters,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const graphql = async (query: string, variables?: Record<string, unknown>) => {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      payload: { query, variables },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ data?: Record<string, unknown>; errors?: { extensions?: unknown }[] }>();
  };

  it('serves the health check under /v1', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('mounts GraphQL at /graphql', async () => {
    expect(await graphql('{ ping }')).toEqual({ data: { ping: 'pong' } });
  });

  describe('dead-lettered triage jobs', () => {
    const list = `{ deadLetteredTriageJobs { id incidentId errorClass failedReason lastStack failedAt
      attempts { attempt errorClass message at } } }`;
    const redrive = `mutation ($id: ID!) { redriveTriageJob(input: { id: $id }) {
      __typename
      ... on TriageJobRedriven { jobId incidentId }
      ... on RedriveError { code message } } }`;

    it('lists them with their error class, attempt history and last stack', async () => {
      expect(await graphql(list)).toEqual({
        data: {
          deadLetteredTriageJobs: [
            {
              id: deadLetter.id,
              incidentId: toPublicId('inc', incidentId),
              errorClass: 'RetryableError',
              failedReason: 'model unavailable (529)',
              lastStack: deadLetter.lastStack,
              failedAt: deadLetter.failedAt,
              attempts,
            },
          ],
        },
      });
    });

    it('redrives one on request, once', async () => {
      expect(await graphql(redrive, { id: deadLetter.id })).toEqual({
        data: {
          redriveTriageJob: {
            __typename: 'TriageJobRedriven',
            jobId: `redrive-${deadLetter.id}`,
            incidentId: toPublicId('inc', incidentId),
          },
        },
      });
      expect(await graphql(redrive, { id: deadLetter.id })).toMatchObject({
        data: { redriveTriageJob: { __typename: 'RedriveError', code: 'DEAD_LETTER_NOT_FOUND' } },
      });
      expect(await graphql(list)).toEqual({ data: { deadLetteredTriageJobs: [] } });
    });

    it('reports an unavailable queue as a GraphQL error', async () => {
      deadLetters.down = true;
      try {
        const result = await graphql(list);
        expect(result.errors?.[0]?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      } finally {
        deadLetters.down = false;
      }
    });
  });
});
