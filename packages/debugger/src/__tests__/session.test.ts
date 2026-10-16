import { CpuStatus } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { DebugSessionBusyError, type DebugStop } from '../index.js';
import { addressOf, DIVIDE_BY_ZERO, FIBONACCI, sessionFor } from './fixtures.js';

describe('debug session', () => {
  it('runs to HALTED and then stays there', () => {
    const session = sessionFor(FIBONACCI);
    const stop = session.run();

    expect(stop).toMatchObject({ stopReason: 'halted', executed: 73, hits: [], fault: null });
    expect(session.getStatus()).toBe(CpuStatus.HALTED);
    expect(session.readMemory(0x80, 10)).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34]);
    expect(session.run()).toMatchObject({ stopReason: 'halted', executed: 0 });
    expect(session.step()).toMatchObject({ stopReason: 'halted', executed: 0 });
  });

  it('reports a fault', () => {
    const session = sessionFor(DIVIDE_BY_ZERO);
    expect(session.run()).toMatchObject({
      stopReason: 'faulted',
      executed: 4,
      fault: { code: 'DIVIDE_BY_ZERO' },
    });
    expect(session.getStatus()).toBe(CpuStatus.FAULTED);
  });

  it('stops at the instruction limit and leaves the session PAUSED', () => {
    const session = sessionFor(FIBONACCI);
    expect(session.getStatus()).toBe(CpuStatus.READY);

    expect(session.run({ maxInstructions: 5 })).toMatchObject({ stopReason: 'limit', executed: 5 });
    expect(session.getStatus()).toBe(CpuStatus.PAUSED);
    expect(session.getInstructionCount()).toBe(5);
    expect(session.run({ maxInstructions: 0 })).toMatchObject({ stopReason: 'limit', executed: 0 });
    expect(() => session.run({ maxInstructions: -1 })).toThrow(RangeError);
  });

  it('pauses from a step listener and is RUNNING meanwhile', () => {
    const session = sessionFor(FIBONACCI);
    const statuses: CpuStatus[] = [];
    let seen = 0;
    session.onStep(() => {
      statuses.push(session.getStatus());
      seen += 1;
      if (seen === 3) session.pause();
    });

    expect(session.run()).toMatchObject({ stopReason: 'paused', executed: 3 });
    expect(statuses).toEqual([CpuStatus.RUNNING, CpuStatus.RUNNING, CpuStatus.RUNNING]);
    expect(session.getStatus()).toBe(CpuStatus.PAUSED);

    session.pause(); // outside a run: nothing to pause
    expect(session.run({ maxInstructions: 1 }).stopReason).toBe('limit');
  });

  it('emits step and stop events, and unsubscribes', () => {
    const session = sessionFor(FIBONACCI);
    const stepped: number[] = [];
    const stops: DebugStop[] = [];
    const offStep = session.onStep((entry) => stepped.push(entry.pc));
    const offStop = session.onStop((stop) => stops.push(stop));

    const first = session.step();
    session.addBreakpoint({ address: addressOf(FIBONACCI, 'STORE [R4], R0') });
    const second = session.run();

    expect(stepped).toEqual([0, 3, 6]);
    expect(stops).toEqual([first, second]);
    offStep();
    offStop();
    session.step();
    expect(stepped).toHaveLength(3);
    expect(stops).toHaveLength(2);
  });

  it('refuses re-entry from a listener', () => {
    const session = sessionFor(FIBONACCI);
    const off = session.onStep(() => session.step());
    expect(() => session.run()).toThrow(DebugSessionBusyError);
    off();

    session.onStop(() => session.stepBack());
    expect(() => session.step()).toThrow(/stepBack\(\) cannot be called/);
    expect(session.getStatus()).toBe(CpuStatus.READY);
  });

  it('resets to the loaded program, keeping breakpoints and watchpoints', () => {
    const session = sessionFor(FIBONACCI);
    session.addBreakpoint({ address: addressOf(FIBONACCI, 'JNZ loop') });
    session.addWatchpoint({ address: 0x85, kind: 'write' });
    session.run();
    session.run();

    session.reset();

    expect(session.getStatus()).toBe(CpuStatus.READY);
    expect(session.getState().pc).toBe(0);
    expect(session.readMemory(0x80, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(session.getInstructionCount()).toBe(0);
    expect(session.getHistoryStats().entries).toBe(0);
    expect(session.listBreakpoints()).toHaveLength(1);
    expect(session.listWatchpoints()).toHaveLength(1);
    expect(session.run().stopReason).toBe('breakpoint');
  });
});
