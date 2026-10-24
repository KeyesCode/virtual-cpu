import { describe, expect, it } from 'vitest';
import { matmulInt8 } from './matmul.js';
import {
  checkerboardSignMatrix,
  GENERATOR_NAMES,
  generateOperands,
  identityMatrix,
  Prng,
  randomInt8Matrix,
} from './prng.js';

describe('Prng', () => {
  it('is a fixed stream for seed 1 (the same stream as @vcpu/rtl-tools)', () => {
    const prng = new Prng(1);
    expect([prng.next(), prng.next(), prng.next(), prng.next()]).toEqual([
      2243319414, 3892457524, 3774914640, 1708185691,
    ]);
  });

  it('gives a different stream for a neighbouring seed', () => {
    expect(new Prng(2).next()).not.toBe(new Prng(1).next());
  });

  it('rejects a negative or fractional seed', () => {
    expect(() => new Prng(-1)).toThrow(RangeError);
    expect(() => new Prng(1.5)).toThrow(RangeError);
  });
});

describe('randomInt8Matrix', () => {
  it('is a function of the seed alone', () => {
    expect(Array.from(randomInt8Matrix(new Prng(1), 2, 4))).toEqual([
      5, 104, 97, -27, 119, -81, -17, 36,
    ]);
    expect(randomInt8Matrix(new Prng(9), 8, 8)).toEqual(randomInt8Matrix(new Prng(9), 8, 8));
  });

  it('stays inside the requested range and reaches both INT8 extremes', () => {
    const narrow = randomInt8Matrix(new Prng(4), 16, 16, { min: -3, max: 2 });
    expect(Math.min(...narrow)).toBeGreaterThanOrEqual(-3);
    expect(Math.max(...narrow)).toBeLessThanOrEqual(2);
    const full = randomInt8Matrix(new Prng(4), 64, 64);
    expect(Math.min(...full)).toBe(-128);
    expect(Math.max(...full)).toBe(127);
  });

  it('rejects a range outside INT8', () => {
    expect(() => randomInt8Matrix(new Prng(1), 1, 1, { max: 128 })).toThrow(RangeError);
    expect(() => randomInt8Matrix(new Prng(1), 1, 1, { min: 3, max: 2 })).toThrow(RangeError);
  });
});

describe('named generators', () => {
  it('builds the identity and the sign checkerboard', () => {
    expect(Array.from(identityMatrix(3))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(Array.from(checkerboardSignMatrix(2, 3))).toEqual([127, -128, 127, -128, 127, -128]);
  });

  it('gives each generator its documented C', () => {
    const dims = { m: 3, n: 4, k: 4 };
    const product = (name: (typeof GENERATOR_NAMES)[number]): number[] => {
      const { a, b } = generateOperands(name, 5, dims);
      return Array.from(matmulInt8(a, b, dims));
    };
    expect(product('zero')).toEqual(new Array<number>(12).fill(0));
    expect(product('identity')).toEqual(Array.from(generateOperands('identity', 5, dims).a));
    expect(product('max')).toEqual(new Array<number>(12).fill(4 * 127 * 127));
    expect(product('min')).toEqual(new Array<number>(12).fill(4 * 16384));
    // Row i of A and column j of B are both checkerboards, so each term is 127², −128² or −127·128.
    expect(product('mixed')[0]).toBe(2 * 127 * 127 + 2 * 128 * 128);
    expect(product('mixed')[1]).toBe(-4 * 127 * 128);
    expect(generateOperands('random', 5, dims)).toEqual(generateOperands('random', 5, dims));
  });

  it('refuses the identity generator unless K = N', () => {
    expect(() => generateOperands('identity', 1, { m: 2, n: 3, k: 4 })).toThrow('needs K = N');
  });
});
