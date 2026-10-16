import { describe, expect, it } from 'vitest';
import { assemble, formatDiagnostic } from './index.js';

/** The diagnostics of a source that must fail, reduced to what the tests compare. */
function errors(source: string): { code: string; line: number; column: number; message: string }[] {
  const result = assemble(source);
  expect(result.ok).toBe(false);
  return result.diagnostics.map(({ code, line, column, message, severity }) => {
    expect(severity).toBe('error');
    return { code, line, column, message };
  });
}

describe('assemble: diagnostics', () => {
  it('reports both problems in LDI R9, 300 at their columns', () => {
    expect(errors('LDI R9, 300')).toEqual([
      {
        code: 'unknown-register',
        line: 1,
        column: 5,
        message: 'unknown register "R9" (valid: R0–R7)',
      },
      {
        code: 'value-out-of-range',
        line: 1,
        column: 9,
        message: 'immediate 300 out of range (valid: -128..255)',
      },
    ]);
  });

  it('formats a diagnostic with the line and a caret under the span', () => {
    const source = 'NOP\nNOP\nNOP\nNOP\nNOP\nNOP\n\tLDI R9, 3';
    const [first] = assemble(source).diagnostics;
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(formatDiagnostic(first)).toBe('line 7, col 6: unknown register "R9" (valid: R0–R7)');
    expect(formatDiagnostic(first, source)).toBe(
      'line 7, col 6: unknown register "R9" (valid: R0–R7)\n  \tLDI R9, 3\n  \t    ^^',
    );
  });

  it('reports an unknown mnemonic', () => {
    expect(errors('NOP\n  FOO R1, 2')).toEqual([
      { code: 'unknown-mnemonic', line: 2, column: 3, message: 'unknown mnemonic "FOO"' },
    ]);
  });

  it('reports an unknown directive', () => {
    expect(errors('.word 5')).toEqual([
      {
        code: 'unknown-directive',
        line: 1,
        column: 1,
        message: 'unknown directive ".word" (valid: .org, .byte, .equ)',
      },
    ]);
  });

  it('reports a wrong operand count', () => {
    expect(errors('ADD R0\nHLT R1\nINC R1, R2\nLOAD R1')).toEqual([
      {
        code: 'operand-count',
        line: 1,
        column: 1,
        message: 'ADD expects 2 operands (ADD Rd, Rs), got 1',
      },
      { code: 'operand-count', line: 2, column: 5, message: 'HLT takes no operands, got 1' },
      {
        code: 'operand-count',
        line: 3,
        column: 9,
        message: 'INC expects 1 operand (INC Rd), got 2',
      },
      {
        code: 'operand-count',
        line: 4,
        column: 1,
        message: 'LOAD expects 2 operands (LOAD Rd, [addr8] or LOAD Rd, [Rp]), got 1',
      },
    ]);
  });

  it('reports a wrong operand kind', () => {
    expect(errors('ADD R0, 5\nLOAD R1, R2\nJMP [0x10]\nLDI [R1], 3\nSTORE R1, [R2]')).toEqual([
      {
        code: 'operand-kind',
        line: 1,
        column: 9,
        message: 'operand 2 of ADD must be a register, got "5"',
      },
      {
        code: 'operand-kind',
        line: 2,
        column: 10,
        message:
          'operand 2 of LOAD must be an address in brackets like [0x80] or a register in brackets like [R1], got "R2"',
      },
      {
        code: 'operand-kind',
        line: 3,
        column: 5,
        message: 'operand 1 of JMP must be an address or label, got "[0x10]"',
      },
      {
        code: 'operand-kind',
        line: 4,
        column: 5,
        message: 'operand 1 of LDI must be a register, got "[R1]"',
      },
      {
        code: 'operand-kind',
        line: 5,
        column: 7,
        message:
          'operand 1 of STORE must be an address in brackets like [0x80] or a register in brackets like [R1], got "R1"',
      },
    ]);
  });

  it('reports out-of-range immediates and addresses', () => {
    expect(
      errors(
        'LDI R0, -129\nJMP 256\nLOAD R0, [-1]\n.byte 1, 0x100\n.equ BIG, 999\n.equ FAR, 200\nLDI R0, 255\nJMP FAR',
      ),
    ).toEqual([
      {
        code: 'value-out-of-range',
        line: 1,
        column: 9,
        message: 'immediate -129 out of range (valid: -128..255)',
      },
      {
        code: 'value-out-of-range',
        line: 2,
        column: 5,
        message: 'address 256 out of range (valid: 0..255)',
      },
      {
        code: 'value-out-of-range',
        line: 3,
        column: 11,
        message: 'address -1 out of range (valid: 0..255)',
      },
      {
        code: 'value-out-of-range',
        line: 4,
        column: 10,
        message: 'immediate 0x100 out of range (valid: -128..255)',
      },
      {
        code: 'value-out-of-range',
        line: 5,
        column: 11,
        message: 'constant 999 out of range (valid: -128..255)',
      },
    ]);
    expect(errors('.equ NEG, -5\nJMP NEG')).toEqual([
      {
        code: 'value-out-of-range',
        line: 2,
        column: 5,
        message: 'address "NEG" (-5) out of range (valid: 0..255)',
      },
    ]);
  });

  it('reports undefined symbols', () => {
    expect(errors('JMP nowhere\nLDI R0, missing')).toEqual([
      { code: 'undefined-symbol', line: 1, column: 5, message: 'undefined symbol "nowhere"' },
      { code: 'undefined-symbol', line: 2, column: 9, message: 'undefined symbol "missing"' },
    ]);
  });

  it('reports duplicate labels and constants', () => {
    expect(errors('loop: NOP\n  loop: NOP\n.equ X, 1\n.equ X, 2\nloop: HLT')).toEqual([
      {
        code: 'duplicate-symbol',
        line: 2,
        column: 3,
        message: 'duplicate symbol "loop" (first defined on line 1)',
      },
      {
        code: 'duplicate-symbol',
        line: 4,
        column: 6,
        message: 'duplicate symbol "X" (first defined on line 3)',
      },
      {
        code: 'duplicate-symbol',
        line: 5,
        column: 1,
        message: 'duplicate symbol "loop" (first defined on line 1)',
      },
    ]);
  });

  it('rejects register and mnemonic names as symbols', () => {
    expect(errors('r3: NOP\nadd: NOP\nR9: NOP\n.equ Jmp, 1')).toEqual([
      {
        code: 'reserved-name',
        line: 1,
        column: 1,
        message: '"r3" cannot be used as a symbol name: it is a register name',
      },
      {
        code: 'reserved-name',
        line: 2,
        column: 1,
        message: '"add" cannot be used as a symbol name: it is a mnemonic',
      },
      {
        code: 'reserved-name',
        line: 3,
        column: 1,
        message: '"R9" cannot be used as a symbol name: it is a register name',
      },
      {
        code: 'reserved-name',
        line: 4,
        column: 6,
        message: '"Jmp" cannot be used as a symbol name: it is a mnemonic',
      },
    ]);
  });

  it('needs .org and .equ values to be known when they are reached', () => {
    expect(errors('.org later\n.equ A, B\n.equ B, 1\nlater: NOP\n.equ C, nothing')).toEqual([
      {
        code: 'symbol-not-yet-defined',
        line: 1,
        column: 6,
        message: '"later" must be defined above this .org: its value is needed here',
      },
      {
        code: 'symbol-not-yet-defined',
        line: 2,
        column: 9,
        message: '"B" must be defined above this .equ: its value is needed here',
      },
      { code: 'undefined-symbol', line: 5, column: 9, message: 'undefined symbol "nothing"' },
    ]);
  });

  it('reports .org going backwards and the output it overlaps', () => {
    expect(errors('LDI R0, 1\nHLT\n.org 0x01\n.byte 0xAA\n.org 0x10\nNOP')).toEqual([
      {
        code: 'org-backwards',
        line: 3,
        column: 1,
        message: '.org 0x01 moves backwards (the current address is 0x04)',
      },
      {
        code: 'overlap',
        line: 4,
        column: 1,
        message: 'output at 0x01 overlaps bytes already emitted by line 1',
      },
    ]);
    // A backwards .org into unused space is still an error, but nothing overlaps.
    expect(errors('.org 0x10\nNOP\n.org 0x08\nNOP').map((d) => d.code)).toEqual(['org-backwards']);
  });

  it('reports a program that runs past 0xFF, once', () => {
    expect(errors('.org 0xFE\nNOP\nLDI R0, 1\nNOP\nNOP')).toEqual([
      {
        code: 'overflow',
        line: 3,
        column: 1,
        message: 'program runs past the end of memory (0xFF): 3 bytes at 0xFF',
      },
    ]);
    expect(errors('.org 0xFF\n.byte 1, 2').map((d) => d.code)).toEqual(['overflow']);
    expect(errors('.org 0x100').map((d) => d.code)).toEqual(['value-out-of-range']);
  });

  it('reports lexical and syntax errors', () => {
    expect(
      errors(
        "LDI R0, 0x\nLDI R0, 12ab\nLDI R0, ''\nLDI R0, 'ab'\nLDI R0, 'é'\nLDI R0, 'x\nNOP #\n",
      ),
    ).toEqual([
      {
        code: 'invalid-number',
        line: 1,
        column: 9,
        message: 'invalid number "0x" (use decimal 42, hex 0x2A or binary 0b101010)',
      },
      {
        code: 'invalid-number',
        line: 2,
        column: 9,
        message: 'invalid number "12ab" (use decimal 42, hex 0x2A or binary 0b101010)',
      },
      {
        code: 'invalid-char',
        line: 3,
        column: 9,
        message: 'invalid character literal: empty literal',
      },
      {
        code: 'invalid-char',
        line: 4,
        column: 9,
        message: 'invalid character literal: a literal holds exactly one character',
      },
      {
        code: 'invalid-char',
        line: 5,
        column: 9,
        message: 'invalid character literal: only printable ASCII characters are allowed',
      },
      {
        code: 'invalid-char',
        line: 6,
        column: 9,
        message: 'invalid character literal: missing closing quote',
      },
      { code: 'unexpected-character', line: 7, column: 5, message: 'unexpected character "#"' },
    ]);
    expect(errors('LDI R0 10\nLDI R0,\nLOAD R0, [R1\n, NOP\nADD R0, :')).toEqual([
      { code: 'syntax', line: 1, column: 8, message: 'expected "," between operands, found "10"' },
      { code: 'syntax', line: 2, column: 7, message: 'expected an operand after ","' },
      { code: 'syntax', line: 3, column: 13, message: 'expected "]", found end of line' },
      {
        code: 'syntax',
        line: 4,
        column: 1,
        message: 'expected a label, mnemonic or directive, found ","',
      },
      { code: 'syntax', line: 5, column: 9, message: 'expected an operand, found ":"' },
    ]);
  });

  it('collects every error in one run, in source order', () => {
    const result = assemble('FOO\nJMP x\nLDI R8, 1\nNOP\n.org 0');
    expect(result.diagnostics.map((d) => [d.code, d.line])).toEqual([
      ['unknown-mnemonic', 1],
      ['undefined-symbol', 2],
      ['unknown-register', 3],
      ['org-backwards', 5],
    ]);
  });
});
