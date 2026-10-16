import {
  REGISTER_COUNT,
  RESET_FLAGS,
  RESET_PC,
  RESET_REGISTER_VALUE,
  RESET_SD,
  RESET_SP,
} from '@vcpu/shared';

/** The mutable architectural registers. Only the CPU writes them. */
export interface RegisterFile {
  /** R0–R7. */
  readonly r: Uint8Array;
  pc: number;
  sp: number;
  /** Stack depth: bytes currently on the stack, 0..STACK_CAPACITY. */
  sd: number;
  /** FLAGS byte; bits 7–4 are always 0. */
  flags: number;
}

export function createRegisterFile(): RegisterFile {
  const file: RegisterFile = { r: new Uint8Array(REGISTER_COUNT), pc: 0, sp: 0, sd: 0, flags: 0 };
  resetRegisterFile(file);
  return file;
}

/** Puts every register at its reset value. */
export function resetRegisterFile(file: RegisterFile): void {
  file.r.fill(RESET_REGISTER_VALUE);
  file.pc = RESET_PC;
  file.sp = RESET_SP;
  file.sd = RESET_SD;
  file.flags = RESET_FLAGS;
}
