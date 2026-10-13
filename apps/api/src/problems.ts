// RFC 9457 problem details, matching the response schemas in packages/contracts/schema/openapi.yaml.
import { activeTraceId } from '@tripwire/telemetry';
import type { FastifyReply } from 'fastify';

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly [extension: string]: unknown;
}

export interface FieldError {
  /** JSON Pointer into the body, or #/header/<name>. */
  readonly pointer: string;
  readonly detail: string;
}

export const problems = {
  validation: (errors: readonly FieldError[]): Problem => ({
    type: '/problems/validation-failed',
    title: 'The request is invalid',
    status: 400,
    errors,
  }),
  invalidSignature: (reason: 'missing' | 'malformed' | 'expired' | 'mismatch'): Problem => ({
    type: '/problems/invalid-signature',
    title: 'The webhook signature is invalid',
    status: 401,
    reason,
  }),
  idempotencyConflict: (key: string, firstIngestId: string, firstReceivedAt: string): Problem => ({
    type: '/problems/idempotency-key-reused',
    title: 'Idempotency key reused with a different body',
    status: 409,
    detail: `Key '${key}' was first used at ${firstReceivedAt} with a different body.`,
    idempotency_key: key,
    first_ingest_id: firstIngestId,
    first_received_at: firstReceivedAt,
  }),
  payloadTooLarge: (): Problem => ({
    type: '/problems/payload-too-large',
    title: 'The body exceeds 1 MiB',
    status: 413,
  }),
  unsupportedMediaType: (): Problem => ({
    type: '/problems/unsupported-media-type',
    title: 'The body must be application/json',
    status: 415,
  }),
  overloaded: (detail: string): Problem => ({
    type: '/problems/overloaded',
    title: 'Ingest is shedding load',
    status: 503,
    detail,
  }),
  unexpected: (): Problem => ({
    type: '/problems/internal',
    title: 'Unexpected error',
    status: 500,
    detail: 'Safe to retry with the same Idempotency-Key.',
  }),
};

export function sendProblem(
  reply: FastifyReply,
  problem: Problem,
  headers: Record<string, string> = {},
) {
  // The trace to look at when asking why, if this request was traced.
  const traceId = activeTraceId();
  return reply
    .code(problem.status)
    .headers(headers)
    .type('application/problem+json')
    .send({ ...problem, instance: reply.request.url, ...(traceId ? { trace_id: traceId } : {}) });
}
