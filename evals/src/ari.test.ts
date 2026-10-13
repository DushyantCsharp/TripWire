import { describe, expect, it } from '@jest/globals';
import { adjustedRandIndex } from './ari.js';

const items = (assignments: [string, string][]) =>
  assignments.map(([truth, cluster]) => ({ truth, cluster }));

describe('adjustedRandIndex', () => {
  it('is 1 when the clusters are the problems, whatever they are called', () => {
    expect(
      adjustedRandIndex(
        items([
          ['payment', 'inc-1'],
          ['payment', 'inc-1'],
          ['cart', 'inc-2'],
          ['cart', 'inc-2'],
        ]),
      ),
    ).toBe(1);
  });

  it('scores each problem split in two at 4/11 here (about 0.64 with many alerts)', () => {
    const split = items([
      ['a', '1'],
      ['a', '1'],
      ['a', '2'],
      ['a', '2'],
      ['b', '3'],
      ['b', '3'],
      ['b', '4'],
      ['b', '4'],
    ]);
    expect(adjustedRandIndex(split)).toBeCloseTo(4 / 11, 10);
  });

  it('scores everything merged into one incident at 0', () => {
    expect(
      adjustedRandIndex(
        items([
          ['a', 'x'],
          ['a', 'x'],
          ['b', 'x'],
          ['b', 'x'],
        ]),
      ),
    ).toBe(0);
  });

  it('has nothing to say about fewer than two alerts', () => {
    expect(adjustedRandIndex(items([['a', 'x']]))).toBeNull();
  });
});
