import { FLAG_MASKS, opcodeById, OPCODES, packFlags } from '@vcpu/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  add,
  ALU_OPERATIONS,
  type AluOpcodeId,
  type AluResult,
  and,
  cmp,
  dec,
  div,
  inc,
  isAluOpcode,
  mul,
  not,
  or,
  shl,
  shr,
  sub,
  xor,
} from '../alu.js';

/**
 * An independent reference ALU. Arithmetic uses BigInt with the operands' exact unsigned and
 * signed (two's complement) values, so carry and overflow come from range checks rather than bit
 * tricks; bitwise operations work on 8-character bit strings.
 */
function reference(id: AluOpcodeId, a: number, b: number, flagsIn: number): AluResult {
  const ua = BigInt(a);
  const ub = BigInt(b);
  const sa = BigInt.asIntN(8, ua);
  const sb = BigInt.asIntN(8, ub);
  const outOfSignedRange = (x: bigint): boolean => x < -128n || x > 127n;
  const bits = (x: number): string => x.toString(2).padStart(8, '0');
  const fromBits = (s: string): number => Number.parseInt(s, 2);
  const bitwise = (f: (x: string, y: string) => string): number =>
    fromBits(
      Array.from(bits(a))
        .map((ch, i) => f(ch, bits(b)[i] ?? '0'))
        .join(''),
    );

  let result: number;
  let carry = false;
  let overflow = false;
  let keepCarry = false;
  switch (id) {
    case 'ADD':
      result = Number(BigInt.asUintN(8, ua + ub));
      carry = ua + ub > 255n;
      overflow = outOfSignedRange(sa + sb);
      break;
    case 'SUB':
    case 'CMP':
      result = Number(BigInt.asUintN(8, ua - ub));
      carry = ua - ub < 0n;
      overflow = outOfSignedRange(sa - sb);
      break;
    case 'MUL':
      result = Number(BigInt.asUintN(8, ua * ub));
      carry = overflow = ua * ub > 255n;
      break;
    case 'DIV':
      result = Number(ua / ub);
      break;
    case 'INC':
      result = Number(BigInt.asUintN(8, ua + 1n));
      overflow = outOfSignedRange(sa + 1n);
      keepCarry = true;
      break;
    case 'DEC':
      result = Number(BigInt.asUintN(8, ua - 1n));
      overflow = outOfSignedRange(sa - 1n);
      keepCarry = true;
      break;
    case 'AND':
      result = bitwise((x, y) => (x === '1' && y === '1' ? '1' : '0'));
      break;
    case 'OR':
      result = bitwise((x, y) => (x === '1' || y === '1' ? '1' : '0'));
      break;
    case 'XOR':
      result = bitwise((x, y) => (x !== y ? '1' : '0'));
      break;
    case 'NOT':
      result = fromBits(
        Array.from(bits(a))
          .map((ch) => (ch === '1' ? '0' : '1'))
          .join(''),
      );
      break;
    case 'SHL':
      result = fromBits(`${bits(a).slice(1)}0`);
      carry = bits(a).startsWith('1');
      break;
    case 'SHR':
      result = fromBits(`0${bits(a).slice(0, 7)}`);
      carry = bits(a).endsWith('1');
      break;
  }
  const flags = packFlags({
    Z: result === 0,
    C: keepCarry ? (flagsIn & FLAG_MASKS.C) !== 0 : carry,
    N: result >= 0x80,
    V: overflow,
  });
  return { result, flags };
}

const ALU_IDS = Object.keys(ALU_OPERATIONS) as AluOpcodeId[];
const BINARY_IDS = ALU_IDS.filter((id) => opcodeById[id].format === 'RR');
const UNARY_IDS = ALU_IDS.filter((id) => opcodeById[id].format === 'R');

const byte = fc.integer({ min: 0, max: 0xff });
const flagsByte = fc.integer({ min: 0, max: 0x0f });

describe('ALU vs reference: exhaustive', () => {
  it.each(BINARY_IDS)('%s over all 256 × 256 operand pairs', (id) => {
    const op = ALU_OPERATIONS[id];
    for (let a = 0; a <= 0xff; a += 1) {
      for (let b = id === 'DIV' ? 1 : 0; b <= 0xff; b += 1) {
        const actual = op(a, b, 0);
        const expected = reference(id, a, b, 0);
        if (actual.result !== expected.result || actual.flags !== expected.flags) {
          expect({ id, a, b, ...actual }).toEqual({ id, a, b, ...expected });
        }
      }
    }
  });

  it.each(UNARY_IDS)('%s over all 256 operands × 16 incoming FLAGS', (id) => {
    const op = ALU_OPERATIONS[id];
    for (let a = 0; a <= 0xff; a += 1) {
      for (let flagsIn = 0; flagsIn <= 0x0f; flagsIn += 1) {
        const actual = op(a, 0, flagsIn);
        const expected = reference(id, a, 0, flagsIn);
        if (actual.result !== expected.result || actual.flags !== expected.flags) {
          expect({ id, a, flagsIn, ...actual }).toEqual({ id, a, flagsIn, ...expected });
        }
      }
    }
  });
});

describe('ALU vs reference: property-based', () => {
  it.each(ALU_IDS)('%s matches for random operands and incoming FLAGS', (id) => {
    fc.assert(
      fc.property(byte, byte, flagsByte, (a, b, flags) => {
        fc.pre(id !== 'DIV' || b !== 0);
        expect(ALU_OPERATIONS[id](a, b, flags)).toEqual(reference(id, a, b, flags));
      }),
      { numRuns: 2000 },
    );
  });

  it('ADD is commutative and SUB undoes it', () => {
    fc.assert(
      fc.property(byte, byte, (a, b) => {
        expect(add(a, b)).toEqual(add(b, a));
        expect(sub(add(a, b).result, b).result).toBe(a);
      }),
    );
  });

  it('carry/borrow and V agree with unsigned and signed arithmetic', () => {
    fc.assert(
      fc.property(byte, byte, (a, b) => {
        const signed = (x: number): number => (x >= 0x80 ? x - 0x100 : x);
        expect((add(a, b).flags & FLAG_MASKS.C) !== 0).toBe(a + b > 255);
        expect((sub(a, b).flags & FLAG_MASKS.C) !== 0).toBe(a < b);
        const sum = signed(a) + signed(b);
        expect((add(a, b).flags & FLAG_MASKS.V) !== 0).toBe(sum < -128 || sum > 127);
      }),
    );
  });

  it('DIV and MUL relate: q × b + remainder = a', () => {
    fc.assert(
      fc.property(byte, fc.integer({ min: 1, max: 0xff }), (a, b) => {
        const q = div(a, b).result;
        expect(q * b <= a && a < (q + 1) * b).toBe(true);
        expect(mul(q, b).result).toBe((q * b) % 256);
      }),
    );
  });

  it('NOT twice is the identity; XOR with itself is zero; SHL then SHR clears bit 7', () => {
    fc.assert(
      fc.property(byte, (a) => {
        expect(not(not(a).result).result).toBe(a);
        expect(xor(a, a)).toEqual({ result: 0, flags: FLAG_MASKS.Z });
        expect(shr(shl(a).result).result).toBe(a & 0x7f);
        expect(and(a, 0xff).result).toBe(a);
        expect(or(a, 0).result).toBe(a);
      }),
    );
  });

  it('INC and DEC are inverses and never touch C', () => {
    fc.assert(
      fc.property(byte, flagsByte, (a, flags) => {
        expect(dec(inc(a, flags).result, flags).result).toBe(a);
        expect(inc(a, flags).flags & FLAG_MASKS.C).toBe(flags & FLAG_MASKS.C);
        expect(dec(a, flags).flags & FLAG_MASKS.C).toBe(flags & FLAG_MASKS.C);
      }),
    );
  });
});

describe('flags matrix vs the shared opcode table', () => {
  it.each(ALU_IDS)('%s writes, clears and preserves exactly the flags the table lists', (id) => {
    const info = opcodeById[id];
    const written = info.flagsWritten.reduce((mask, flag) => mask | FLAG_MASKS[flag], 0);
    const cleared = info.flagsCleared.reduce((mask, flag) => mask | FLAG_MASKS[flag], 0);
    const preserved = 0x0f & ~written & ~cleared;
    let writtenSeenSet = 0;
    let writtenSeenClear = 0;
    for (let a = 0; a <= 0xff; a += 1) {
      for (const b of [...(id === 'DIV' ? [] : [0]), 1, 0x7f, 0x80, 0xff]) {
        for (let flags = 0; flags <= 0x0f; flags += 1) {
          const out = ALU_OPERATIONS[id](a, b, flags).flags;
          expect(out & preserved).toBe(flags & preserved);
          expect(out & cleared).toBe(0);
          writtenSeenSet |= out & written;
          writtenSeenClear |= ~out & written;
        }
      }
    }
    // Every written flag is really computed: it is seen both set and clear. SHR writes N, but a
    // logical right shift always leaves bit 7 clear, so N is always 0 (docs: "r[7] (always 0)").
    expect(writtenSeenSet).toBe(id === 'SHR' ? written & ~FLAG_MASKS.N : written);
    expect(writtenSeenClear & 0x0f).toBe(written);
  });

  it('isAluOpcode matches the arithmetic and logic categories', () => {
    for (const info of OPCODES) {
      expect(isAluOpcode(info.id)).toBe(
        info.category === 'arithmetic' || info.category === 'logic',
      );
    }
    expect(cmp(1, 2)).toEqual(sub(1, 2));
  });
});

describe('ALU input validation', () => {
  it.each([256, -1, 1.5, Number.NaN])('rejects operand %s', (bad) => {
    expect(() => add(bad, 0)).toThrow(RangeError);
    expect(() => add(0, bad)).toThrow(RangeError);
    expect(() => not(bad)).toThrow(RangeError);
    expect(() => inc(bad, 0)).toThrow(RangeError);
  });

  it('rejects a FLAGS byte with bits 7–4 set', () => {
    expect(() => inc(0, 0x10)).toThrow(RangeError);
    expect(() => dec(0, 0x100)).toThrow(RangeError);
  });

  it('rejects division by zero (the CPU faults before calling the ALU)', () => {
    expect(() => div(5, 0)).toThrow(/Division by zero/);
  });
});
