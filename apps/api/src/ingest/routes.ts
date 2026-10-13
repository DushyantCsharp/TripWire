import { createHash } from 'node:crypto';
import { toPublicId } from '@tripwire/contracts/ids';
import type { IngestJob } from '@tripwire/contracts/queues';
import {
  zIdempotencyKey,
  zIngestAlertmanagerWebhookBody,
  zIngestGenericWebhookBody,
} from '@tripwire/contracts/zod';
import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { problems, sendProblem, type FieldError } from '../problems.js';
import type { IngestDeps } from './ports.js';
import { verifySignature } from './signature.js';

const BODY_LIMIT = 1024 * 1024;
/** The OpenAPI LabelSet's maxProperties, which the generated validators drop. */
const MAX_LABELS = 64;
/** When Redis itself is unavailable, the sender should come back soon. */
const DEPENDENCY_RETRY_AFTER_SECONDS = '5';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

interface LabelledAlert {
  readonly labels?: Readonly<Record<string, string>>;
  readonly annotations?: Readonly<Record<string, string>>;
}

/**
 * POST /alertmanager and /generic. Ingest only verifies and enqueues, cheapest check first:
 * load shedding (503), size and media type (413, 415), signature (401), body (400),
 * idempotency (202 replay or 409), enqueue (202).
 */
export function webhookRoutes(deps: IngestDeps): FastifyPluginCallback {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => uuidv7());

  return (app, _options, done) => {
    // Before the body is even read: shedding must cost as little as possible.
    app.addHook('onRequest', (_request, reply, next) => {
      const shed = deps.admission.check();
      if (!shed) {
        next();
        return;
      }
      void sendProblem(
        reply,
        problems.overloaded(
          'The ingest queue is above its high-water mark. Retry after the Retry-After delay.',
        ),
        { 'retry-after': String(shed.retryAfterSeconds) },
      );
    });

    // The signature covers the exact bytes received, so keep them alongside the parsed body.
    app.removeAllContentTypeParsers();
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
      (request, body, parsed) => {
        const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
        request.rawBody = raw;
        try {
          parsed(null, JSON.parse(raw.toString('utf8')) as unknown);
        } catch {
          parsed(
            Object.assign(new Error('The body is not valid JSON'), {
              statusCode: 400,
              code: 'TRIPWIRE_INVALID_JSON',
            }),
          );
        }
      },
    );

    app.setErrorHandler((error: FastifyError, request, reply) => {
      switch (error.code) {
        case 'FST_ERR_CTP_BODY_TOO_LARGE':
          return sendProblem(reply, problems.payloadTooLarge());
        case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
          return sendProblem(reply, problems.unsupportedMediaType());
        case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        case 'TRIPWIRE_INVALID_JSON':
          return sendProblem(reply, problems.validation([{ pointer: '#', detail: error.message }]));
        default:
          request.log.error({ err: error }, 'webhook failed');
          return sendProblem(reply, problems.unexpected());
      }
    });

    app.post('/alertmanager', (request, reply) =>
      accept('alertmanager', zIngestAlertmanagerWebhookBody, request, reply),
    );
    app.post('/generic', (request, reply) =>
      accept('generic', zIngestGenericWebhookBody, request, reply),
    );
    done();
  };

  async function accept(
    source: IngestJob['source'],
    schema: z.ZodType<{ alerts: readonly LabelledAlert[] }>,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    const key = zIdempotencyKey.safeParse(request.headers['idempotency-key']);
    const signature = request.headers['x-tripwire-signature'];
    if (signature === undefined) return sendProblem(reply, problems.invalidSignature('missing'));
    if (!key.success) {
      return sendProblem(
        reply,
        problems.validation([
          {
            pointer: '#/header/Idempotency-Key',
            detail: 'required: 1-255 printable ASCII characters, no spaces',
          },
        ]),
      );
    }

    const verified = verifySignature({
      header: signature,
      idempotencyKey: key.data,
      body: rawBody,
      secrets: deps.secrets,
      now: now(),
    });
    if (!verified.ok) return sendProblem(reply, problems.invalidSignature(verified.error));

    const body = schema.safeParse(request.body);
    if (!body.success) {
      return sendProblem(
        reply,
        problems.validation(
          body.error.issues.map((issue) => ({
            pointer: `#/${issue.path.map(String).join('/')}`,
            detail: issue.message,
          })),
        ),
      );
    }
    const tooManyLabels = labelLimitErrors(body.data.alerts);
    if (tooManyLabels.length > 0) return sendProblem(reply, problems.validation(tooManyLabels));

    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    const record = { ingestId: newId(), bodyHash, receivedAt: now().toISOString() };
    const claim = await deps.idempotency.claim(key.data, record);
    if (!claim.ok) {
      request.log.error({ err: claim.error }, 'idempotency store unavailable');
      return sendProblem(reply, problems.overloaded('The idempotency store is unavailable.'), {
        'retry-after': DEPENDENCY_RETRY_AFTER_SECONDS,
      });
    }

    let accepted = record;
    if (!claim.value.claimed) {
      const { existing } = claim.value;
      if (existing.bodyHash !== bodyHash) {
        return sendProblem(
          reply,
          problems.idempotencyConflict(
            key.data,
            toPublicId('ing', existing.ingestId),
            existing.receivedAt,
          ),
        );
      }
      // A retry of a delivery we accepted. Enqueue again anyway: if the first job never landed this
      // recovers it, and if it did, BullMQ (same job id) or Postgres (same key) makes it a no-op.
      accepted = existing;
    }

    const enqueued = await deps.queue.enqueue({
      ingestId: accepted.ingestId,
      idempotencyKey: key.data,
      bodyHash,
      source,
      receivedAt: accepted.receivedAt,
      payload: body.data,
    });
    if (!enqueued.ok) {
      request.log.error({ err: enqueued.error }, 'ingest queue unavailable');
      // Best effort: if the release fails too, the retry's re-enqueue (above) still recovers it.
      if (claim.value.claimed) await deps.idempotency.release(key.data);
      return sendProblem(reply, problems.overloaded('The ingest queue is unavailable.'), {
        'retry-after': DEPENDENCY_RETRY_AFTER_SECONDS,
      });
    }

    return reply
      .code(202)
      .headers(claim.value.claimed ? {} : { 'idempotent-replayed': 'true' })
      .send({
        ingest_id: toPublicId('ing', accepted.ingestId),
        received_at: accepted.receivedAt,
        alert_count: body.data.alerts.length,
      });
  }
}

function labelLimitErrors(alerts: readonly LabelledAlert[]): FieldError[] {
  return alerts.flatMap((alert, i) =>
    (['labels', 'annotations'] as const)
      .filter((field) => Object.keys(alert[field] ?? {}).length > MAX_LABELS)
      .map((field) => ({
        pointer: `#/alerts/${String(i)}/${field}`,
        detail: `at most ${String(MAX_LABELS)} entries`,
      })),
  );
}
