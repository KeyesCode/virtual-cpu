import { describe, expect, it } from 'vitest';
import { asm, C, execAlu, FLAG_PREAMBLES, N, program, reg, runProgram, V, Z } from '../helpers.js';

// Rows cite the worked examples and the "Exact flag rules" table in docs/instruction-set.md.

describe('ADD Rd, Rs', () => {
  it.each([
    { a: 0x0a, b: 0x14, r: 0x1e, flags: 0, why: '10 + 20 = 30' },
    { a: 0xff, b: 0x01, r: 0x00, flags: Z | C, why: 'unsigned wrap; −1 + 1 = 0 is signed-correct' },
    { a: 0x7f, b: 0x01, r: 0x80, flags: N | V, why: '127 + 1 overflows signed' },
    { a: 0x80, b: 0x80, r: 0x00, flags: Z | C | V, why: '−128 + −128 overflows both ways' },
    { a: 0xff, b: 0xff, r: 0xfe, flags: C | N, why: '−1 + −1 = −2 carries, no signed overflow' },
    { a: 0x00, b: 0x00, r: 0x00, flags: Z, why: 'zero' },
  ])('$a + $b → $r ($why)', ({ a, b, r, flags }) => {
    expect(execAlu('ADD', a, b)).toMatchObject({ result: r, flags });
  });

  it('replaces all four flags regardless of the incoming FLAGS', () => {
    expect(execAlu('ADD', 1, 1, FLAG_PREAMBLES.ZCV.code).flags).toBe(0);
  });

  it('reads both operands before writing when Rd = Rs (ADD R0, R0 doubles)', () => {
    const state = runProgram(program(asm.ldi(0, 0x21), asm.rr('ADD', 0, 0), asm.hlt())).getState();
    expect(reg(state, 0)).toBe(0x42);
  });

  it('leaves Rs unchanged', () => {
    const { cpu } = execAlu('ADD', 3, 4);
    expect(reg(cpu.getState(), 1)).toBe(4);
  });
});

describe('SUB Rd, Rs', () => {
  it.each([
    { a: 0x1e, b: 0x0a, r: 0x14, flags: 0, why: '30 − 10' },
    { a: 0x00, b: 0x01, r: 0xff, flags: C | N, why: 'borrow; 0 − 1 = −1 is signed-correct' },
    { a: 0x80, b: 0x01, r: 0x7f, flags: V, why: '−128 − 1 overflows signed' },
    { a: 0x7f, b: 0xff, r: 0x80, flags: C | N | V, why: '127 − (−1) overflows signed, borrows' },
    { a: 0x42, b: 0x42, r: 0x00, flags: Z, why: 'equal operands' },
  ])('$a − $b → $r ($why)', ({ a, b, r, flags }) => {
    expect(execAlu('SUB', a, b)).toMatchObject({ result: r, flags });
  });

  it('SUB R0, R0 is zero with no borrow', () => {
    const state = runProgram(program(asm.ldi(0, 0x99), asm.rr('SUB', 0, 0), asm.hlt())).getState();
    expect(reg(state, 0)).toBe(0);
    expect(state.flags).toBe(Z);
  });
});

describe('MUL Rd, Rs', () => {
  it.each([
    { a: 6, b: 7, r: 42, flags: 0, why: 'fits in a byte' },
    { a: 0x10, b: 0x10, r: 0x00, flags: Z | C | V, why: '256 → low byte 0, high byte non-zero' },
    { a: 0x0c, b: 0x0b, r: 0x84, flags: N, why: '132 fits unsigned; N is just bit 7' },
    { a: 0xff, b: 0xff, r: 0x01, flags: C | V, why: '65025 = 0xFE01' },
    { a: 0x00, b: 0xff, r: 0x00, flags: Z, why: 'times zero' },
  ])('$a × $b → $r ($why)', ({ a, b, r, flags }) => {
    expect(execAlu('MUL', a, b)).toMatchObject({ result: r, flags });
  });

  it('charges the 3 extra execute cycles (6 in total)', () => {
    const { cpu } = execAlu('MUL', 2, 3);
    expect(cpu.getExecutionTrace().at(-2)?.cycles).toBe(6);
  });
});

describe('DIV Rd, Rs', () => {
  it.each([
    { a: 100, b: 7, r: 14, flags: 0, why: 'floor(100 ÷ 7)' },
    { a: 0xff, b: 1, r: 0xff, flags: N, why: 'unsigned: 255 ÷ 1' },
    { a: 3, b: 4, r: 0, flags: Z, why: 'floor rounds down to 0' },
    { a: 0x80, b: 0xff, r: 0, flags: Z, why: 'unsigned, not −128 ÷ −1' },
  ])('$a ÷ $b → $r ($why)', ({ a, b, r, flags }) => {
    expect(execAlu('DIV', a, b)).toMatchObject({ result: r, flags });
  });

  it('clears C and V', () => {
    expect(execAlu('DIV', 9, 3, FLAG_PREAMBLES.ZCV.code).flags).toBe(0);
  });

  it('charges the 7 extra execute cycles (10 in total)', () => {
    const { cpu } = execAlu('DIV', 9, 3);
    expect(cpu.getExecutionTrace().at(-2)?.cycles).toBe(10);
  });
});

describe('INC Rd', () => {
  it.each([
    { a: 0x00, r: 0x01, flags: 0 },
    { a: 0x7f, r: 0x80, flags: N | V },
    { a: 0xff, r: 0x00, flags: Z },
    { a: 0x80, r: 0x81, flags: N },
  ])('$a + 1 → $r', ({ a, r, flags }) => {
    expect(execAlu('INC', a)).toMatchObject({ result: r, flags });
  });

  it('leaves C unchanged, set or clear, and never sets it on wrap', () => {
    expect(execAlu('INC', 0x01, 0, FLAG_PREAMBLES.CN.code).flags).toBe(C);
    expect(execAlu('INC', 0xff, 0, FLAG_PREAMBLES.CN.code).flags).toBe(C | Z);
    expect(execAlu('INC', 0xff).flags & C).toBe(0);
  });
});

describe('DEC Rd', () => {
  it.each([
    { a: 0x01, r: 0x00, flags: Z },
    { a: 0x00, r: 0xff, flags: N },
    { a: 0x80, r: 0x7f, flags: V },
    { a: 0x02, r: 0x01, flags: 0 },
  ])('$a − 1 → $r', ({ a, r, flags }) => {
    expect(execAlu('DEC', a)).toMatchObject({ result: r, flags });
  });

  it('leaves C unchanged', () => {
    expect(execAlu('DEC', 0x05, 0, FLAG_PREAMBLES.ZCV.code).flags).toBe(C);
    expect(execAlu('DEC', 0x00).flags & C).toBe(0);
  });
});
