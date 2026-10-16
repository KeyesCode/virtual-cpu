import { describe, expect, it } from 'vitest';
import instructionSetDoc from '../../../../docs/instruction-set.md?raw';
import { ISA_VERSION } from './constants.js';
import { INSTRUCTION_FORMATS } from './formats.js';
import { OPCODES } from './opcodes.js';
import { FLAG_NAMES, type FlagName, type OpcodeInfo, type OperandRole } from './types.js';

/** Encoding-template placeholder for each operand role (nibble letter or byte pair). */
const PLACEHOLDER: Record<OperandRole, string> = {
  dest: 'd',
  src: 's',
  ptr: 'p',
  lhs: 'a',
  rhs: 'b',
  imm: 'ii',
  addr: 'mm',
  target: 'mm',
};

const hex2 = (byte: number): string => byte.toString(16).toUpperCase().padStart(2, '0');

/** e.g. `11 d0 ii` for LDI, `15 ps` for STORE [Rp], Rs, `40 mm` for JMP. */
function encodingTemplate(info: OpcodeInfo): string {
  const parts = [hex2(info.opcode)];
  const roleIn = (field: 'a' | 'b' | 'byte'): OperandRole | undefined =>
    info.operands.find((operand) => operand.field === field)?.role;
  const format = INSTRUCTION_FORMATS[info.format];
  if (format.registerFields > 0) {
    const a = roleIn('a');
    const b = roleIn('b');
    parts.push((a ? PLACEHOLDER[a] : '0') + (b ? PLACEHOLDER[b] : '0'));
  }
  const trailing = roleIn('byte');
  if (trailing) {
    parts.push(PLACEHOLDER[trailing]);
  }
  return parts.join(' ');
}

function flagCell(info: OpcodeInfo, flag: FlagName): string {
  if (info.flagsWritten.includes(flag)) return 'Δ';
  if (info.flagsCleared.includes(flag)) return '0';
  return '–';
}

/** The opcode-map row the docs must contain for one opcode, cell by cell. */
function opcodeMapRow(info: OpcodeInfo): string[] {
  return [
    `0x${hex2(info.opcode)}`,
    info.mnemonic,
    info.syntax,
    info.format,
    String(info.length),
    encodingTemplate(info),
    ...FLAG_NAMES.map((flag) => flagCell(info, flag)),
    String(info.baseCycles),
    info.branchTakenPenalty > 0 ? `+${String(info.branchTakenPenalty)}` : '–',
  ];
}

/** Table rows between the opcode-map markers, split into trimmed cells. */
function documentedOpcodeRows(doc: string): string[][] {
  const start = doc.indexOf('<!-- opcode-map:start -->');
  const end = doc.indexOf('<!-- opcode-map:end -->');
  expect(start, 'opcode-map start marker').toBeGreaterThanOrEqual(0);
  expect(end, 'opcode-map end marker').toBeGreaterThan(start);
  return doc
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\|\s*0x[0-9A-F]{2}\s*\|/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    );
}

describe('docs/instruction-set.md', () => {
  const rows = documentedOpcodeRows(instructionSetDoc);

  it('documents exactly the 30 opcodes of the table, in opcode order', () => {
    expect(rows.map((row) => row[0])).toEqual(OPCODES.map((info) => `0x${hex2(info.opcode)}`));
  });

  it.each(OPCODES)('$id row matches the code (syntax, length, encoding, flags, cycles)', (info) => {
    const row = rows.find((cells) => cells[0] === `0x${hex2(info.opcode)}`);
    expect(row).toEqual(opcodeMapRow(info));
  });

  it('names the ISA version', () => {
    expect(instructionSetDoc).toContain(`ISA version ${ISA_VERSION}`);
  });

  it('documents every format layout', () => {
    for (const format of Object.values(INSTRUCTION_FORMATS)) {
      expect(instructionSetDoc).toContain(format.layout);
    }
  });
});
