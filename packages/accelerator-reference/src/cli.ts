import { resolve } from 'node:path';
import { writePeVectors } from './harness/pe-vectors.js';
import { tileCaseName, writeTileCase, writeTileSuite } from './harness/tile-vectors.js';
import { MUTANTS_DEFAULTS, runMutants } from './harness/mutants.js';
import { writeTopSuite } from './harness/top-vectors.js';
import { writeCase } from './harness/vectors.js';
import { defaultVerifyOptions, replayCase, runVerify, VERIFY_DEFAULTS } from './harness/verify.js';
import { writeVisualizations } from './viz/page.js';
import { MAX_DIM, validateDims } from './model/matmul.js';
import {
  GENERATOR_DESCRIPTIONS,
  GENERATOR_NAMES,
  type GeneratorName,
  generateOperands,
  isGeneratorName,
} from './model/prng.js';

// `pnpm --filter @vcpu/accelerator-reference …` runs this from packages/accelerator-reference;
// INIT_CWD is the directory pnpm was started in, so a relative --out resolves where the user typed it.
// A make recipe that runs this under a root `pnpm accel:*` script inherits the repo root as INIT_CWD,
// so recipes pass absolute paths ($(BUILD_DIR)/…).
const cwd = process.env.INIT_CWD ?? process.cwd();

const GENERATORS = GENERATOR_NAMES.map(
  (name) => `    ${name.padEnd(10)}${GENERATOR_DESCRIPTIONS[name]}`,
).join('\n');

const USAGE = `Usage: tsx src/cli.ts <command> [options]

Commands:
  gen-vectors --seed S --m M --n N --k K --out <dir> [--generator G] [--name <name>]
                                         Write one matmul test case, C = A (M × K) × B (K × N), as
                                         <dir>/<name>.in (M N K, then A, then B), <name>.expected
                                         (C, INT32 with wrap-around) and the <name>.json sidecar.
                                         M, N and K are 1 … ${String(MAX_DIM)}. The default generator is random,
                                         the default name <generator>-m<M>-n<N>-k<K>-s<S>.
  Generators:
${GENERATORS}
  gen-pe-vectors --seed S --count N --out <file>
                                         Write the processing-element unit-test vectors: the
                                         directed segments, then N random clocks from seed S, one
                                         line per clock with the outputs the clock-level PE model
                                         expects (format in src/harness/pe-vectors.ts).
  gen-tile-vectors --rows R --cols C --k K --seed S --out <dir> [--generator G] [--name <name>]
                                         Write one systolic-array tile case: gen-vectors with
                                         M = R and N = C, so C is a single R × C output tile.
                                         The default name is <generator>-<R>x<C>-k<K>-s<S>.
  gen-tile-suite --rows R --cols C --seed S --count N --out <dir>
                                         Write the array unit-test suite into <dir>: the directed
                                         tiles, then N random tiles (K and seed drawn from S), and
                                         <dir>/cases.txt, the case names in run order.
  gen-top-suite --rows R --cols C --seed S --count N --out <dir>
                                         Write the matmul_top unit-test suite into <dir>: the
                                         directed products (two of them reuse the buffers of the
                                         first), then N random products (M, N, K and seed drawn
                                         from S), and <dir>/cases.txt, the case names in run order
                                         (' reuse' after a case that reuses the buffers).
  gen-viz                                Regenerate docs/hardware/accelerators/images/: the 4 × 4
                                         dataflow SVG and the trace embedded in systolic-4x4.html,
                                         both from the timing rule in src/viz/schedule.ts.
  verify --sim <bin> [--sim <bin> …] [--seed S] [--count N] [--jobs J] [--work <dir>]
         [--failures <dir>] [--reports <dir>] [--directed-only | --random-only]
                                         Differential verification: for each runner
                                         (build/sim-<R>x<C>/matmul_sim, which reports its own size)
                                         the directed corpus and N random cases (default ${String(VERIFY_DEFAULTS.count)}) from
                                         seed S (default ${String(VERIFY_DEFAULTS.seed)}), C compared element by element with the
                                         reference; failures saved under --failures, the report in
                                         --reports/verify.{json,md}. Exit 1 on any failing case.
  verify --replay <dir> [--sim <bin>] [--work <dir>]
                                         Rerun a saved failure (on its own runner unless --sim) and
                                         compare the report with its report.txt. Exit 1 while it fails.
  mutants --verilator <bin> [--seed S] [--count N] [--only <id>] [--jobs J]
                                         Build a runner from each mutant of rtl/ in
                                         scripts/mutants.txt at 4x4, 8x8 and 16x16 and require
                                         verify (directed + N random per size, default ${String(MUTANTS_DEFAULTS.count)}) to fail.
`;

type Command = (args: readonly string[]) => number | Promise<number>;

/** A non-negative decimal integer, or undefined. */
function parseCount(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

const GEN_VECTORS_FLAGS = ['--seed', '--m', '--n', '--k', '--out', '--generator', '--name'];

function genVectors(args: readonly string[]): number {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    if (!GEN_VECTORS_FLAGS.includes(flag)) {
      process.stderr.write(`gen-vectors: unexpected argument ${flag}\n${USAGE}`);
      return 2;
    }
    if (value === undefined) {
      process.stderr.write(`gen-vectors: ${flag} needs a value\n${USAGE}`);
      return 2;
    }
    if (values.has(flag)) {
      process.stderr.write(`gen-vectors: ${flag} given twice\n`);
      return 2;
    }
    values.set(flag, value);
  }
  const missing = ['--seed', '--m', '--n', '--k', '--out'].filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    process.stderr.write(`gen-vectors: missing ${missing.join(', ')}\n${USAGE}`);
    return 2;
  }
  const numbers: Partial<Record<'seed' | 'm' | 'n' | 'k', number>> = {};
  for (const key of ['seed', 'm', 'n', 'k'] as const) {
    const raw = values.get(`--${key}`) ?? '';
    const parsed = parseCount(raw);
    if (parsed === undefined || !Number.isSafeInteger(parsed)) {
      process.stderr.write(`gen-vectors: --${key} must be a non-negative integer, got '${raw}'\n`);
      return 2;
    }
    numbers[key] = parsed;
  }
  const { seed = 0, m = 0, n = 0, k = 0 } = numbers;
  const generatorArg = values.get('--generator') ?? 'random';
  if (!isGeneratorName(generatorArg)) {
    process.stderr.write(
      `gen-vectors: --generator must be one of ${GENERATOR_NAMES.join(', ')}, got '${generatorArg}'\n`,
    );
    return 2;
  }
  const generator: GeneratorName = generatorArg;
  const dims = { m, n, k };
  try {
    validateDims(dims);
  } catch (error) {
    process.stderr.write(
      `gen-vectors: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const name =
    values.get('--name') ??
    `${generator}-m${String(m)}-n${String(n)}-k${String(k)}-s${String(seed)}`;
  const operands = generateOperands(generator, seed, dims);
  const written = writeCase(
    resolve(cwd, values.get('--out') ?? ''),
    name,
    { ...dims, ...operands },
    { seed, generator },
  );
  for (const file of [written.input, written.expected, written.meta]) {
    process.stdout.write(`wrote ${file}\n`);
  }
  process.stdout.write(
    `${String(written.caseMeta.macs)} MACs, fitsInt32 ${String(written.caseMeta.fitsInt32)}, max |C| ${String(written.caseMeta.maxAbsExact)}\n`,
  );
  return 0;
}

const GEN_PE_VECTORS_FLAGS = ['--seed', '--count', '--out'];

function genPeVectors(args: readonly string[]): number {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    if (!GEN_PE_VECTORS_FLAGS.includes(flag)) {
      process.stderr.write(`gen-pe-vectors: unexpected argument ${flag}\n${USAGE}`);
      return 2;
    }
    if (value === undefined) {
      process.stderr.write(`gen-pe-vectors: ${flag} needs a value\n${USAGE}`);
      return 2;
    }
    if (values.has(flag)) {
      process.stderr.write(`gen-pe-vectors: ${flag} given twice\n`);
      return 2;
    }
    values.set(flag, value);
  }
  const missing = GEN_PE_VECTORS_FLAGS.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    process.stderr.write(`gen-pe-vectors: missing ${missing.join(', ')}\n${USAGE}`);
    return 2;
  }
  const seedRaw = values.get('--seed') ?? '';
  const seed = parseCount(seedRaw);
  if (seed === undefined || !Number.isSafeInteger(seed)) {
    process.stderr.write(
      `gen-pe-vectors: --seed must be a non-negative integer, got '${seedRaw}'\n`,
    );
    return 2;
  }
  const countRaw = values.get('--count') ?? '';
  const count = parseCount(countRaw);
  if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
    process.stderr.write(`gen-pe-vectors: --count must be a positive integer, got '${countRaw}'\n`);
    return 2;
  }
  const file = resolve(cwd, values.get('--out') ?? '');
  const vectors = writePeVectors(file, seed, count);
  const directed = vectors.segments.filter((segment) => !segment.random).length;
  process.stdout.write(
    `wrote ${file}: ${String(vectors.clocks)} clocks, ${String(vectors.clocks - vectors.randomClocks)} directed in ${String(directed)} segments and ${String(vectors.randomClocks)} random from seed ${String(seed)}\n`,
  );
  return 0;
}

/**
 * The `--flag value` pairs of `command`, each flag in `allowed` at most once and every one in
 * `required` present; otherwise writes the problem to stderr and returns undefined.
 */
function parseFlags(
  command: string,
  args: readonly string[],
  allowed: readonly string[],
  required: readonly string[],
): Map<string, string> | undefined {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    if (!allowed.includes(flag)) {
      process.stderr.write(`${command}: unexpected argument ${flag}\n${USAGE}`);
      return undefined;
    }
    if (value === undefined) {
      process.stderr.write(`${command}: ${flag} needs a value\n${USAGE}`);
      return undefined;
    }
    if (values.has(flag)) {
      process.stderr.write(`${command}: ${flag} given twice\n`);
      return undefined;
    }
    values.set(flag, value);
  }
  const missing = required.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    process.stderr.write(`${command}: missing ${missing.join(', ')}\n${USAGE}`);
    return undefined;
  }
  return values;
}

/** The non-negative integer values of `keys` (`--<key>`), or undefined after reporting one. */
function parseCounts<Key extends string>(
  command: string,
  values: ReadonlyMap<string, string>,
  keys: readonly Key[],
): Record<Key, number> | undefined {
  const numbers: Partial<Record<Key, number>> = {};
  for (const key of keys) {
    const raw = values.get(`--${key}`) ?? '';
    const parsed = parseCount(raw);
    if (parsed === undefined || !Number.isSafeInteger(parsed)) {
      process.stderr.write(`${command}: --${key} must be a non-negative integer, got '${raw}'\n`);
      return undefined;
    }
    numbers[key] = parsed;
  }
  return numbers as Record<Key, number>;
}

function genTileVectors(args: readonly string[]): number {
  const values = parseFlags(
    'gen-tile-vectors',
    args,
    ['--rows', '--cols', '--k', '--seed', '--out', '--generator', '--name'],
    ['--rows', '--cols', '--k', '--seed', '--out'],
  );
  const numbers =
    values && parseCounts('gen-tile-vectors', values, ['rows', 'cols', 'k', 'seed'] as const);
  if (values === undefined || numbers === undefined) {
    return 2;
  }
  const generatorArg = values.get('--generator') ?? 'random';
  if (!isGeneratorName(generatorArg)) {
    process.stderr.write(
      `gen-tile-vectors: --generator must be one of ${GENERATOR_NAMES.join(', ')}, got '${generatorArg}'\n`,
    );
    return 2;
  }
  const { rows, cols, k, seed } = numbers;
  const array = { rows, cols };
  try {
    validateDims({ m: rows, n: cols, k });
  } catch (error) {
    process.stderr.write(
      `gen-tile-vectors: ${error instanceof Error ? error.message : String(error)} (M is --rows, N is --cols)\n`,
    );
    return 2;
  }
  const name = values.get('--name') ?? tileCaseName(array, generatorArg, k, seed);
  const written = writeTileCase(resolve(cwd, values.get('--out') ?? ''), array, {
    name,
    generator: generatorArg,
    k,
    seed,
  });
  for (const file of [written.input, written.expected, written.meta]) {
    process.stdout.write(`wrote ${file}\n`);
  }
  return 0;
}

function genTileSuite(args: readonly string[]): number {
  const flags = ['--rows', '--cols', '--seed', '--count', '--out'];
  const values = parseFlags('gen-tile-suite', args, flags, flags);
  const numbers =
    values && parseCounts('gen-tile-suite', values, ['rows', 'cols', 'seed', 'count'] as const);
  if (values === undefined || numbers === undefined) {
    return 2;
  }
  const { rows, cols, seed, count } = numbers;
  try {
    validateDims({ m: rows, n: cols, k: 1 });
  } catch (error) {
    process.stderr.write(
      `gen-tile-suite: ${error instanceof Error ? error.message : String(error)} (M is --rows, N is --cols)\n`,
    );
    return 2;
  }
  const dir = resolve(cwd, values.get('--out') ?? '');
  const suite = writeTileSuite(dir, { rows, cols, seed, count });
  const random = suite.cases.filter((testCase) => testCase.random).length;
  process.stdout.write(
    `wrote ${String(suite.cases.length)} ${String(rows)}x${String(cols)} tile cases to ${dir} (${String(suite.cases.length - random)} directed, ${String(random)} random from seed ${String(seed)}) and ${suite.list}\n`,
  );
  return 0;
}

function genTopSuite(args: readonly string[]): number {
  const flags = ['--rows', '--cols', '--seed', '--count', '--out'];
  const values = parseFlags('gen-top-suite', args, flags, flags);
  const numbers =
    values && parseCounts('gen-top-suite', values, ['rows', 'cols', 'seed', 'count'] as const);
  if (values === undefined || numbers === undefined) {
    return 2;
  }
  const { rows, cols, seed, count } = numbers;
  try {
    validateDims({ m: rows, n: cols, k: 1 });
  } catch (error) {
    process.stderr.write(
      `gen-top-suite: ${error instanceof Error ? error.message : String(error)} (M is --rows, N is --cols)\n`,
    );
    return 2;
  }
  const dir = resolve(cwd, values.get('--out') ?? '');
  const suite = writeTopSuite(dir, { rows, cols, seed, count });
  const random = suite.cases.filter((testCase) => testCase.random).length;
  process.stdout.write(
    `wrote ${String(suite.cases.length)} matmul cases for a ${String(rows)}x${String(cols)} array to ${dir} (${String(suite.cases.length - random)} directed, ${String(random)} random from seed ${String(seed)}) and ${suite.list}\n`,
  );
  return 0;
}

function genViz(args: readonly string[]): number {
  if (args.length > 0) {
    process.stderr.write(`gen-viz: takes no arguments, got ${args.join(' ')}\n`);
    return 2;
  }
  for (const path of writeVisualizations()) {
    process.stdout.write(`wrote ${path}\n`);
  }
  return 0;
}

/**
 * The arguments of `command`: `--flag value` pairs for `valued` (those in `repeatable` may repeat,
 * the others not) and bare `switches`; otherwise writes the problem to stderr and returns
 * undefined.
 */
function parseArgs(
  command: string,
  args: readonly string[],
  valued: readonly string[],
  switches: readonly string[],
  repeatable: readonly string[] = [],
): { values: Map<string, string[]>; set: Set<string> } | undefined {
  const values = new Map<string, string[]>();
  const set = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] ?? '';
    if (switches.includes(flag)) {
      set.add(flag);
      continue;
    }
    if (!valued.includes(flag)) {
      process.stderr.write(`${command}: unexpected argument ${flag}\n${USAGE}`);
      return undefined;
    }
    const value = args[i + 1];
    if (value === undefined) {
      process.stderr.write(`${command}: ${flag} needs a value\n${USAGE}`);
      return undefined;
    }
    const list = values.get(flag) ?? [];
    if (list.length > 0 && !repeatable.includes(flag)) {
      process.stderr.write(`${command}: ${flag} given twice\n`);
      return undefined;
    }
    list.push(value);
    values.set(flag, list);
    i += 1;
  }
  return { values, set };
}

/** The value of a count flag, `fallback` when absent, or undefined after reporting it. */
function countFlag(
  command: string,
  values: ReadonlyMap<string, readonly string[]>,
  flag: string,
  fallback: number,
  min = 0,
): number | undefined {
  const raw = values.get(flag)?.[0];
  if (raw === undefined) return fallback;
  const parsed = parseCount(raw);
  if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < min) {
    process.stderr.write(
      `${command}: ${flag} must be an integer of at least ${String(min)}, got '${raw}'\n`,
    );
    return undefined;
  }
  return parsed;
}

async function verify(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(
    'verify',
    args,
    ['--sim', '--seed', '--count', '--jobs', '--work', '--failures', '--reports', '--replay'],
    ['--directed-only', '--random-only'],
    ['--sim'],
  );
  if (parsed === undefined) return 2;
  const { values, set } = parsed;
  const path = (flag: string) => {
    const value = values.get(flag)?.[0];
    return value === undefined ? undefined : resolve(cwd, value);
  };
  const sims = (values.get('--sim') ?? []).map((sim) => resolve(cwd, sim));
  const write = (text: string) => process.stdout.write(text);
  const replay = path('--replay');
  if (replay !== undefined) {
    if (sims.length > 1) {
      process.stderr.write('verify --replay: at most one --sim\n');
      return 2;
    }
    return replayCase(replay, sims[0], path('--work') ?? VERIFY_DEFAULTS.work, write);
  }
  if (set.has('--directed-only') && set.has('--random-only')) {
    process.stderr.write('verify: --directed-only and --random-only exclude each other\n');
    return 2;
  }
  const defaults = defaultVerifyOptions(sims);
  const seed = countFlag('verify', values, '--seed', defaults.seed);
  const count = countFlag('verify', values, '--count', defaults.count);
  const jobs = countFlag('verify', values, '--jobs', defaults.jobs, 1);
  if (seed === undefined || count === undefined || jobs === undefined) return 2;
  const outcome = await runVerify(
    {
      ...defaults,
      seed,
      count,
      jobs,
      directed: !set.has('--random-only'),
      random: !set.has('--directed-only'),
      work: path('--work') ?? defaults.work,
      failures: path('--failures') ?? defaults.failures,
      reports: path('--reports') ?? defaults.reports,
    },
    write,
  );
  return outcome.exitCode;
}

async function mutants(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(
    'mutants',
    args,
    ['--verilator', '--seed', '--count', '--only', '--jobs'],
    [],
  );
  if (parsed === undefined) return 2;
  const { values } = parsed;
  const verilator = values.get('--verilator')?.[0];
  if (verilator === undefined) {
    process.stderr.write(`mutants: missing --verilator\n${USAGE}`);
    return 2;
  }
  const defaults = defaultVerifyOptions([]);
  const seed = countFlag('mutants', values, '--seed', defaults.seed);
  const count = countFlag('mutants', values, '--count', MUTANTS_DEFAULTS.count);
  const jobs = countFlag('mutants', values, '--jobs', defaults.jobs, 1);
  if (seed === undefined || count === undefined || jobs === undefined) return 2;
  return runMutants(
    {
      ...MUTANTS_DEFAULTS,
      verilator,
      only: values.get('--only')?.[0],
      verify: { ...defaults, seed, count, jobs },
    },
    (text) => process.stdout.write(text),
  );
}

const COMMANDS: Readonly<Record<string, Command>> = {
  'gen-vectors': genVectors,
  'gen-pe-vectors': genPeVectors,
  'gen-tile-vectors': genTileVectors,
  'gen-tile-suite': genTileSuite,
  'gen-top-suite': genTopSuite,
  'gen-viz': genViz,
  verify,
  mutants,
};

const [name, ...rest] = process.argv.slice(2);
const command = name === undefined ? undefined : COMMANDS[name];
if (command === undefined) {
  process.stderr.write(name === undefined ? USAGE : `Unknown command ${name}\n${USAGE}`);
  process.exitCode = 2;
} else {
  Promise.resolve()
    .then(() => command(rest))
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error: unknown) => {
        process.stderr.write(
          `${name ?? ''}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 2;
      },
    );
}
