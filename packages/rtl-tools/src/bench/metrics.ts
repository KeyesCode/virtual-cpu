import {
  FLAG_BITS,
  type InstructionCategory,
  OPCODE_IDS,
  type OpcodeId,
  opcodeByByte,
  RESET_FLAGS,
} from '@vcpu/shared';
import type { RtlTraceStep } from '../verify/compare.js';

/**
 * Performance metrics of one RTL run, computed from the runner's per-step trace: the clocks each
 * retired instruction took (the `cycle` at its retirement minus the previous step's), grouped by
 * opcode and by ISA class, plus branch, call, return and data-memory counts. Pure functions over
 * parsed data; the benchmark command gates them on a passing differential comparison first.
 */

/** The ISA's instruction classes (`OpcodeInfo.category`), in the order reports list them. */
export const INSTRUCTION_CLASSES = [
  'system',
  'data',
  'arithmetic',
  'logic',
  'control',
  'stack',
] as const satisfies readonly InstructionCategory[];

/** Clocks spent by a group of retired instructions. */
export interface ClockGroup {
  readonly instructions: number;
  readonly cycles: number;
  /** cycles / instructions. */
  readonly cpi: number;
  /** Fewest and most clocks one instruction of the group took. */
  readonly minClocks: number;
  readonly maxClocks: number;
}

export interface BranchCounts {
  readonly taken: number;
  readonly notTaken: number;
}

export interface RtlMetrics {
  /** Clock cycles from reset release to the stop: the runner's `cycles`. */
  readonly cycles: number;
  /** Retired instructions (`instret`). */
  readonly instructions: number;
  /** CPI = cycles / instructions; null when nothing retired. */
  readonly cpi: number | null;
  /** Retired instructions per ISA class, classes that never ran left out. */
  readonly byClass: Partial<Record<InstructionCategory, ClockGroup>>;
  /** Retired instructions per opcode id, ids that never ran left out. */
  readonly byOpcode: Partial<Record<OpcodeId, ClockGroup>>;
  /** Conditional branches (JZ, JNZ, JC, JNC), all together and per opcode. */
  readonly branches: BranchCounts & {
    readonly byOpcode: Partial<Record<OpcodeId, BranchCounts>>;
  };
  readonly jumps: number;
  readonly calls: number;
  readonly returns: number;
  /** Data-memory accesses (instruction fetches excluded), from the opcode table. */
  readonly dataReads: number;
  readonly dataWrites: number;
  /** Instruction bytes fetched by retired instructions. */
  readonly fetchedBytes: number;
}

/** CPI = total clock cycles / retired instructions; null when no instruction retired. */
export function cpi(cycles: number, instructions: number): number | null {
  return instructions === 0 ? null : cycles / instructions;
}

interface MutableGroup {
  instructions: number;
  cycles: number;
  minClocks: number;
  maxClocks: number;
}

function add(groups: Map<string, MutableGroup>, key: string, clocks: number): void {
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, { instructions: 1, cycles: clocks, minClocks: clocks, maxClocks: clocks });
  } else {
    group.instructions += 1;
    group.cycles += clocks;
    group.minClocks = Math.min(group.minClocks, clocks);
    group.maxClocks = Math.max(group.maxClocks, clocks);
  }
}

/** The groups in `order`, those that never ran left out. */
function ordered<K extends string>(
  groups: Map<string, MutableGroup>,
  order: readonly K[],
): Partial<Record<K, ClockGroup>> {
  const out: Partial<Record<K, ClockGroup>> = {};
  for (const key of order) {
    const group = groups.get(key);
    if (group !== undefined) {
      out[key] = { ...group, cpi: group.cycles / group.instructions };
    }
  }
  return out;
}

/**
 * The metrics of one run from its trace and the runner's end counts. Only the first
 * `instructions` steps retired: a precise fault is always the last step and retires nothing, so
 * its clocks count in `cycles` but in no class. A conditional branch was taken when its condition
 * held on the flags before it (the previous step's, or the reset value), which also settles a
 * branch whose target is the next instruction.
 */
export function rtlMetrics(
  trace: readonly RtlTraceStep[],
  end: { readonly cycles: number; readonly instructions: number },
): RtlMetrics {
  const byClass = new Map<string, MutableGroup>();
  const byOpcode = new Map<string, MutableGroup>();
  const branches = new Map<OpcodeId, { taken: number; notTaken: number }>();
  let taken = 0;
  let notTaken = 0;
  let jumps = 0;
  let calls = 0;
  let returns = 0;
  let dataReads = 0;
  let dataWrites = 0;
  let fetchedBytes = 0;
  let previousCycle = 0;
  let flags = RESET_FLAGS;
  trace.slice(0, end.instructions).forEach((step) => {
    const info = opcodeByByte[step.ir[0] ?? -1];
    if (info === undefined) {
      throw new Error(
        `step ${String(step.step)} retired an invalid opcode ${String(step.ir[0] ?? '-')}`,
      );
    }
    const clocks = step.cycle - previousCycle;
    previousCycle = step.cycle;
    add(byClass, info.category, clocks);
    add(byOpcode, info.id, clocks);
    if (info.controlFlow === 'branch' && info.condition !== null) {
      const held = ((flags >> FLAG_BITS[info.condition.flag]) & 1) === info.condition.value;
      const counts = branches.get(info.id) ?? { taken: 0, notTaken: 0 };
      if (held) {
        counts.taken += 1;
        taken += 1;
      } else {
        counts.notTaken += 1;
        notTaken += 1;
      }
      branches.set(info.id, counts);
    }
    if (info.controlFlow === 'jump') jumps += 1;
    if (info.controlFlow === 'call') calls += 1;
    if (info.controlFlow === 'return') returns += 1;
    dataReads += info.dataReads;
    dataWrites += info.dataWrites;
    fetchedBytes += info.length;
    flags = step.flags;
  });
  const branchesByOpcode: Partial<Record<OpcodeId, BranchCounts>> = {};
  for (const id of OPCODE_IDS) {
    const counts = branches.get(id);
    if (counts !== undefined) branchesByOpcode[id] = counts;
  }
  return {
    cycles: end.cycles,
    instructions: end.instructions,
    cpi: cpi(end.cycles, end.instructions),
    byClass: ordered(byClass, INSTRUCTION_CLASSES),
    byOpcode: ordered(byOpcode, OPCODE_IDS),
    branches: { taken, notTaken, byOpcode: branchesByOpcode },
    jumps,
    calls,
    returns,
    dataReads,
    dataWrites,
    fetchedBytes,
  };
}
