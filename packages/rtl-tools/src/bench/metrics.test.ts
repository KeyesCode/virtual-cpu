import { CpuStatus, FLAG_MASKS, Op } from '@vcpu/shared';
import { describe, expect, it } from 'vitest';
import type { RtlTraceStep } from '../verify/compare.js';
import { cpi, rtlMetrics } from './metrics.js';

/** One hand-built trace line: only `ir[0]`, `flags`, `pc`, `nextPc` and `cycle` matter here. */
function step(
  index: number,
  ir: number[],
  cycle: number,
  flags = 0,
  pc = 0,
  nextPc = pc + ir.length,
): RtlTraceStep {
  return {
    step: index,
    pc,
    ir,
    status: ir[0] === Op.HLT ? CpuStatus.HALTED : CpuStatus.READY,
    fault: null,
    regs: [0, 0, 0, 0, 0, 0, 0, 0],
    flags,
    sp: 0xff,
    sd: 0,
    nextPc,
    memWrites: [],
    cycle,
  };
}

const C = FLAG_MASKS.C;
const Z = FLAG_MASKS.Z;

describe('cpi', () => {
  it('is total cycles divided by retired instructions', () => {
    expect(cpi(53, 10)).toBe(5.3);
    expect(cpi(39, 8)).toBe(39 / 8);
  });

  it('is null, not a division by zero, when nothing retired', () => {
    expect(cpi(0, 0)).toBeNull();
    expect(cpi(2, 0)).toBeNull();
  });
});

describe('rtlMetrics', () => {
  // LDI (6 clocks), CMP sets C (5), JC taken on that C (5), JZ not taken (5), CALL (5), RET (4),
  // DIV (5), HLT (4): 39 clocks for 8 instructions.
  const trace = [
    step(0, [Op.LDI, 0x00, 0x01], 6),
    step(1, [Op.CMP, 0x01], 11, C),
    step(2, [Op.JC, 0x20], 16, C, 0x05, 0x20),
    step(3, [Op.JZ, 0x00], 21, C, 0x20),
    step(4, [Op.CALL, 0x40], 26, C, 0x22, 0x40),
    step(5, [Op.RET], 30, C, 0x40, 0x24),
    step(6, [Op.DIV, 0x01], 35, 0, 0x24),
    step(7, [Op.HLT], 39, 0, 0x26, 0x26),
  ];
  const metrics = rtlMetrics(trace, { cycles: 39, instructions: 8 });

  it('reports cycles, retired instructions and CPI = cycles / instructions', () => {
    expect(metrics.cycles).toBe(39);
    expect(metrics.instructions).toBe(8);
    expect(metrics.cpi).toBe(39 / 8);
  });

  it('charges each instruction the clocks between its retirement and the previous one', () => {
    expect(metrics.byOpcode).toEqual({
      HLT: { instructions: 1, cycles: 4, cpi: 4, minClocks: 4, maxClocks: 4 },
      LDI: { instructions: 1, cycles: 6, cpi: 6, minClocks: 6, maxClocks: 6 },
      DIV: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      CMP: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      JZ: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      JC: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      CALL: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      RET: { instructions: 1, cycles: 4, cpi: 4, minClocks: 4, maxClocks: 4 },
    });
  });

  it('groups by ISA class, and the class cycles add up to the total', () => {
    expect(metrics.byClass).toEqual({
      system: { instructions: 1, cycles: 4, cpi: 4, minClocks: 4, maxClocks: 4 },
      data: { instructions: 1, cycles: 6, cpi: 6, minClocks: 6, maxClocks: 6 },
      arithmetic: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      logic: { instructions: 1, cycles: 5, cpi: 5, minClocks: 5, maxClocks: 5 },
      control: { instructions: 4, cycles: 19, cpi: 19 / 4, minClocks: 4, maxClocks: 5 },
    });
    const groups = Object.values(metrics.byClass);
    expect(groups.reduce((sum, g) => sum + g.cycles, 0)).toBe(metrics.cycles);
    expect(groups.reduce((sum, g) => sum + g.instructions, 0)).toBe(metrics.instructions);
  });

  it('decides taken and not taken from the flags before the branch', () => {
    expect(metrics.branches).toEqual({
      taken: 1,
      notTaken: 1,
      byOpcode: { JZ: { taken: 0, notTaken: 1 }, JC: { taken: 1, notTaken: 0 } },
    });
    expect(metrics.calls).toBe(1);
    expect(metrics.returns).toBe(1);
    expect(metrics.jumps).toBe(0);
  });

  it('counts a branch to the next instruction as taken when its condition held', () => {
    const next = rtlMetrics(
      [step(0, [Op.CMP, 0x00], 5, Z), step(1, [Op.JZ, 0x04], 10, Z, 0x02, 0x04)],
      { cycles: 10, instructions: 2 },
    );
    expect(next.branches).toMatchObject({ taken: 1, notTaken: 0 });
  });

  it('counts data accesses from the opcode table and fetched bytes from the lengths', () => {
    // CALL writes the return address and RET reads it; nothing else touches data memory.
    expect(metrics.dataReads).toBe(1);
    expect(metrics.dataWrites).toBe(1);
    expect(metrics.fetchedBytes).toBe(3 + 2 + 2 + 2 + 2 + 1 + 2 + 1);
  });

  it('leaves a final precise fault out of every class but keeps its clocks in the total', () => {
    const faulted = rtlMetrics(
      [step(0, [Op.LDI, 0x00, 0x00], 6), step(1, [Op.DIV, 0x01], 9, 0, 0x03, 0x03)],
      { cycles: 9, instructions: 1 },
    );
    expect(faulted.byOpcode).toEqual({
      LDI: { instructions: 1, cycles: 6, cpi: 6, minClocks: 6, maxClocks: 6 },
    });
    expect(faulted.cpi).toBe(9);
  });

  it('is safe for a run that retires nothing', () => {
    const none = rtlMetrics([step(0, [0xff], 2)], { cycles: 2, instructions: 0 });
    expect(none.cpi).toBeNull();
    expect(none.byClass).toEqual({});
    expect(none.byOpcode).toEqual({});
    expect(none.branches).toEqual({ taken: 0, notTaken: 0, byOpcode: {} });
  });
});
