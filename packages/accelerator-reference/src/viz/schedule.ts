/**
 * The clock-by-clock schedule of one output-stationary systolic-array tile, for the educational
 * visualizations in docs/hardware/accelerators/images/. It re-states the documented timing rule
 * (docs/hardware/accelerators/systolic-array.md); it is not a simulator of the RTL.
 *
 * Clocks are numbered as in that document: clock 0 is the `tile_start` clock, operand clock k is
 * clock k + 1, PE(i, j) multiplies A[i, k] by B[k, j] in clock k + i + j + 1, and `tile_done`
 * pulses in clock K + ROWS + COLS − 1. In a clock, a PE's accumulator register holds the sum of
 * the MACs of the earlier clocks; the MAC of the clock itself lands at the end of the clock.
 */

import { matmulInt8, validateDims, validateInt8Matrix } from '../model/matmul.js';

/** The shape of one tile: A is `rows` × k, B is k × `cols`. */
export interface TileShape {
  readonly rows: number;
  readonly cols: number;
  readonly k: number;
}

/** One tile's operands, row-major, and its shape. */
export interface TileExample extends TileShape {
  readonly a: readonly number[];
  readonly b: readonly number[];
}

/** The tile's control signals and its MAC pattern in one clock. */
export interface ScheduleClock {
  /** Clock number, 0 = the `tile_start` clock. */
  readonly clock: number;
  /** Operand clock (clock − 1), null in the `tile_start` clock. */
  readonly operandClock: number | null;
  /** The k of A[·, k] and B[k, ·] the caller presents in this clock, or null. */
  readonly inputK: number | null;
  /** `macK[i][j]`: the k PE(i, j) multiplies in this clock, or null when it is idle. */
  readonly macK: readonly (readonly (number | null)[])[];
  /** How many PEs do a MAC in this clock. */
  readonly macs: number;
  readonly busy: boolean;
  readonly tileDone: boolean;
}

/** The clock of the `tile_done` pulse, counted from `tile_start`. */
export function tileDoneClock(shape: TileShape): number {
  return shape.k + shape.rows + shape.cols - 1;
}

/** The k PE(i, j) multiplies in `clock`, or null when it is idle (the documented rule). */
export function macKAt(shape: TileShape, clock: number, i: number, j: number): number | null {
  const k = clock - 1 - i - j;
  return k >= 0 && k < shape.k ? k : null;
}

/** Every clock of one tile, `tile_start` (clock 0) through `tile_done`. */
export function tileSchedule(shape: TileShape): ScheduleClock[] {
  validateDims({ m: shape.rows, n: shape.cols, k: shape.k });
  const done = tileDoneClock(shape);
  const clocks: ScheduleClock[] = [];
  for (let clock = 0; clock <= done; clock += 1) {
    const macK = Array.from({ length: shape.rows }, (_, i) =>
      Array.from({ length: shape.cols }, (_, j) => macKAt(shape, clock, i, j)),
    );
    clocks.push({
      clock,
      operandClock: clock === 0 ? null : clock - 1,
      inputK: clock >= 1 && clock <= shape.k ? clock - 1 : null,
      macK,
      macs: macK.flat().filter((k) => k !== null).length,
      busy: clock >= 1 && clock < done,
      tileDone: clock === done,
    });
  }
  return clocks;
}

/** An operand held in a register: its value and the k it belongs to. */
export interface HeldOperand {
  readonly k: number;
  readonly value: number;
}

/** One clock of a tile with the example's values filled in. */
export interface TraceClock extends ScheduleClock {
  /** `aSkew[i][s]`: what skew stage s + 1 of row i holds (row i has i stages), or null. */
  readonly aSkew: readonly (readonly (HeldOperand | null)[])[];
  /** `bSkew[j][s]`: what skew stage s + 1 of column j holds (column j has j stages), or null. */
  readonly bSkew: readonly (readonly (HeldOperand | null)[])[];
  /** `a[i][j]`, `b[i][j]`: the operands PE(i, j) multiplies in this clock, or null when idle. */
  readonly a: readonly (readonly (number | null)[])[];
  readonly b: readonly (readonly (number | null)[])[];
  /** `acc[i][j]`: PE(i, j)'s accumulator register in this clock (INT32, wrapping). */
  readonly acc: readonly (readonly number[])[];
  /** `final[i][j]`: the accumulator already holds C[i, j] (from clock K + i + j + 1). */
  readonly final: readonly (readonly boolean[])[];
}

/** A tile's schedule with every register's value for one example, plus the reference product. */
export interface TileTrace {
  readonly rows: number;
  readonly cols: number;
  readonly k: number;
  readonly a: readonly number[];
  readonly b: readonly number[];
  /** The reference product, `matmulInt8(a, b)`, row-major. */
  readonly c: readonly number[];
  readonly doneClock: number;
  readonly clocks: readonly TraceClock[];
}

/** The tile's schedule with the example's operands, skew registers and accumulators per clock. */
export function tileTrace(example: TileExample): TileTrace {
  const { rows, cols, k } = example;
  validateDims({ m: rows, n: cols, k });
  validateInt8Matrix('A', example.a, rows, k);
  validateInt8Matrix('B', example.b, k, cols);
  const aAt = (i: number, kk: number): number => example.a[i * k + kk] ?? 0;
  const bAt = (kk: number, j: number): number => example.b[kk * cols + j] ?? 0;
  // The caller presents operand kk in clock kk + 1; skew stage s outputs it s clocks later.
  const held = (clock: number, stage: number, value: (kk: number) => number) => {
    const kk = clock - 1 - stage;
    return kk >= 0 && kk < k ? { k: kk, value: value(kk) } : null;
  };
  // Row-major, PE(i, j) at i · cols + j.
  const acc = new Int32Array(rows * cols);
  const clocks = tileSchedule(example).map((step): TraceClock => {
    const snapshot = Array.from({ length: rows }, (_, i) =>
      Array.from(acc.subarray(i * cols, (i + 1) * cols)),
    );
    const pick = (value: (i: number, j: number, kk: number) => number) =>
      step.macK.map((row, i) => row.map((kk, j) => (kk === null ? null : value(i, j, kk))));
    const a = pick((i, _j, kk) => aAt(i, kk));
    const b = pick((_i, j, kk) => bAt(kk, j));
    step.macK.forEach((row, i) => {
      row.forEach((kk, j) => {
        if (kk !== null) {
          // The Int32Array store wraps to INT32, as the RTL accumulator does.
          acc[i * cols + j] = (acc[i * cols + j] ?? 0) + aAt(i, kk) * bAt(kk, j);
        }
      });
    });
    return {
      ...step,
      aSkew: Array.from({ length: rows }, (_, i) =>
        Array.from({ length: i }, (_, s) => held(step.clock, s + 1, (kk) => aAt(i, kk))),
      ),
      bSkew: Array.from({ length: cols }, (_, j) =>
        Array.from({ length: j }, (_, s) => held(step.clock, s + 1, (kk) => bAt(kk, j))),
      ),
      a,
      b,
      acc: snapshot,
      final: snapshot.map((row, i) => row.map((_, j) => step.clock >= k + i + j + 1)),
    };
  });
  return {
    rows,
    cols,
    k,
    a: [...example.a],
    b: [...example.b],
    c: Array.from(matmulInt8(example.a, example.b, { m: rows, n: cols, k })),
    doneClock: tileDoneClock(example),
    clocks,
  };
}

/** The 4 × 4, K = 3 example the animated page shows: small signed INT8 values, −3 … 3. */
export const SYSTOLIC_4X4_EXAMPLE: TileExample = {
  rows: 4,
  cols: 4,
  k: 3,
  // prettier-ignore
  a: [
     1, -2,  3,
     0,  2, -1,
    -3,  1,  2,
     2, -1, -2,
  ],
  // prettier-ignore
  b: [
     2,  1, -1,  0,
    -1,  3,  2, -2,
     1,  0, -3,  1,
  ],
};
