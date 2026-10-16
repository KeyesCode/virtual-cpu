import { FLAG_MASKS, FLAGS_USED_MASK, type OpcodeId, u8 } from '@vcpu/shared';

/**
 * The arithmetic logic unit. Every function is pure: it takes unsigned bytes and the current
 * FLAGS byte and returns the 8-bit result plus the new FLAGS byte, following the exact flag rules
 * in docs/instruction-set.md. All wrapping is explicit masking with 0xFF; no function relies on
 * JavaScript number overflow behaviour.
 */
export interface AluResult {
  /** The 8-bit result. CMP returns the discarded difference. */
  readonly result: number;
  /** The complete new FLAGS byte. */
  readonly flags: number;
}

const BYTE_MASK = 0xff;
const SIGN_BIT = 0x80;
const { Z, C, N, V } = FLAG_MASKS;

function checkFlags(flags: number): number {
  if ((u8(flags) & ~FLAGS_USED_MASK) !== 0) {
    throw new RangeError(`FLAGS bits 7-4 must be 0, got ${String(flags)}`);
  }
  return flags;
}

/** Z and N from an 8-bit result. */
function zeroNegative(result: number): number {
  return (result === 0 ? Z : 0) | ((result & SIGN_BIT) !== 0 ? N : 0);
}

function signDiffers(x: number, y: number): boolean {
  return ((x ^ y) & SIGN_BIT) !== 0;
}

/** r = (a + b) mod 256. Z N from r; C = carry out of bit 7; V = signed overflow. */
export function add(a: number, b: number): AluResult {
  const sum = u8(a) + u8(b);
  const result = sum & BYTE_MASK;
  const carry = sum > BYTE_MASK;
  const overflow = !signDiffers(a, b) && signDiffers(result, a);
  return {
    result,
    flags: zeroNegative(result) | (carry ? C : 0) | (overflow ? V : 0),
  };
}

/** r = (a − b) mod 256. Z N from r; C = borrow (a < b unsigned); V = signed overflow. */
export function sub(a: number, b: number): AluResult {
  const result = (u8(a) - u8(b) + 0x100) & BYTE_MASK;
  const borrow = a < b;
  const overflow = signDiffers(a, b) && signDiffers(result, a);
  return {
    result,
    flags: zeroNegative(result) | (borrow ? C : 0) | (overflow ? V : 0),
  };
}

/** Flags of a − b; `result` is the difference, which the CPU discards. */
export function cmp(a: number, b: number): AluResult {
  return sub(a, b);
}

/** r = low byte of a × b (unsigned). Z N from r; C = V = (a × b > 0xFF). */
export function mul(a: number, b: number): AluResult {
  const product = u8(a) * u8(b);
  const result = product & BYTE_MASK;
  const high = product > BYTE_MASK ? C | V : 0;
  return { result, flags: zeroNegative(result) | high };
}

/** r = floor(a ÷ b) (unsigned). Z N from r; C = V = 0. Throws a RangeError when b = 0. */
export function div(a: number, b: number): AluResult {
  u8(a);
  if (u8(b) === 0) {
    throw new RangeError('Division by zero: the CPU raises DIVIDE_BY_ZERO before calling the ALU');
  }
  const result = (a - (a % b)) / b;
  return { result, flags: zeroNegative(result) };
}

/** r = (a + 1) mod 256. Z N from r; V = (a = 0x7F); C unchanged. */
export function inc(a: number, flags: number): AluResult {
  const result = (u8(a) + 1) & BYTE_MASK;
  return {
    result,
    flags: (checkFlags(flags) & C) | zeroNegative(result) | (a === 0x7f ? V : 0),
  };
}

/** r = (a − 1) mod 256. Z N from r; V = (a = 0x80); C unchanged. */
export function dec(a: number, flags: number): AluResult {
  const result = (u8(a) + BYTE_MASK) & BYTE_MASK;
  return {
    result,
    flags: (checkFlags(flags) & C) | zeroNegative(result) | (a === SIGN_BIT ? V : 0),
  };
}

/** r = a AND b. Z N from r; C = V = 0. */
export function and(a: number, b: number): AluResult {
  const result = u8(a) & u8(b);
  return { result, flags: zeroNegative(result) };
}

/** r = a OR b. Z N from r; C = V = 0. */
export function or(a: number, b: number): AluResult {
  const result = u8(a) | u8(b);
  return { result, flags: zeroNegative(result) };
}

/** r = a XOR b. Z N from r; C = V = 0. */
export function xor(a: number, b: number): AluResult {
  const result = u8(a) ^ u8(b);
  return { result, flags: zeroNegative(result) };
}

/** r = a XOR 0xFF. Z N from r; C = V = 0. */
export function not(a: number): AluResult {
  const result = u8(a) ^ BYTE_MASK;
  return { result, flags: zeroNegative(result) };
}

/** r = (a × 2) mod 256. Z N from r; C = a[7]; V = 0. */
export function shl(a: number): AluResult {
  const result = (u8(a) << 1) & BYTE_MASK;
  return { result, flags: zeroNegative(result) | ((a & SIGN_BIT) !== 0 ? C : 0) };
}

/** r = floor(a ÷ 2) (logical). Z N from r; C = a[0]; V = 0. */
export function shr(a: number): AluResult {
  const result = u8(a) >>> 1;
  return { result, flags: zeroNegative(result) | ((a & 1) !== 0 ? C : 0) };
}

/** An ALU operation as the CPU calls it. Unary operations ignore `b`. */
export type AluOperation = (a: number, b: number, flags: number) => AluResult;

/** The opcode ids the ALU executes. */
export type AluOpcodeId = Extract<
  OpcodeId,
  | 'ADD'
  | 'SUB'
  | 'MUL'
  | 'DIV'
  | 'INC'
  | 'DEC'
  | 'AND'
  | 'OR'
  | 'XOR'
  | 'NOT'
  | 'SHL'
  | 'SHR'
  | 'CMP'
>;

/** ALU operation by opcode id. */
export const ALU_OPERATIONS: Readonly<Record<AluOpcodeId, AluOperation>> = Object.freeze({
  ADD: add,
  SUB: sub,
  MUL: mul,
  DIV: div,
  INC: (a, _b, flags) => inc(a, flags),
  DEC: (a, _b, flags) => dec(a, flags),
  AND: and,
  OR: or,
  XOR: xor,
  NOT: (a) => not(a),
  SHL: (a) => shl(a),
  SHR: (a) => shr(a),
  CMP: cmp,
});

/** True when `id` is executed by the ALU. */
export function isAluOpcode(id: OpcodeId): id is AluOpcodeId {
  return Object.hasOwn(ALU_OPERATIONS, id);
}
