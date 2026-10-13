import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { strictJsonSchema } from './json-schema.js';
import { REPORT_OUTPUT_SCHEMA } from './report.js';
import { modelTools, READ_TOOL_NAMES } from './tools/definitions.js';

// Strict tool use and structured outputs reject numeric and string bounds, maxItems, minItems above
// 1 and oneOf with a 400. Every schema we send must be inside that subset.
const UNSUPPORTED = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'oneOf',
  'pattern',
  'format',
  '$schema',
]);

/** Every keyword in a schema (skipping property names), with where it is. */
function keywords(node: unknown, path = '$'): [string, string, unknown][] {
  if (Array.isArray(node))
    return node.flatMap((item, i) => keywords(item, `${path}[${String(i)}]`));
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]): [string, string, unknown][] => {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      return Object.entries(value as Record<string, unknown>).flatMap(([name, schema]) =>
        keywords(schema, `${path}.${name}`),
      );
    }
    return [[key, path, value], ...keywords(value, `${path}.${key}`)];
  });
}

describe('strictJsonSchema', () => {
  it('drops what strict mode rejects and says it in the description instead', () => {
    const schema = strictJsonSchema(
      z.strictObject({
        replicas: z.number().int().min(1).max(10).describe('Replica count.'),
        ids: z.array(z.string().max(30)).min(1).max(5),
        names: z.array(z.string()).min(2),
        kind: z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('a') }),
          z.strictObject({ type: z.literal('b'), n: z.number() }),
        ]),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        replicas: { type: 'integer', description: 'Replica count. (at least 1, at most 10)' },
        ids: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', description: '(at most 30 characters)' },
          description: '(at most 5 items)',
        },
        names: { type: 'array', items: { type: 'string' }, description: '(at least 2 items)' },
        kind: {
          anyOf: [
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'a' } },
              required: ['type'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { type: { type: 'string', const: 'b' }, n: { type: 'number' } },
              required: ['type', 'n'],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['replicas', 'ids', 'names', 'kind'],
      additionalProperties: false,
    });
  });

  it('keeps properties whose names are keywords', () => {
    const schema = strictJsonSchema(z.strictObject({ maximum: z.number(), format: z.string() }));
    expect(Object.keys(schema.properties as object)).toEqual(['maximum', 'format']);
  });

  it.each([
    ['the report', REPORT_OUTPUT_SCHEMA],
    ...modelTools(READ_TOOL_NAMES).map((tool): [string, Record<string, unknown>] => [
      tool.name,
      { ...tool.inputSchema },
    ]),
  ])('makes %s a schema strict mode accepts', (_name, schema) => {
    for (const [key, path, value] of keywords(schema)) {
      expect([path, key, UNSUPPORTED.has(key)]).toEqual([path, key, false]);
      if (key === 'minItems') expect([path, value]).toEqual([path, expect.any(Number)]);
      if (key === 'minItems') expect(value as number).toBeLessThanOrEqual(1);
      if (key === 'type' && value === 'object') {
        expect([
          path,
          keywords(schema).some(([k, p]) => k === 'additionalProperties' && p === path),
        ]).toEqual([path, true]);
      }
    }
  });
});
