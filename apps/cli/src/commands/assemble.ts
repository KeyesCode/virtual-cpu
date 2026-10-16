import { writeFileSync } from 'node:fs';
import type { AssembleResult } from '@vcpu/assembler';
import { HELP_OPTION, parseCommandLine, singleFile } from '../args.js';
import { bytesHex, hex } from '../format/hex.js';
import { type CliIo, ExitCode, println, resolvePath, UsageError } from '../io.js';
import { assembleFile, binaryImage, programKind } from '../program.js';
import type { Command } from './command.js';

const help = `Usage: pnpm cpu assemble <file.asm> [-o out.bin] [--symbols] [--listing]

Assembles VCPU-8 source into raw machine code. Diagnostics are printed to stderr as
file:line:col with the source line and a caret under the problem.

The output holds the bytes from address 0x00 to the last emitted byte, ready for
\`pnpm cpu run\` or \`pnpm cpu disassemble\` (a .bin always loads at 0x00).

Options:
  -o, --output <file>   Where to write the bytes (default: <file> with a .bin extension)
      --symbols         Print the symbol table (labels and .equ constants)
      --listing         Print each statement with its address and bytes
  -h, --help            Show this help

Exit codes: 0 assembled, 1 assembly errors, 64 usage error.`;

function run(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseCommandLine(args, {
    ...HELP_OPTION,
    output: { type: 'string', short: 'o' },
    symbols: { type: 'boolean' },
    listing: { type: 'boolean' },
  });
  if (values.help === true) {
    println(io.stdout, help);
    return ExitCode.OK;
  }
  const file = singleFile(positionals, 'the <file.asm> to assemble');
  programKind(file, ['asm']);
  const output = values.output ?? file.replace(/\.asm$/i, '.bin');

  const { result } = assembleFile(io, file);
  const image = binaryImage(result);
  try {
    writeFileSync(resolvePath(io, output), image);
  } catch (error) {
    throw new UsageError(
      `${output}: cannot write file (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`,
    );
  }

  const ranges = result.bytes.ranges.map((r) => `${hex(r.start)}–${hex(r.end)}`).join(', ');
  const used = result.bytes.ranges.reduce((sum, r) => sum + r.end - r.start + 1, 0);
  println(
    io.stdout,
    `Assembled ${file}: ${String(used)} byte${used === 1 ? '' : 's'}${ranges === '' ? '' : ` at ${ranges}`}; wrote ${String(image.length)} to ${output}`,
  );
  if (values.listing === true) {
    println(io.stdout);
    println(io.stdout, formatListing(result));
  }
  if (values.symbols === true) {
    println(io.stdout);
    println(io.stdout, formatSymbols(result));
  }
  return ExitCode.OK;
}

/** Address, bytes, source line and statement, one row per statement. */
export function formatListing(result: AssembleResult): string {
  const rows: { address: number; bytes: number[]; line: number; text: string }[] = [];
  const entries = [...result.sourceMap.values()].sort((x, y) => x.address - y.address);
  for (const entry of entries) {
    const bytes = Array.from(result.bytes.image.slice(entry.address, entry.address + entry.length));
    const previous = rows.at(-1);
    // The values of one `.byte` statement are separate entries; show them on one row.
    if (
      previous?.line === entry.line &&
      previous.address + previous.bytes.length === entry.address
    ) {
      previous.bytes.push(...bytes);
    } else {
      rows.push({ address: entry.address, bytes, line: entry.line, text: entry.text });
    }
  }
  if (rows.length === 0) return 'Listing\n  (no output)';
  const width = Math.max(8, ...rows.map((r) => bytesHex(r.bytes).length)) + 2;
  return [
    'Listing',
    `  Addr  ${'Bytes'.padEnd(width)}Line  Source`,
    ...rows.map(
      (r) =>
        `  ${hex(r.address)}  ${bytesHex(r.bytes).padEnd(width)}${String(r.line).padStart(4)}  ${r.text}`,
    ),
  ].join('\n');
}

/** Labels and `.equ` constants, in definition order. */
export function formatSymbols(result: AssembleResult): string {
  const symbols = [...result.symbols.values()];
  if (symbols.length === 0) return 'Symbols\n  (none)';
  const width = Math.max(4, ...symbols.map((s) => s.name.length)) + 2;
  const value = (v: number): string => (v >= 0 && v <= 0xff ? hex(v) : String(v));
  return [
    'Symbols',
    `  ${'Name'.padEnd(width)}Kind   Value  Line`,
    ...symbols.map(
      (s) =>
        `  ${s.name.padEnd(width)}${s.kind.padEnd(7)}${value(s.value).padEnd(7)}${String(s.line)}`,
    ),
  ].join('\n');
}

export const assembleCommand: Command = {
  name: 'assemble',
  synopsis: 'assemble <file.asm>',
  summary: 'Assemble a source file into machine code',
  help,
  run,
};
