import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_DIM } from '../model/matmul.js';
import { applyMutant, MUTANTS_DEFAULTS, MutantError, parseMutants } from './mutants.js';
import {
  buildVerifyReport,
  formatVerifyMarkdown,
  type Provenance,
  type VerifyCaseResult,
  VerifyReportSchema,
} from './report.js';
import {
  caseOperands,
  corpusPlan,
  cycleLimit,
  directedPlan,
  formatFailureReport,
  randomPlan,
  runnerFlagArgs,
} from './verify.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'accel-verify-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SIZES = [
  { rows: 4, cols: 4 },
  { rows: 8, cols: 8 },
  { rows: 16, cols: 16 },
];

describe('corpusPlan', () => {
  it('is a function of the seed and the size alone', () => {
    for (const size of SIZES) {
      const options = { seed: 5, count: 40, directed: true, random: true };
      expect(corpusPlan(size, options)).toEqual(corpusPlan(size, options));
      const operands = corpusPlan(size, options).map((plan) => caseOperands(plan));
      expect(corpusPlan(size, options).map((plan) => caseOperands(plan))).toEqual(operands);
    }
  });

  it('gives each seed and each size its own random cases', () => {
    const names = (seed: number, size = SIZES[0] ?? { rows: 4, cols: 4 }) =>
      randomPlan(size, seed, 40).map((plan) => plan.name);
    expect(names(1)).not.toEqual(names(2));
    expect(names(1, SIZES[0])).not.toEqual(names(1, SIZES[1]));
  });

  it('keeps every case within capacity, with unique names per size', () => {
    for (const size of SIZES) {
      const plan = corpusPlan(size, { seed: 1, count: 200, directed: true, random: true });
      expect(new Set(plan.map((p) => p.name)).size).toBe(plan.length);
      for (const { dims } of plan) {
        for (const value of [dims.m, dims.n, dims.k]) {
          expect(value).toBeGreaterThanOrEqual(1);
          expect(value).toBeLessThanOrEqual(MAX_DIM);
        }
      }
    }
  });

  it('draws mostly edge tiles and some MAX_DIM sides in the random cases', () => {
    const size = { rows: 8, cols: 8 };
    const plan = randomPlan(size, 1, 40);
    const edge = plan.filter((p) => p.dims.m % size.rows !== 0 || p.dims.n % size.cols !== 0);
    expect(edge.length).toBeGreaterThan(plan.length / 2);
    for (const key of ['m', 'n', 'k'] as const) {
      expect(plan.filter((p) => p.dims[key] === MAX_DIM).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('includes the directed classes the brief requires', () => {
    const plan = directedPlan({ rows: 16, cols: 16 }, 1);
    const has = (test: (p: (typeof plan)[number]) => boolean) => plan.some(test);
    expect(has((p) => p.dims.m === 1)).toBe(true);
    expect(has((p) => p.dims.n === 1)).toBe(true);
    expect(has((p) => p.dims.k === 1)).toBe(true);
    expect(has((p) => p.dims.m === MAX_DIM && p.dims.n === MAX_DIM && p.dims.k === MAX_DIM)).toBe(
      true,
    );
    for (const generator of ['negative', 'zero', 'identity', 'min', 'max', 'mixed']) {
      expect(has((p) => p.generator === generator)).toBe(true);
    }
    expect(has((p) => p.flags.repeat > 1 && !p.flags.resetBetween)).toBe(true);
    expect(has((p) => p.flags.abortFirst && p.flags.resetBetween)).toBe(true);
    const edge = plan.find((p) => p.name.startsWith('edge-tiles-'));
    expect(edge?.dims).toEqual({ m: 33, n: 31, k: 7 });
  });

  it('draws the sign patterns it names', () => {
    const negative = caseOperands({ generator: 'negative', dims: { m: 9, n: 7, k: 5 }, seed: 3 });
    expect([...negative.a, ...negative.b].every((v) => v < 0)).toBe(true);
    const negpos = caseOperands({ generator: 'negpos', dims: { m: 9, n: 7, k: 5 }, seed: 3 });
    expect([...negpos.a].every((v) => v < 0)).toBe(true);
    expect([...negpos.b].every((v) => v >= 0)).toBe(true);
  });
});

describe('runner arguments', () => {
  it('maps the flags to the runner options', () => {
    expect(runnerFlagArgs({ repeat: 1, resetBetween: false, abortFirst: false })).toEqual([]);
    expect(runnerFlagArgs({ repeat: 2, resetBetween: true, abortFirst: true })).toEqual([
      '--repeat',
      '2',
      '--reset-between',
      '--abort-first',
    ]);
  });

  it('allows four times the documented clocks from start to done', () => {
    // 1 + tiles · (K + ROWS + COLS + 1) + M · N for 64³ on 4 × 4: 22,785 clocks.
    expect(cycleLimit({ rows: 4, cols: 4 }, { m: 64, n: 64, k: 64 })).toBe(4 * 22_785 + 1000);
  });
});

const PROVENANCE: Provenance = {
  revision: 'matmul-os-r1',
  git: { commit: '0123456789abcdef', dirty: false },
  toolchain: 'OSS CAD Suite 2026-10-16',
  tools: { verilator: 'Verilator 5.053' },
};

function result(size: string, name: string, passed: boolean): VerifyCaseResult {
  return {
    size,
    name,
    kind: 'directed',
    generator: 'random',
    seed: 1,
    dims: { m: 2, n: 3, k: 2 },
    macs: 12,
    flags: { repeat: 1, resetBetween: false, abortFirst: false },
    passed,
    reason: passed ? null : '1 of 6 elements differ',
    mismatches: passed ? 0 : 1,
    firstMismatches: passed ? [] : [{ index: 4, i: 1, j: 1, expected: 7, actual: 8 }],
    cycles: null,
    saved: null,
  };
}

describe('buildVerifyReport', () => {
  it('sorts the cases by size then name and counts them per size', () => {
    const report = buildVerifyReport({
      seed: 1,
      countPerSize: 0,
      corpora: ['directed'],
      provenance: PROVENANCE,
      sims: [
        { rows: 4, cols: 4, sim: 'build/sim-4x4/matmul_sim' },
        { rows: 16, cols: 16, sim: 'build/sim-16x16/matmul_sim' },
      ],
      cases: [result('16x16', 'b', true), result('4x4', 'z', false), result('4x4', 'a', true)],
    });
    expect(VerifyReportSchema.parse(report)).toEqual(report);
    expect(report.cases.map((c) => `${c.size} ${c.name}`)).toEqual(['4x4 a', '4x4 z', '16x16 b']);
    expect(report.passed).toBe(false);
    expect(report.totals).toEqual({ cases: 3, passed: 2, failed: 1, directed: 3, random: 0 });
    expect(report.sizes.map((s) => [s.size, s.failed])).toEqual([
      ['4x4', 1],
      ['16x16', 0],
    ]);
    const markdown = formatVerifyMarkdown(report);
    expect(markdown).toContain('Result: **FAIL**, 2/3 cases');
    expect(markdown).toContain('| 4x4 | z | 1 of 6 elements differ | - |');
  });
});

describe('formatFailureReport', () => {
  const plan = {
    name: 'nonsquare-m13-n11-k19-s1',
    kind: 'directed' as const,
    generator: 'random' as const,
    dims: { m: 13, n: 11, k: 19 },
    seed: 1,
    flags: { repeat: 3, resetBetween: false, abortFirst: false },
    what: 'non-square',
  };

  it('is null for a passing case', () => {
    expect(
      formatFailureReport('4x4', plan, { reason: null, mismatches: [], cycles: null }, 'r'),
    ).toBe(null);
  });

  it('names the case, its flags, the first differing elements and the replay command', () => {
    const mismatches = Array.from({ length: 10 }, (_, index) => ({
      index,
      i: 0,
      j: index,
      expected: index,
      actual: -index - 1,
    }));
    const report = formatFailureReport(
      '4x4',
      plan,
      { reason: '10 of 143 elements differ', mismatches, cycles: null },
      'make -C hardware/accelerators/matmul replay CASE=build/failures/x',
    );
    expect(report?.split('\n')).toEqual([
      'FAIL 4x4 nonsquare-m13-n11-k19-s1: 10 of 143 elements differ',
      '  array 4x4 · M 13 N 11 K 19 · directed · generator random · seed 1 · non-square',
      '  runner flags --repeat 3',
      '  C[0][0]: expected 0, actual -1 (-1)',
      '  C[0][1]: expected 1, actual -2 (-3)',
      '  C[0][2]: expected 2, actual -3 (-5)',
      '  C[0][3]: expected 3, actual -4 (-7)',
      '  C[0][4]: expected 4, actual -5 (-9)',
      '  C[0][5]: expected 5, actual -6 (-11)',
      '  C[0][6]: expected 6, actual -7 (-13)',
      '  C[0][7]: expected 7, actual -8 (-15)',
      '  … 2 more',
      '  replay: make -C hardware/accelerators/matmul replay CASE=build/failures/x',
      '',
    ]);
  });
});

describe('mutants', () => {
  it('parses scripts/mutants.txt, and every mutant applies to rtl/ exactly once', () => {
    const mutants = parseMutants(readFileSync(MUTANTS_DEFAULTS.list, 'utf8'));
    expect(mutants.length).toBeGreaterThanOrEqual(3);
    for (const id of ['pe-sign-extension', 'skew-off-by-one', 'edge-row-mask-uses-n']) {
      expect(mutants.map((m) => m.id)).toContain(id);
    }
    for (const mutant of mutants) {
      const out = tempDir();
      applyMutant(MUTANTS_DEFAULTS.rtl, out, mutant);
      const changed = readdirSync(out).filter(
        (file) =>
          readFileSync(join(out, file), 'utf8') !==
          readFileSync(join(MUTANTS_DEFAULTS.rtl, file), 'utf8'),
      );
      expect(changed).toEqual([mutant.file]);
    }
  });

  it('rejects a block with a missing field or an unchanged replacement', () => {
    expect(() => parseMutants('[a]\nfile: x.sv\nwhat: w\nfrom: f\n')).toThrow(MutantError);
    expect(() => parseMutants('[a]\nfile: x.sv\nwhat: w\nfrom: f\nto: f\n')).toThrow(/the same/);
  });
});
