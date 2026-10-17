import {
  CpuStatus,
  FAULT_CODE_NUMBERS,
  type FixtureExpectedState,
  type FixtureInitialState,
  type FixtureTraceStep,
  resetFixtureState,
} from '@vcpu/shared';
import { createCpu } from './cpu.js';
import type { CpuState } from './state.js';

/** What running a fixture's initial state produces: its expected final state and step trace. */
export interface FixtureExecution {
  readonly expected: FixtureExpectedState;
  /** One entry per `step()`, a faulting step included. */
  readonly trace: readonly FixtureTraceStep[];
}

/** Thrown when a fixture cannot be run or does not end HALTED or FAULTED. */
export class FixtureExecutionError extends Error {
  override readonly name = 'FixtureExecutionError';
}

function sameRegisters(state: FixtureInitialState, reset: FixtureInitialState): boolean {
  return (
    state.pc === reset.pc &&
    state.sp === reset.sp &&
    state.sd === reset.sd &&
    state.flags === reset.flags &&
    state.registers.every((value, index) => value === reset.registers[index])
  );
}

/** A program run step by step from reset: its step trace and the CPU's state when it stopped. */
export interface TracedRun {
  /** One entry per `step()`, a faulting step included. */
  readonly trace: readonly FixtureTraceStep[];
  /** HALTED, FAULTED, or READY when the step limit came first. */
  readonly state: CpuState;
  /** Retired instructions. */
  readonly instructions: number;
}

/**
 * Loads `memory` into a fresh CPU (reset registers) and runs it one `step()` at a time until it
 * halts or faults, or for at most `maxSteps` steps, recording each step as a fixture trace line.
 * Never throws for a program that is still running at the limit: the caller decides what that
 * means. `executeFixture` and the RTL differential verification (`@vcpu/rtl-tools`) share it.
 */
export function traceRun(memory: ArrayLike<number>, maxSteps: number): TracedRun {
  const cpu = createCpu({ traceCapacity: 0 });
  cpu.loadProgram(Array.from(memory));

  const trace: FixtureTraceStep[] = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const { status, entry } = cpu.step();
    if (entry === null) break;
    const state = cpu.getState();
    trace.push({
      step,
      pc: entry.pc,
      ir: [...entry.bytes],
      status: status === CpuStatus.HALTED || status === CpuStatus.FAULTED ? status : 'READY',
      fault: entry.fault?.code ?? null,
      regs: [...state.registers],
      flags: state.flags,
      sp: state.sp,
      sd: state.sd,
      nextPc: entry.nextPc,
      memWrites: entry.memoryWrites.map(({ address, after }) => ({ address, value: after })),
    });
    if (status === CpuStatus.HALTED || status === CpuStatus.FAULTED) break;
  }
  return { trace, state: cpu.getState(), instructions: cpu.getMetrics().instructions };
}

/**
 * Runs a fixture on a fresh CPU, one `step()` at a time, for at most `maxInstructions` steps.
 * The CPU can only start from reset (as an RTL core does), so the initial registers must be the
 * reset values; only the memory image varies. Throws `FixtureExecutionError` when they are not,
 * or when the program is still running at the limit.
 */
export function executeFixture(
  initial: FixtureInitialState,
  maxInstructions: number,
): FixtureExecution {
  if (!sameRegisters(initial, resetFixtureState(initial.memory))) {
    throw new FixtureExecutionError(
      'The initial registers must be the reset state (R0–R7 = 0, PC = 0x00, SP = 0xFF, SD = 0, FLAGS = 0)',
    );
  }
  const { trace, state, instructions } = traceRun(initial.memory, maxInstructions);
  const final = {
    registers: [...state.registers],
    pc: state.pc,
    sp: state.sp,
    sd: state.sd,
    flags: state.flags,
    memory: [...state.memory],
    instructions,
  };
  if (state.status === CpuStatus.HALTED) {
    return { expected: { status: CpuStatus.HALTED, fault: null, ...final }, trace };
  }
  if (state.fault !== null) {
    const { code, pc } = state.fault;
    const fault = { code, number: FAULT_CODE_NUMBERS[code], pc };
    return { expected: { status: CpuStatus.FAULTED, fault, ...final }, trace };
  }
  throw new FixtureExecutionError(
    `Still running after ${String(maxInstructions)} instructions; a fixture must halt or fault`,
  );
}
