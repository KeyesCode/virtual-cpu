import { disassemble, type SourceMapEntry } from '@vcpu/assembler';
import {
  type CpuFault,
  type CpuState,
  decode,
  type DecodedInstruction,
  type TraceEntry,
} from '@vcpu/cpu-core';
import { FLAG_MASKS, FLAG_NAMES, type FlagName, MEMORY_SIZE } from '@vcpu/shared';
import { instructionAt, type SourceMap } from './source-map.js';

/** One live stack byte. */
export interface StackSlot {
  readonly address: number;
  readonly value: number;
}

export interface StackView {
  readonly sp: number;
  /** SD: bytes on the stack. */
  readonly depth: number;
  /** The live slots SP+1 … 0xFF, top of stack (the most recent push) first. */
  readonly slots: readonly StackSlot[];
}

/** The instruction at PC, about to execute. */
export interface CurrentInstruction {
  readonly address: number;
  /** The bytes it occupies (only those fetched before the fault when it cannot decode). */
  readonly bytes: readonly number[];
  /** `null` when the bytes at PC do not decode; `fault` then says why. */
  readonly instruction: DecodedInstruction | null;
  /** Assembly for it, e.g. `JNZ 0x08`, or `.byte 0xNN` when it does not decode. */
  readonly text: string;
  readonly fault: CpuFault | null;
  /** The source line it came from, when a source map was given and covers it. */
  readonly source: SourceMapEntry | null;
}

/** Canonical assembly for one instruction's bytes, from the assembler's disassembler. */
export function instructionText(bytes: readonly number[]): string {
  return disassemble(bytes)[0]?.text ?? '';
}

/** The FLAGS byte as named booleans. */
export function flagsOf(flags: number): Readonly<Record<FlagName, boolean>> {
  return Object.freeze(
    Object.fromEntries(
      FLAG_NAMES.map((flag) => [flag, (flags & FLAG_MASKS[flag]) !== 0]),
    ) as Record<FlagName, boolean>,
  );
}

/** The stack as the slots between SP and the top of memory. */
export function stackView(state: CpuState): StackView {
  const slots: StackSlot[] = [];
  for (let address = state.sp + 1; address < MEMORY_SIZE; address += 1) {
    slots.push(Object.freeze({ address, value: state.memory[address] ?? 0 }));
  }
  return Object.freeze({ sp: state.sp, depth: state.sd, slots: Object.freeze(slots) });
}

/** Decodes the instruction at PC without executing it. */
export function currentInstruction(
  state: CpuState,
  sourceMap: SourceMap | null,
): CurrentInstruction {
  const decoded = decode(state.memory, state.pc);
  const bytes = decoded.ok ? decoded.instruction.bytes : decoded.bytes;
  return Object.freeze({
    address: state.pc,
    bytes,
    instruction: decoded.ok ? decoded.instruction : null,
    text: instructionText(bytes),
    fault: decoded.ok ? null : decoded.fault,
    source: instructionAt(sourceMap, state.pc),
  });
}

/** The newest `count` entries of a trace (all of them when `count` is omitted), oldest first. */
export function timeline(trace: readonly TraceEntry[], count?: number): readonly TraceEntry[] {
  if (count === undefined) {
    return trace;
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`A timeline length must be a non-negative integer, got ${String(count)}`);
  }
  return Object.freeze(trace.slice(Math.max(0, trace.length - count)));
}
