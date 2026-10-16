import {
  encodeRegisterByte,
  FLAG_MASKS,
  MEMORY_SIZE,
  Op,
  opcodeById,
  type OpcodeId,
} from '@vcpu/shared';
import { expect } from 'vitest';
import { type Cpu, type CpuOptions, createCpu } from '../cpu.js';
import type { CpuState } from '../state.js';

/** Encoders for every instruction, built from the shared table. */
export const asm = {
  nop: (): number[] => [Op.NOP],
  hlt: (): number[] => [Op.HLT],
  mov: (d: number, s: number): number[] => [Op.MOV, encodeRegisterByte(d, s)],
  ldi: (d: number, imm: number): number[] => [Op.LDI, encodeRegisterByte(d), imm],
  loadAbs: (d: number, addr: number): number[] => [Op.LOAD_ABS, encodeRegisterByte(d), addr],
  loadInd: (d: number, p: number): number[] => [Op.LOAD_IND, encodeRegisterByte(d, p)],
  storeAbs: (addr: number, s: number): number[] => [Op.STORE_ABS, encodeRegisterByte(s), addr],
  storeInd: (p: number, s: number): number[] => [Op.STORE_IND, encodeRegisterByte(p, s)],
  /** RR-format ALU op: ADD SUB MUL DIV AND OR XOR CMP. */
  rr: (id: OpcodeId, a: number, b: number): number[] => [
    opcodeById[id].opcode,
    encodeRegisterByte(a, b),
  ],
  /** R-format op: INC DEC NOT SHL SHR PUSH POP. */
  r: (id: OpcodeId, a: number): number[] => [opcodeById[id].opcode, encodeRegisterByte(a)],
  /** A-format op: JMP JZ JNZ JC JNC CALL. */
  jump: (id: OpcodeId, target: number): number[] => [opcodeById[id].opcode, target],
  push: (s: number): number[] => [Op.PUSH, encodeRegisterByte(s)],
  pop: (d: number): number[] => [Op.POP, encodeRegisterByte(d)],
  call: (target: number): number[] => [Op.CALL, target],
  ret: (): number[] => [Op.RET],
};

export const { Z, C, N, V } = FLAG_MASKS;

/** Concatenates encoded instructions. */
export function program(...parts: number[][]): number[] {
  return parts.flat();
}

/** A full 256-byte image with code placed at the given addresses. */
export function image(parts: Readonly<Record<number, number[]>>): number[] {
  const bytes = new Array<number>(MEMORY_SIZE).fill(0);
  for (const [address, code] of Object.entries(parts)) {
    bytes.splice(Number(address), code.length, ...code);
  }
  expect(bytes).toHaveLength(MEMORY_SIZE);
  return bytes;
}

/** Loads `bytes` at 0x00 into a fresh CPU. */
export function load(bytes: readonly number[], options: CpuOptions = {}): Cpu {
  const cpu = createCpu(options);
  cpu.loadProgram(bytes);
  return cpu;
}

/** Loads `bytes`, runs to completion and returns the CPU. */
export function runProgram(bytes: readonly number[], options: CpuOptions = {}): Cpu {
  const cpu = load(bytes, options);
  cpu.run();
  return cpu;
}

/** Register Rn of a state. */
export function reg(state: CpuState, index: number): number | undefined {
  return state.registers[index];
}

/** LDI each listed value into R0, R1, … */
export function setRegisters(...values: number[]): number[] {
  return values.flatMap((value, index) => asm.ldi(index, value));
}

/**
 * Preambles that leave known FLAGS without touching R0–R3: each computes in R6/R7.
 * - `ZCV`: 0x80 + 0x80 → Z=1 C=1 N=0 V=1.
 * - `CN`: 0x00 − 0x01 → Z=0 C=1 N=1 V=0.
 */
export const FLAG_PREAMBLES = {
  ZCV: { code: program(asm.ldi(6, 0x80), asm.ldi(7, 0x80), asm.rr('ADD', 6, 7)), flags: Z | C | V },
  CN: { code: program(asm.ldi(6, 0x00), asm.ldi(7, 0x01), asm.rr('SUB', 6, 7)), flags: C | N },
} as const;

/** The architectural part of a state: everything except status and fault. */
export function architectural(state: CpuState): Omit<CpuState, 'status' | 'fault'> {
  const { registers, pc, sp, sd, flags, ir, memory } = state;
  return { registers, pc, sp, sd, flags, ir, memory };
}

export interface AluRun {
  /** R0 after the instruction (unchanged a for CMP). */
  readonly result: number | undefined;
  readonly flags: number;
  readonly cpu: Cpu;
}

/**
 * Runs `[preamble] LDI R0, a; LDI R1, b; <op> R0[, R1]; HLT` and returns R0 and FLAGS. The preamble
 * only touches R6/R7, so it sets the incoming FLAGS.
 */
export function execAlu(id: OpcodeId, a: number, b = 0, preamble: readonly number[] = []): AluRun {
  const unary = opcodeById[id].format === 'R';
  const op = unary ? asm.r(id, 0) : asm.rr(id, 0, 1);
  const cpu = runProgram(program([...preamble], asm.ldi(0, a), asm.ldi(1, b), op, asm.hlt()));
  const state = cpu.getState();
  expect(state.status).toBe('HALTED');
  return { result: reg(state, 0), flags: state.flags, cpu };
}
