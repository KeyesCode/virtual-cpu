import { describe, expect, it } from 'vitest';
import {
  fitsInt32,
  INT32_MAX,
  matmulExact,
  matmulInt8,
  MAX_DIM,
  maxAbs,
  validateDims,
  validateInt8Matrix,
} from './matmul.js';
import { allMinMatrix, identityMatrix, Prng, randomInt8Matrix } from './prng.js';

describe('matmulInt8', () => {
  it('computes a 2 × 2 product', () => {
    const c = matmulInt8([1, 2, 3, 4], [5, 6, 7, 8], { m: 2, n: 2, k: 2 });
    expect(Array.from(c)).toEqual([19, 22, 43, 50]);
  });

  it('computes a 3 × 2 · 2 × 4 product with mixed signs', () => {
    const a = [1, -2, 3, 4, -5, 6];
    const b = [1, 0, -1, 2, 3, -4, 5, 0];
    const c = matmulInt8(a, b, { m: 3, n: 4, k: 2 });
    expect(Array.from(c)).toEqual([-5, 8, -11, 2, 15, -16, 17, 6, 13, -24, 35, -10]);
  });

  it('leaves A unchanged when B is the identity', () => {
    const a = randomInt8Matrix(new Prng(7), 5, 6);
    const c = matmulInt8(a, identityMatrix(6), { m: 5, n: 6, k: 6 });
    expect(Array.from(c)).toEqual(Array.from(a));
  });

  it('handles M, N and K of 1', () => {
    expect(Array.from(matmulInt8([-128], [-128], { m: 1, n: 1, k: 1 }))).toEqual([16384]);
    expect(Array.from(matmulInt8([2, 3], [4, 5], { m: 1, n: 1, k: 2 }))).toEqual([23]);
    expect(Array.from(matmulInt8([2, 3], [4, 5], { m: 2, n: 2, k: 1 }))).toEqual([8, 10, 12, 15]);
  });

  it('equals the exact product when it fits in INT32', () => {
    const prng = new Prng(3);
    const dims = { m: 13, n: 11, k: 19 };
    const a = randomInt8Matrix(prng, dims.m, dims.k);
    const b = randomInt8Matrix(prng, dims.k, dims.n);
    const exact = matmulExact(a, b, dims);
    expect(fitsInt32(exact)).toBe(true);
    expect(Array.from(matmulInt8(a, b, dims))).toEqual(exact);
  });

  it('cannot overflow at the r1 maximum dimension', () => {
    const dims = { m: 1, n: 1, k: MAX_DIM };
    const exact = matmulExact(allMinMatrix(1, MAX_DIM), allMinMatrix(MAX_DIM, 1), dims);
    expect(exact).toEqual([MAX_DIM * 16384]);
    expect(fitsInt32(exact)).toBe(true);
  });

  it('wraps two’s-complement after every MAC, exactly as `| 0`', () => {
    // 127 · 127 = 16129; 140 000 of them is 2 258 060 000, past INT32_MAX.
    const k = 140_000;
    const dims = { m: 1, n: 1, k };
    const ones = new Int8Array(k).fill(127);
    const options = { maxDim: k };
    const exact = matmulExact(ones, ones, dims, options);
    expect(exact).toEqual([16129 * k]);
    expect(exact[0]).toBeGreaterThan(INT32_MAX);
    expect(fitsInt32(exact)).toBe(false);
    const wrapped = matmulInt8(ones, ones, dims, options);
    expect(wrapped[0]).toBe((16129 * k) | 0);
    expect(wrapped[0]).toBe(16129 * k - 2 ** 32);
    expect(wrapped[0]).toBeLessThan(0);
  });

  it('reports a negative overflow too', () => {
    const k = 140_000;
    const dims = { m: 1, n: 1, k };
    const options = { maxDim: k };
    const a = new Int8Array(k).fill(127);
    const b = new Int8Array(k).fill(-128);
    const exact = matmulExact(a, b, dims, options);
    expect(fitsInt32(exact)).toBe(false);
    expect(maxAbs(exact)).toBe(16256 * k);
    expect(matmulInt8(a, b, dims, options)[0]).toBe((-16256 * k) | 0);
  });
});

describe('validation', () => {
  it('names a zero, too-large or fractional dimension', () => {
    expect(() => {
      validateDims({ m: 0, n: 1, k: 1 });
    }).toThrow('M must be at least 1, got 0');
    expect(() => {
      validateDims({ m: 1, n: 65, k: 1 });
    }).toThrow('N must be at most 64, got 65');
    expect(() => {
      validateDims({ m: 1, n: 1, k: 1.5 });
    }).toThrow('K must be an integer');
    expect(() => {
      validateDims({ m: 1, n: 1, k: 100 }, { maxDim: 128 });
    }).not.toThrow();
  });

  it('rejects a value outside INT8 and a wrong length', () => {
    expect(() => {
      validateInt8Matrix('A', [0, 128], 1, 2);
    }).toThrow('A[0][1] must be a signed INT8');
    expect(() => {
      validateInt8Matrix('B', [0, -129, 0, 0], 2, 2);
    }).toThrow('B[0][1] must be a signed INT8');
    expect(() => {
      validateInt8Matrix('A', [0, 1, 2], 2, 2);
    }).toThrow('A must hold 2 × 2 = 4 values, got 3');
    expect(() => matmulInt8([1, 2], [0.5, 1], { m: 1, n: 1, k: 2 })).toThrow('B[0][0]');
  });
});
