/**
 * Checked 8-bit helpers. The ISA never relies on JavaScript number semantics implicitly: every
 * 8-bit value is validated or wrapped explicitly through these functions.
 */

export type RegisterIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** True when `value` is an integer in 0..255. */
export function isU8(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xff;
}

/** True when `value` is an integer in −128..127. */
export function isS8(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= -0x80 && value <= 0x7f;
}

/** Returns `value` unchanged if it is an unsigned byte; throws a RangeError otherwise. */
export function u8(value: number): number {
  if (!isU8(value)) {
    throw new RangeError(`Expected an unsigned 8-bit integer (0..255), got ${String(value)}`);
  }
  return value;
}

/**
 * Wraps any safe integer to its low 8 bits (two's complement modulo 256), e.g. `low8(256) === 0`
 * and `low8(-1) === 255`. Throws on non-integers, so a stray fraction or NaN never wraps silently.
 */
export function low8(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Expected a safe integer to wrap to 8 bits, got ${String(value)}`);
  }
  return ((value % 0x100) + 0x100) % 0x100;
}

/** Reads an unsigned byte as two's complement: 0x00..0x7F → 0..127, 0x80..0xFF → −128..−1. */
export function toSigned8(value: number): number {
  return u8(value) >= 0x80 ? value - 0x100 : value;
}

/** Encodes a signed value in −128..127 as its two's-complement byte; throws otherwise. */
export function fromSigned8(value: number): number {
  if (!isS8(value)) {
    throw new RangeError(`Expected a signed 8-bit integer (-128..127), got ${String(value)}`);
  }
  return value < 0 ? value + 0x100 : value;
}

/** Bit `index` (0 = least significant, 7 = most significant) of an unsigned byte. */
export function bit(value: number, index: number): 0 | 1 {
  u8(value);
  if (!Number.isInteger(index) || index < 0 || index > 7) {
    throw new RangeError(`Expected a bit index 0..7, got ${String(index)}`);
  }
  return ((value >> index) & 1) === 1 ? 1 : 0;
}

/** True when `value` is a register number 0..7. */
export function isRegisterIndex(value: unknown): value is RegisterIndex {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 7;
}

/**
 * Builds a register byte: high nibble = field `a`, low nibble = field `b`. For one-register
 * formats leave `b` at 0. Throws a RangeError for a field outside 0..7: callers (the assembler)
 * validate register names before encoding.
 */
export function encodeRegisterByte(a: number, b = 0): number {
  if (!isRegisterIndex(a)) {
    throw new RangeError(`Register field a must be 0..7, got ${String(a)}`);
  }
  if (!isRegisterIndex(b)) {
    throw new RangeError(`Register field b must be 0..7, got ${String(b)}`);
  }
  return (a << 4) | b;
}

export type RegisterByteError = {
  readonly ok: false;
  /** The offending field: `a` = high nibble, `b` = low nibble. */
  readonly field: 'a' | 'b';
  /** The nibble's value (0..15). */
  readonly value: number;
  /** `register-out-of-range`: a used field holds 8..15. `unused-field-not-zero`: an unused field is not 0. */
  readonly reason: 'register-out-of-range' | 'unused-field-not-zero';
};

export type RegisterByteResult =
  { readonly ok: true; readonly a: RegisterIndex; readonly b: RegisterIndex } | RegisterByteError;

/**
 * Decodes a register byte for a format that uses `fieldsUsed` register fields (1 = `a` only,
 * 2 = `a` and `b`). A malformed byte returns a typed error and never throws; the CPU maps any
 * error to a MALFORMED_OPERAND fault. Field `a` is checked before field `b`.
 * Throws a RangeError only when `byte` is not a byte at all.
 */
export function decodeRegisterByte(byte: number, fieldsUsed: 1 | 2 = 2): RegisterByteResult {
  u8(byte);
  const a = byte >> 4;
  const b = byte & 0x0f;
  if (!isRegisterIndex(a)) {
    return { ok: false, field: 'a', value: a, reason: 'register-out-of-range' };
  }
  if (fieldsUsed === 1) {
    return b === 0
      ? { ok: true, a, b: 0 }
      : { ok: false, field: 'b', value: b, reason: 'unused-field-not-zero' };
  }
  if (!isRegisterIndex(b)) {
    return { ok: false, field: 'b', value: b, reason: 'register-out-of-range' };
  }
  return { ok: true, a, b };
}
