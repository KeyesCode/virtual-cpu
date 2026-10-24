import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DIM, validateDims } from '../model/matmul.js';
import { type GeneratorName, generateOperands, Prng } from '../model/prng.js';
import { writeCase, type WrittenCase } from './vectors.js';

/**
 * The single-tile vectors of the systolic-array unit test (`tb/unit/tb_systolic_array.sv`). A tile
 * case is an ordinary matmul case ({@link writeCase}: `<name>.in`, `<name>.expected`,
 * `<name>.json`) whose M and N are the array's ROWS and COLS, so the whole of C is one output
 * tile; K is 1 … {@link MAX_DIM}. A suite directory also holds `cases.txt`, the case names in the
 * order the testbench runs them, one per line.
 */

export interface TileArray {
  readonly rows: number;
  readonly cols: number;
}

export interface TileCasePlan {
  readonly name: string;
  readonly generator: GeneratorName;
  readonly k: number;
  readonly seed: number;
  /** Whether the case is one of the suite's random tiles (rather than a directed one). */
  readonly random: boolean;
}

export interface TileSuiteOptions extends TileArray {
  readonly seed: number;
  /** The number of random tiles after the directed ones. */
  readonly count: number;
}

/** Throws unless ROWS and COLS are 1 … MAX_DIM. */
export function validateTileArray(array: TileArray): void {
  validateDims({ m: array.rows, n: array.cols, k: 1 });
}

/** The default name of a tile case: `<generator>-<R>x<C>-k<K>-s<seed>`. */
export function tileCaseName(
  array: TileArray,
  generator: GeneratorName,
  k: number,
  seed: number,
): string {
  return `${generator}-${String(array.rows)}x${String(array.cols)}-k${String(k)}-s${String(seed)}`;
}

/**
 * The cases of a suite, directed first: an all-zero product, the identity (K = COLS), every
 * operand −128 and every operand 127 at K = MAX_DIM (the largest r1 magnitudes), mixed-sign
 * extremes, random tiles at K = 1, 3 and MAX_DIM; then `count` random tiles whose K and seed are
 * drawn from `seed`. The K = 3 case is the one `docs/hardware/accelerators/systolic-array.md`
 * traces clock by clock.
 */
export function tileSuitePlan(options: TileSuiteOptions): TileCasePlan[] {
  validateTileArray(options);
  const { seed, count } = options;
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError(`A seed is a non-negative integer, got ${String(seed)}`);
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`The random tile count is a non-negative integer, got ${String(count)}`);
  }
  const directed: [GeneratorName, number][] = [
    ['zero', 16],
    ['identity', options.cols],
    ['min', MAX_DIM],
    ['max', MAX_DIM],
    ['mixed', 17],
    ['random', 1],
    ['random', 3],
    ['random', MAX_DIM],
  ];
  const plan: TileCasePlan[] = directed.map(([generator, k]) => ({
    name: tileCaseName(options, generator, k, seed),
    generator,
    k,
    seed,
    random: false,
  }));
  // Each random tile gets its own K and seed, so one of them can be rerun alone with
  // gen-tile-vectors.
  const prng = new Prng(seed);
  for (let index = 0; index < count; index += 1) {
    const k = prng.int(1, MAX_DIM);
    const caseSeed = prng.int(0, 0x7fff_ffff);
    plan.push({
      name: `rand${String(index).padStart(3, '0')}-${tileCaseName(options, 'random', k, caseSeed)}`,
      generator: 'random',
      k,
      seed: caseSeed,
      random: true,
    });
  }
  return plan;
}

/** Writes one tile case into `dir`: A is ROWS × K, B is K × COLS. */
export function writeTileCase(
  dir: string,
  array: TileArray,
  testCase: Omit<TileCasePlan, 'random'>,
): WrittenCase {
  validateTileArray(array);
  const dims = { m: array.rows, n: array.cols, k: testCase.k };
  validateDims(dims);
  const operands = generateOperands(testCase.generator, testCase.seed, dims);
  return writeCase(
    dir,
    testCase.name,
    { ...dims, ...operands },
    { seed: testCase.seed, generator: testCase.generator },
  );
}

export interface WrittenTileSuite {
  readonly list: string;
  readonly cases: readonly TileCasePlan[];
}

/** Writes every case of the suite and `cases.txt` into `dir` (created if missing). */
export function writeTileSuite(dir: string, options: TileSuiteOptions): WrittenTileSuite {
  const cases = tileSuitePlan(options);
  mkdirSync(dir, { recursive: true });
  for (const testCase of cases) {
    writeTileCase(dir, options, testCase);
  }
  const list = join(dir, 'cases.txt');
  writeFileSync(list, cases.map((testCase) => `${testCase.name}\n`).join(''));
  return { list, cases };
}
