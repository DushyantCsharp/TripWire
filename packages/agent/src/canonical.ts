import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted, so equal values serialise identically whatever order their keys were
 * written in, or came back from Postgres jsonb in. Hashes of proposal payloads and recorded model
 * requests are taken over this.
 */
export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, nested: unknown) =>
    isPlainObject(nested)
      ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : nested,
  ) as string | undefined;
  if (json === undefined) throw new Error(`cannot serialise ${typeof value} as JSON`);
  return json;
}

/** Hex SHA-256 of a value's canonical JSON. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
