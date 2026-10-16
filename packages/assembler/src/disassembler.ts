import {
  INSTRUCTION_FORMATS,
  MEMORY_SIZE,
  REGISTER_BYTE_OFFSET,
  U8Schema,
  decodeRegisterByte,
  isU8,
  lookupOpcode,
  type OpcodeId,
  type OperandSpec,
} from '@vcpu/shared';
import { z } from 'zod';
import { hex } from './diagnostics.js';
import type { AssemblerSymbol } from './pass1.js';

export const DisassembleOptionsSchema = z
  .strictObject({
    /** First address to decode (default 0x00). */
    start: U8Schema.optional(),
    /** Last address to decode, inclusive (default: the last byte given). */
    end: U8Schema.optional(),
    /** Names to print for addresses, e.g. from `labelsFromSymbols(result.symbols)`. */
    labels: z.map(U8Schema, z.string()).optional(),
  })
  .refine((o) => o.start === undefined || o.end === undefined || o.start <= o.end, {
    message: 'start must not be after end',
    path: ['start'],
  });
export type DisassembleOptions = z.input<typeof DisassembleOptionsSchema>;

/** Why a byte was emitted as `.byte` rather than decoded. */
export type DataReason =
  | 'invalid-opcode' // no instruction has this opcode
  | 'malformed-operand' // the register byte breaks the format's rules
  | 'truncated'; // the instruction would run past `end`

export interface DisassemblyLine {
  readonly address: number;
  readonly bytes: readonly number[];
  /** Canonical assembly, e.g. `LOAD R1, [0x80]` or `.byte 0xFF`. */
  readonly text: string;
  readonly kind: 'instruction' | 'data';
  /** The decoded opcode, or `null` for data. */
  readonly opcodeId: OpcodeId | null;
  /** Set for data lines only. */
  readonly reason: DataReason | null;
  /** The label at this address, if `labels` names one. */
  readonly label: string | null;
}

/** Address → label name for every label symbol, first definition winning. */
export function labelsFromSymbols(
  symbols: ReadonlyMap<string, AssemblerSymbol>,
): Map<number, string> {
  const labels = new Map<number, string>();
  for (const symbol of symbols.values()) {
    if (symbol.kind === 'label' && isU8(symbol.value) && !labels.has(symbol.value)) {
      labels.set(symbol.value, symbol.name);
    }
  }
  return labels;
}

/**
 * Linear-sweep disassembler over `bytes[start..end]` (indexed by address). It is total: an
 * invalid opcode, a malformed register byte or an instruction cut off by `end` becomes
 * `.byte 0xNN` for that one byte, and decoding resumes at the next byte. Throws only for
 * invalid options or values that are not bytes at all.
 */
export function disassemble(
  bytes: Uint8Array | readonly number[],
  options: DisassembleOptions = {},
): DisassemblyLine[] {
  const parsed = DisassembleOptionsSchema.parse(options);
  if (bytes.length > MEMORY_SIZE) {
    throw new RangeError(
      `Expected at most ${String(MEMORY_SIZE)} bytes, got ${String(bytes.length)}`,
    );
  }
  const start = parsed.start ?? 0;
  const end = parsed.end ?? bytes.length - 1;
  if (end >= bytes.length) {
    throw new RangeError(
      `end ${hex(end)} is past the last byte given (${String(bytes.length)} bytes)`,
    );
  }
  const memory = Array.from(bytes);
  for (let address = start; address <= end; address += 1) {
    if (!isU8(memory[address])) {
      throw new RangeError(`Value at ${hex(address)} is not a byte: ${String(memory[address])}`);
    }
  }
  const labels = parsed.labels ?? new Map<number, string>();
  const byteAt = (address: number): number => memory[address] ?? 0;

  const lines: DisassemblyLine[] = [];
  let address = start;
  while (address <= end) {
    const line = decodeAt(address);
    lines.push(line);
    address += line.bytes.length;
  }
  return lines;

  function decodeAt(at: number): DisassemblyLine {
    const opcode = byteAt(at);
    const label = labels.get(at) ?? null;
    const data = (reason: DataReason): DisassemblyLine => ({
      address: at,
      bytes: [opcode],
      text: `.byte ${hex(opcode)}`,
      kind: 'data',
      opcodeId: null,
      reason,
      label,
    });

    const info = lookupOpcode(opcode);
    if (info === undefined) return data('invalid-opcode');
    if (at + info.length - 1 > end) return data('truncated');
    const format = INSTRUCTION_FORMATS[info.format];
    let fields = { a: 0, b: 0 };
    if (format.registerFields !== 0) {
      const decoded = decodeRegisterByte(byteAt(at + REGISTER_BYTE_OFFSET), format.registerFields);
      if (!decoded.ok) return data('malformed-operand');
      fields = { a: decoded.a, b: decoded.b };
    }
    const trailing = byteAt(at + info.length - 1);
    const name = (value: number): string => labels.get(value) ?? hex(value);
    const render = (spec: OperandSpec): string => {
      switch (spec.kind) {
        case 'reg':
          return `R${String(fields[spec.field === 'b' ? 'b' : 'a'])}`;
        case 'regIndirect':
          return `[R${String(fields[spec.field === 'b' ? 'b' : 'a'])}]`;
        case 'imm8':
          return String(trailing);
        case 'addr8':
          return spec.role === 'addr' ? `[${name(trailing)}]` : name(trailing);
      }
    };
    const operands = info.operands.map(render).join(', ');
    return {
      address: at,
      bytes: Array.from({ length: info.length }, (_, i) => byteAt(at + i)),
      text: operands === '' ? info.mnemonic : `${info.mnemonic} ${operands}`,
      kind: 'instruction',
      opcodeId: info.id,
      reason: null,
      label,
    };
  }
}

/**
 * Turns disassembly back into source the assembler accepts: an `.org` wherever the address
 * jumps, a `name:` line before each labelled address, then one statement per line. Pass the
 * `labels` given to `disassemble` so that a label whose address starts no line (it points into
 * a gap or the middle of an instruction) is still defined, as an `.equ`.
 */
export function toAssemblySource(
  lines: readonly DisassemblyLine[],
  labels: ReadonlyMap<number, string> = new Map(),
): string {
  const placed = new Set(lines.map((line) => line.label));
  const out = [...labels]
    .filter(([, name]) => !placed.has(name))
    .map(([address, name]) => `.equ ${name}, ${hex(address)}`);
  let next = 0;
  for (const line of lines) {
    if (line.address !== next) out.push(`.org ${hex(line.address)}`);
    if (line.label !== null) out.push(`${line.label}:`);
    out.push(`    ${line.text}`);
    next = line.address + line.bytes.length;
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
