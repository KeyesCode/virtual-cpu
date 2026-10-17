import { disassemble } from '@vcpu/assembler';
import { describe, expect, it, vi } from 'vitest';
import { runReference } from '../verify/reference.js';
import {
  generateProgram,
  RANDOM_MAX_STEPS,
  type RandomProgram,
  SHAPE_WEIGHTS,
  SHAPES,
} from './generator.js';
import { Prng } from './prng.js';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);
const programs: RandomProgram[] = SEEDS.map(generateProgram);

describe('Prng', () => {
  it('gives the same sequence for the same seed and another for the next seed', () => {
    const draw = (seed: number) => {
      const rng = new Prng(seed);
      return Array.from({ length: 8 }, () => rng.next());
    };
    expect(draw(42)).toEqual(draw(42));
    expect(draw(42)).not.toEqual(draw(43));
  });

  it('keeps int() within its bounds', () => {
    const rng = new Prng(7);
    const values = Array.from({ length: 10_000 }, () => rng.int(3, 9));
    expect(Math.min(...values)).toBe(3);
    expect(Math.max(...values)).toBe(9);
  });
});

describe('generateProgram', () => {
  it('is a function of the seed alone', () => {
    for (const seed of [1, 2, 99, 12_345, 2 ** 40]) {
      const a = generateProgram(seed);
      const b = generateProgram(seed);
      expect(b.source).toBe(a.source);
      expect(b.image).toEqual(a.image);
    }
  });

  it('never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    SEEDS.slice(0, 200).forEach(generateProgram);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('gives different seeds different programs', () => {
    const images = new Set(programs.map((p) => p.image.join(',')));
    expect(images.size).toBe(programs.length);
  });

  it('assembles every program and keeps structured code inside 0x00–0x7F', () => {
    for (const p of programs) {
      expect(p.image).toHaveLength(256);
      expect(p.codeBytes).toBeGreaterThan(0);
      expect(p.codeBytes).toBeLessThanOrEqual(0x80);
      expect(p.maxSteps).toBe(RANDOM_MAX_STEPS);
    }
  });

  it('encodes only valid instructions outside the fault and raw shapes', () => {
    for (const p of programs.filter((q) => q.shape !== 'fault' && q.shape !== 'raw')) {
      const data = disassemble(p.image, { end: p.codeBytes - 1 }).filter(
        (line) => line.kind === 'data',
      );
      expect(data, `seed ${String(p.seed)}`).toEqual([]);
    }
  });

  it('draws the shapes in proportion to their weights', () => {
    const total = Object.values(SHAPE_WEIGHTS).reduce((sum, w) => sum + w, 0);
    for (const shape of SHAPES) {
      const share = programs.filter((p) => p.shape === shape).length / programs.length;
      const want = SHAPE_WEIGHTS[shape] / total;
      expect(share, shape).toBeGreaterThan(want * 0.75);
      expect(share, shape).toBeLessThan(want * 1.25);
    }
    expect(programs.some((p) => p.selfModifying)).toBe(true);
    expect(programs.some((p) => p.endless)).toBe(true);
  });

  it('ends structured programs in HLT, a divide by zero or (endless loops) the step limit', () => {
    for (const p of programs.filter(
      (q) => !q.selfModifying && q.shape !== 'fault' && q.shape !== 'raw',
    )) {
      const { end } = runReference(p.image, p.maxSteps);
      const how = end.fault?.code ?? end.stopReason;
      const allowed = p.endless ? ['max_steps', 'DIVIDE_BY_ZERO'] : ['halted', 'DIVIDE_BY_ZERO'];
      expect(allowed, `seed ${String(p.seed)} (${p.shape})`).toContain(how);
    }
  });

  it('ends fault programs in the fault they were built for (or an earlier divide by zero)', () => {
    const faults = programs.filter((p) => p.shape === 'fault');
    const reached = new Set<string>();
    for (const p of faults) {
      const { end } = runReference(p.image, p.maxSteps);
      expect([p.targetFault, 'DIVIDE_BY_ZERO'], `seed ${String(p.seed)}`).toContain(
        end.fault?.code,
      );
      reached.add(end.fault?.code ?? '');
    }
    expect(reached.size).toBe(7);
  });

  it('reaches a full stack', () => {
    const depth = Math.max(
      ...programs
        .filter((p) => p.shape === 'calls')
        .map((p) => Math.max(0, ...runReference(p.image, p.maxSteps).trace.map((s) => s.sd))),
    );
    expect(depth).toBe(64);
  });
});
