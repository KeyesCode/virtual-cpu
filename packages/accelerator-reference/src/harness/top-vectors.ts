import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DIM, type MatmulDims, validateDims } from '../model/matmul.js';
import { type GeneratorName, generateOperands, type Operands, Prng } from '../model/prng.js';
import { type TileArray, validateTileArray } from './tile-vectors.js';
import { writeCase, type WrittenCase } from './vectors.js';

/**
 * The vectors of the whole-accelerator unit test (`tb/unit/tb_matmul_top.sv`): ordinary matmul
 * cases ({@link writeCase}: `<name>.in`, `<name>.expected`, `<name>.json`) of any M, N and K in
 * 1 … {@link MAX_DIM}, tiled by the RTL over its ROWS × COLS array. A suite directory also holds
 * `cases.txt`, one case per line in run order: the case name, then ` reuse` for a case that runs
 * on the A and B already in the accelerator's buffers.
 *
 * A reuse case's A and B are the leading M × K and K × N submatrices of the last case that was
 * not a reuse case, so the testbench starts it without writing the buffers (a second run without
 * a reset, on different dimensions); it checks the `.in` file against what it wrote.
 */

export interface TopCasePlan {
  readonly name: string;
  /** The generator of the operands, or of the case whose operands a reuse case slices. */
  readonly generator: GeneratorName;
  readonly dims: MatmulDims;
  readonly seed: number;
  /** Whether the case is one of the suite's random cases (rather than a directed one). */
  readonly random: boolean;
  /** Whether the case runs on the A and B of the last case that is not a reuse case. */
  readonly reuse: boolean;
}

export interface TopSuiteOptions extends TileArray {
  readonly seed: number;
  /** The number of random cases after the directed ones. */
  readonly count: number;
}

/** The default name of a case: `<generator>-m<M>-n<N>-k<K>-s<seed>`, as `gen-vectors` names it. */
export function topCaseName(generator: string, dims: MatmulDims, seed: number): string {
  return `${generator}-m${String(dims.m)}-n${String(dims.n)}-k${String(dims.k)}-s${String(seed)}`;
}

/**
 * The cases of a suite, directed first: a random MAX_DIM³ product (which also leaves non-zero
 * data in every buffer entry that a later, smaller case's edge tiles must mask out), two reuse
 * cases on its buffers (a smaller product, then the full one again), the products of the ticket's
 * directed list (4³, 8³, 16³, 32³, 13 × 19 · 19 × 11, M = 1, N = 1, K = 1, 1 × 1 × 1, all-zero B,
 * the identity, all −128, all 127 at MAX_DIM³, mixed-sign extremes); then `count` random cases
 * with M, N, K and seed drawn from `seed`.
 */
export function topSuitePlan(options: TopSuiteOptions): TopCasePlan[] {
  validateTileArray(options);
  const { seed, count } = options;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError(`A seed is a non-negative integer, got ${String(seed)}`);
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`The random case count is a non-negative integer, got ${String(count)}`);
  }
  const full = { m: MAX_DIM, n: MAX_DIM, k: MAX_DIM };
  const directed: [GeneratorName | 'reuse', MatmulDims][] = [
    ['random', full],
    ['reuse', { m: 40, n: 27, k: 33 }],
    ['reuse', full],
    ['random', { m: 4, n: 4, k: 4 }],
    ['random', { m: 8, n: 8, k: 8 }],
    ['random', { m: 16, n: 16, k: 16 }],
    ['random', { m: 32, n: 32, k: 32 }],
    ['random', { m: 13, n: 11, k: 19 }],
    ['random', { m: 1, n: 45, k: 30 }],
    ['random', { m: 37, n: 1, k: 50 }],
    ['random', { m: 53, n: 61, k: 1 }],
    ['random', { m: 1, n: 1, k: 1 }],
    ['zero', { m: 23, n: 29, k: 31 }],
    ['identity', { m: 27, n: 20, k: 20 }],
    ['min', full],
    ['max', full],
    ['mixed', { m: 33, n: 35, k: 37 }],
  ];
  const plan: TopCasePlan[] = [];
  let source: GeneratorName = 'random';
  for (const [generator, dims] of directed) {
    const reuse = generator === 'reuse';
    if (!reuse) source = generator;
    plan.push({
      name: topCaseName(generator, dims, seed),
      generator: reuse ? source : generator,
      dims,
      seed,
      random: false,
      reuse,
    });
  }
  // Each random case gets its own dimensions and seed, so one of them can be rerun alone with
  // gen-vectors.
  const prng = new Prng(seed);
  for (let index = 0; index < count; index += 1) {
    const dims = { m: prng.int(1, MAX_DIM), n: prng.int(1, MAX_DIM), k: prng.int(1, MAX_DIM) };
    const caseSeed = prng.int(0, 0x7fff_ffff);
    plan.push({
      name: `rand${String(index).padStart(3, '0')}-${topCaseName('random', dims, caseSeed)}`,
      generator: 'random',
      dims,
      seed: caseSeed,
      random: true,
      reuse: false,
    });
  }
  return plan;
}

/** The leading M × K submatrix of A and K × N submatrix of B, from operands of `from`. */
export function leadingOperands(operands: Operands, from: MatmulDims, dims: MatmulDims): Operands {
  if (dims.m > from.m || dims.n > from.n || dims.k > from.k) {
    throw new RangeError(
      `A ${String(dims.m)} × ${String(dims.k)} · ${String(dims.k)} × ${String(dims.n)} product is not inside ${String(from.m)} × ${String(from.k)} · ${String(from.k)} × ${String(from.n)}`,
    );
  }
  const a = new Int8Array(dims.m * dims.k);
  for (let i = 0; i < dims.m; i += 1) {
    a.set(operands.a.subarray(i * from.k, i * from.k + dims.k), i * dims.k);
  }
  const b = new Int8Array(dims.k * dims.n);
  for (let k = 0; k < dims.k; k += 1) {
    b.set(operands.b.subarray(k * from.n, k * from.n + dims.n), k * dims.n);
  }
  return { a, b };
}

export interface WrittenTopSuite {
  readonly list: string;
  readonly cases: readonly TopCasePlan[];
  readonly written: readonly WrittenCase[];
}

/** Writes every case of the suite and `cases.txt` into `dir` (created if missing). */
export function writeTopSuite(dir: string, options: TopSuiteOptions): WrittenTopSuite {
  const cases = topSuitePlan(options);
  mkdirSync(dir, { recursive: true });
  const written: WrittenCase[] = [];
  let loaded: { dims: MatmulDims; operands: Operands } | undefined;
  for (const testCase of cases) {
    validateDims(testCase.dims);
    let operands: Operands;
    if (testCase.reuse) {
      if (loaded === undefined) {
        throw new RangeError(`Reuse case ${testCase.name} has no earlier case to reuse`);
      }
      operands = leadingOperands(loaded.operands, loaded.dims, testCase.dims);
    } else {
      operands = generateOperands(testCase.generator, testCase.seed, testCase.dims);
      loaded = { dims: testCase.dims, operands };
    }
    written.push(
      writeCase(
        dir,
        testCase.name,
        { ...testCase.dims, ...operands },
        { seed: testCase.seed, generator: testCase.reuse ? 'reuse' : testCase.generator },
      ),
    );
  }
  const list = join(dir, 'cases.txt');
  writeFileSync(
    list,
    cases.map((testCase) => `${testCase.name}${testCase.reuse ? ' reuse' : ''}\n`).join(''),
  );
  return { list, cases, written };
}
