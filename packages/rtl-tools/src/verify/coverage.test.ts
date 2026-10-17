import { assemble } from '@vcpu/assembler';
import { describe, expect, it } from 'vitest';
import {
  addCoverage,
  coverageGaps,
  emptyCoverage,
  formatCoverage,
  mergeCoverage,
} from './coverage.js';
import { runReference } from './reference.js';

function run(source: string, maxSteps = 100) {
  const result = assemble(source);
  if (!result.ok) throw new Error('does not assemble');
  return runReference(Array.from(result.bytes.image), maxSteps);
}

describe('coverage', () => {
  it('counts retired opcodes, branch outcomes, the stop and the deepest stack', () => {
    const coverage = emptyCoverage();
    // CMP 1, 2 sets C (borrow): JC is taken, then JNC is not; JZ is not taken; the POP is extra.
    addCoverage(
      coverage,
      run(`
        LDI R0, 1
        LDI R1, 2
        PUSH R0
        CMP R0, R1
        JC over
        NOP
over:   JNC 0x00
        JZ 0x00
        POP R2
        POP R2
      `),
    );
    expect(coverage.opcodes).toMatchObject({
      LDI: 2,
      PUSH: 1,
      CMP: 1,
      JC: 1,
      JNC: 1,
      JZ: 1,
      NOP: 0,
    });
    // The faulting POP did not retire.
    expect(coverage.opcodes.POP).toBe(1);
    expect(coverage.branches.JC).toEqual({ taken: 1, notTaken: 0 });
    expect(coverage.branches.JNC).toEqual({ taken: 0, notTaken: 1 });
    expect(coverage.branches.JZ).toEqual({ taken: 0, notTaken: 1 });
    expect(coverage.faults.STACK_UNDERFLOW).toBe(1);
    expect(coverage.stops).toEqual({ halted: 0, faulted: 1, max_steps: 0 });
    expect(coverage.maxStackDepth).toBe(1);
    expect(coverage.retired).toBe(8);
    expect(coverage.steps).toBe(9);
  });

  it('counts a post-commit PC_OVERFLOW instruction as retired', () => {
    const coverage = emptyCoverage();
    addCoverage(coverage, run('JMP 0xFF'));
    expect(coverage.opcodes).toMatchObject({ JMP: 1, NOP: 1 });
    expect(coverage.faults.PC_OVERFLOW).toBe(1);
  });

  it('lists every opcode and fault code never exercised', () => {
    const coverage = emptyCoverage();
    addCoverage(coverage, run('HLT'));
    const gaps = coverageGaps(coverage);
    expect(gaps).toHaveLength(29 + 7);
    expect(gaps).toContain('opcode NOP never retired');
    expect(gaps).toContain('fault STACK_UNDERFLOW never hit');
    expect(gaps).not.toContain('opcode HLT never retired');
  });

  it('merges per-corpus coverage', () => {
    const a = emptyCoverage();
    const b = emptyCoverage();
    addCoverage(a, run('HLT'));
    addCoverage(b, run('LDI R0, 0\nDIV R1, R0'));
    mergeCoverage(a, b);
    expect(a.cases).toBe(2);
    expect(a.opcodes).toMatchObject({ HLT: 1, LDI: 1, DIV: 0 });
    expect(a.faults.DIVIDE_BY_ZERO).toBe(1);
    expect(formatCoverage(a)).toContain('faults hit (1/7)');
  });
});
