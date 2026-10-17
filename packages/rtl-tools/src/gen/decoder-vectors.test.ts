import { Op } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import {
  decoderOpRecords,
  decoderRbRecords,
  renderDecoderOps,
  renderDecoderRb,
} from './decoder-vectors.js';
import { ISA_CTRL, ISA_FIELDS } from './isa-pkg.js';

const ops = decoderOpRecords();
const rbs = decoderRbRecords();

/** The data lines of a rendered vector file (comments dropped). */
const dataLines = (text: string): string[] =>
  text.split('\n').filter((line) => line !== '' && !line.startsWith('//'));

const malformed = (opcode: number, rb: number): number | undefined =>
  rbs[opcode * 256 + rb]?.malformed;

describe('decoder opcode vectors', () => {
  it('has one record per opcode byte, in order', () => {
    expect(ops).toHaveLength(256);
    expect(ops.map((r) => r.opcode)).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  it('marks exactly the opcodes of Op as valid', () => {
    const valid = ops.filter((r) => r.valid === 1).map((r) => r.opcode);
    expect(valid).toHaveLength(30);
    expect(valid).toEqual(Object.values(Op).sort((x, y) => x - y));
  });

  it('gives an invalid byte all-zero fields', () => {
    expect(ops[0x02]).toEqual({
      opcode: 0x02,
      valid: 0,
      len: 0,
      fields: ISA_FIELDS.NONE,
      flagMask: 0,
      ctrl: ISA_CTRL.SEQ,
      cond: 0,
      dataRead: 0,
      dataWrite: 0,
      writesReg: 0,
    });
  });

  it('derives spot rows from OPCODES', () => {
    expect(ops[Op.INC]).toMatchObject({ len: 2, fields: ISA_FIELDS.A, flagMask: 0b1011 });
    expect(ops[Op.LDI]).toMatchObject({ len: 3, fields: ISA_FIELDS.A, writesReg: 1 });
    expect(ops[Op.CMP]).toMatchObject({ fields: ISA_FIELDS.AB, flagMask: 0b1111, writesReg: 0 });
    expect(ops[Op.STORE_IND]).toMatchObject({ dataWrite: 1, writesReg: 0 });
    expect(ops[Op.POP]).toMatchObject({ dataRead: 1, writesReg: 1 });
    expect(ops[Op.CALL]).toMatchObject({ ctrl: ISA_CTRL.CALL, dataWrite: 1, fields: 0 });
    expect(ops[Op.RET]).toMatchObject({ ctrl: ISA_CTRL.RET, dataRead: 1, len: 1 });
    // {flag bit index, value}: Z is bit 3, C is bit 2.
    expect(ops[Op.JZ]).toMatchObject({ ctrl: ISA_CTRL.BRANCH, cond: 0b111 });
    expect(ops[Op.JNC]).toMatchObject({ ctrl: ISA_CTRL.BRANCH, cond: 0b100 });
  });

  it('renders one 11-digit line per record', () => {
    const lines = dataLines(renderDecoderOps(ops));
    expect(lines).toHaveLength(256);
    expect(lines.every((line) => /^[0-9A-F]{11}$/.test(line))).toBe(true);
    expect(lines[Op.INC]).toBe('2412' + '1B0000' + '1');
    expect(lines[0xff]).toBe('FF000000000');
  });
});

describe('decoder register-byte vectors', () => {
  it('has one record per (opcode, register byte) pair, opcode-major', () => {
    expect(rbs).toHaveLength(65_536);
    expect(rbs.every((r, i) => r.opcode === i >> 8 && r.rb === (i & 0xff))).toBe(true);
  });

  it('matches decode() on spot rows', () => {
    expect(malformed(Op.INC, 0x10)).toBe(0); // INC R1
    expect(malformed(Op.INC, 0x12)).toBe(1); // field b must be 0
    expect(malformed(Op.INC, 0x80)).toBe(1); // register 8
    expect(malformed(Op.ADD, 0x12)).toBe(0); // ADD R1, R2
    expect(malformed(Op.ADD, 0x18)).toBe(1); // field b names register 8
    expect(malformed(Op.ADD, 0xf7)).toBe(1); // field a names register 15
    expect(malformed(Op.JMP, 0xff)).toBe(0); // byte 1 is the address, not a register byte
    expect(malformed(Op.RET, 0xff)).toBe(0); // no register byte
    expect(malformed(0xff, 0x88)).toBe(0); // invalid opcode faults first
  });

  it('follows the register-byte rule of docs/hardware-porting.md for every pair', () => {
    for (const { opcode, rb, malformed: actual } of rbs) {
      const { fields } = ops[opcode] ?? { fields: ISA_FIELDS.NONE };
      const expected =
        fields === ISA_FIELDS.A
          ? (rb & 0x80) !== 0 || (rb & 0x0f) !== 0
          : fields === ISA_FIELDS.AB
            ? (rb & 0x88) !== 0
            : false;
      if (actual !== Number(expected)) {
        expect.fail(`opcode 0x${opcode.toString(16)} rb 0x${rb.toString(16)}`);
      }
    }
  });

  it('renders one 5-digit line per record', () => {
    const lines = dataLines(renderDecoderRb(rbs));
    expect(lines).toHaveLength(65_536);
    expect(lines[Op.INC * 256 + 0x12]).toBe('24121');
    expect(lines[Op.ADD * 256 + 0x12]).toBe('20120');
  });
});
