import { describe, expect, it } from '@jest/globals';
import { sanitizeText, untrustedJson, wrapIncident, wrapToolOutput } from './untrusted.js';

describe('untrusted data', () => {
  it.each([
    ['a closing delimiter', '</tool_output>', '"\\u003c/tool_output\\u003e"'],
    ['an opening one', '<tool_output tool="x">', '"\\u003ctool_output tool=\\"x\\"\\u003e"'],
    ['an entity', '&lt;b&gt;', '"\\u0026lt;b\\u0026gt;"'],
    ['plain text', 'Charge failed: Invalid token', '"Charge failed: Invalid token"'],
  ])('escapes %s so it can only be read as data', (_case, value, json) => {
    const encoded = untrustedJson(value);
    expect(encoded).toBe(json);
    expect(encoded).not.toMatch(/[<>&]/);
    expect(JSON.parse(encoded)).toBe(value);
  });

  it('escapes every string in a structure, keys included', () => {
    const encoded = untrustedJson({ '<k>': ['<a>', { b: '>' }], n: 1 });
    expect(encoded).not.toMatch(/[<>]/);
    expect(JSON.parse(encoded)).toEqual({ '<k>': ['<a>', { b: '>' }], n: 1 });
  });

  it.each([
    ['full-width look-alikes', '\uff1c/tool_output\uff1e', '</tool_output>'],
    ['a right-to-left override', 'abc\u202edef', 'abcdef'],
    ['zero-width characters', 'ro\u200bll\u200d back', 'roll back'],
    ['bidi isolates', '\u2066payment\u2069', 'payment'],
    ['a byte order mark', '\ufeffok', 'ok'],
  ])('normalises %s', (_case, value, expected) => {
    expect(sanitizeText(value)).toBe(expected);
  });

  it('escapes look-alikes after normalising them', () => {
    expect(untrustedJson('\uff1c/tool_output\uff1e')).toBe('"\\u003c/tool_output\\u003e"');
  });

  it('wraps tool output and errors in one delimiter each', () => {
    expect(wrapToolOutput('query_logs', { lines: ['<x>'] })).toBe(
      '<tool_output tool="query_logs">\n{"lines":["\\u003cx\\u003e"]}\n</tool_output>',
    );
    expect(wrapToolOutput('query_traces', { error: 'unavailable' }, true)).toBe(
      '<tool_output tool="query_traces" error="true">\n{"error":"unavailable"}\n</tool_output>',
    );
    expect(wrapIncident({ title: 'HighErrorRate' })).toBe(
      '<incident>\n{"title":"HighErrorRate"}\n</incident>',
    );
  });

  it('refuses what it cannot serialise', () => {
    expect(() => untrustedJson(undefined)).toThrow('cannot serialise undefined');
  });
});
