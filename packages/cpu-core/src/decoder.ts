import {
  decodeRegisterByte,
  FaultCode,
  INSTRUCTION_FORMATS,
  ISA_VERSION,
  lookupOpcode,
  MEMORY_SIZE,
  REGISTER_BYTE_OFFSET,
  type RegisterIndex,
  u8,
} from '@vcpu/shared';
import { byteAt } from './memory.js';
import type { CpuFault, DecodedInstruction } from './state.js';

export type DecodeResult =
  | { readonly ok: true; readonly instruction: DecodedInstruction }
  | {
      readonly ok: false;
      readonly fault: CpuFault;
      /** The bytes fetched before the fault was detected, opcode first. */
      readonly bytes: readonly number[];
    };

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

function failure(code: FaultCode, pc: number, detail: string, bytes: number[]): DecodeResult {
  return Object.freeze({
    ok: false,
    fault: Object.freeze({ code, pc, detail }),
    bytes: Object.freeze(bytes),
  });
}

/**
 * Decodes the instruction at `pc` from a 256-byte memory, driven only by the shared opcode table.
 * Faults are checked in ISA order: INVALID_OPCODE → INSTRUCTION_OVERRUN → MALFORMED_OPERAND
 * (field a before field b). No byte past 0xFF is ever read. Decoding never changes anything.
 */
export function decode(memory: ArrayLike<number>, pc: number): DecodeResult {
  if (memory.length !== MEMORY_SIZE) {
    throw new RangeError(
      `decode() needs the ${String(MEMORY_SIZE)}-byte memory, got ${String(memory.length)} bytes`,
    );
  }
  const opcode = byteAt(memory, u8(pc));
  const info = lookupOpcode(opcode);
  if (info === undefined) {
    return failure(
      FaultCode.INVALID_OPCODE,
      pc,
      `${hex(opcode)} is not an ISA v${ISA_VERSION} opcode`,
      [opcode],
    );
  }
  if (pc + info.length > MEMORY_SIZE) {
    return failure(
      FaultCode.INSTRUCTION_OVERRUN,
      pc,
      `${info.mnemonic} is ${String(info.length)} bytes and crosses the end of memory at ${hex(pc)}`,
      [opcode],
    );
  }
  const bytes = [opcode];
  for (let offset = 1; offset < info.length; offset += 1) {
    bytes.push(byteAt(memory, pc + offset));
  }

  const format = INSTRUCTION_FORMATS[info.format];
  let a: RegisterIndex | null = null;
  let b: RegisterIndex | null = null;
  if (format.registerFields !== 0) {
    const registerByte = byteAt(bytes, REGISTER_BYTE_OFFSET);
    const fields = decodeRegisterByte(registerByte, format.registerFields);
    if (!fields.ok) {
      const problem =
        fields.reason === 'register-out-of-range'
          ? `names register ${String(fields.value)}, but only R0–R7 exist`
          : `must be 0 because ${info.mnemonic} does not use it, got ${String(fields.value)}`;
      return failure(
        FaultCode.MALFORMED_OPERAND,
        pc,
        `${info.mnemonic} register byte ${hex(registerByte)}: field ${fields.field} ${problem}`,
        bytes,
      );
    }
    a = fields.a;
    b = format.registerFields === 2 ? fields.b : null;
  }
  const byte = format.trailingByte === null ? null : byteAt(bytes, info.length - 1);

  return Object.freeze({
    ok: true,
    instruction: Object.freeze({
      address: pc,
      opcode,
      id: info.id,
      mnemonic: info.mnemonic,
      length: info.length,
      bytes: Object.freeze(bytes),
      a,
      b,
      byte,
    }),
  });
}
