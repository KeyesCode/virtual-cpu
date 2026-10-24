import { resolve } from 'node:path';
import { writePeVectors } from './harness/pe-vectors.js';
import { tileCaseName, writeTileCase, writeTileSuite } from './harness/tile-vectors.js';
import { writeCase } from './harness/vectors.js';
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

const COMMANDS: Readonly<Record<string, Command>> = {
  'gen-vectors': genVectors,
  'gen-pe-vectors': genPeVectors,
  'gen-tile-vectors': genTileVectors,
  'gen-tile-suite': genTileSuite,
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
