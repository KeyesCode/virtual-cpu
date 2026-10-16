import { deepFreeze } from '../freeze.js';
import { CpuStatus, FaultCode, type FlagName } from './types.js';

/** Semantic version of the ISA. Any change to encodings or semantics bumps it. */
export const ISA_VERSION = '1.0.0';

/** Display name of the CPU, shared by the CLI and the web dashboard. */
export const CPU_NAME = 'VCPU-8';

export const WORD_BITS = 8;
export const BYTE_MAX = 0xff;

export const MEMORY_SIZE = 256;
export const MIN_ADDRESS = 0x00;
export const MAX_ADDRESS = 0xff;

export const REGISTER_COUNT = 8;
export const REGISTER_NAMES = deepFreeze(['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const);
export type RegisterName = (typeof REGISTER_NAMES)[number];

export interface MemoryRegion {
  readonly name: 'program' | 'data' | 'stack';
  /** First address, inclusive. */
  readonly start: number;
  /** Last address, inclusive. */
  readonly end: number;
  readonly size: number;
}

/** Conventional regions. They are not protected: any instruction may access any address. */
export const MEMORY_MAP = deepFreeze({
  program: { name: 'program', start: 0x00, end: 0x7f, size: 128 },
  data: { name: 'data', start: 0x80, end: 0xbf, size: 64 },
  stack: { name: 'stack', start: 0xc0, end: 0xff, size: 64 },
} as const satisfies Record<MemoryRegion['name'], MemoryRegion>);

/** Maximum stack depth (SD). PUSH or CALL at this depth faults with STACK_OVERFLOW. */
export const STACK_CAPACITY = 64;

/** Reset values of the architectural state. Memory is restored separately (see docs). */
export const RESET_PC = 0x00;
export const RESET_SP = 0xff;
export const RESET_SD = 0;
export const RESET_FLAGS = 0x00;
export const RESET_REGISTER_VALUE = 0x00;
export const RESET_STATUS = CpuStatus.READY;

/** FLAGS bit positions. Bits 7–4 always read 0. */
export const FLAG_BITS = deepFreeze({ Z: 3, C: 2, N: 1, V: 0 } as const satisfies Record<
  FlagName,
  number
>);

/** FLAGS bit masks. */
export const FLAG_MASKS = deepFreeze({
  Z: 0b1000,
  C: 0b0100,
  N: 0b0010,
  V: 0b0001,
} as const satisfies Record<FlagName, number>);

/** The FLAGS bits that exist; `flags & ~FLAGS_USED_MASK` is always 0. */
export const FLAGS_USED_MASK = 0x0f;

/**
 * Instructional timing model (estimated cycles, not measured hardware):
 * cycles = length × fetchCyclesPerByte + executeCycles + dataAccessCycles per data access
 *        + per-opcode extra execute cycles + branchTakenPenalty when control transfers.
 */
export const TIMING_MODEL = deepFreeze({
  fetchCyclesPerByte: 1,
  executeCycles: 1,
  dataAccessCycles: 1,
  mulExtraCycles: 3,
  divExtraCycles: 7,
  branchTakenPenalty: 1,
} as const);

/**
 * 3-bit numeric fault encodings for hardware (RTL) fixtures and test vectors.
 * 0 means "no fault".
 */
export const FAULT_CODE_NUMBERS = deepFreeze({
  [FaultCode.INVALID_OPCODE]: 1,
  [FaultCode.MALFORMED_OPERAND]: 2,
  [FaultCode.INSTRUCTION_OVERRUN]: 3,
  [FaultCode.PC_OVERFLOW]: 4,
  [FaultCode.DIVIDE_BY_ZERO]: 5,
  [FaultCode.STACK_OVERFLOW]: 6,
  [FaultCode.STACK_UNDERFLOW]: 7,
} as const satisfies Record<FaultCode, number>);
export const NO_FAULT_NUMBER = 0;

/** 3-bit numeric status encodings for hardware (RTL) fixtures and test vectors. */
export const CPU_STATUS_NUMBERS = deepFreeze({
  [CpuStatus.READY]: 0,
  [CpuStatus.RUNNING]: 1,
  [CpuStatus.PAUSED]: 2,
  [CpuStatus.HALTED]: 3,
  [CpuStatus.FAULTED]: 4,
} as const satisfies Record<CpuStatus, number>);
