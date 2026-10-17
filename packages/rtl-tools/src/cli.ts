import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ALU_VECTORS_PATH, renderAluVectors } from './gen/alu-vectors.js';
import { ISA_PKG_PATH, renderIsaPackage } from './gen/isa-pkg.js';

// `pnpm --filter @vcpu/rtl-tools …` runs this from packages/rtl-tools; INIT_CWD is the directory
// pnpm was started in, so a relative --out resolves where the user typed it.
const cwd = process.env.INIT_CWD ?? process.cwd();

const USAGE = `Usage: tsx src/cli.ts <command> [options]

Commands:
  gen-isa [--out <file>]            Write the generated ISA package (default: ${ISA_PKG_PATH})
  gen-alu-vectors [--out <file>]    Write the exhaustive ALU vectors and, beside them, a .meta file
                                    holding the record count (default: ${ALU_VECTORS_PATH})
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

const COMMANDS: Readonly<Record<string, Command>> = {
  'gen-isa': genIsa,
  'gen-alu-vectors': genAluVectors,
};

const [name, ...rest] = process.argv.slice(2);
const command = name === undefined ? undefined : COMMANDS[name];
if (command === undefined) {
  process.stderr.write(name === undefined ? USAGE : `Unknown command ${name}\n${USAGE}`);
  process.exitCode = 2;
} else {
  process.exitCode = command(rest);
}
