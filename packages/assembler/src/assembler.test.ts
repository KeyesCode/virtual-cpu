import { OPCODES, type OpcodeId } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { assemble } from './index.js';

/** The emitted bytes of a program that assembled cleanly, from address `from` on. */
function bytesOf(source: string, from = 0): number[] {
  const result = assemble(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const last = result.bytes.ranges.at(-1)?.end ?? from - 1;
  return Array.from(result.bytes.image.slice(from, last + 1));
}

/** One hand-written encoding per opcode variant, independent of the shared table. */
const ENCODINGS: readonly [OpcodeId, string, number[]][] = [
  ['NOP', 'NOP', [0x00]],
  ['HLT', 'HLT', [0x01]],
  ['MOV', 'MOV R2, R5', [0x10, 0x25]],
  ['LDI', 'LDI R3, 0x7F', [0x11, 0x30, 0x7f]],
  ['LOAD_ABS', 'LOAD R1, [0x80]', [0x12, 0x10, 0x80]],
  ['LOAD_IND', 'LOAD R1, [R2]', [0x13, 0x12]],
  ['STORE_ABS', 'STORE [0x81], R4', [0x14, 0x40, 0x81]],
  ['STORE_IND', 'STORE [R2], R1', [0x15, 0x21]],
  ['ADD', 'ADD R0, R1', [0x20, 0x01]],
  ['SUB', 'SUB R7, R6', [0x21, 0x76]],
  ['MUL', 'MUL R1, R2', [0x22, 0x12]],
  ['DIV', 'DIV R3, R4', [0x23, 0x34]],
  ['INC', 'INC R7', [0x24, 0x70]],
  ['DEC', 'DEC R0', [0x25, 0x00]],
  ['AND', 'AND R5, R5', [0x30, 0x55]],
  ['OR', 'OR R6, R0', [0x31, 0x60]],
  ['XOR', 'XOR R0, R7', [0x32, 0x07]],
  ['NOT', 'NOT R4', [0x33, 0x40]],
  ['SHL', 'SHL R1', [0x34, 0x10]],
  ['SHR', 'SHR R2', [0x35, 0x20]],
  ['CMP', 'CMP R0, R1', [0x36, 0x01]],
  ['JMP', 'JMP 0x10', [0x40, 0x10]],
  ['JZ', 'JZ 0x20', [0x41, 0x20]],
  ['JNZ', 'JNZ 0x04', [0x42, 0x04]],
  ['JC', 'JC 0xFF', [0x43, 0xff]],
  ['JNC', 'JNC 0', [0x44, 0x00]],
  ['CALL', 'CALL 0x40', [0x45, 0x40]],
  ['RET', 'RET', [0x46]],
  ['PUSH', 'PUSH R6', [0x50, 0x60]],
  ['POP', 'POP R3', [0x51, 0x30]],
];

describe('assemble: encodings', () => {
  it('covers every opcode in the shared table', () => {
    expect(ENCODINGS.map(([id]) => id).sort()).toEqual(OPCODES.map((info) => info.id).sort());
  });

  it.each(ENCODINGS)('%s: %s', (_id, source, expected) => {
    expect(bytesOf(source)).toEqual(expected);
  });

  it('assembles the reference program', () => {
    const result = assemble('LDI R0, 10\nLDI R1, 20\nADD R0, R1\nHLT');
    expect(result.ok).toBe(true);
    expect(Array.from(result.bytes.image.slice(0, 9))).toEqual([
      0x11, 0x00, 0x0a, 0x11, 0x10, 0x14, 0x20, 0x01, 0x01,
    ]);
    expect(result.bytes.ranges).toEqual([{ start: 0, end: 8 }]);
  });

  it('treats mnemonics and registers case-insensitively', () => {
    expect(bytesOf('ldi r3, 1\nLoAd r1, [r2]')).toEqual([0x11, 0x30, 0x01, 0x13, 0x12]);
  });

  it('assembles an empty source to nothing', () => {
    const result = assemble('');
    expect(result.ok).toBe(true);
    expect(result.bytes.ranges).toEqual([]);
    expect(result.bytes.image.every((byte) => byte === 0)).toBe(true);
    expect(result.symbols.size).toBe(0);
    expect(assemble('  ; just a comment\n\n').bytes.ranges).toEqual([]);
  });
});

describe('assemble: literals', () => {
  it.each([
    ['42', 42],
    ['0', 0],
    ['255', 255],
    ['-1', 0xff],
    ['-128', 0x80],
    ['0x2A', 0x2a],
    ['0XfF', 0xff],
    ['0b101010', 0x2a],
    ['0B1', 1],
    ["'A'", 0x41],
    ["' '", 0x20],
    ["';'", 0x3b],
    ["'\\n'", 0x0a],
    ["'\\''", 0x27],
    ["'\\\\'", 0x5c],
    ["'\\0'", 0x00],
  ])('LDI R0, %s', (literal, value) => {
    expect(bytesOf(`LDI R0, ${literal}`)).toEqual([0x11, 0x00, value]);
  });

  it('accepts every literal form in .byte', () => {
    expect(bytesOf(".byte 1, -2, 0x10, 0b11, 'z'")).toEqual([1, 0xfe, 0x10, 3, 0x7a]);
  });

  it('strips comments, including after a character literal', () => {
    expect(bytesOf("LDI R0, ';' ; load a semicolon\nNOP;trailing")).toEqual([
      0x11, 0x00, 0x3b, 0x00,
    ]);
  });
});

describe('assemble: symbols and directives', () => {
  it('resolves backward and forward label references', () => {
    const source = [
      'start:  LDI R0, 3',
      'loop:   DEC R0',
      '        JNZ loop',
      '        JMP done',
      '        NOP',
      'done:',
      '        JMP start',
    ].join('\n');
    expect(bytesOf(source)).toEqual([
      0x11, 0x00, 0x03, 0x25, 0x00, 0x42, 0x03, 0x40, 0x0a, 0x00, 0x40, 0x00,
    ]);
    const result = assemble(source);
    expect([...result.symbols.values()]).toEqual([
      { name: 'start', kind: 'label', value: 0, line: 1, column: 1 },
      { name: 'loop', kind: 'label', value: 3, line: 2, column: 1 },
      { name: 'done', kind: 'label', value: 10, line: 6, column: 1 },
    ]);
  });

  it('uses labels as data addresses and immediates', () => {
    const source = ['LOAD R0, [value]', 'LDI R1, value', 'HLT', 'value: .byte 7'].join('\n');
    expect(bytesOf(source)).toEqual([0x12, 0x00, 0x07, 0x11, 0x10, 0x07, 0x01, 0x07]);
  });

  it('keeps labels case-sensitive', () => {
    expect(bytesOf('Loop: NOP\nloop: NOP\nJMP Loop\nJMP loop')).toEqual([
      0x00, 0x00, 0x40, 0x00, 0x40, 0x01,
    ]);
  });

  it('allows several labels on one line', () => {
    const result = assemble('a: b: NOP');
    expect(result.symbols.get('a')?.value).toBe(0);
    expect(result.symbols.get('b')?.value).toBe(0);
  });

  it('substitutes .equ constants', () => {
    const source = ['.equ OUT, 0x80', '.equ COUNT, 5', '.equ MINUS, -3', '.equ ALIAS, OUT'].join(
      '\n',
    );
    expect(
      bytesOf(`${source}\nLDI R0, COUNT\nSTORE [OUT], R0\nLDI R1, MINUS\nLOAD R2, [ALIAS]`),
    ).toEqual([0x11, 0x00, 0x05, 0x14, 0x00, 0x80, 0x11, 0x10, 0xfd, 0x12, 0x20, 0x80]);
    expect(assemble(source).symbols.get('MINUS')).toEqual({
      name: 'MINUS',
      kind: 'equ',
      value: -3,
      line: 3,
      column: 6,
    });
  });

  it('moves the output position with .org and leaves the gap at 0', () => {
    const result = assemble('NOP\n.org 0x10\nhere: HLT\n.org 0x11\n.org 0x20\n.byte 9');
    expect(result.ok).toBe(true);
    expect(result.bytes.ranges).toEqual([
      { start: 0x00, end: 0x00 },
      { start: 0x10, end: 0x10 },
      { start: 0x20, end: 0x20 },
    ]);
    expect(result.bytes.image[0x10]).toBe(0x01);
    expect(result.bytes.image[0x20]).toBe(9);
    expect(result.bytes.image.slice(0x01, 0x10).every((byte) => byte === 0)).toBe(true);
    expect(result.symbols.get('here')?.value).toBe(0x10);
  });

  it('starts at the origin option', () => {
    const result = assemble('start: JMP start', { origin: 0x40 });
    expect(result.bytes.ranges).toEqual([{ start: 0x40, end: 0x41 }]);
    expect(result.bytes.image[0x41]).toBe(0x40);
    expect(() => assemble('NOP', { origin: 256 })).toThrow();
  });

  it('fills memory exactly to 0xFF', () => {
    const result = assemble('.org 0xFD\nLDI R0, 1');
    expect(result.ok).toBe(true);
    expect(result.bytes.ranges).toEqual([{ start: 0xfd, end: 0xff }]);
  });

  it('accepts directives in any case', () => {
    expect(bytesOf('.BYTE 1\n.Org 2\n.EQU X, 3\n.byte X')).toEqual([1, 0, 3]);
  });
});

describe('assemble: source map', () => {
  it('maps each instruction and each .byte value to its source', () => {
    const result = assemble('start: LDI R0, 5 ; five\n\n  .byte 1, 0x02');
    expect([...result.sourceMap.values()]).toEqual([
      { address: 0, length: 3, line: 1, column: 8, text: 'LDI R0, 5' },
      { address: 3, length: 1, line: 3, column: 9, text: '.byte 1, 0x02' },
      { address: 4, length: 1, line: 3, column: 12, text: '.byte 1, 0x02' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const result = assemble('NOP\r\nLDI R0, 1\r\n');
    expect(result.ok).toBe(true);
    expect(result.sourceMap.get(1)).toEqual({
      address: 1,
      length: 3,
      line: 2,
      column: 1,
      text: 'LDI R0, 1',
    });
  });
});
