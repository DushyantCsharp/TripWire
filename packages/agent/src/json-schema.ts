import { z } from 'zod';

// Strict tool use and structured outputs accept a subset of JSON Schema: no numeric or string
// bounds, no maxItems, minItems only 0 or 1, no oneOf, and every object closed. The API rejects
// anything else with a 400, so the schemas we send are reduced to that subset, with each dropped
// bound restated in the description for the model. zod still enforces the full schema on whatever
// comes back.

const BOUNDS: Readonly<Record<string, (value: unknown) => string>> = {
  minimum: (v) => `at least ${String(v)}`,
  exclusiveMinimum: (v) => `more than ${String(v)}`,
  maximum: (v) => `at most ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  multipleOf: (v) => `a multiple of ${String(v)}`,
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  maxItems: (v) => `at most ${String(v)} items`,
  minItems: (v) => `at least ${String(v)} items`,
};

const NAMED_SCHEMAS = new Set(['properties', '$defs', 'definitions']);

/** The JSON Schema for a zod schema's input, reduced to what strict mode accepts. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return reduce(rest);
}

function reduce(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const bound = BOUNDS[key];
    if (bound && !(key === 'minItems' && typeof value === 'number' && value <= 1)) {
      notes.push(bound(value));
      continue;
    }
    if (key === 'pattern' || key === 'format') continue;
    // Keys of these maps are property names, not keywords: a property may be called `maximum`.
    if (NAMED_SCHEMAS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, reduceValue(schema)]),
      );
      continue;
    }
    out[key === 'oneOf' ? 'anyOf' : key] = reduceValue(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  if (notes.length > 0) {
    const note = `(${notes.join(', ')})`;
    out.description = typeof out.description === 'string' ? `${out.description} ${note}` : note;
  }
  return out;
}

function reduceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reduceValue);
  if (isRecord(value)) return reduce(value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
