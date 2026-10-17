import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeDecoderVectors } from './gen/decoder-vectors.js';
import { ISA_PKG_PATH, renderIsaPackage } from './gen/isa-pkg.js';

// `pnpm --filter @vcpu/rtl-tools …` runs this from packages/rtl-tools; INIT_CWD is the directory
// pnpm was started in, so a relative --out resolves where the user typed it.
const cwd = process.env.INIT_CWD ?? process.cwd();

const USAGE = `Usage: tsx src/cli.ts <command> [options]

Commands:
  gen-isa [--out <file>]                 Write the generated ISA package (default: ${ISA_PKG_PATH})
  gen-decoder-vectors --out-dir <dir>    Write decoder-ops.hex and decoder-rb.hex for the decoder testbench
`;

type Command = (args: readonly string[]) => number;

function genIsa(args: readonly string[]): number {
  let out = ISA_PKG_PATH;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i + 1];
    if (args[i] === '--out' && value !== undefined) {
      out = resolve(cwd, value);
      i += 1;
    } else {
      process.stderr.write(`gen-isa: unexpected argument ${String(args[i])}\n${USAGE}`);
      return 2;
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderIsaPackage());
  process.stdout.write(`wrote ${out}\n`);
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

const COMMANDS: Readonly<Record<string, Command>> = {
  'gen-isa': genIsa,
  'gen-decoder-vectors': genDecoderVectors,
};

const [name, ...rest] = process.argv.slice(2);
const command = name === undefined ? undefined : COMMANDS[name];
if (command === undefined) {
  process.stderr.write(name === undefined ? USAGE : `Unknown command ${name}\n${USAGE}`);
  process.exitCode = 2;
} else {
  process.exitCode = command(rest);
}
