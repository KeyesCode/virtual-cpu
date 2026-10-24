import { resolve } from 'node:path';
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
`;

type Command = (args: readonly string[]) => number | Promise<number>;

/** A non-negative decimal integer, or undefined. */
function parseCount(value: string): number | undefined {
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

function genVectors(args: readonly string[]): number {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    const known = ['--seed', '--m', '--n', '--k', '--out', '--generator', '--name'];
    if (!known.includes(flag) || value === undefined || values.has(flag)) {
      process.stderr.write(`gen-vectors: unexpected argument ${flag}\n${USAGE}`);
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

const COMMANDS: Readonly<Record<string, Command>> = {
  'gen-vectors': genVectors,
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
