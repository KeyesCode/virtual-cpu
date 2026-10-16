import { describe, expect, it } from 'vitest';
import {
  bit,
  decodeRegisterByte,
  encodeRegisterByte,
  fromSigned8,
  isRegisterIndex,
  isS8,
  isU8,
  low8,
  toSigned8,
  u8,
} from './bits.js';

const NOT_INTEGERS = [0.5, -0.5, 255.5, Number.NaN, Number.POSITIVE_INFINITY, -Infinity];

describe('u8 / isU8', () => {
  it('accepts exactly the integers 0..255', () => {
    for (let value = -300; value <= 600; value += 1) {
      const valid = value >= 0 && value <= 255;
      expect(isU8(value)).toBe(valid);
      if (valid) {
        expect(u8(value)).toBe(value);
      } else {
        expect(() => u8(value)).toThrow(RangeError);
      }
    }
  });

  it('rejects non-integers and non-numbers', () => {
    for (const value of NOT_INTEGERS) {
      expect(isU8(value)).toBe(false);
      expect(() => u8(value)).toThrow(RangeError);
    }
    expect(isU8('1')).toBe(false);
    expect(isU8(null)).toBe(false);
  });
});

describe('low8', () => {
  it('wraps integers modulo 256 into 0..255', () => {
    for (let value = -1024; value <= 1024; value += 1) {
      const wrapped = low8(value);
      expect(isU8(wrapped)).toBe(true);
      expect(Math.abs((wrapped - value) % 256)).toBe(0);
    }
    expect(low8(256)).toBe(0);
    expect(low8(-1)).toBe(255);
    expect(low8(255 * 255)).toBe(0x01);
  });

  it('throws on non-integers instead of wrapping them', () => {
    for (const value of NOT_INTEGERS) {
      expect(() => low8(value)).toThrow(RangeError);
    }
    expect(() => low8(2 ** 53)).toThrow(RangeError);
  });
});

describe('two-complement conversions', () => {
  it('toSigned8 is exhaustive over 0..255', () => {
    for (let value = 0; value <= 255; value += 1) {
      expect(toSigned8(value)).toBe(value < 128 ? value : value - 256);
    }
    expect(toSigned8(0x7f)).toBe(127);
    expect(toSigned8(0x80)).toBe(-128);
    expect(toSigned8(0xff)).toBe(-1);
  });

  it('fromSigned8 is exhaustive over -128..127 and inverts toSigned8', () => {
    for (let value = -128; value <= 127; value += 1) {
      const byte = fromSigned8(value);
      expect(isU8(byte)).toBe(true);
      expect(toSigned8(byte)).toBe(value);
    }
    for (let byte = 0; byte <= 255; byte += 1) {
      expect(fromSigned8(toSigned8(byte))).toBe(byte);
    }
  });

  it('rejects out-of-range input', () => {
    expect(() => toSigned8(256)).toThrow(RangeError);
    expect(() => toSigned8(-1)).toThrow(RangeError);
    expect(() => fromSigned8(128)).toThrow(RangeError);
    expect(() => fromSigned8(-129)).toThrow(RangeError);
    for (const value of NOT_INTEGERS) {
      expect(() => toSigned8(value)).toThrow(RangeError);
      expect(() => fromSigned8(value)).toThrow(RangeError);
    }
    expect(isS8(-128)).toBe(true);
    expect(isS8(127)).toBe(true);
    expect(isS8(128)).toBe(false);
  });
});

describe('bit', () => {
  it('reads every bit of every byte', () => {
    for (let value = 0; value <= 255; value += 1) {
      let rebuilt = 0;
      for (let index = 0; index <= 7; index += 1) {
        rebuilt += bit(value, index) * 2 ** index;
      }
      expect(rebuilt).toBe(value);
    }
  });

  it('rejects bad values and bad indices', () => {
    expect(() => bit(256, 0)).toThrow(RangeError);
    expect(() => bit(1, 8)).toThrow(RangeError);
    expect(() => bit(1, -1)).toThrow(RangeError);
    expect(() => bit(1, 0.5)).toThrow(RangeError);
  });
});

describe('register byte', () => {
  it('encodes every register pair as high nibble a, low nibble b', () => {
    for (let a = 0; a <= 7; a += 1) {
      expect(encodeRegisterByte(a)).toBe(a * 16);
      for (let b = 0; b <= 7; b += 1) {
        const byte = encodeRegisterByte(a, b);
        expect(byte).toBe(a * 16 + b);
        expect(decodeRegisterByte(byte, 2)).toEqual({ ok: true, a, b });
      }
    }
  });

  it('refuses to encode a field outside 0..7', () => {
    for (const bad of [-1, 8, 15, 0.5]) {
      expect(() => encodeRegisterByte(bad, 0)).toThrow(RangeError);
      expect(() => encodeRegisterByte(0, bad)).toThrow(RangeError);
    }
  });

  it('decodes all 256 bytes for two-register formats', () => {
    for (let byte = 0; byte <= 255; byte += 1) {
      const a = byte >> 4;
      const b = byte & 0x0f;
      const result = decodeRegisterByte(byte, 2);
      if (a > 7) {
        expect(result).toEqual({
          ok: false,
          field: 'a',
          value: a,
          reason: 'register-out-of-range',
        });
      } else if (b > 7) {
        expect(result).toEqual({
          ok: false,
          field: 'b',
          value: b,
          reason: 'register-out-of-range',
        });
      } else {
        expect(result).toEqual({ ok: true, a, b });
        expect(encodeRegisterByte(a, b)).toBe(byte);
      }
    }
  });

  it('decodes all 256 bytes for one-register formats', () => {
    let valid = 0;
    for (let byte = 0; byte <= 255; byte += 1) {
      const a = byte >> 4;
      const b = byte & 0x0f;
      const result = decodeRegisterByte(byte, 1);
      if (a > 7) {
        expect(result).toEqual({
          ok: false,
          field: 'a',
          value: a,
          reason: 'register-out-of-range',
        });
      } else if (b !== 0) {
        expect(result).toEqual({
          ok: false,
          field: 'b',
          value: b,
          reason: 'unused-field-not-zero',
        });
      } else {
        valid += 1;
        expect(result).toEqual({ ok: true, a, b: 0 });
        expect(encodeRegisterByte(a)).toBe(byte);
      }
    }
    expect(valid).toBe(8);
  });

  it('never throws on a malformed byte, only on a value that is not a byte', () => {
    for (let byte = 0; byte <= 255; byte += 1) {
      expect(() => decodeRegisterByte(byte, 1)).not.toThrow();
      expect(() => decodeRegisterByte(byte, 2)).not.toThrow();
    }
    expect(() => decodeRegisterByte(256)).toThrow(RangeError);
  });

  it('isRegisterIndex accepts exactly 0..7', () => {
    expect([-1, 0, 7, 8, 1.5].map(isRegisterIndex)).toEqual([false, true, true, false, false]);
  });
});
