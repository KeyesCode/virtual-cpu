import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assembleToHex } from './assemble.js';
import { FIXTURES_DEFAULTS, type FixturesOptions, runFixtures } from './commands/fixtures.js';
import { MUTANTS_DEFAULTS, runMutants } from './commands/mutants.js';
import { writeTamperedFixtures } from './commands/tamper-fixtures.js';
import {
  defaultVerifyOptions,
  promoteCase,
  replayCase,
  VERIFY_DEFAULTS,
  type VerifyOptions,
  runVerify,
} from './commands/verify.js';
import { ALU_VECTORS_PATH, renderAluVectors } from './gen/alu-vectors.js';
import { writeDecoderVectors } from './gen/decoder-vectors.js';
import { ISA_PKG_PATH, renderIsaPackage } from './gen/isa-pkg.js';
import { CORPORA } from './verify/corpora.js';

// `pnpm --filter @vcpu/rtl-tools …` runs this from packages/rtl-tools; INIT_CWD is the directory
// pnpm was started in, so a relative --out resolves where the user typed it.
const cwd = process.env.INIT_CWD ?? process.cwd();

const USAGE = `Usage: tsx src/cli.ts <command> [options]

Commands:
  gen-isa [--out <file>]                 Write the generated ISA package (default: ${ISA_PKG_PATH})
  gen-alu-vectors [--out <file>]         Write the exhaustive ALU vectors and, beside them, a .meta file
                                         holding the record count (default: ${ALU_VECTORS_PATH})
  gen-decoder-vectors --out-dir <dir>    Write decoder-ops.hex and decoder-rb.hex for the decoder testbench
  assemble <file.asm> --out <file.hex>   Assemble a program into the 256-line image the RTL runner loads
  fixtures [--dir <dir>] [--filter <glob>] [--sim <bin>] [--work <dir>] [--report <file>]
                                         Run the fixtures on the RTL runner and compare the end state
                                         and the trace in lock-step (default: every fixture in
                                         ${FIXTURES_DEFAULTS.dir})
  tamper-fixtures --dir <dir> --out <dir>
                                         Write tampered copies of op-add and op-push-full-stack for
                                         \`make fixtures-tamper\`
  verify [--all] [--fixtures] [--examples] [--programs [<dir>]] [--regressions] [--random]
         [--seed S] [--count N] [--sim <bin>] [--work <dir>] [--failures <dir>] [--reports <dir>]
         [--jobs N]
                                         Run each program on @vcpu/cpu-core (live) and on the RTL
                                         runner and compare them in lock-step and at the end. No
                                         corpus flag, or --all, runs every corpus and requires full
                                         opcode and fault coverage (default seeds ${String(VERIFY_DEFAULTS.seed)}…${String(VERIFY_DEFAULTS.count)})
  verify --replay <case-dir> [--sim <bin>]
                                         Rerun a saved failure or a regression and print its report
  verify --promote <case-dir>            Copy a saved failure into tb/regressions/
  mutants --verilator <bin> [--list <file>] [--only <id>] [--seed S] [--count N] [--jobs N]
                                         Build each mutant of core/ (scripts/mutants.txt) into
                                         build/mutants/<id>/ and require verify to catch it
`;

type Command = (args: readonly string[]) => number | Promise<number>;

/** `[--out <file>]`, resolved against the user's directory; undefined after a usage error. */
function parseOut(command: string, args: readonly string[], fallback: string): string | undefined {
  let out = fallback;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i + 1];
    if (args[i] === '--out' && value !== undefined) {
      out = resolve(cwd, value);
      i += 1;
    } else {
      process.stderr.write(`${command}: unexpected argument ${String(args[i])}\n${USAGE}`);
      return undefined;
    }
  }
  return out;
}

function genIsa(args: readonly string[]): number {
  const out = parseOut('gen-isa', args, ISA_PKG_PATH);
  if (out === undefined) {
    return 2;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderIsaPackage());
  process.stdout.write(`wrote ${out}\n`);
  return 0;
}

function genAluVectors(args: readonly string[]): number {
  const out = parseOut('gen-alu-vectors', args, ALU_VECTORS_PATH);
  if (out === undefined) {
    return 2;
  }
  const meta = out.replace(/(\.hex)?$/, '.meta');
  const { hex, count } = renderAluVectors();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, hex);
  writeFileSync(meta, `${String(count)}\n`);
  process.stdout.write(`wrote ${String(count)} ALU vectors to ${out}\n`);
  return 0;
}

function genDecoderVectors(args: readonly string[]): number {
  const [flag, value, ...extra] = args;
  if (flag !== '--out-dir' || value === undefined || extra.length > 0) {
    process.stderr.write(`gen-decoder-vectors: expected --out-dir <dir>\n${USAGE}`);
    return 2;
  }
  for (const file of writeDecoderVectors(resolve(cwd, value))) {
    process.stdout.write(`wrote ${file}\n`);
  }
  return 0;
}

function assembleCommand(args: readonly string[]): number {
  const [file, flag, value, ...extra] = args;
  if (file === undefined || flag !== '--out' || value === undefined || extra.length > 0) {
    process.stderr.write(`assemble: expected <file.asm> --out <file.hex>\n${USAGE}`);
    return 2;
  }
  const source = resolve(cwd, file);
  const result = assembleToHex(readFileSync(source, 'utf8'));
  if (!result.ok) {
    process.stderr.write(`assemble: ${source} does not assemble:\n${result.errors.join('\n')}\n`);
    return 1;
  }
  const out = resolve(cwd, value);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.hex);
  process.stdout.write(`assembled ${source} into ${out}\n`);
  return 0;
}

const FIXTURES_FLAGS = {
  '--dir': 'dir',
  '--filter': 'filter',
  '--sim': 'sim',
  '--work': 'work',
  '--report': 'report',
} as const satisfies Record<string, keyof FixturesOptions>;

function fixtures(args: readonly string[]): number {
  const options: { -readonly [K in keyof FixturesOptions]: FixturesOptions[K] } = {
    ...FIXTURES_DEFAULTS,
  };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const key = flag in FIXTURES_FLAGS ? FIXTURES_FLAGS[flag as keyof typeof FIXTURES_FLAGS] : null;
    const value = args[i + 1];
    if (key === null || value === undefined) {
      process.stderr.write(`fixtures: unexpected argument ${flag}\n${USAGE}`);
      return 2;
    }
    options[key] = key === 'filter' ? value : resolve(cwd, value);
  }
  return runFixtures(options, (text) => process.stdout.write(text));
}

function tamperFixtures(args: readonly string[]): number {
  const [dirFlag, dir, outFlag, out, ...extra] = args;
  if (
    dirFlag !== '--dir' ||
    dir === undefined ||
    outFlag !== '--out' ||
    out === undefined ||
    extra.length > 0
  ) {
    process.stderr.write(`tamper-fixtures: expected --dir <dir> --out <dir>\n${USAGE}`);
    return 2;
  }
  process.stdout.write(`${writeTamperedFixtures(resolve(cwd, dir), resolve(cwd, out))}\n`);
  return 0;
}

/** `--flag value` pairs and bare flags, or a usage error. */
function parseFlags(
  command: string,
  args: readonly string[],
  valued: readonly string[],
  bare: readonly string[],
): Map<string, string> | undefined {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    if (bare.includes(flag)) {
      // `--programs` may be followed by a directory.
      if (flag === '--programs' && value !== undefined && !value.startsWith('--')) {
        flags.set(flag, value);
        i += 1;
      } else {
        flags.set(flag, '');
      }
    } else if (valued.includes(flag) && value !== undefined) {
      flags.set(flag, value);
      i += 1;
    } else {
      process.stderr.write(`${command}: unexpected argument ${flag}\n${USAGE}`);
      return undefined;
    }
  }
  return flags;
}

function count(flags: Map<string, string>, flag: string, fallback: number): number {
  const text = flags.get(flag);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${flag} must be a non-negative integer, got ${text}`);
  }
  return value;
}

function verifyOptions(flags: Map<string, string>): VerifyOptions {
  const defaults = defaultVerifyOptions();
  const selected = CORPORA.filter((corpus) => flags.has(`--${corpus}`));
  const all = flags.has('--all') || selected.length === 0;
  const path = (flag: string, fallback: string) => {
    const value = flags.get(flag);
    return value === undefined || value === '' ? fallback : resolve(cwd, value);
  };
  return {
    ...defaults,
    corpora: all ? CORPORA : selected,
    requireCoverage: all,
    seed: count(flags, '--seed', defaults.seed),
    count: count(flags, '--count', defaults.count),
    jobs: Math.max(1, count(flags, '--jobs', defaults.jobs)),
    sim: path('--sim', defaults.sim),
    work: path('--work', defaults.work),
    failures: path('--failures', defaults.failures),
    reports: path('--reports', defaults.reports),
    programs: path('--programs', defaults.programs),
  };
}

const VERIFY_VALUED = [
  '--seed',
  '--count',
  '--sim',
  '--work',
  '--failures',
  '--reports',
  '--jobs',
  '--replay',
  '--promote',
];
const VERIFY_BARE = ['--all', ...CORPORA.map((corpus) => `--${corpus}`)];

async function verify(args: readonly string[]): Promise<number> {
  const flags = parseFlags('verify', args, VERIFY_VALUED, VERIFY_BARE);
  if (flags === undefined) return 2;
  const write = (text: string) => process.stdout.write(text);
  const replay = flags.get('--replay');
  if (replay !== undefined) {
    const sim = flags.get('--sim');
    return replayCase(
      resolve(cwd, replay),
      sim === undefined ? undefined : resolve(cwd, sim),
      VERIFY_DEFAULTS.work,
      write,
    );
  }
  const promote = flags.get('--promote');
  if (promote !== undefined) {
    return promoteCase(resolve(cwd, promote), VERIFY_DEFAULTS.regressions, write);
  }
  return (await runVerify(verifyOptions(flags), write)).exitCode;
}

async function mutants(args: readonly string[]): Promise<number> {
  const flags = parseFlags(
    'mutants',
    args,
    ['--verilator', '--list', '--only', '--seed', '--count', '--jobs', '--out', '--report'],
    [],
  );
  if (flags === undefined) return 2;
  const verilator = flags.get('--verilator');
  if (verilator === undefined) {
    process.stderr.write(`mutants: --verilator <bin> is required\n${USAGE}`);
    return 2;
  }
  return runMutants(
    {
      ...MUTANTS_DEFAULTS,
      list: flags.has('--list') ? resolve(cwd, flags.get('--list') ?? '') : MUTANTS_DEFAULTS.list,
      out: flags.has('--out') ? resolve(cwd, flags.get('--out') ?? '') : MUTANTS_DEFAULTS.out,
      report: flags.has('--report')
        ? resolve(cwd, flags.get('--report') ?? '')
        : MUTANTS_DEFAULTS.report,
      verilator,
      only: flags.get('--only'),
      verify: verifyOptions(flags),
    },
    (text) => process.stdout.write(text),
  );
}

const COMMANDS: Readonly<Record<string, Command>> = {
  'gen-isa': genIsa,
  'gen-alu-vectors': genAluVectors,
  'gen-decoder-vectors': genDecoderVectors,
  assemble: assembleCommand,
  fixtures,
  'tamper-fixtures': tamperFixtures,
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
