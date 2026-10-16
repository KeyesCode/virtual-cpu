import { lookupOpcode } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { assemble, disassemble, labelsFromSymbols, toAssemblySource } from './index.js';

const texts = (bytes: readonly number[], options?: Parameters<typeof disassemble>[1]): string[] =>
  disassemble(bytes, options).map((line) => line.text);

describe('disassemble', () => {
  it('decodes every opcode to canonical assembly', () => {
    const cases: [number[], string][] = [
      [[0x00], 'NOP'],
      [[0x01], 'HLT'],
      [[0x10, 0x25], 'MOV R2, R5'],
      [[0x11, 0x30, 0xff], 'LDI R3, 255'],
      [[0x12, 0x10, 0x80], 'LOAD R1, [0x80]'],
      [[0x13, 0x12], 'LOAD R1, [R2]'],
      [[0x14, 0x40, 0x81], 'STORE [0x81], R4'],
      [[0x15, 0x21], 'STORE [R2], R1'],
      [[0x20, 0x01], 'ADD R0, R1'],
      [[0x21, 0x76], 'SUB R7, R6'],
      [[0x22, 0x12], 'MUL R1, R2'],
      [[0x23, 0x34], 'DIV R3, R4'],
      [[0x24, 0x70], 'INC R7'],
      [[0x25, 0x00], 'DEC R0'],
      [[0x30, 0x55], 'AND R5, R5'],
      [[0x31, 0x60], 'OR R6, R0'],
      [[0x32, 0x07], 'XOR R0, R7'],
      [[0x33, 0x40], 'NOT R4'],
      [[0x34, 0x10], 'SHL R1'],
      [[0x35, 0x20], 'SHR R2'],
      [[0x36, 0x01], 'CMP R0, R1'],
      [[0x40, 0x10], 'JMP 0x10'],
      [[0x41, 0x20], 'JZ 0x20'],
      [[0x42, 0x04], 'JNZ 0x04'],
      [[0x43, 0xff], 'JC 0xFF'],
      [[0x44, 0x00], 'JNC 0x00'],
      [[0x45, 0x40], 'CALL 0x40'],
      [[0x46], 'RET'],
      [[0x50, 0x60], 'PUSH R6'],
      [[0x51, 0x30], 'POP R3'],
    ];
    const covered = new Set(cases.map(([bytes]) => lookupOpcode(bytes[0] ?? -1)?.id));
    expect(covered.size).toBe(30);
    for (const [bytes, text] of cases) {
      const [line, ...rest] = disassemble(bytes);
      expect(rest).toEqual([]);
      expect(line).toMatchObject({ address: 0, bytes, text, kind: 'instruction', reason: null });
      expect(line?.opcodeId).toBe(lookupOpcode(bytes[0] ?? -1)?.id);
    }
  });

  it('turns every invalid opcode into .byte without throwing', () => {
    const invalid = Array.from({ length: 256 }, (_, byte) => byte).filter(
      (byte) => lookupOpcode(byte) === undefined,
    );
    expect(invalid).toHaveLength(226);
    const lines = disassemble(invalid);
    expect(lines).toHaveLength(226);
    lines.forEach((line, i) => {
      const byte = invalid[i] ?? -1;
      expect(line).toEqual({
        address: i,
        bytes: [byte],
        text: `.byte 0x${byte.toString(16).toUpperCase().padStart(2, '0')}`,
        kind: 'data',
        opcodeId: null,
        reason: 'invalid-opcode',
        label: null,
      });
    });
  });

  it('emits a malformed register byte as data and resumes at the next byte', () => {
    const lines = disassemble([0x20, 0x88, 0x24, 0x71, 0x00]);
    expect(lines.map((line) => [line.text, line.reason])).toEqual([
      ['.byte 0x20', 'malformed-operand'], // field a = 8
      ['.byte 0x88', 'invalid-opcode'],
      ['.byte 0x24', 'malformed-operand'], // INC uses field a only; field b must be 0
      ['.byte 0x71', 'invalid-opcode'],
      ['NOP', null],
    ]);
  });

  it('emits an instruction cut off by end as data', () => {
    const lines = disassemble([0x11, 0x00, 0x05], { end: 1 });
    expect(lines.map((line) => [line.text, line.reason])).toEqual([
      ['.byte 0x11', 'truncated'],
      ['NOP', null],
    ]);
  });

  it('decodes only the start..end window, inclusive', () => {
    const bytes = [0x01, 0x00, 0x40, 0x07, 0x01];
    expect(
      disassemble(bytes, { start: 2, end: 3 }).map((line) => [line.address, line.text]),
    ).toEqual([[2, 'JMP 0x07']]);
    expect(texts(bytes, { start: 4 })).toEqual(['HLT']);
    expect(disassemble([])).toEqual([]);
  });

  it('prints label names for addresses and marks labelled lines', () => {
    const program = assemble(
      'start: LDI R0, 3\nloop: DEC R0\nJNZ loop\nLOAD R1, [value]\nJMP start\nvalue: .byte 1',
    );
    expect(program.ok).toBe(true);
    const labels = labelsFromSymbols(program.symbols);
    const lines = disassemble(program.bytes.image, { end: 12, labels });
    expect(lines.map((line) => [line.label, line.text])).toEqual([
      ['start', 'LDI R0, 3'],
      ['loop', 'DEC R0'],
      [null, 'JNZ loop'],
      [null, 'LOAD R1, [value]'],
      [null, 'JMP start'],
      ['value', 'HLT'],
    ]);
    // Immediates stay numeric even when a label has the same value.
    expect(texts([0x11, 0x00, 0x00], { labels })).toEqual(['LDI R0, 0']);
  });

  it('rejects invalid options and values that are not bytes', () => {
    expect(() => disassemble([0, 0], { start: 1, end: 0 })).toThrow();
    expect(() => disassemble([0, 0], { end: 2 })).toThrow(RangeError);
    expect(() => disassemble([0, 256])).toThrow(RangeError);
    expect(() => disassemble([0, 1.5])).toThrow(RangeError);
    expect(() => disassemble(new Array<number>(257).fill(0))).toThrow(RangeError);
    // Values outside the window are not inspected.
    expect(texts([0, 999], { end: 0 })).toEqual(['NOP']);
  });
});

describe('toAssemblySource', () => {
  it('adds .org at gaps, label lines and .equ for labels that start no line', () => {
    const lines = [
      ...disassemble([0x40, 0x11], { end: 1, labels: new Map([[0x00, 'top']]) }),
      ...disassemble([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x46], { start: 0x10 }),
    ];
    const labels = new Map([
      [0x00, 'top'],
      [0x11, 'middle'],
    ]);
    expect(toAssemblySource(lines, labels)).toBe(
      ['.equ middle, 0x11', 'top:', '    JMP 0x11', '.org 0x10', '    RET', ''].join('\n'),
    );
    expect(toAssemblySource([])).toBe('');
  });
});
