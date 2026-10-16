import { CpuStatus } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import { createDebugSession, DEFAULT_HISTORY_CAPACITY, HistoryBuffer } from '../index.js';
import { DIVIDE_BY_ZERO, FIBONACCI, sessionFor } from './fixtures.js';

function stepTimes(session: ReturnType<typeof sessionFor>, count: number): void {
  for (let i = 0; i < count; i += 1) session.step();
}

describe('step-back history', () => {
  it('says there is no more history at the start', () => {
    const session = sessionFor(FIBONACCI);
    expect(session.stepBack()).toEqual({
      ok: false,
      reason: 'no-history',
      message: 'No more history: already at the oldest recorded step',
    });
  });

  it('undoes one step at a time, newest first', () => {
    const session = sessionFor(FIBONACCI);
    const before = session.getState();
    session.step();
    const afterOne = session.getState();
    session.step();

    const back = session.stepBack();
    expect(back).toMatchObject({ ok: true, pc: 3, remaining: 1 });
    expect(back.ok && back.undone.instruction?.mnemonic).toBe('LDI');
    expect(session.getState()).toEqual(afterOne);
    session.stepBack();
    expect(session.getState()).toEqual(before);
    expect(session.getInstructionCount()).toBe(0);
    expect(session.getExecutionTrace()).toEqual([]);
  });

  it('keeps only historyCapacity steps and refuses to go further back', () => {
    const session = sessionFor(FIBONACCI, { historyCapacity: 3 });
    stepTimes(session, 2);
    const oldestReachable = session.getState();
    stepTimes(session, 3);

    expect(session.getHistoryStats()).toMatchObject({ entries: 3, capacity: 3 });
    for (let i = 0; i < 3; i += 1) expect(session.stepBack().ok).toBe(true);
    expect(session.getState()).toEqual(oldestReachable);
    expect(session.stepBack()).toMatchObject({ ok: false, reason: 'no-history' });
    expect(session.getInstructionCount()).toBe(2);
  });

  it('disables step-back when historyCapacity is 0', () => {
    const session = sessionFor(FIBONACCI, { historyCapacity: 0 });
    session.run();
    expect(session.stepBack()).toEqual({
      ok: false,
      reason: 'no-history',
      message: 'No more history: step-back is disabled (historyCapacity is 0)',
    });
    expect(session.getHistoryStats()).toEqual({
      entries: 0,
      capacity: 0,
      approxBytes: 0,
      maxApproxBytes: 0,
    });
  });

  it('enforces the bound however long the run, and reports estimated memory', () => {
    const session = sessionFor(FIBONACCI, { historyCapacity: 16 });
    expect(session.getHistoryStats()).toMatchObject({ entries: 0, approxBytes: 0 });

    session.run();
    const full = session.getHistoryStats();
    expect(full.entries).toBe(16);
    expect(full.approxBytes).toBeGreaterThan(0);
    expect(full.approxBytes).toBeLessThanOrEqual(full.maxApproxBytes);

    session.stepBack();
    expect(session.getHistoryStats().approxBytes).toBeLessThan(full.approxBytes);
    session.reset();
    expect(session.getHistoryStats()).toMatchObject({ entries: 0, approxBytes: 0 });
    expect(session.stepBack().ok).toBe(false);
  });

  it('defaults to 1024 entries and rejects a bad capacity', () => {
    expect(DEFAULT_HISTORY_CAPACITY).toBe(1024);
    expect(sessionFor(FIBONACCI).getHistoryStats().capacity).toBe(1024);
    expect(() => createDebugSession({ program: [1], historyCapacity: -1 })).toThrow(RangeError);
    expect(() => new HistoryBuffer(1.5)).toThrow(/non-negative integer/);
  });

  it('steps back from HALTED to the READY state before the HLT', () => {
    const session = sessionFor(FIBONACCI);
    session.run();
    expect(session.getStatus()).toBe(CpuStatus.HALTED);

    expect(session.stepBack().ok).toBe(true);
    expect(session.getState().status).toBe(CpuStatus.READY);
    expect(session.getCurrentInstruction().text).toBe('HLT');
    expect(session.run().stopReason).toBe('halted');
  });

  it('steps back from a precise fault to the READY state before it', () => {
    const session = sessionFor(DIVIDE_BY_ZERO);
    const instructions = session.run().executed;
    const metrics = session.getMetrics();
    expect(session.getState().fault?.code).toBe('DIVIDE_BY_ZERO');

    expect(session.stepBack().ok).toBe(true);
    expect(session.getState()).toMatchObject({ status: CpuStatus.READY, fault: null });
    expect(session.getMetrics()).toEqual(metrics);
    expect(session.getExecutionTrace()).toHaveLength(instructions - 1);
    expect(session.step()).toMatchObject({ stopReason: 'faulted', executed: 1 });
  });
});
