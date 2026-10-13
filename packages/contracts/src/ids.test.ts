import { describe, expect, it } from '@jest/globals';
import { fromPublicId, toPublicId } from './ids.js';

const uuid = '01928c4e-7b2a-7c3d-9e4f-5a6b7c8d9e0f';

describe('public ids', () => {
  it('round-trip, in the shape the OpenAPI contract requires', () => {
    const id = toPublicId('inc', uuid);
    expect(id).toMatch(/^inc_[0-9a-z]{26}$/);
    expect(fromPublicId('inc', id)).toBe(uuid);
  });

  it('round-trip the smallest and largest UUIDs', () => {
    for (const edge of [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]) {
      expect(fromPublicId('ing', toPublicId('ing', edge))).toBe(edge);
    }
  });

  it('reject an id of another type', () => {
    expect(fromPublicId('alr', toPublicId('inc', uuid))).toBeUndefined();
  });

  it.each([
    'inc_',
    `inc_${'A'.repeat(26)}`,
    `inc_${'u'.repeat(26)}`,
    // 26 base32 characters can encode 130 bits; anything above 128 isn't a UUID.
    `inc_${'z'.repeat(26)}`,
  ])('reject %s', (id) => {
    expect(fromPublicId('inc', id)).toBeUndefined();
  });
});
