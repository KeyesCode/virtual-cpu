import type {
  CpuStatus,
  FaultCode,
  InstructionLength,
  Mnemonic,
  OpcodeId,
  RegisterIndex,
} from '@vcpu/shared';
import type { Memory } from './memory.js';
import type { RegisterFile } from './registers.js';

/** A fault record: what went wrong and at which instruction address. */
export interface CpuFault {
  readonly code: FaultCode;
  /** Address of the faulting instruction (its PC). */
  readonly pc: number;
  /** Human-readable explanation. */
  readonly detail: string;
}

/**
 * One decoded instruction: the contents of IR. Register fields are `null` when the format has
 * no such field; `byte` is the trailing immediate or address byte, or `null`.
 */
export interface DecodedInstruction {
  readonly address: number;
  readonly opcode: number;
  readonly id: OpcodeId;
  readonly mnemonic: Mnemonic;
  readonly length: InstructionLength;
  /** The encoded bytes, opcode first. */
  readonly bytes: readonly number[];
  /** Register field `a` (high nibble of the register byte). */
  readonly a: RegisterIndex | null;
  /** Register field `b` (low nibble), set only for the RR format. */
  readonly b: RegisterIndex | null;
  /** Trailing imm8 / addr8 byte. */
  readonly byte: number | null;
}

/** A frozen, serializable snapshot of the whole CPU. */
export interface CpuState {
  /** R0–R7. */
  readonly registers: readonly number[];
  readonly pc: number;
  readonly sp: number;
  readonly sd: number;
  readonly flags: number;
  /** The last retired instruction; `null` after reset. Not architectural. */
  readonly ir: DecodedInstruction | null;
  readonly status: CpuStatus;
  readonly fault: CpuFault | null;
  /** All 256 memory bytes. */
  readonly memory: readonly number[];
}

/** Builds a deep-frozen `CpuState`. `ir` and `fault` are already frozen when the CPU creates them. */
export function snapshotState(
  registers: RegisterFile,
  memory: Memory,
  ir: DecodedInstruction | null,
  status: CpuStatus,
  fault: CpuFault | null,
): CpuState {
  return Object.freeze({
    registers: Object.freeze(Array.from(registers.r)),
    pc: registers.pc,
    sp: registers.sp,
    sd: registers.sd,
    flags: registers.flags,
    ir,
    status,
    fault,
    memory: Object.freeze(memory.toArray()),
  });
}
