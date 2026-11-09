import { describe, expect, it } from 'vitest';
import { comparability, scoreAdp } from './comparability.js';
import { evaluateHardConstraints } from './constraints.js';
import {
  canonicalJson,
  type Evaluation,
  type EvaluationConfig,
  hashEvaluationConfig,
} from './evaluation.js';
import { measured, unavailable } from './metric.js';
import { unavailablePpaSnapshot } from './ppa.js';

const LIBERTY = 'a'.repeat(64);

function config(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    baselineId: 'pe-matmul-os-r1',
    toolVersions: { yosys: '0.70+145', opensta: '2.6.0' },
    imageDigest: 'sha256:' + 'b'.repeat(64),
    targetTechnology: 'sky130_fd_sc_hd',
    libertyFile: 'hardware/asic/sky130hd/sky130_fd_sc_hd__tt_025C_1v80.lib',
    libertySha256: LIBERTY,
    clockPeriod: { value: 5, unit: 'ns' },
    synthesisSettings: { script: 'synth-liberty.ys', abc: 'default' },
    physicalDesignSettings: null,
    verification: { fixedSeed: 1, randomizedCount: 40 },
    ...overrides,
  };
}

// A stand-in hasher: the real one (node:crypto) belongs to the caller, not this package.
const fakeSha256 = (text: string) => {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
};

function evaluation(cfg: EvaluationConfig, area: number, delay: number): Evaluation {
  const ppa = unavailablePpaSnapshot('not evaluated');
  ppa.area.cellArea = measured(area, 'um^2', { tool: 'yosys' });
  ppa.performance.criticalPath = measured(delay, 'ns', { tool: 'opensta' });
  return {
    evaluationConfig: cfg,
    evaluationConfigHash: hashEvaluationConfig(cfg, fakeSha256),
    ppa,
  };
}

describe('canonical JSON and the config hash', () => {
  it('sorts keys so key order does not change the hash', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    const reordered = { ...config(), toolVersions: { opensta: '2.6.0', yosys: '0.70+145' } };
    expect(hashEvaluationConfig(reordered, fakeSha256)).toBe(
      hashEvaluationConfig(config(), fakeSha256),
    );
  });

  it('refuses non-finite numbers and a hasher that does not return SHA-256 hex', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => hashEvaluationConfig(config(), () => 'xyz')).toThrow(/SHA-256/);
  });
});

describe('comparability', () => {
  it('is comparable for equal configs and hashes', () => {
    expect(comparability(evaluation(config(), 1, 1), evaluation(config(), 2, 2))).toEqual({
      status: 'comparable',
    });
  });

  it('names a differing liberty hash', () => {
    const other = config({ libertySha256: 'c'.repeat(64) });
    expect(comparability(evaluation(config(), 1, 1), evaluation(other, 1, 1))).toEqual({
      status: 'not-comparable',
      differingFields: ['libertySha256'],
    });
  });

  it('names nested fields and the hash alone when only the hash differs', () => {
    const other = config({ toolVersions: { yosys: '0.71', opensta: '2.6.0' } });
    expect(comparability(evaluation(config(), 1, 1), evaluation(other, 1, 1))).toEqual({
      status: 'not-comparable',
      differingFields: ['toolVersions.yosys'],
    });
    const stale = { ...evaluation(config(), 1, 1), evaluationConfigHash: 'f'.repeat(64) };
    expect(comparability(evaluation(config(), 1, 1), stale)).toEqual({
      status: 'not-comparable',
      differingFields: ['evaluationConfigHash'],
    });
  });
});

describe('scoreAdp', () => {
  it('scores comparable evaluations: 2,500 vs 2,125 µm²·ns is 15 %', () => {
    const score = scoreAdp(evaluation(config(), 1000, 2.5), evaluation(config(), 850, 2.5));
    expect(score.baselineAdp).toMatchObject({ value: 2500 });
    expect(score.candidateAdp).toMatchObject({ value: 2125 });
    expect(score.improvement).toMatchObject({ unit: '%', provenance: 'measured' });
    expect(score.improvement.provenance !== 'unavailable' && score.improvement.value).toBeCloseTo(
      15,
      9,
    );
  });

  it('never yields an improvement for incomparable evaluations', () => {
    const other = config({ clockPeriod: { value: 4, unit: 'ns' } });
    const score = scoreAdp(evaluation(config(), 1000, 2.5), evaluation(other, 850, 2.5));
    expect(score.improvement).toEqual({
      provenance: 'unavailable',
      reason: 'not comparable: clockPeriod.value differ',
    });
  });
});

describe('evaluateHardConstraints', () => {
  const constraints = {
    maxAreaUm2: 1200,
    requireTimingMet: true,
    requiredVerification: ['lint', 'unit', 'differential'] as const,
  };

  it('is satisfied when area, timing and verification all pass', () => {
    const ppa = evaluation(config(), 1000, 2.5).ppa;
    ppa.performance.worstSlack = measured(2.5, 'ns', { signed: true });
    const result = evaluateHardConstraints(constraints, {
      ppa,
      verification: { lint: 'passed', unit: 'passed', differential: 'passed' },
    });
    expect(result).toEqual({ satisfied: true, violations: [] });
  });

  it('returns every violated constraint', () => {
    const ppa = evaluation(config(), 1500, 2.5).ppa;
    ppa.performance.worstSlack = measured(-0.4, 'ns', { signed: true });
    const result = evaluateHardConstraints(constraints, {
      ppa,
      verification: { lint: 'passed', unit: 'failed' },
    });
    expect(result.satisfied).toBe(false);
    expect(result.violations).toEqual([
      { constraint: 'maxAreaUm2', reason: 'cell area 1500 um^2 exceeds the maximum 1200 um^2' },
      { constraint: 'requireTimingMet', reason: 'worst slack -0.4 ns is negative' },
      { constraint: 'requiredVerification', suite: 'unit', reason: 'unit failed' },
      { constraint: 'requiredVerification', suite: 'differential', reason: 'differential not-run' },
    ]);
  });

  it('treats unprovable constraints as violated and falls back to path vs period', () => {
    const ppa = unavailablePpaSnapshot('synthesis failed');
    const result = evaluateHardConstraints(
      { maxAreaUm2: 1200, requireTimingMet: true },
      { ppa, verification: {} },
    );
    expect(result.violations.map((violation) => violation.constraint)).toEqual([
      'maxAreaUm2',
      'requireTimingMet',
    ]);

    const late = evaluation(config(), 1000, 5.5).ppa;
    late.performance.clockPeriod = measured(5, 'ns');
    late.performance.worstSlack = unavailable('not reported');
    expect(
      evaluateHardConstraints({ requireTimingMet: true }, { ppa: late, verification: {} })
        .violations,
    ).toEqual([
      {
        constraint: 'requireTimingMet',
        reason: 'critical path 5.5 ns exceeds the clock period 5 ns',
      },
    ]);
  });
});
