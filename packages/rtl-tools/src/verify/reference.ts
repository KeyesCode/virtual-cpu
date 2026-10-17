import { traceRun } from '@vcpu/cpu-core';
import { CpuStatus, FAULT_CODE_NUMBERS, type FixtureTraceStep } from '@vcpu/shared';
import type { EndState } from './compare.js';

/** What the reference CPU did with a program: its per-step trace and where it stopped. */
export interface ReferenceRun {
  /** One fixture-shaped line per step, a faulting step included. */
  readonly trace: readonly FixtureTraceStep[];
  readonly end: EndState;
}

/**
 * Runs a 256-byte image on `@vcpu/cpu-core`, live, from reset, for at most `maxSteps` steps:
 * the reference side of the differential verification. The trace comes from cpu-core's own
 * `traceRun`, the code `pnpm fixtures:export` uses, so it has exactly the fixtures' shape. A
 * program still running at the limit ends READY with `stopReason` `max_steps`; the RTL runner,
 * given the same `--max-steps`, must stop at the same place in the same state.
 */
export function runReference(image: readonly number[], maxSteps: number): ReferenceRun {
  const { trace, state, instructions } = traceRun(image, maxSteps);
  const common = {
    instructions,
    registers: [...state.registers],
    pc: state.pc,
    sp: state.sp,
    sd: state.sd,
    flags: state.flags,
    memory: [...state.memory],
  };
  if (state.status === CpuStatus.HALTED) {
    return {
      trace,
      end: { stopReason: 'halted', status: CpuStatus.HALTED, fault: null, ...common },
    };
  }
  if (state.status === CpuStatus.FAULTED && state.fault !== null) {
    const { code, pc } = state.fault;
    return {
      trace,
      end: {
        stopReason: 'faulted',
        status: CpuStatus.FAULTED,
        fault: { code, number: FAULT_CODE_NUMBERS[code], pc },
        ...common,
      },
    };
  }
  return {
    trace,
    end: { stopReason: 'max_steps', status: CpuStatus.READY, fault: null, ...common },
  };
}
