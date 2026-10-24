import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_DIM, type MatmulDims, validateDims } from '../model/matmul.js';
import {
  type GeneratorName,
  generateOperands,
  isGeneratorName,
  type Operands,
  Prng,
  randomInt8Matrix,
} from '../model/prng.js';
import {
  BUILD_DIR,
  buildVerifyReport,
  formatVerifyMarkdown,
  HW_DIR,
  MAX_LISTED_MISMATCHES,
  type Provenance,
  readProvenance,
  REPO,
  type RunnerCycles,
  RunnerCyclesSchema,
  type RunnerFlags,
  RunnerFlagsSchema,
  sortCases,
  type VerifyCaseResult,
  type VerifyReport,
} from './report.js';
import { compareOutputs, type OutputMismatch, readOutput, writeCase } from './vectors.js';

/**
 * Differential verification of the RTL (`make -C hardware/accelerators/matmul verify`): for every
 * array size, a corpus of matmul cases is generated deterministically from a seed, each case's C
 * is computed by the reference model ({@link writeCase}), run on that size's Verilator runner
 * (tb/sim/matmul_sim.cpp) and compared element by element. Failing cases are saved with
 * everything needed to replay them; build/reports/verify.{json,md} records every case.
 * docs/hardware/accelerators/verification-strategy.md explains the corpora.
 */

export interface ArraySize {
  readonly rows: number;
  readonly cols: number;
}

export function sizeName(size: ArraySize): string {
  return `${String(size.rows)}x${String(size.cols)}`;
}

/** The operand generators of the corpus: the reference's named ones plus two sign patterns. */
export type CaseGenerator = GeneratorName | 'negative' | 'negpos';

export interface VerifyCasePlan {
  readonly name: string;
  readonly kind: 'directed' | 'random';
  readonly generator: CaseGenerator;
  readonly dims: MatmulDims;
  readonly seed: number;
  readonly flags: RunnerFlags;
  /** What the case is for, in words. */
  readonly what: string;
}

const ONE_RUN: RunnerFlags = { repeat: 1, resetBetween: false, abortFirst: false };

function caseName(label: string, dims: MatmulDims, seed: number): string {
  return `${label}-m${String(dims.m)}-n${String(dims.n)}-k${String(dims.k)}-s${String(seed)}`;
}

/**
 * The directed corpus of one array size, every operand drawn from `seed`: products smaller than
 * the array, exactly one tile, the largest within capacity, non-square ones, edge tiles in both
 * dimensions (near the start and at the far end of the buffers), negative and mixed-sign operands,
 * zero, the identity, all −128, all 127, sign checkerboards, M, N or K equal to 1, a MAX_DIM dot
 * product, three runs in one runner process without a reset, and a run reset in its first STORE
 * clock then restarted twice with a reset in between.
 */
export function directedPlan(size: ArraySize, seed: number): VerifyCasePlan[] {
  const { rows: r, cols: c } = size;
  const full = { m: MAX_DIM, n: MAX_DIM, k: MAX_DIM };
  // Two tile rows and one more, two tile columns and one fewer (capped for the 32 and 64 sides).
  const edge = { m: Math.min(2 * r + 1, MAX_DIM - 1), n: Math.min(2 * c - 1, MAX_DIM - 1), k: 7 };
  const list: [string, CaseGenerator, MatmulDims, string, RunnerFlags?][] = [
    ['small', 'random', { m: 2, n: 3, k: 2 }, 'smaller than the array in every dimension'],
    ['one-tile', 'random', { m: r, n: c, k: r }, 'exactly one full output tile'],
    ['large', 'random', full, 'the largest product within capacity'],
    ['nonsquare', 'random', { m: 13, n: 11, k: 19 }, 'non-square, not a multiple of any size'],
    ['wide', 'random', { m: 5, n: MAX_DIM, k: 33 }, 'a short, wide C'],
    ['tall', 'random', { m: MAX_DIM, n: 7, k: 50 }, 'a tall, narrow C (N < M)'],
    ['edge-tiles', 'random', edge, 'edge tiles in both dimensions'],
    ['edge-far', 'random', { m: 63, n: 61, k: 62 }, 'edge tiles at the far end of the buffers'],
    ['negative', 'negative', { m: 24, n: 22, k: 26 }, 'A and B all negative'],
    ['negpos', 'negpos', { m: 19, n: 23, k: 21 }, 'A negative, B non-negative'],
    ['zero', 'zero', { m: 23, n: 29, k: 31 }, 'B all zeros, so C is all zeros'],
    ['identity', 'identity', { m: 27, n: 20, k: 20 }, 'B the identity, so C equals A'],
    ['all-min', 'min', full, 'every operand −128, the largest products'],
    ['all-max', 'max', full, 'every operand 127'],
    ['mixed', 'mixed', { m: 33, n: 35, k: 37 }, 'checkerboards of 127 and −128'],
    ['m1', 'random', { m: 1, n: 45, k: 30 }, 'M = 1'],
    ['n1', 'random', { m: 37, n: 1, k: 50 }, 'N = 1'],
    ['k1', 'random', { m: 53, n: 61, k: 1 }, 'K = 1'],
    ['mnk1', 'random', { m: 1, n: 1, k: 1 }, 'M = N = K = 1'],
    ['dot', 'random', { m: 1, n: 1, k: MAX_DIM }, 'one dot product of length MAX_DIM'],
    [
      'repeat',
      'random',
      { m: 21, n: 19, k: 17 },
      'three runs in one runner process with no reset',
      { repeat: 3, resetBetween: false, abortFirst: false },
    ],
    [
      'reset-restart',
      'random',
      { m: 30, n: 30, k: 30 },
      'reset in the first STORE clock, then two runs with a reset in between',
      { repeat: 2, resetBetween: true, abortFirst: true },
    ],
  ];
  return list.map(([label, generator, dims, what, flags]) => ({
    name: caseName(label, dims, seed),
    kind: 'directed',
    generator,
    dims,
    seed,
    flags: flags ?? ONE_RUN,
    what,
  }));
}

/**
 * A random M (side = ROWS) or N (side = COLS): MAX_DIM one time in eight, a multiple of the side
 * one time in eight, otherwise a non-multiple of the side below MAX_DIM, so most products have
 * edge tiles.
 */
function randomSide(prng: Prng, side: number): number {
  const pick = prng.int(0, 7);
  if (pick === 0) return MAX_DIM;
  if (pick === 1) return side * prng.int(1, MAX_DIM / side);
  for (;;) {
    const value = prng.int(1, MAX_DIM - 1);
    if (value % side !== 0) return value;
  }
}

/**
 * `count` random cases for one array size, drawn from `seed` and the size (each size gets its own
 * cases): M and N from {@link randomSide}, K uniform in 1 … MAX_DIM (MAX_DIM one time in eight),
 * and every tenth case has one dimension (M, N, K in turn) forced to MAX_DIM. Each case has its own
 * operand seed, so one can be regenerated alone.
 */
export function randomPlan(size: ArraySize, seed: number, count: number): VerifyCasePlan[] {
  const base = new Prng(seed).next() ^ ((size.rows << 16) | size.cols);
  const prng = new Prng(base >>> 0);
  const plan: VerifyCasePlan[] = [];
  for (let index = 0; index < count; index += 1) {
    const dims = {
      m: randomSide(prng, size.rows),
      n: randomSide(prng, size.cols),
      k: prng.int(0, 7) === 0 ? MAX_DIM : prng.int(1, MAX_DIM),
    };
    if (index % 10 === 0) {
      const forced = (['m', 'n', 'k'] as const)[(index / 10) % 3] ?? 'm';
      dims[forced] = MAX_DIM;
    }
    const caseSeed = prng.int(0, 0x7fff_ffff);
    plan.push({
      name: `rand${String(index).padStart(3, '0')}-${caseName('random', dims, caseSeed)}`,
      kind: 'random',
      generator: 'random',
      dims,
      seed: caseSeed,
      flags: ONE_RUN,
      what: 'random operands',
    });
  }
  return plan;
}

export interface CorpusOptions {
  readonly seed: number;
  /** Random cases per size. */
  readonly count: number;
  readonly directed: boolean;
  readonly random: boolean;
}

/** The corpus of one size: the directed cases, then the random ones. */
export function corpusPlan(size: ArraySize, options: CorpusOptions): VerifyCasePlan[] {
  for (const [name, value] of [
    ['seed', options.seed],
    ['count', options.count],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`The ${name} is a non-negative integer, got ${String(value)}`);
    }
  }
  return [
    ...(options.directed ? directedPlan(size, options.seed) : []),
    ...(options.random ? randomPlan(size, options.seed, options.count) : []),
  ];
}

/** A and B of a case, a function of its generator, dimensions and seed alone. */
export function caseOperands(plan: Pick<VerifyCasePlan, 'generator' | 'dims' | 'seed'>): Operands {
  const { m, n, k } = plan.dims;
  if (plan.generator === 'negative' || plan.generator === 'negpos') {
    const prng = new Prng(plan.seed);
    const a = randomInt8Matrix(prng, m, k, { max: -1 });
    const b =
      plan.generator === 'negative'
        ? randomInt8Matrix(prng, k, n, { max: -1 })
        : randomInt8Matrix(prng, k, n, { min: 0 });
    return { a, b };
  }
  if (!isGeneratorName(plan.generator)) {
    throw new RangeError(`Unknown generator ${String(plan.generator)}`);
  }
  return generateOperands(plan.generator, plan.seed, plan.dims);
}

/** The runner arguments for a case's flags (after --case, --out and --cycles). */
export function runnerFlagArgs(flags: RunnerFlags): string[] {
  return [
    ...(flags.repeat > 1 ? ['--repeat', String(flags.repeat)] : []),
    ...(flags.resetBetween ? ['--reset-between'] : []),
    ...(flags.abortFirst ? ['--abort-first'] : []),
  ];
}

/**
 * The runner's clock limit for one run: four times the clocks from start to done that
 * docs/hardware/accelerators/controller.md gives (1 + tiles · (K + ROWS + COLS + 1) + M · N),
 * plus a margin. It only stops an RTL that hangs.
 */
export function cycleLimit(size: ArraySize, dims: MatmulDims): number {
  const tiles = Math.ceil(dims.m / size.rows) * Math.ceil(dims.n / size.cols);
  return 4 * (1 + tiles * (dims.k + size.rows + size.cols + 1) + dims.m * dims.n) + 1000;
}

/** Wall-clock limit for one runner process. */
export const RUNNER_TIMEOUT_MS = 120_000;

export interface RunnerResult {
  /** Why the runner could not be used, or null. */
  readonly error: string | null;
  readonly command: string;
}

function quote(arg: string): string {
  return /^[\w./=+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** Runs the runner with `args`; resolves with the failure (exit, signal, timeout) or null. */
export function runRunner(sim: string, args: readonly string[]): Promise<RunnerResult> {
  const command = [sim, ...args].map(quote).join(' ');
  return new Promise((done) => {
    execFile(
      sim,
      args,
      { timeout: RUNNER_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (error, _stdout, stderr) => {
        if (error === null) {
          done({ error: null, command });
          return;
        }
        const why = error.killed
          ? `timed out after ${String(RUNNER_TIMEOUT_MS)} ms`
          : error.message;
        const detail = stderr.trim().split('\n')[0] ?? '';
        done({
          error: `the runner failed (${why.trim().split('\n')[0] ?? ''})${detail === '' ? '' : `: ${detail}`}`,
          command,
        });
      },
    );
  });
}

/** The array a runner was built for (`matmul_sim --info`). */
export async function runnerInfo(sim: string): Promise<ArraySize> {
  const output = await new Promise<string>((done, fail) => {
    execFile(sim, ['--info'], { timeout: 10_000 }, (error, stdout) => {
      if (error === null) done(stdout);
      else fail(new Error(`${sim} --info failed: ${error.message}`));
    });
  });
  const info = z
    .object({ rows: z.number().int(), cols: z.number().int(), maxDim: z.number().int() })
    .parse(JSON.parse(output));
  if (info.maxDim !== MAX_DIM) {
    throw new Error(
      `${sim} was built with MAX_DIM ${String(info.maxDim)}; the reference uses ${String(MAX_DIM)}`,
    );
  }
  return { rows: info.rows, cols: info.cols };
}

/** One line for a mismatching element. */
export function describeMismatch(m: OutputMismatch): string {
  return `C[${String(m.i)}][${String(m.j)}]: expected ${String(m.expected)}, actual ${String(m.actual)} (${m.actual > m.expected ? '+' : ''}${String(m.actual - m.expected)})`;
}

/** `make -C hardware/accelerators/matmul replay CASE=…` for a saved case directory. */
export function replayCommand(dir: string): string {
  const rel = relative(HW_DIR, dir);
  return `make -C hardware/accelerators/matmul replay CASE=${rel.startsWith('..') ? dir : rel}`;
}

export interface CaseOutcome {
  readonly reason: string | null;
  readonly mismatches: readonly OutputMismatch[];
  readonly cycles: RunnerCycles | null;
}

/**
 * The failure report of a case: one header line, the case, the first differing elements (or the
 * reason it could not be compared) and the replay command. Null when the case passed.
 */
export function formatFailureReport(
  size: string,
  plan: Pick<VerifyCasePlan, 'name' | 'kind' | 'generator' | 'dims' | 'seed' | 'flags' | 'what'>,
  outcome: CaseOutcome,
  replay: string,
): string | null {
  if (outcome.reason === null) return null;
  const { m, n, k } = plan.dims;
  const lines = [
    `FAIL ${size} ${plan.name}: ${outcome.reason}`,
    `  array ${size} · M ${String(m)} N ${String(n)} K ${String(k)} · ${plan.kind} · generator ${plan.generator} · seed ${String(plan.seed)} · ${plan.what}`,
  ];
  const runner = runnerFlagArgs(plan.flags);
  if (runner.length > 0) lines.push(`  runner flags ${runner.join(' ')}`);
  for (const mismatch of outcome.mismatches.slice(0, MAX_LISTED_MISMATCHES)) {
    lines.push(`  ${describeMismatch(mismatch)}`);
  }
  if (outcome.mismatches.length > MAX_LISTED_MISMATCHES) {
    lines.push(`  … ${String(outcome.mismatches.length - MAX_LISTED_MISMATCHES)} more`);
  }
  lines.push(`  replay: ${replay}`);
  return `${lines.join('\n')}\n`;
}

/** Reads what the runner wrote for a case and compares C; never throws. */
export function judge(
  plan: Pick<VerifyCasePlan, 'dims' | 'flags'>,
  run: RunnerResult,
  files: { readonly expected: string; readonly out: string; readonly cycles: string },
): CaseOutcome {
  if (run.error !== null) return { reason: run.error, mismatches: [], cycles: null };
  let cycles: RunnerCycles;
  try {
    cycles = RunnerCyclesSchema.parse(JSON.parse(readFileSync(files.cycles, 'utf8')));
  } catch (error) {
    return {
      reason: `cannot read the runner's cycles JSON: ${(error as Error).message.split('\n')[0] ?? ''}`,
      mismatches: [],
      cycles: null,
    };
  }
  const { m, n, k } = plan.dims;
  if (cycles.m !== m || cycles.n !== n || cycles.k !== k) {
    return {
      reason: `the runner ran M ${String(cycles.m)} N ${String(cycles.n)} K ${String(cycles.k)}`,
      mismatches: [],
      cycles,
    };
  }
  if (cycles.stop === 'error') {
    return { reason: `the controller raised error ${cycles.error ?? '?'}`, mismatches: [], cycles };
  }
  if (cycles.stop === 'timeout') {
    return { reason: 'timeout: done never pulsed within the cycle limit', mismatches: [], cycles };
  }
  let actual: Int32Array;
  let expected: Int32Array;
  try {
    expected = readOutput(files.expected);
    actual = readOutput(files.out);
  } catch (error) {
    return { reason: `cannot read C: ${(error as Error).message}`, mismatches: [], cycles };
  }
  let mismatches: OutputMismatch[];
  try {
    mismatches = compareOutputs(expected, actual, n);
  } catch (error) {
    return { reason: (error as Error).message, mismatches: [], cycles };
  }
  if (mismatches.length > 0) {
    const first = mismatches[0];
    return {
      reason: `${String(mismatches.length)} of ${String(expected.length)} elements differ${first === undefined ? '' : `, first ${describeMismatch(first)}`}`,
      mismatches,
      cycles,
    };
  }
  if (plan.flags.abortFirst && !cycles.aborted) {
    return {
      reason: 'the --abort-first run finished without reaching STORE, so no reset interrupted it',
      mismatches: [],
      cycles,
    };
  }
  if (cycles.runsDiffering > 0) {
    return {
      reason: `${String(cycles.runsDiffering)} of ${String(plan.flags.repeat - 1)} repeated runs differ from the first`,
      mismatches: [],
      cycles,
    };
  }
  return { reason: null, mismatches: [], cycles };
}

/** `case.json` of a saved failure: what `verify --replay` needs to rerun it. */
export const FailureCaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('matmul-verify-failure'),
  size: z.string(),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  name: z.string(),
  caseKind: z.enum(['directed', 'random']),
  generator: z.string(),
  seed: z.number().int().nonnegative(),
  dims: z.object({ m: z.number().int(), n: z.number().int(), k: z.number().int() }),
  flags: RunnerFlagsSchema,
  what: z.string(),
  /** The runner it failed on (absolute). */
  sim: z.string(),
  reason: z.string(),
});
export type FailureCase = z.infer<typeof FailureCaseSchema>;

export const VERIFY_DEFAULTS = {
  work: join(BUILD_DIR, 'verify'),
  failures: join(BUILD_DIR, 'failures'),
  reports: join(BUILD_DIR, 'reports'),
  seed: 1,
  count: 40,
  /** Failing cases saved and printed in full; the rest get one line each. */
  keepFailures: 25,
} as const;

export interface VerifyOptions extends CorpusOptions {
  /** One runner per array size; each says its size with --info. */
  readonly sims: readonly string[];
  readonly work: string;
  readonly failures: string;
  readonly reports: string;
  /** Runner processes in flight at once. */
  readonly jobs: number;
  readonly keepFailures: number;
  /** Read once per run; tests pass a fixed one. */
  readonly provenance?: Provenance;
}

export function defaultVerifyOptions(sims: readonly string[]): VerifyOptions {
  return {
    ...VERIFY_DEFAULTS,
    sims,
    directed: true,
    random: true,
    jobs: availableParallelism(),
  };
}

export interface VerifyOutcome {
  readonly exitCode: number;
  readonly report: VerifyReport | null;
  readonly failures: readonly VerifyCaseResult[];
}

interface Task {
  readonly size: ArraySize;
  readonly sim: string;
  readonly plan: VerifyCasePlan;
}

interface Failure {
  readonly dir: string;
  readonly task: Task;
  readonly files: {
    readonly input: string;
    readonly expected: string;
    readonly out: string;
    readonly cycles: string;
  };
  readonly outcome: CaseOutcome;
  /** The runner command line. */
  readonly command: string;
}

/** Writes everything needed to understand and rerun a failing case into `dir`; returns its report. */
function saveFailure(failure: Failure): string {
  const { dir, task, files, outcome, command } = failure;
  const report =
    formatFailureReport(sizeName(task.size), task.plan, outcome, replayCommand(dir)) ?? '';
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { plan, size, sim } = task;
  const file: FailureCase = {
    schemaVersion: 1,
    kind: 'matmul-verify-failure',
    size: sizeName(size),
    rows: size.rows,
    cols: size.cols,
    name: plan.name,
    caseKind: plan.kind,
    generator: plan.generator,
    seed: plan.seed,
    dims: plan.dims,
    flags: plan.flags,
    what: plan.what,
    sim: resolve(sim),
    reason: outcome.reason ?? '',
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(file, null, 2)}\n`);
  copyFileSync(files.input, join(dir, 'case.in'));
  // case.expected beside case.in, so `make simulate CASE=<dir>/case.in` checks C as well.
  copyFileSync(files.expected, join(dir, 'case.expected'));
  if (existsSync(files.out)) copyFileSync(files.out, join(dir, 'actual.out'));
  if (existsSync(files.cycles)) copyFileSync(files.cycles, join(dir, 'cycles.json'));
  writeFileSync(join(dir, 'report.txt'), report);
  writeFileSync(
    join(dir, 'found.txt'),
    `Found by verify on ${sizeName(size)}: ${outcome.reason ?? ''}\nRunner command:\n  ${command}\nReplay:\n  ${replayCommand(dir)}\n`,
  );
  return report;
}

/**
 * Runs every case of every runner's corpus, compares C element by element, keeps going after a
 * failure, saves failing cases (up to keepFailures), prints a failure report per saved case and a
 * summary, and writes verify.json and verify.md to `reports`. Exit code 0 only when every case
 * matched, 1 when one did not, 2 when a runner is missing or unusable.
 */
export async function runVerify(
  options: VerifyOptions,
  write: (text: string) => void,
): Promise<VerifyOutcome> {
  if (options.sims.length === 0) {
    write('verify: no runner given (--sim build/sim-<R>x<C>/matmul_sim)\n');
    return { exitCode: 2, report: null, failures: [] };
  }
  const sizes: { size: ArraySize; sim: string }[] = [];
  for (const sim of options.sims) {
    if (!existsSync(sim)) {
      write(`verify: no runner at ${sim}; run 'make -C hardware/accelerators/matmul sim-all'\n`);
      return { exitCode: 2, report: null, failures: [] };
    }
    let size: ArraySize;
    try {
      size = await runnerInfo(sim);
    } catch (error) {
      write(`verify: ${(error as Error).message}\n`);
      return { exitCode: 2, report: null, failures: [] };
    }
    if (sizes.some((s) => sizeName(s.size) === sizeName(size))) {
      write(`verify: two runners for the ${sizeName(size)} array\n`);
      return { exitCode: 2, report: null, failures: [] };
    }
    sizes.push({ size, sim });
  }
  sizes.sort((a, b) => a.size.rows - b.size.rows || a.size.cols - b.size.cols);

  const started = Date.now();
  rmSync(options.failures, { recursive: true, force: true });
  const tasks: Task[] = [];
  for (const { size, sim } of sizes) {
    // The case files of a size are exactly its corpus: the same seed gives the same files.
    rmSync(join(options.work, sizeName(size)), { recursive: true, force: true });
    for (const plan of corpusPlan(size, options)) tasks.push({ size, sim, plan });
  }
  const corpora = [
    ...(options.directed ? (['directed'] as const) : []),
    ...(options.random ? (['random'] as const) : []),
  ];
  write(
    `verify: ${corpora.join(' + ')} corpus (seed ${String(options.seed)}, ${String(options.count)} random per size) on ${sizes.map((s) => sizeName(s.size)).join(', ')}: ${String(tasks.length)} cases, ${String(options.jobs)} jobs\n`,
  );

  const results: VerifyCaseResult[] = [];
  // Failures are saved after the pool, in report order, so which ones are kept never depends on
  // which runner finished first.
  const failed = new Map<VerifyCaseResult, Omit<Failure, 'dir'>>();
  let next = 0;
  const worker = async () => {
    for (let task = tasks[next++]; task !== undefined; task = tasks[next++]) {
      const { size, sim, plan } = task;
      const dir = join(options.work, sizeName(size));
      validateDims(plan.dims);
      const written = writeCase(
        dir,
        plan.name,
        { ...plan.dims, ...caseOperands(plan) },
        { seed: plan.seed, generator: plan.generator },
      );
      const files = {
        input: written.input,
        expected: written.expected,
        out: join(dir, `${plan.name}.out`),
        cycles: join(dir, `${plan.name}.cycles.json`),
      };
      // DELIBERATE CI FAILURE (scratch PR only, never merged): C[0][0] of the 4x4 `small` directed case
      // is expected one too high, so the accelerator workflow's verify step must go red.
      if (sizeName(size) === '4x4' && plan.name.startsWith('small-')) {
        const text = readFileSync(files.expected, 'utf8');
        writeFileSync(files.expected, text.replace(/-?\d+/, (v) => String(Number(v) + 1)));
      }
      const args = [
        '--case',
        files.input,
        '--out',
        files.out,
        '--cycles',
        files.cycles,
        '--max-cycles',
        String(cycleLimit(size, plan.dims)),
        '--quiet',
        ...runnerFlagArgs(plan.flags),
      ];
      const run = await runRunner(sim, args);
      const outcome = judge(plan, run, files);
      const result: VerifyCaseResult = {
        size: sizeName(size),
        name: plan.name,
        kind: plan.kind,
        generator: plan.generator,
        seed: plan.seed,
        dims: plan.dims,
        macs: plan.dims.m * plan.dims.n * plan.dims.k,
        flags: plan.flags,
        passed: outcome.reason === null,
        reason: outcome.reason,
        mismatches: outcome.mismatches.length,
        firstMismatches: outcome.mismatches.slice(0, MAX_LISTED_MISMATCHES),
        cycles: outcome.cycles,
        saved: null,
      };
      results.push(result);
      if (outcome.reason !== null)
        failed.set(result, { task, files, outcome, command: run.command });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, () => worker()));
  let saved = 0;
  for (const result of sortCases(results)) {
    const failure = failed.get(result);
    if (failure === undefined) continue;
    if (saved < options.keepFailures) {
      saved += 1;
      const dir = join(options.failures, `${result.size}-${result.name}`);
      write(saveFailure({ ...failure, dir }));
      results[results.indexOf(result)] = { ...result, saved: dir };
    } else {
      write(`FAIL ${result.size} ${result.name}: ${result.reason ?? '-'} (not saved)\n`);
    }
  }

  const report = buildVerifyReport({
    seed: options.seed,
    countPerSize: options.random ? options.count : 0,
    corpora,
    provenance: options.provenance ?? readProvenance(),
    sims: sizes.map(({ size, sim }) => ({ ...size, sim: repoPath(sim) })),
    cases: results,
  });
  for (const s of report.sizes) {
    write(
      `  ${s.size.padEnd(6)} ${String(s.cases).padStart(4)} cases (${String(s.directed)} directed, ${String(s.random)} random): ${String(s.passed)} passed, ${String(s.failed)} failed\n`,
    );
  }
  const { totals } = report;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failures = report.cases.filter((c) => !c.passed);
  if (report.passed) {
    write(
      `verify: PASS, ${String(totals.passed)}/${String(totals.cases)} cases (${String(totals.directed)} directed, ${String(totals.random)} random) match the reference element by element (${seconds} s)\n`,
    );
  } else {
    const names = failures.slice(0, 10).map((f) => `${f.size} ${f.name}`);
    const more = failures.length > 10 ? `, … ${String(failures.length - 10)} more` : '';
    write(
      `verify: FAIL, ${String(totals.failed)}/${String(totals.cases)} cases differ: ${names.join(', ')}${more} (${seconds} s)\n`,
    );
    if (saved > 0) {
      write(
        `failing cases saved under ${options.failures}/; replay one with 'make -C hardware/accelerators/matmul replay CASE=<dir>'\n`,
      );
    }
  }
  mkdirSync(options.reports, { recursive: true });
  const json = join(options.reports, 'verify.json');
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(options.reports, 'verify.md'), formatVerifyMarkdown(report));
  write(`wrote ${json} and verify.md\n`);
  return { exitCode: report.passed ? 0 : 1, report, failures };
}

/** A path relative to the repository root when it is inside it. */
function repoPath(path: string): string {
  const rel = relative(REPO, resolve(path));
  return rel.startsWith('..') ? path : rel;
}

/**
 * Reruns a saved failure with the same case, runner flags and runner (or `sim`), prints the
 * failure report and says whether it is the saved one. Exit code 1 while the case still fails, 0
 * once it passes, 2 when the directory is not a saved case.
 */
export async function replayCase(
  dir: string,
  sim: string | undefined,
  work: string,
  write: (text: string) => void,
): Promise<number> {
  let file: FailureCase;
  try {
    file = FailureCaseSchema.parse(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')));
  } catch (error) {
    write(
      `replay: ${dir} is not a saved failure: ${(error as Error).message.split('\n')[0] ?? ''}\n`,
    );
    return 2;
  }
  const runner = sim ?? file.sim;
  if (!existsSync(runner)) {
    write(`replay: no runner at ${runner}\n`);
    return 2;
  }
  const size = await runnerInfo(runner);
  if (size.rows !== file.rows || size.cols !== file.cols) {
    write(`replay: ${runner} is a ${sizeName(size)} runner; the case failed on ${file.size}\n`);
    return 2;
  }
  mkdirSync(work, { recursive: true });
  const files = {
    expected: join(dir, 'case.expected'),
    out: join(work, 'replay.out'),
    cycles: join(work, 'replay.cycles.json'),
  };
  write(`replay ${file.size} ${file.name} on ${runner}\n`);
  const run = await runRunner(runner, [
    '--case',
    join(dir, 'case.in'),
    '--out',
    files.out,
    '--cycles',
    files.cycles,
    '--max-cycles',
    String(cycleLimit(size, file.dims)),
    '--quiet',
    ...runnerFlagArgs(file.flags),
  ]);
  const plan = {
    name: file.name,
    kind: file.caseKind,
    generator: file.generator as CaseGenerator,
    dims: file.dims,
    seed: file.seed,
    flags: file.flags,
    what: file.what,
  };
  const outcome = judge(plan, run, files);
  const report = formatFailureReport(file.size, plan, outcome, replayCommand(resolve(dir)));
  if (report === null) {
    write(`PASS ${file.size} ${file.name}: C matches the reference element by element\n`);
    return 0;
  }
  write(report);
  const savedReport = join(dir, 'report.txt');
  if (existsSync(savedReport)) {
    write(
      readFileSync(savedReport, 'utf8') === report
        ? 'replay: the same mismatch as the saved report.txt\n'
        : 'replay: the report differs from the saved report.txt\n',
    );
  }
  return 1;
}
