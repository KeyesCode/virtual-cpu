import { FaultCode, INSTRUCTION_FORMATS, MEMORY_SIZE, Op, OPCODES } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { decode } from '../decoder.js';
import { image } from './helpers.js';

/** A valid encoding of `info` at 0x00: register fields R3 / R5 where used, trailing byte 0xA7. */
function validBytes(format: keyof typeof INSTRUCTION_FORMATS, opcode: number): number[] {
  switch (format) {
    case 'N':
      return [opcode];
    case 'R':
      return [opcode, 0x30];
    case 'RR':
      return [opcode, 0x35];
    case 'RI':
    case 'RA':
      return [opcode, 0x30, 0xa7];
    case 'A':
      return [opcode, 0xa7];
  }
}

describe('decode', () => {
  it.each(OPCODES)('decodes $syntax from the shared table', (info) => {
    const bytes = validBytes(info.format, info.opcode);
    const result = decode(image({ 0x00: bytes }), 0);
    const format = INSTRUCTION_FORMATS[info.format];
    expect(result).toEqual({
      ok: true,
      instruction: {
        address: 0,
        opcode: info.opcode,
        id: info.id,
        mnemonic: info.mnemonic,
        length: info.length,
        bytes,
        a: format.registerFields >= 1 ? 3 : null,
        b: format.registerFields === 2 ? 5 : null,
        byte: format.trailingByte === null ? null : 0xa7,
      },
    });
    expect(bytes).toHaveLength(info.length);
  });

  it('decodes at any address and freezes its result', () => {
    const result = decode(image({ 0x80: [Op.LDI, 0x70, 0xff] }), 0x80);
    expect(result).toMatchObject({ ok: true, instruction: { address: 0x80, a: 7, byte: 0xff } });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.instruction)).toBe(true);
      expect(Object.isFrozen(result.instruction.bytes)).toBe(true);
    }
  });

  it('accepts any trailing byte and any A-format operand byte', () => {
    for (let byte = 0; byte <= 0xff; byte += 1) {
      expect(decode(image({ 0x00: [Op.JMP, byte] }), 0).ok).toBe(true);
      expect(decode(image({ 0x00: [Op.LDI, 0x00, byte] }), 0).ok).toBe(true);
    }
  });

  it('reports INVALID_OPCODE with only the opcode byte', () => {
    expect(decode(image({ 0x10: [0x02] }), 0x10)).toEqual({
      ok: false,
      fault: {
        code: FaultCode.INVALID_OPCODE,
        pc: 0x10,
        detail: '0x02 is not an ISA v1.0.0 opcode',
      },
      bytes: [0x02],
    });
  });

  it('reports INSTRUCTION_OVERRUN without reading past 0xFF', () => {
    const memory = image({ 0xff: [Op.MOV] });
    const result = decode(memory, 0xff);
    expect(result).toMatchObject({
      ok: false,
      fault: { code: FaultCode.INSTRUCTION_OVERRUN, pc: 0xff },
      bytes: [Op.MOV],
    });
    expect(decode(image({ 0xfe: [Op.LDI, 0x00] }), 0xfe)).toMatchObject({
      fault: { code: FaultCode.INSTRUCTION_OVERRUN },
    });
    // A 2-byte instruction at 0xFE and a 3-byte one at 0xFD fit exactly.
    expect(decode(image({ 0xfe: [Op.JMP, 0] }), 0xfe).ok).toBe(true);
    expect(decode(image({ 0xfd: [Op.LDI, 0, 0] }), 0xfd).ok).toBe(true);
  });

  it.each([
    { name: 'RR field a = 8', bytes: [Op.ADD, 0x81], field: 'a', why: 'names register 8' },
    { name: 'RR field b = 15', bytes: [Op.ADD, 0x1f], field: 'b', why: 'names register 15' },
    { name: 'RR both bad: field a first', bytes: [Op.ADD, 0xf9], field: 'a', why: 'register 15' },
    { name: 'R unused field b ≠ 0', bytes: [Op.INC, 0x01], field: 'b', why: 'must be 0' },
    { name: 'R field a = 9', bytes: [Op.PUSH, 0x90], field: 'a', why: 'register 9' },
    { name: 'RI unused field b ≠ 0', bytes: [Op.LDI, 0x08, 0x00], field: 'b', why: 'must be 0' },
    { name: 'RA field a = 8', bytes: [Op.STORE_ABS, 0x80, 0x00], field: 'a', why: 'register 8' },
  ])('reports MALFORMED_OPERAND: $name', ({ bytes, field, why }) => {
    const result = decode(image({ 0x00: bytes }), 0);
    expect(result).toMatchObject({
      ok: false,
      fault: { code: FaultCode.MALFORMED_OPERAND, pc: 0 },
      bytes,
    });
    if (!result.ok) {
      expect(result.fault.detail).toContain(`field ${field}`);
      expect(result.fault.detail).toContain(why);
    }
  });

  it('does not change memory', () => {
    const memory = image({ 0x00: [Op.ADD, 0x81] });
    const copy = [...memory];
    decode(memory, 0);
    expect(memory).toEqual(copy);
  });

  it('rejects a memory that is not 256 bytes and a PC that is not a byte', () => {
    expect(() => decode([Op.NOP], 0)).toThrow(RangeError);
    expect(() => decode(new Array<number>(MEMORY_SIZE).fill(0), 256)).toThrow(RangeError);
    expect(() => decode(new Array<number>(MEMORY_SIZE).fill(0), -1)).toThrow(RangeError);
  });
});
