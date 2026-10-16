import { type DataReason, disassemble, type DisassemblyLine } from '@vcpu/assembler';
import { HELP_OPTION, parseAddress, parseCommandLine, singleFile } from '../args.js';
import { bytesHex, hex } from '../format/hex.js';
import { type CliIo, ExitCode, println, UsageError } from '../io.js';
import { programKind, readBinary } from '../program.js';
import type { Command } from './command.js';

const help = `Usage: pnpm cpu disassemble <file.bin> [--start ADDR] [--end ADDR]

Decodes raw machine code (loaded at 0x00) back into assembly, one line per instruction:
address, bytes, then the instruction. A byte that does not start a valid instruction is
shown as .byte with the reason.

Options:
      --start <ADDR>   First address to decode (default 0x00)
      --end <ADDR>     Last address to decode, inclusive (default: the last byte in the file)
  -h, --help           Show this help

Addresses are decimal, 0x hex or 0b binary. Exit codes: 0 ok, 64 usage error.`;

const REASONS: Record<DataReason, string> = {
  'invalid-opcode': 'invalid opcode',
  'malformed-operand': 'malformed register byte',
  truncated: 'instruction cut off by the end of the range',
};

export function formatDisassembly(lines: readonly DisassemblyLine[]): string {
  return lines
    .map((line) => {
      const note = line.reason === null ? '' : `  ; ${REASONS[line.reason]}`;
      return `${hex(line.address)}  ${bytesHex(line.bytes).padEnd(10)}${line.text}${note}`;
    })
    .join('\n');
}

function run(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseCommandLine(args, {
    ...HELP_OPTION,
    start: { type: 'string' },
    end: { type: 'string' },
  });
  if (values.help === true) {
    println(io.stdout, help);
    return ExitCode.OK;
  }
  const file = singleFile(positionals, 'the <file.bin> to disassemble');
  programKind(file, ['bin']);
  const start = values.start === undefined ? 0 : parseAddress(values.start, '--start');
  const bytes = readBinary(io, file);
  const end = values.end === undefined ? bytes.length - 1 : parseAddress(values.end, '--end');
  if (end >= bytes.length) {
    throw new UsageError(
      `--end ${hex(end)} is past the last byte of ${file} (${hex(bytes.length - 1)})`,
    );
  }
  if (start > end) {
    throw new UsageError(`--start ${hex(start)} is after --end ${hex(end)}`);
  }
  println(io.stdout, formatDisassembly(disassemble(bytes, { start, end })));
  return ExitCode.OK;
}

export const disassembleCommand: Command = {
  name: 'disassemble',
  synopsis: 'disassemble <file.bin>',
  summary: 'Turn machine code back into assembly',
  help,
  run,
};
