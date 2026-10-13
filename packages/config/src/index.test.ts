import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { baseEnv, parseEnv } from './index.js';

describe('parseEnv', () => {
  it('applies defaults', () => {
    expect(parseEnv(baseEnv, {})).toEqual({
      ok: true,
      value: { NODE_ENV: 'development', LOG_LEVEL: 'info' },
    });
  });

  it('reports every invalid variable as an Err instead of throwing', () => {
    const schema = baseEnv.extend({ DATABASE_URL: z.url() });
    const result = parseEnv(schema, { NODE_ENV: 'staging', DATABASE_URL: 'not a url' });

    if (result.ok) throw new Error('expected an invalid env');
    expect(result.error.kind).toBe('invalid_env');
    expect(result.error.issues).toEqual([
      expect.stringMatching(/^NODE_ENV: /),
      expect.stringMatching(/^DATABASE_URL: /),
    ]);
  });
});
