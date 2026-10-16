import { z } from 'zod';
import {
  FAULT_CODE_NUMBERS,
  FLAGS_USED_MASK,
  MEMORY_SIZE,
  REGISTER_COUNT,
  RESET_FLAGS,
  RESET_PC,
  RESET_REGISTER_VALUE,
  RESET_SD,
  RESET_SP,
  STACK_CAPACITY,
} from '../isa/constants.js';
import { CpuStatus, FaultCode } from '../isa/types.js';
import { U8Schema } from '../schemas.js';

/**
 * Hardware test fixtures, format `vcpu8-fixture/1`: a program's initial state, its instruction
 * limit and the exact final state the emulator reaches. They are written for RTL verification
 * (Project 2), so every value is a plain number and every memory image is all 256 bytes.
 */
export const FIXTURE_FORMAT_V1 = 'vcpu8-fixture/1';

/** All 256 memory bytes, address 0x00 first. */
export const MemoryImageSchema = z.array(U8Schema).length(MEMORY_SIZE);

/** A FLAGS byte: bits 7–4 always read 0. */
export const FlagsByteSchema = U8Schema.max(FLAGS_USED_MASK);

/** The stack depth counter SD, 0..64. */
export const StackDepthSchema = z.number().int().min(0).max(STACK_CAPACITY);

/** The architectural registers. IR is not architectural and is never compared. */
const cpuRegisters = {
  /** R0–R7, in order. */
  registers: z.array(U8Schema).length(REGISTER_COUNT),
  pc: U8Schema,
  sp: U8Schema,
  sd: StackDepthSchema,
  flags: FlagsByteSchema,
};

/** The state a fixture starts from: registers plus the full memory image (the program). */
export const FixtureInitialStateSchema = z.strictObject({
  ...cpuRegisters,
  memory: MemoryImageSchema,
});

export const FaultCodeSchema = z.enum(FaultCode);

/** The fault that stopped the CPU: its code, its 3-bit hardware number and the instruction's PC. */
export const FixtureFaultSchema = z
  .strictObject({
    code: FaultCodeSchema,
    /** `FAULT_CODE_NUMBERS[code]`, 1..7. */
    number: z.number().int().min(1).max(7),
    pc: U8Schema,
  })
  .refine((fault) => FAULT_CODE_NUMBERS[fault.code] === fault.number, {
    message: 'Fault number does not match FAULT_CODE_NUMBERS[code]',
    path: ['number'],
  });

const finalState = {
  /** Retired instructions: HLT and a post-commit PC_OVERFLOW instruction count, a precise fault does not. */
  instructions: z.number().int().min(0),
  ...cpuRegisters,
  memory: MemoryImageSchema,
};

/** The final state: HALTED with no fault, or FAULTED with one. */
export const FixtureExpectedStateSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal(CpuStatus.HALTED), fault: z.null(), ...finalState }),
  z.strictObject({
    status: z.literal(CpuStatus.FAULTED),
    fault: FixtureFaultSchema,
    ...finalState,
  }),
]);

export const FixtureKindSchema = z.enum(['example', 'instruction', 'fault']);

/**
 * One `fixtures/v1/<name>.json`. Run `initial` for at most `maxInstructions` steps; the CPU must
 * then be HALTED or FAULTED in exactly the `expected` state.
 */
export const FixtureSchemaV1 = z
  .strictObject({
    format: z.literal(FIXTURE_FORMAT_V1),
    /** The ISA version the fixture was generated for (`ISA_VERSION`). */
    isaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** Also the file's base name. */
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: FixtureKindSchema,
    description: z.string().min(1),
    /** The assembly source the memory image was assembled from. */
    source: z.string(),
    initial: FixtureInitialStateSchema,
    maxInstructions: z.number().int().positive(),
    expected: FixtureExpectedStateSchema,
  })
  .meta({
    title: 'VCPU-8 hardware test fixture (vcpu8-fixture/1)',
    description:
      'Initial state, instruction limit and expected final state of one VCPU-8 program, for verifying an RTL implementation against the emulator.',
  });

export type FixtureInitialState = z.output<typeof FixtureInitialStateSchema>;
export type FixtureFault = z.output<typeof FixtureFaultSchema>;
export type FixtureExpectedState = z.output<typeof FixtureExpectedStateSchema>;
export type FixtureKind = z.output<typeof FixtureKindSchema>;
export type FixtureV1 = z.output<typeof FixtureSchemaV1>;

/** The JSON Schema of `FixtureSchemaV1`, committed as `fixtures/v1/fixture.schema.json`. */
export function fixtureJsonSchemaV1(): Record<string, unknown> {
  return z.toJSONSchema(FixtureSchemaV1, { target: 'draft-2020-12' });
}

/** The reset state with `memory` as the memory image: where every v1 fixture starts. */
export function resetFixtureState(memory: ArrayLike<number>): FixtureInitialState {
  return {
    registers: new Array<number>(REGISTER_COUNT).fill(RESET_REGISTER_VALUE),
    pc: RESET_PC,
    sp: RESET_SP,
    sd: RESET_SD,
    flags: RESET_FLAGS,
    memory: MemoryImageSchema.parse(Array.from(memory)),
  };
}

/** One line of `<name>.trace.jsonl`: the state after one `step()`, faulting steps included. */
export const FixtureTraceStepSchema = z.strictObject({
  /** 0-based step number. */
  step: z.number().int().min(0),
  /** Address of the instruction. */
  pc: U8Schema,
  /** The fetched bytes, opcode first (only the opcode when the fault came before operand fetch). */
  ir: z.array(U8Schema).min(1).max(3),
  /** Status after the step: READY to continue, HALTED or FAULTED. */
  status: z.enum([CpuStatus.READY, CpuStatus.HALTED, CpuStatus.FAULTED]),
  fault: FaultCodeSchema.nullable(),
  /** Registers after the step. */
  regs: z.array(U8Schema).length(REGISTER_COUNT),
  flags: FlagsByteSchema,
  sp: U8Schema,
  sd: StackDepthSchema,
  /** PC after the step. */
  nextPc: U8Schema,
  /** Data-memory writes, in order. */
  memWrites: z.array(z.strictObject({ address: U8Schema, value: U8Schema })),
});

export type FixtureTraceStep = z.output<typeof FixtureTraceStepSchema>;

/** Renders trace steps as JSON Lines, one step per line, ending with a newline. */
export function formatTraceJsonl(steps: readonly FixtureTraceStep[]): string {
  return steps.map((step) => `${JSON.stringify(step)}\n`).join('');
}

/** Parses and validates `<name>.trace.jsonl`. */
export function parseTraceJsonl(text: string): FixtureTraceStep[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => FixtureTraceStepSchema.parse(JSON.parse(line)));
}

/**
 * A `$readmemh` image: one byte per line as two uppercase hex digits, address 0x00 first,
 * newline-terminated. Throws unless `memory` is exactly 256 bytes.
 */
export function formatMemoryHex(memory: readonly number[]): string {
  return MemoryImageSchema.parse(memory)
    .map((byte) => `${byte.toString(16).toUpperCase().padStart(2, '0')}\n`)
    .join('');
}

/** Parses a `formatMemoryHex` image back into 256 bytes; throws on any other shape. */
export function parseMemoryHex(text: string): number[] {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const bad = lines.findIndex((line) => !/^[0-9A-F]{2}$/.test(line));
  if (bad !== -1) {
    throw new RangeError(`Line ${String(bad + 1)} is not two uppercase hex digits`);
  }
  return MemoryImageSchema.parse(lines.map((line) => Number.parseInt(line, 16)));
}
