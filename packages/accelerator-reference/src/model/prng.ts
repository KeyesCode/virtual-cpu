import { INT8_MAX, INT8_MIN, type MatmulDims } from './matmul.js';

/**
 * A small seeded PRNG, so a test matrix is a function of its seed alone: mulberry32 on a 32-bit
 * state that splitmix32 derives from the seed (neighbouring seeds give unrelated streams). Never
 * `Math.random`. The same algorithm as `@vcpu/rtl-tools`' Prng, copied so that this package
 * depends on no other workspace.
 */
export class Prng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new RangeError(`A seed is a non-negative integer, got ${String(seed)}`);
    }
    // splitmix32 over the low and high halves, so seeds above 2^32 still differ.
    let z = (seed >>> 0) ^ Math.floor(seed / 0x1_0000_0000) ^ 0x9e3779b9;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    this.#state = (z ^ (z >>> 16)) >>> 0;
  }

  /** A uniform 32-bit unsigned integer (mulberry32). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor((this.next() / 0x1_0000_0000) * (max - min + 1));
  }
}

export interface Int8Range {
  readonly min?: number;
  readonly max?: number;
}

/** A rows × cols matrix of uniform values in [min, max] (default the whole INT8 range). */
export function randomInt8Matrix(
  prng: Prng,
  rows: number,
  cols: number,
  range: Int8Range = {},
): Int8Array {
  const min = range.min ?? INT8_MIN;
  const max = range.max ?? INT8_MAX;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < INT8_MIN || max > INT8_MAX) {
    throw new RangeError(
      `The range must lie within ${String(INT8_MIN)} … ${String(INT8_MAX)}, got ${String(min)} … ${String(max)}`,
    );
  }
  if (min > max) {
    throw new RangeError(`The range minimum ${String(min)} is above its maximum ${String(max)}`);
  }
  const out = new Int8Array(rows * cols);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = prng.int(min, max);
  }
  return out;
}

/** A rows × cols matrix with every value equal to `value`. */
export function filledInt8Matrix(rows: number, cols: number, value: number): Int8Array {
  if (!Number.isInteger(value) || value < INT8_MIN || value > INT8_MAX) {
    throw new RangeError(`A fill value must be a signed INT8, got ${String(value)}`);
  }
  return new Int8Array(rows * cols).fill(value);
}

export function zeroMatrix(rows: number, cols: number): Int8Array {
  return new Int8Array(rows * cols);
}

/** The size × size identity. */
export function identityMatrix(size: number): Int8Array {
  const out = new Int8Array(size * size);
  for (let i = 0; i < size; i += 1) {
    out[i * size + i] = 1;
  }
  return out;
}

/** Every value 127 (INT8_MAX). */
export function allMaxMatrix(rows: number, cols: number): Int8Array {
  return filledInt8Matrix(rows, cols, INT8_MAX);
}

/** Every value −128 (INT8_MIN). */
export function allMinMatrix(rows: number, cols: number): Int8Array {
  return filledInt8Matrix(rows, cols, INT8_MIN);
}

/** 127 where i + j is even and −128 where it is odd: the extreme values with mixed signs. */
export function checkerboardSignMatrix(rows: number, cols: number): Int8Array {
  const out = new Int8Array(rows * cols);
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      out[i * cols + j] = (i + j) % 2 === 0 ? INT8_MAX : INT8_MIN;
    }
  }
  return out;
}

/** The operand generators `gen-vectors --generator` accepts. */
export const GENERATOR_NAMES = ['random', 'zero', 'identity', 'max', 'min', 'mixed'] as const;
export type GeneratorName = (typeof GENERATOR_NAMES)[number];

export function isGeneratorName(name: string): name is GeneratorName {
  return (GENERATOR_NAMES as readonly string[]).includes(name);
}

/** What each generator puts in A (M × K) and B (K × N); C follows from them. */
export const GENERATOR_DESCRIPTIONS: Readonly<Record<GeneratorName, string>> = {
  random: 'A and B uniform over −128 … 127',
  zero: 'A uniform, B all zeros, so C is all zeros',
  identity: 'A uniform, B the identity (needs K = N), so C equals A',
  max: 'A and B all 127',
  min: 'A and B all −128 (the largest product, +16384)',
  mixed: 'A and B checkerboards of 127 and −128',
};

export interface Operands {
  readonly a: Int8Array;
  readonly b: Int8Array;
}

/** A and B for `generator`; the random parts are drawn from `seed`, A before B. */
export function generateOperands(
  generator: GeneratorName,
  seed: number,
  dims: MatmulDims,
): Operands {
  const { m, n, k } = dims;
  const prng = new Prng(seed);
  switch (generator) {
    case 'random': {
      const a = randomInt8Matrix(prng, m, k);
      return { a, b: randomInt8Matrix(prng, k, n) };
    }
    case 'zero':
      return { a: randomInt8Matrix(prng, m, k), b: zeroMatrix(k, n) };
    case 'identity':
      if (k !== n) {
        throw new RangeError(
          `The identity generator needs K = N, got K ${String(k)} and N ${String(n)}`,
        );
      }
      return { a: randomInt8Matrix(prng, m, k), b: identityMatrix(n) };
    case 'max':
      return { a: allMaxMatrix(m, k), b: allMaxMatrix(k, n) };
    case 'min':
      return { a: allMinMatrix(m, k), b: allMinMatrix(k, n) };
    case 'mixed':
      return { a: checkerboardSignMatrix(m, k), b: checkerboardSignMatrix(k, n) };
  }
}
