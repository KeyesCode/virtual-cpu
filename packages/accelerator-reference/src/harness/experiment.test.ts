import { describe, expect, it } from 'vitest';
import { paretoOptimal, unsupportedReason } from './experiment.js';

describe('paretoOptimal', () => {
  it('keeps exactly the non-dominated points of a hand-made set', () => {
    // fast and big, balanced, and small and slow are each best somewhere; worse loses to
    // balanced on both axes.
    const points = [
      { name: 'fast', cycles: 100, cells: 900 },
      { name: 'balanced', cycles: 300, cells: 400 },
      { name: 'worse', cycles: 350, cells: 450 },
      { name: 'small', cycles: 800, cells: 150 },
    ];
    expect(paretoOptimal(points)).toEqual(['fast', 'balanced', 'small']);
  });

  it('drops a point that only ties on one axis, keeps identical points', () => {
    expect(
      paretoOptimal([
        { name: 'a', cycles: 100, cells: 200 },
        { name: 'b', cycles: 100, cells: 250 },
        { name: 'c', cycles: 100, cells: 200 },
      ]),
    ).toEqual(['a', 'c']);
  });
});

describe('unsupportedReason', () => {
  it('accepts a workload within MAX_DIM and names every dimension above it', () => {
    expect(unsupportedReason({ m: 32, n: 32, k: 32 }, 32)).toBeNull();
    expect(unsupportedReason({ m: 64, n: 8, k: 64 }, 32)).toBe(
      'not supported by this variant: M, K above MAX_DIM 32',
    );
  });
});
