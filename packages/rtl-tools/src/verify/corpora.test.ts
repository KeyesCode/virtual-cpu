import { describe, expect, it } from 'vitest';
import {
  caseDirName,
  DEFAULT_PROGRAM_MAX_STEPS,
  exampleCases,
  fixtureCases,
  programCases,
  programMaxSteps,
  randomCases,
  regressionCases,
} from './corpora.js';
import { runReference } from './reference.js';

describe('corpora', () => {
  it('finds all 98 fixtures and all 20 examples', () => {
    expect(fixtureCases()).toHaveLength(98);
    const examples = exampleCases();
    expect(examples).toHaveLength(20);
    for (const pending of examples) {
      expect(pending.load().maxSteps).toBeGreaterThan(0);
    }
  });

  it('assembles every directed program, and each one stops within its own limit', () => {
    const programs = programCases();
    expect(programs.length).toBeGreaterThanOrEqual(10);
    for (const pending of programs) {
      const c = pending.load();
      expect(c.source).toMatch(/^; \S+\.asm — /);
      expect(c.source).toMatch(/^; Targets: /m);
      expect(c.source).toMatch(/^; Expected: /m);
      expect(runReference(c.image, c.maxSteps).end.stopReason, c.name).not.toBe('max_steps');
    }
  });

  it('loads every committed regression', () => {
    for (const pending of regressionCases()) {
      const c = pending.load();
      expect(c.image).toHaveLength(256);
      expect(c.corpus).toBe('regressions');
    }
  });

  it('reads a max-steps header, or falls back to the default', () => {
    expect(programMaxSteps('; x\n; max-steps: 250\n  HLT\n')).toBe(250);
    expect(programMaxSteps('HLT\n')).toBe(DEFAULT_PROGRAM_MAX_STEPS);
  });

  it('names random cases by seed', () => {
    const names = [...randomCases(41, 3)].map((c) => c.name);
    expect(names).toEqual(['random/s41', 'random/s42', 'random/s43']);
    expect(caseDirName('random/s41')).toBe('random-s41');
  });
});
