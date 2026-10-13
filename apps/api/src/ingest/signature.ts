// X-Tripwire-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<Idempotency-Key>.<raw body>">.
// Signing the key binds it to the body, so a captured request can't be replayed under a new key.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { err, ok, type Result } from '@tripwire/result';

export type SignatureFailure = 'missing' | 'malformed' | 'expired' | 'mismatch';

/** How far the signed timestamp may be from the server's clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const FORMAT = /^t=(\d{1,12})((?:,v1=[0-9a-f]{64}){1,4})$/;

export function sign(
  secret: string,
  timestamp: number,
  idempotencyKey: string,
  body: Buffer | string,
): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${idempotencyKey}.`)
    .update(body)
    .digest('hex');
}

/** A complete header value, for senders and tests. */
export function signatureHeader(
  secret: string,
  timestamp: number,
  idempotencyKey: string,
  body: Buffer | string,
) {
  return `t=${String(timestamp)},v1=${sign(secret, timestamp, idempotencyKey, body)}`;
}

export interface SignedRequest {
  readonly header: string | readonly string[] | undefined;
  readonly idempotencyKey: string;
  readonly body: Buffer;
  /** Every secret currently accepted: during a rotation, the new one and the old one. */
  readonly secrets: readonly string[];
  readonly now: Date;
}

export function verifySignature(request: SignedRequest): Result<void, SignatureFailure> {
  if (request.header === undefined) return err('missing');
  if (typeof request.header !== 'string') return err('malformed');
  const match = FORMAT.exec(request.header);
  const [, timestamp, signatures] = match ?? [];
  if (timestamp === undefined || signatures === undefined) return err('malformed');
  if (Math.abs(request.now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) {
    return err('expired');
  }
  const presented = signatures
    .split(',v1=')
    .filter(Boolean)
    .map((hex) => Buffer.from(hex, 'hex'));
  for (const secret of request.secrets) {
    const expected = Buffer.from(
      sign(secret, Number(timestamp), request.idempotencyKey, request.body),
      'hex',
    );
    if (presented.some((candidate) => timingSafeEqual(candidate, expected))) return ok(undefined);
  }
  return err('mismatch');
}
