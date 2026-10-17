import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assembleToHex } from './assemble.js';
import { FIXTURES_DEFAULTS, type FixturesOptions, runFixtures } from './commands/fixtures.js';
import { parseTarget, runSynthCompare, runSynthSummary } from './commands/synth.js';
import { writeTamperedFixtures } from './commands/tamper-fixtures.js';
import { ALU_VECTORS_PATH, renderAluVectors } from './gen/alu-vectors.js';
import { writeDecoderVectors } from './gen/decoder-vectors.js';
import { ISA_PKG_PATH, renderIsaPackage } from './gen/isa-pkg.js';

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
  synth-summary --dir <dir> --allow <file> --toolchain <dir|PATH> --toolchain-version <v>
                --init-file <file> --seed <n> --ice40 <device>:<package> --ecp5 <device>:<package>:<speed>
                                         Parse the outputs of \`make synth\` in <dir>, write summary.json
                                         and summary.md there, and exit 1 on a warning not in <file>
  synth-compare --baseline <file> --summary <file>
                                         Print the deltas between a synthesis summary and the baseline
`;

type Command = (args: readonly string[]) => number;

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

/** `--flag value` pairs into a record, or undefined (after a usage message) on anything else. */
function parseFlags(
  command: string,
  args: readonly string[],
  flags: readonly string[],
): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i] ?? '';
    const value = args[i + 1];
    if (!flags.includes(flag) || value === undefined) {
      process.stderr.write(`${command}: unexpected argument ${flag}\n${USAGE}`);
      return undefined;
    }
    values[flag] = value;
  }
  const missing = flags.filter((flag) => !(flag in values));
  if (missing.length > 0) {
    process.stderr.write(`${command}: missing ${missing.join(', ')}\n${USAGE}`);
    return undefined;
  }
  return values;
}

function synthSummary(args: readonly string[]): number {
  const flags = [
    '--dir',
    '--allow',
    '--toolchain',
    '--toolchain-version',
    '--init-file',
    '--seed',
    '--ice40',
    '--ecp5',
  ] as const;
  const v = parseFlags('synth-summary', args, flags);
  if (v === undefined) {
    return 2;
  }
  const ice40 = parseTarget('ice40', v['--ice40'] ?? '');
  const ecp5 = parseTarget('ecp5', v['--ecp5'] ?? '');
  const seed = Number(v['--seed']);
  if (ice40 === undefined || ecp5 === undefined || !Number.isInteger(seed)) {
    process.stderr.write(`synth-summary: bad --ice40, --ecp5 or --seed\n${USAGE}`);
    return 2;
  }
  return runSynthSummary(
    {
      dir: resolve(cwd, v['--dir'] ?? ''),
      allow: resolve(cwd, v['--allow'] ?? ''),
      toolchain: v['--toolchain'] ?? 'PATH',
      toolchainVersion: v['--toolchain-version'] ?? '',
      initFile: resolve(cwd, v['--init-file'] ?? ''),
      seed,
      targets: [ice40, ecp5],
    },
    (text) => process.stdout.write(text),
  );
}

function synthCompare(args: readonly string[]): number {
  const v = parseFlags('synth-compare', args, ['--baseline', '--summary']);
  if (v === undefined) {
    return 2;
  }
  return runSynthCompare(
    resolve(cwd, v['--baseline'] ?? ''),
    resolve(cwd, v['--summary'] ?? ''),
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
  'synth-summary': synthSummary,
  'synth-compare': synthCompare,
};

const [name, ...rest] = process.argv.slice(2);
const command = name === undefined ? undefined : COMMANDS[name];
if (command === undefined) {
  process.stderr.write(name === undefined ? USAGE : `Unknown command ${name}\n${USAGE}`);
  process.exitCode = 2;
} else {
  process.exitCode = command(rest);
}
