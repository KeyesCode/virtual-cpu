/**
 * The reference INT8 × INT8 → INT32 matrix multiplication every accelerator RTL test is compared
 * against: C = A × B for A = M × K and B = K × N, all matrices row-major.
 *
 * It is deliberately the plain triple loop. Each multiply-accumulate (one MAC: one multiply plus
 * one add) is computed exactly in a JS double, then wrapped to signed 32 bits with `| 0`, which is
 * two's-complement wrap-around: bit-identical to an INT32 accumulator register in the RTL.
 */

/** Operand width in bits: signed INT8. */
export const DATA_W = 8;
/** Accumulator width in bits: signed INT32. */
export const ACC_W = 32;
/** The largest M, N or K the r1 accelerator accepts. */
export const MAX_DIM = 64;

export const INT8_MIN = -128;
export const INT8_MAX = 127;
export const INT32_MIN = -0x8000_0000;
export const INT32_MAX = 0x7fff_ffff;

/** A is M × K, B is K × N, C is M × N. */
export interface MatmulDims {
  readonly m: number;
  readonly n: number;
  readonly k: number;
}

export interface MatmulOptions {
  /** The largest accepted dimension (default {@link MAX_DIM}). */
  readonly maxDim?: number;
}

/** Throws unless every dimension is an integer in 1 … maxDim, naming the first that is not. */
export function validateDims(dims: MatmulDims, options: MatmulOptions = {}): void {
  const maxDim = options.maxDim ?? MAX_DIM;
  if (!Number.isSafeInteger(maxDim) || maxDim < 1) {
    throw new RangeError(`maxDim must be a positive integer, got ${String(maxDim)}`);
  }
  for (const [name, value] of [
    ['M', dims.m],
    ['N', dims.n],
    ['K', dims.k],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${name} must be an integer, got ${String(value)}`);
    }
    if (value < 1) {
      throw new RangeError(`${name} must be at least 1, got ${String(value)}`);
    }
    if (value > maxDim) {
      throw new RangeError(`${name} must be at most ${String(maxDim)}, got ${String(value)}`);
    }
  }
}

/** Throws unless `values` holds exactly rows × cols signed INT8 integers. */
export function validateInt8Matrix(
  name: string,
  values: ArrayLike<number>,
  rows: number,
  cols: number,
): void {
  if (values.length !== rows * cols) {
    throw new RangeError(
      `${name} must hold ${String(rows)} × ${String(cols)} = ${String(rows * cols)} values, got ${String(values.length)}`,
    );
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !Number.isInteger(value) || value < INT8_MIN || value > INT8_MAX) {
      const i = Math.floor(index / cols);
      const j = index % cols;
      throw new RangeError(
        `${name}[${String(i)}][${String(j)}] must be a signed INT8 (${String(INT8_MIN)} … ${String(INT8_MAX)}), got ${String(value)}`,
      );
    }
  }
}

function validateOperands(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  dims: MatmulDims,
  options: MatmulOptions,
): void {
  validateDims(dims, options);
  validateInt8Matrix('A', a, dims.m, dims.k);
  validateInt8Matrix('B', b, dims.k, dims.n);
}

/** C = A × B with an INT32 accumulator that wraps (two's complement) after every MAC. */
export function matmulInt8(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  dims: MatmulDims,
  options: MatmulOptions = {},
): Int32Array {
  validateOperands(a, b, dims, options);
  const { m, n, k } = dims;
  const c = new Int32Array(m * n);
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let acc = 0;
      for (let p = 0; p < k; p += 1) {
        acc = (acc + (a[i * k + p] ?? 0) * (b[p * n + j] ?? 0)) | 0;
      }
      c[i * n + j] = acc;
    }
  }
  return c;
}

/**
 * C = A × B in exact integer arithmetic, with no wrap-around. Every partial sum is at most
 * K · 2^14 in magnitude, so it is exact in a double for any K below 2^39.
 */
export function matmulExact(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  dims: MatmulDims,
  options: MatmulOptions = {},
): number[] {
  validateOperands(a, b, dims, options);
  const { m, n, k } = dims;
  const c: number[] = [];
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) {
      let acc = 0;
      for (let p = 0; p < k; p += 1) {
        acc += (a[i * k + p] ?? 0) * (b[p * n + j] ?? 0);
      }
      c.push(acc);
    }
  }
  return c;
}

/**
 * True when every exact result is representable as a signed INT32, so the final results need no
 * wrap-around and the wrapped C equals the mathematical one. (A partial sum may still pass the INT32
 * range on the way when this is true; wrap-around is modular, so the result is unaffected.)
 */
export function fitsInt32(exact: Iterable<number>): boolean {
  for (const value of exact) {
    if (value < INT32_MIN || value > INT32_MAX) {
      return false;
    }
  }
  return true;
}

/** The largest magnitude among the exact results (0 for an empty matrix). */
export function maxAbs(exact: Iterable<number>): number {
  let max = 0;
  for (const value of exact) {
    max = Math.max(max, Math.abs(value));
  }
  return max;
}
