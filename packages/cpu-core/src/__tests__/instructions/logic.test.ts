import { describe, expect, it } from 'vitest';
import { C, execAlu, FLAG_PREAMBLES, N, reg, V, Z } from '../helpers.js';

describe.each([
  { id: 'AND', a: 0b1100_1010, b: 0b1010_0110, r: 0b1000_0010, flags: N },
  { id: 'OR', a: 0b0100_1010, b: 0b0010_0110, r: 0b0110_1110, flags: 0 },
  { id: 'XOR', a: 0b1100_1010, b: 0b0100_0110, r: 0b1000_1100, flags: N },
] as const)('$id Rd, Rs', ({ id, a, b, r, flags }) => {
  it('computes the bitwise result and Z N from it', () => {
    expect(execAlu(id, a, b)).toMatchObject({ result: r, flags });
  });

  it('clears C and V', () => {
    expect(execAlu(id, a, b, FLAG_PREAMBLES.ZCV.code).flags).toBe(flags);
  });
});

describe('zero results set Z', () => {
  it.each([
    { id: 'AND', a: 0xf0, b: 0x0f },
    { id: 'OR', a: 0x00, b: 0x00 },
    { id: 'XOR', a: 0x5a, b: 0x5a },
  ] as const)('$id', ({ id, a, b }) => {
    expect(execAlu(id, a, b)).toMatchObject({ result: 0, flags: Z });
  });
});

describe('NOT Rd', () => {
  it.each([
    { a: 0x00, r: 0xff, flags: N },
    { a: 0xff, r: 0x00, flags: Z },
    { a: 0x0f, r: 0xf0, flags: N },
    { a: 0xaa, r: 0x55, flags: 0 },
  ])('NOT $a → $r', ({ a, r, flags }) => {
    expect(execAlu('NOT', a)).toMatchObject({ result: r, flags });
  });

  it('clears C and V', () => {
    expect(execAlu('NOT', 0xaa, 0, FLAG_PREAMBLES.ZCV.code).flags).toBe(0);
  });
});

describe('SHL Rd', () => {
  it.each([
    { a: 0b0000_0001, r: 0b0000_0010, flags: 0 },
    { a: 0b1000_0000, r: 0x00, flags: Z | C, why: 'bit 7 moves into C' },
    { a: 0b1100_0000, r: 0b1000_0000, flags: C | N },
    { a: 0b0100_0000, r: 0b1000_0000, flags: N, why: 'V stays 0 although the sign changed' },
  ])('SHL $a → $r', ({ a, r, flags }) => {
    expect(execAlu('SHL', a)).toMatchObject({ result: r, flags });
  });

  it('clears V', () => {
    expect(execAlu('SHL', 0x01, 0, FLAG_PREAMBLES.ZCV.code).flags & V).toBe(0);
  });
});

describe('SHR Rd', () => {
  it.each([
    { a: 0b0000_0010, r: 0b0000_0001, flags: 0 },
    { a: 0b0000_0001, r: 0x00, flags: Z | C, why: 'bit 0 moves into C' },
    { a: 0b1000_0001, r: 0b0100_0000, flags: C, why: 'logical: a 0 enters bit 7, N is 0' },
    { a: 0xff, r: 0x7f, flags: C },
  ])('SHR $a → $r', ({ a, r, flags }) => {
    expect(execAlu('SHR', a)).toMatchObject({ result: r, flags });
  });

  it('clears V', () => {
    expect(execAlu('SHR', 0x02, 0, FLAG_PREAMBLES.ZCV.code).flags).toBe(0);
  });
});

describe('CMP Ra, Rb', () => {
  it.each([
    { a: 5, b: 5, flags: Z, why: 'equal' },
    { a: 3, b: 5, flags: C | N, why: 'a < b unsigned: borrow' },
    { a: 5, b: 3, flags: 0, why: 'a > b' },
    { a: 0x80, b: 0x01, flags: V, why: 'signed overflow as SUB' },
  ])('CMP $a, $b ($why)', ({ a, b, flags }) => {
    const run = execAlu('CMP', a, b);
    expect(run.flags).toBe(flags);
    expect(run.result).toBe(a);
  });

  it('writes no register', () => {
    const { cpu } = execAlu('CMP', 3, 5);
    const state = cpu.getState();
    expect([reg(state, 0), reg(state, 1)]).toEqual([3, 5]);
    expect(cpu.getExecutionTrace().at(-2)?.registerChanges).toEqual([]);
  });
});
