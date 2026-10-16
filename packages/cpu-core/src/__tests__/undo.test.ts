import { CpuStatus, Op } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { CpuBusyError, type Cpu } from '../cpu.js';
import type { TraceEntry } from '../trace.js';
import { asm, load, program } from './helpers.js';

/** Branches both ways and calls a subroutine that pushes, stores, loads and returns. */
const PROGRAM = program(
  asm.ldi(0, 0x7f), // 0x00
  asm.ldi(1, 1), // 0x03
  asm.jump('JZ', 0x00), // 0x06: not taken
  asm.call(0x0c), // 0x08
  asm.hlt(), // 0x0a
  asm.nop(), // 0x0b
  asm.push(0), // 0x0c
  asm.rr('ADD', 0, 1), // 0x0e: 0x7F + 1 sets N and V
  asm.storeAbs(0x80, 0), // 0x10
  asm.loadAbs(2, 0x80), // 0x13
  asm.jump('JNZ', 0x18), // 0x16: taken
  asm.pop(3), // 0x18
  asm.ret(), // 0x1a
);

function snapshot(cpu: Cpu) {
  return { state: cpu.getState(), metrics: cpu.getMetrics(), trace: cpu.getExecutionTrace() };
}

/** Steps to completion, keeping each step's undo record and the snapshot before it. */
function record(cpu: Cpu) {
  const steps: { before: ReturnType<typeof snapshot>; entry: TraceEntry }[] = [];
  while (
    cpu.getState().status !== CpuStatus.HALTED &&
    cpu.getState().status !== CpuStatus.FAULTED
  ) {
    const before = snapshot(cpu);
    const { entry } = cpu.step();
    if (entry === null) throw new Error('no step');
    steps.push({ before, entry });
  }
  return steps;
}

describe('undoStep', () => {
  it('reverses every step back to reset: state, metrics and trace', () => {
    const cpu = load(PROGRAM);
    const steps = record(cpu);
    expect(steps).toHaveLength(12);

    for (const { before, entry } of steps.toReversed()) {
      cpu.undoStep({ entry, ir: before.state.ir, status: before.state.status });
      expect(snapshot(cpu)).toEqual(before);
    }
  });

  it('reverses a precise fault without touching metrics', () => {
    const cpu = load(program(asm.ldi(0, 1), [Op.DIV, 0x01], asm.hlt()));
    const [first, faulting] = record(cpu);
    if (first === undefined || faulting === undefined) throw new Error('expected two steps');
    expect(cpu.getState().status).toBe(CpuStatus.FAULTED);

    cpu.undoStep({ entry: faulting.entry, ir: faulting.before.state.ir, status: CpuStatus.READY });
    expect(snapshot(cpu)).toEqual(faulting.before);
  });

  it('restores PAUSED and keeps a wrapped trace in order', () => {
    const cpu = load(PROGRAM, { traceCapacity: 2 });
    cpu.run({ maxInstructions: 4 });
    const before = snapshot(cpu);
    const { entry } = cpu.step();
    if (entry === null) throw new Error('no step');

    cpu.undoStep({ entry, ir: before.state.ir, status: CpuStatus.PAUSED });

    expect(snapshot(cpu)).toEqual({ ...before, trace: before.trace.slice(1) });
    expect(cpu.getState().status).toBe(CpuStatus.PAUSED);
    cpu.step();
    expect(cpu.getExecutionTrace().map((e) => e.sequence)).toEqual([3, 4]);
  });

  it('only takes the most recent step and a resting status', () => {
    const cpu = load(PROGRAM);
    const [first, second] = record(cpu).slice(0, 2);
    if (first === undefined || second === undefined) throw new Error('expected steps');

    cpu.reset();
    cpu.step();
    cpu.step();
    expect(() => {
      cpu.undoStep({ entry: first.entry, ir: null, status: CpuStatus.READY });
    }).toThrow(/most recent step \(sequence 1\), got sequence 0/);
    expect(() => {
      cpu.undoStep({ entry: second.entry, ir: null, status: CpuStatus.RUNNING });
    }).toThrow(/READY or PAUSED, not RUNNING/);
  });

  it('cannot be called from an observer callback', () => {
    const cpu = load(program(asm.nop(), asm.nop(), asm.hlt()));
    const { entry } = cpu.step();
    if (entry === null) throw new Error('no step');
    cpu.setObserver({
      beforeExecute: () => {
        cpu.undoStep({ entry, ir: null, status: CpuStatus.READY });
        return undefined;
      },
    });
    expect(() => cpu.step()).toThrow(CpuBusyError);
  });
});
