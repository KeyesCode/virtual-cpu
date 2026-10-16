import type { CpuMetrics, CpuState, TraceEntry } from '@vcpu/cpu-core';
import { instructionText } from '@vcpu/debugger';
import {
  CpuStatus,
  FaultCode,
  FLAG_MASKS,
  FLAG_NAMES,
  ISA_VERSION,
  MEMORY_SIZE,
  OPCODE_IDS,
  REGISTER_NAMES,
  U8Schema,
} from '@vcpu/shared';
import { z } from 'zod';

/**
 * The `pnpm cpu run --json` document. It is a stable interface: fields are only ever added, and
 * any change that removes or redefines one bumps `version`. apps/cli/README.md documents it.
 */
export const RUN_JSON_VERSION = 1;

const Count = z.number().int().nonnegative();

export const FaultJsonSchema = z.strictObject({
  code: z.enum(Object.values(FaultCode)),
  /** Address of the faulting instruction. */
  pc: U8Schema,
  detail: z.string(),
});

export const TraceEntryJsonSchema = z.strictObject({
  /** 0-based step number since reset. */
  sequence: Count,
  pc: U8Schema,
  nextPc: U8Schema,
  bytes: z.array(U8Schema),
  /** The instruction as assembly, e.g. `STORE [R2], R0`. */
  text: z.string(),
  registerChanges: z.array(
    z.strictObject({
      register: z.enum([...REGISTER_NAMES, 'SP', 'SD']),
      before: U8Schema,
      after: U8Schema,
    }),
  ),
  flagChanges: z.array(
    z.strictObject({ flag: z.enum(FLAG_NAMES), before: z.boolean(), after: z.boolean() }),
  ),
  memoryReads: z.array(z.strictObject({ address: U8Schema, value: U8Schema })),
  memoryWrites: z.array(z.strictObject({ address: U8Schema, before: U8Schema, after: U8Schema })),
  /** Conditional branches only; `null` for every other instruction. */
  branchTaken: z.boolean().nullable(),
  cycles: Count,
  status: z.enum(Object.values(CpuStatus)),
  fault: FaultJsonSchema.nullable(),
});
export type TraceEntryJson = z.infer<typeof TraceEntryJsonSchema>;

export const RunJsonSchema = z.strictObject({
  version: z.literal(RUN_JSON_VERSION),
  isaVersion: z.string(),
  /** The input path as given on the command line. */
  file: z.string(),
  input: z.enum(['asm', 'bin']),
  maxInstructions: Count,
  /** `halted` (exit 0), `faulted` (exit 2) or `limit` (exit 3). */
  stopReason: z.enum(['halted', 'faulted', 'limit']),
  exitCode: z.union([z.literal(0), z.literal(2), z.literal(3)]),
  status: z.enum(Object.values(CpuStatus)),
  registers: z.strictObject(
    Object.fromEntries(REGISTER_NAMES.map((name) => [name, U8Schema])) as Record<
      (typeof REGISTER_NAMES)[number],
      typeof U8Schema
    >,
  ),
  pc: U8Schema,
  sp: U8Schema,
  /** Stack depth in bytes. */
  sd: Count,
  flags: z.strictObject({
    /** The FLAGS byte. */
    value: U8Schema,
    Z: z.boolean(),
    C: z.boolean(),
    N: z.boolean(),
    V: z.boolean(),
  }),
  /** The last retired instruction as assembly; `null` when none has retired. */
  ir: z.string().nullable(),
  fault: FaultJsonSchema.nullable(),
  /** All 256 bytes of memory, address 0x00 first. */
  memory: z.array(U8Schema).length(MEMORY_SIZE),
  metrics: z.strictObject({
    instructions: Count,
    /** From the documented timing model; not measured clock cycles. */
    estimatedCycles: Count,
    memoryReads: Count,
    memoryWrites: Count,
    fetchedBytes: Count,
    branchesTaken: Count,
    branchesNotTaken: Count,
    /** Retired instructions per opcode id; every id is present. */
    opcodeCounts: z.record(z.enum(OPCODE_IDS), Count),
  }),
  /** Every executed step, oldest first. Present only with `--trace`. */
  trace: z.array(TraceEntryJsonSchema).optional(),
});
export type RunJson = z.infer<typeof RunJsonSchema>;

export function traceEntryJson(entry: TraceEntry): TraceEntryJson {
  return {
    sequence: entry.sequence,
    pc: entry.pc,
    nextPc: entry.nextPc,
    bytes: [...entry.bytes],
    text: instructionText(entry.bytes),
    registerChanges: entry.registerChanges.map((c) => ({ ...c })),
    flagChanges: entry.flagChanges.map((c) => ({ ...c })),
    memoryReads: entry.memoryReads.map((r) => ({ ...r })),
    memoryWrites: entry.memoryWrites.map((w) => ({ ...w })),
    branchTaken: entry.branchTaken,
    cycles: entry.cycles,
    status: entry.status,
    fault: entry.fault === null ? null : { ...entry.fault },
  };
}

export interface RunJsonInput {
  readonly file: string;
  readonly input: 'asm' | 'bin';
  readonly maxInstructions: number;
  readonly stopReason: RunJson['stopReason'];
  readonly exitCode: RunJson['exitCode'];
  readonly state: CpuState;
  readonly metrics: CpuMetrics;
  readonly trace: readonly TraceEntry[] | null;
}

/** Builds the `run --json` document and validates it against `RunJsonSchema`. */
export function runJson(input: RunJsonInput): RunJson {
  const { state, metrics } = input;
  return RunJsonSchema.parse({
    version: RUN_JSON_VERSION,
    isaVersion: ISA_VERSION,
    file: input.file,
    input: input.input,
    maxInstructions: input.maxInstructions,
    stopReason: input.stopReason,
    exitCode: input.exitCode,
    status: state.status,
    registers: Object.fromEntries(REGISTER_NAMES.map((name, i) => [name, state.registers[i]])),
    pc: state.pc,
    sp: state.sp,
    sd: state.sd,
    flags: {
      value: state.flags,
      ...Object.fromEntries(FLAG_NAMES.map((f) => [f, (state.flags & FLAG_MASKS[f]) !== 0])),
    },
    ir: state.ir === null ? null : instructionText(state.ir.bytes),
    fault: state.fault === null ? null : { ...state.fault },
    memory: [...state.memory],
    metrics: {
      instructions: metrics.instructions,
      estimatedCycles: metrics.estimatedCycles,
      memoryReads: metrics.memoryReads,
      memoryWrites: metrics.memoryWrites,
      fetchedBytes: metrics.fetchedBytes,
      branchesTaken: metrics.branchesTaken,
      branchesNotTaken: metrics.branchesNotTaken,
      opcodeCounts: { ...metrics.opcodeCounts },
    },
    ...(input.trace === null ? {} : { trace: input.trace.map(traceEntryJson) }),
  });
}
