import { describe, expect, it } from 'vitest';
import { type BenchmarkReport, BenchmarkReportSchema } from './report.js';
import { runBenchmark } from './runner.js';

/** A fake clock that advances 1 ms per reading, so every batch "takes" 1 ms. */
function fakeClock() {
  let now = 0;
  return () => (now += 1);
}

// LDI R0, 10 · LDI R1, 20 · ADD R0, R1 · HLT
const ADDITION = [0x11, 0x00, 10, 0x11, 0x10, 20, 0x20, 0x01, 0x01];

function report(programs: BenchmarkReport['programs']): BenchmarkReport {
  return {
    schemaVersion: 1,
    createdAt: '2026-10-16T20:00:00.000Z',
    isaVersion: '1.0.0',
    environment: {
      runtime: 'node v24.15.0',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.6.0',
      cpuModel: 'Test CPU',
      cpuCount: 8,
      totalMemoryBytes: 1024,
      gitSha: 'abc1234',
      gitDirty: false,
      packages: { '@vcpu/cpu-core': '0.0.0' },
    },
    settings: {
      warmupIterations: 1,
      samples: 3,
      maxInstructions: 100,
      minSampleMs: 1,
      trace: true,
    },
    programs,
  };
}

describe('BenchmarkReportSchema', () => {
  it('accepts a report built from real runner results, ok and error alike', () => {
    const settings = { samples: 3, warmupIterations: 1, minSampleMs: 1, maxInstructions: 100 };
    const ok = runBenchmark({
      name: 'addition',
      program: ADDITION,
      clock: fakeClock(),
      ...settings,
    });
    // DIV R0, R1 with R1 = 0 faults.
    const fault = runBenchmark({
      name: 'divide-by-zero',
      program: [0x23, 0x01, 0x01],
      clock: fakeClock(),
      ...settings,
    });

    expect(ok.status).toBe('ok');
    expect(fault).toMatchObject({ status: 'error', simulated: { stopReason: 'faulted' } });
    expect(BenchmarkReportSchema.safeParse(report([ok, fault])).success).toBe(true);
  });

  it('keeps host time and simulated metrics in separate sections', () => {
    const result = runBenchmark({
      name: 'addition',
      program: ADDITION,
      clock: fakeClock(),
      samples: 2,
      warmupIterations: 0,
      minSampleMs: 1,
    });
    if (result.status !== 'ok') throw new Error(result.error);
    expect(result.simulated).toEqual({
      stopReason: 'halted',
      instructions: 4,
      estimatedCycles: 4 + 4 + 3 + 2,
      memoryReads: 0,
      memoryWrites: 0,
      fetchedBytes: 9,
      branchesTaken: 0,
      branchesNotTaken: 0,
      opcodeCounts: { LDI: 2, ADD: 1, HLT: 1 },
    });
    // Each batch is one run lasting one fake millisecond.
    expect(result.host.runsPerSample).toBe(1);
    expect(result.host.samplesNs).toEqual([1e6, 1e6]);
    expect(result.host.nsPerInstruction).toBe(250_000);
    expect(result.traceOverheadPct).toBe(0);
  });

  it('rejects unknown fields, a wrong schema version and invalid stats', () => {
    const base = report([]);
    expect(BenchmarkReportSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(BenchmarkReportSchema.safeParse({ ...base, schemaVersion: 2 }).success).toBe(false);
    expect(BenchmarkReportSchema.safeParse({ ...base, createdAt: 'yesterday' }).success).toBe(
      false,
    );
    const ok = runBenchmark({
      name: 'addition',
      program: ADDITION,
      clock: fakeClock(),
      samples: 1,
      minSampleMs: 1,
    });
    if (ok.status !== 'ok') throw new Error(ok.error);
    const negative = {
      ...ok,
      host: { ...ok.host, timePerRunNs: { ...ok.host.timePerRunNs, stddev: -1 } },
    };
    expect(BenchmarkReportSchema.safeParse(report([negative])).success).toBe(false);
  });
});
