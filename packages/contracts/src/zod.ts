export * from './generated/zod/zod.gen.js';

/**
 * Node lower-cases incoming header names, but the generated header schemas keep the spec's casing
 * (`Idempotency-Key`). Picks each schema key out of `headers` case-insensitively, ready to parse:
 * `zIngestGenericWebhookHeaders.safeParse(selectHeaders(zIngestGenericWebhookHeaders, req.headers))`.
 */
export function selectHeaders(
  schema: { readonly shape: Readonly<Record<string, unknown>> },
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(
    Object.keys(schema.shape).map((name) => [name, headers[name.toLowerCase()]]),
  );
}
