import {
  FaultCode,
  FLAG_BITS,
  OPCODE_IDS,
  type OpcodeId,
  opcodeByByte,
  RESET_FLAGS,
} from '@vcpu/shared';
import type { ReferenceRun } from './reference.js';

/** The conditional branches, whose taken and not-taken outcomes are counted separately. */
export const BRANCH_IDS = ['JZ', 'JNZ', 'JC', 'JNC'] as const satisfies readonly OpcodeId[];
export type BranchId = (typeof BRANCH_IDS)[number];

export const FAULT_CODES: readonly FaultCode[] = Object.values(FaultCode);

/**
 * What the verified programs exercised, counted on the reference run (on a passing case the RTL
 * did exactly the same): retired instructions per opcode, the fault each run ended in, branch
 * outcomes per condition and the deepest stack.
 */
export interface Coverage {
  cases: number;
  steps: number;
  retired: number;
  readonly opcodes: Record<OpcodeId, number>;
  readonly faults: Record<FaultCode, number>;
  readonly branches: Record<BranchId, { taken: number; notTaken: number }>;
  readonly stops: { halted: number; faulted: number; max_steps: number };
  maxStackDepth: number;
}

export function emptyCoverage(): Coverage {
  return {
    cases: 0,
    steps: 0,
    retired: 0,
    opcodes: Object.fromEntries(OPCODE_IDS.map((id) => [id, 0])) as Record<OpcodeId, number>,
    faults: Object.fromEntries(FAULT_CODES.map((code) => [code, 0])) as Record<FaultCode, number>,
    branches: Object.fromEntries(
      BRANCH_IDS.map((id) => [id, { taken: 0, notTaken: 0 }]),
    ) as Coverage['branches'],
    stops: { halted: 0, faulted: 0, max_steps: 0 },
    maxStackDepth: 0,
  };
}

function isBranch(id: OpcodeId): id is BranchId {
  return (BRANCH_IDS as readonly string[]).includes(id);
}

/**
 * Adds one reference run. Only the first `instructions` steps retired: a precise fault is always
 * the last step and retires nothing. A branch was taken when its condition held on the flags
 * before it (the previous step's, or the reset value), which also settles a branch whose target
 * is the next instruction.
 */
export function addCoverage(coverage: Coverage, run: ReferenceRun): void {
  coverage.cases += 1;
  coverage.steps += run.trace.length;
  coverage.retired += run.end.instructions;
  coverage.stops[run.end.stopReason] += 1;
  if (run.end.fault !== null) {
    coverage.faults[run.end.fault.code] += 1;
  }
  let flags = RESET_FLAGS;
  run.trace.forEach((step, i) => {
    coverage.maxStackDepth = Math.max(coverage.maxStackDepth, step.sd);
    const info = opcodeByByte[step.ir[0] ?? -1];
    if (i < run.end.instructions && info !== undefined) {
      coverage.opcodes[info.id] += 1;
      if (isBranch(info.id) && info.condition !== null) {
        const bit = (flags >> FLAG_BITS[info.condition.flag]) & 1;
        coverage.branches[info.id][bit === info.condition.value ? 'taken' : 'notTaken'] += 1;
      }
    }
    flags = step.flags;
  });
}

export function mergeCoverage(into: Coverage, from: Coverage): void {
  into.cases += from.cases;
  into.steps += from.steps;
  into.retired += from.retired;
  for (const id of OPCODE_IDS) into.opcodes[id] += from.opcodes[id];
  for (const code of FAULT_CODES) into.faults[code] += from.faults[code];
  for (const id of BRANCH_IDS) {
    into.branches[id].taken += from.branches[id].taken;
    into.branches[id].notTaken += from.branches[id].notTaken;
  }
  into.stops.halted += from.stops.halted;
  into.stops.faulted += from.stops.faulted;
  into.stops.max_steps += from.stops.max_steps;
  into.maxStackDepth = Math.max(into.maxStackDepth, from.maxStackDepth);
}

/** Every opcode never retired and every fault code never hit; empty when coverage is full. */
export function coverageGaps(coverage: Coverage): string[] {
  return [
    ...OPCODE_IDS.filter((id) => coverage.opcodes[id] === 0).map(
      (id) => `opcode ${id} never retired`,
    ),
    ...FAULT_CODES.filter((code) => coverage.faults[code] === 0).map(
      (code) => `fault ${code} never hit`,
    ),
  ];
}

/** Plain-text tables of the coverage, for the console and the Markdown report alike. */
export function formatCoverage(coverage: Coverage): string {
  const lines: string[] = [];
  const covered = OPCODE_IDS.filter((id) => coverage.opcodes[id] > 0).length;
  lines.push(`opcodes retired (${String(covered)}/${String(OPCODE_IDS.length)}):`);
  const cells = OPCODE_IDS.map(
    (id) => `${id.padEnd(9)} ${String(coverage.opcodes[id]).padStart(9)}`,
  );
  for (let i = 0; i < cells.length; i += 5) {
    lines.push(`  ${cells.slice(i, i + 5).join('   ')}`);
  }
  const hit = FAULT_CODES.filter((code) => coverage.faults[code] > 0).length;
  lines.push(`faults hit (${String(hit)}/${String(FAULT_CODES.length)}):`);
  for (const code of FAULT_CODES) {
    lines.push(`  ${code.padEnd(19)} ${String(coverage.faults[code]).padStart(7)}`);
  }
  lines.push('branches (taken / not taken):');
  for (const id of BRANCH_IDS) {
    const { taken, notTaken } = coverage.branches[id];
    lines.push(`  ${id.padEnd(4)} ${String(taken).padStart(9)} / ${String(notTaken)}`);
  }
  const { halted, faulted, max_steps: limit } = coverage.stops;
  lines.push(
    `stops: ${String(halted)} halted, ${String(faulted)} faulted, ${String(limit)} at the step limit`,
    `max stack depth: ${String(coverage.maxStackDepth)}`,
    `steps: ${String(coverage.steps)} (${String(coverage.retired)} retired)`,
  );
  return `${lines.join('\n')}\n`;
}
