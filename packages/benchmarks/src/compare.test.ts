import { describe, expect, it } from 'vitest';
import { compareReports } from './compare.js';
import type { BenchmarkReport, ProgramResult } from './report.js';

function ok(name: string, medianNs: number, instructions = 10): ProgramResult {
  const stats = {
    n: 1,
    min: medianNs,
    max: medianNs,
    mean: medianNs,
    median: medianNs,
    stddev: 0,
    p5: medianNs,
    p95: medianNs,
  };
  return {
    name,
    status: 'ok',
    host: {
      runsPerSample: 1,
      timePerRunNs: stats,
      samplesNs: [medianNs],
      instructionsPerSecond: (instructions * 1e9) / medianNs,
      nsPerInstruction: medianNs / instructions,
      traced: null,
    },
    simulated: {
      stopReason: 'halted',
      instructions,
      estimatedCycles: instructions * 3,
      memoryReads: 0,
      memoryWrites: 0,
      fetchedBytes: instructions * 2,
      branchesTaken: 0,
      branchesNotTaken: 0,
      opcodeCounts: { NOP: instructions - 1, HLT: 1 },
    },
    traceOverheadPct: null,
  };
}

function report(programs: ProgramResult[], cpuModel = 'Test CPU'): BenchmarkReport {
  return {
    schemaVersion: 1,
    createdAt: '2026-10-16T20:00:00.000Z',
    isaVersion: '1.0.0',
    environment: {
      runtime: 'node v24.15.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.6.0',
      cpuModel,
      cpuCount: 8,
      totalMemoryBytes: 1024,
      gitSha: null,
      gitDirty: null,
      packages: {},
    },
    settings: {
      warmupIterations: 3,
      samples: 10,
      maxInstructions: 1000,
      minSampleMs: 50,
      trace: false,
    },
    programs,
  };
}

describe('compareReports', () => {
  it('flags IPS changes beyond the threshold and treats smaller ones as noise', () => {
    const baseline = report([ok('slower', 100), ok('faster', 100), ok('steady', 100)]);
    const current = report([ok('slower', 125), ok('faster', 80), ok('steady', 103)]);
    const result = compareReports(baseline, current, { thresholdPct: 5 });

    expect(result.regressions).toBe(1);
    expect(result.programs.map((p) => [p.name, p.status])).toEqual([
      ['slower', 'regression'],
      ['faster', 'improvement'],
      ['steady', 'unchanged'],
    ]);
    const [slower, faster] = result.programs;
    expect(slower?.ipsDeltaPct).toBeCloseTo(-20, 10);
    expect(slower?.timeDeltaPct).toBeCloseTo(25, 10);
    expect(faster?.ipsDeltaPct).toBeCloseTo(25, 10);
  });

  it('honors a configurable threshold', () => {
    const baseline = report([ok('a', 100)]);
    const current = report([ok('a', 125)]);
    expect(compareReports(baseline, current, { thresholdPct: 30 }).programs[0]?.status).toBe(
      'unchanged',
    );
    expect(() => compareReports(baseline, current, { thresholdPct: -1 })).toThrow(RangeError);
  });

  it('reports new, missing and errored programs without deltas', () => {
    const failed: ProgramResult = {
      name: 'broken',
      status: 'error',
      error: 'faulted',
      simulated: null,
    };
    const result = compareReports(
      report([ok('gone', 100), ok('broken', 100)]),
      report([failed, ok('added', 100)]),
    );
    expect(result.programs.map((p) => [p.name, p.status, p.ipsDeltaPct])).toEqual([
      ['gone', 'missing', null],
      ['broken', 'error', null],
      ['added', 'new', null],
    ]);
    expect(result.regressions).toBe(0);
  });

  it('notices changed simulated work and a different environment', () => {
    const result = compareReports(
      report([ok('a', 100, 10)]),
      report([ok('a', 100, 12)], 'Other CPU'),
    );
    expect(result.programs[0]?.simulatedChanged).toBe(true);
    expect(result.differences).toEqual(['cpuModel: Test CPU → Other CPU']);
  });
});
