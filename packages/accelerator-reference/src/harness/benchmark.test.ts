import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_WORKLOADS,
  buildBenchmarkReport,
  newestCommittedReport,
  publishedName,
  readBenchmarkReport,
} from './benchmark.js';
import {
  BENCHMARK_CSV_COLUMNS,
  BENCHMARK_LABELS,
  benchmarkMetrics,
  type BenchmarkReport,
  type BenchmarkRow,
  compareBenchmarkModelled,
  expectedComputeCycles,
  type Provenance,
  renderBenchmarkCsv,
  renderBenchmarkMarkdown,
  REPO,
} from './report.js';

const PROVENANCE: Provenance = {
  revision: 'matmul-os-r1',
  git: { commit: '0123456789abcdef0123456789abcdef01234567', dirty: false },
  toolchain: 'OSS CAD Suite test',
  tools: { verilator: 'Verilator 5.053' },
};

const SIZES = [4, 8, 16].map((side) => ({
  size: { rows: side, cols: side },
  sim: `build/sim-${String(side)}x${String(side)}/matmul_sim`,
}));

/** The clock counts docs/hardware/accelerators/controller.md gives for one run. */
function formulaCycles(
  size: { rows: number; cols: number },
  dims: { m: number; n: number; k: number },
) {
  const { m, n, k } = dims;
  const tiles = Math.ceil(m / size.rows) * Math.ceil(n / size.cols);
  const transferIn = Math.max(m * k, k * n);
  const compute = expectedComputeCycles(size, dims);
  const busy = 1 + tiles * (k + size.rows + size.cols + 1) + m * n;
  const transferOut = m * n + 1;
  return {
    transferIn,
    compute,
    store: m * n,
    busy,
    transferOut,
    total: transferIn + 1 + busy + transferOut,
  };
}

function fixtureReport(createdAt = '2026-10-24T00:00:00.000Z', wallMs = 10): BenchmarkReport {
  const rows: BenchmarkRow[] = SIZES.flatMap(({ size }) =>
    BENCHMARK_WORKLOADS.map((w) => ({
      size: `${String(size.rows)}x${String(size.cols)}`,
      ...size,
      workload: w.name,
      dims: w.dims,
      status: 'passed' as const,
      metrics: benchmarkMetrics(size, w.dims, formulaCycles(size, w.dims)),
    })),
  );
  return buildBenchmarkReport({
    provenance: PROVENANCE,
    createdAt,
    sizes: SIZES,
    seed: 1,
    workloads: BENCHMARK_WORKLOADS,
    rows,
    host: {
      label: BENCHMARK_LABELS.host,
      runtime: 'node test',
      platform: 'test',
      arch: 'test',
      cpuModel: 'test',
      jobs: 1,
      totalWallMs: wallMs,
      cases: rows.map((r) => ({ size: r.size, workload: r.workload, runnerMs: wallMs })),
    },
  });
}

describe('benchmarkMetrics', () => {
  it('computes the 4 × 4 × 4 single tile on the 4 × 4 array by hand', () => {
    // One tile: 1 PREPARE_TILE + K = 4 COMPUTE + ROWS + COLS − 1 = 7 DRAIN clocks = 12.
    const size = { rows: 4, cols: 4 };
    const dims = { m: 4, n: 4, k: 4 };
    expect(expectedComputeCycles(size, dims)).toBe(12);
    const metrics = benchmarkMetrics(size, dims, formulaCycles(size, dims));
    expect(metrics).toEqual({
      macs: 64,
      tiles: 1,
      peakMacsPerCycle: 16,
      transferIn: 16,
      compute: 12,
      store: 16,
      busy: 30,
      transferOut: 17,
      total: 64,
      fillDrain: 8,
      // 64 MACs / (16 PEs · 12 clocks) = 1/3.
      utilization: 0.333333,
      macsPerCycleCompute: 5.333333,
      macsPerCycleTotal: 1,
      opsPerCycleCompute: 10.666667,
      opsPerCycleTotal: 2,
      bytesIn: 32,
      bytesOut: 64,
    });
  });

  it('counts edge tiles as whole tiles and masked PEs as idle', () => {
    // 13 × 19 × 11 on 8 × 8: 2 · 2 tiles of 19 + 16 compute clocks.
    const size = { rows: 8, cols: 8 };
    const dims = { m: 13, n: 11, k: 19 };
    const metrics = benchmarkMetrics(size, dims, formulaCycles(size, dims));
    expect(metrics.tiles).toBe(4);
    expect(metrics.compute).toBe(140);
    expect(metrics.utilization).toBe(Number((2717 / (64 * 140)).toFixed(6)));
  });
});

describe('the committed baseline', () => {
  it('measured the controller formula for the 4 × 4 × 4 workload on the 4 × 4 array', () => {
    const newest = newestCommittedReport(
      join(REPO, 'research', 'accelerators', 'matmul', 'reports'),
    );
    expect(newest).not.toBeNull();
    const report = readBenchmarkReport(newest ?? '');
    const row = report.rows.find((r) => r.size === '4x4' && r.workload === '4x4x4');
    expect(row?.status).toBe('passed');
    expect(row?.status === 'passed' ? row.metrics.compute : null).toBe(12);
    for (const r of report.rows) {
      expect(r.status).toBe('passed');
      if (r.status === 'passed') {
        expect(r.metrics).toEqual(benchmarkMetrics(r, r.dims, formulaCycles(r, r.dims)));
      }
    }
    expect(report.provenance.gitDirty).toBe(false);
  });
});

describe('the report', () => {
  it('has every workload of the brief on every size', () => {
    const report = fixtureReport();
    expect(BENCHMARK_WORKLOADS.map((w) => w.name)).toEqual([
      '4x4x4',
      '8x8x8',
      '16x16x16',
      '32x32x32',
      '64x64x64',
      '13x19x11',
      '64x8x64',
      '8x64x64',
      '1x64x1',
    ]);
    expect(report.rows).toHaveLength(27);
    expect(report.verification).toMatchObject({ gate: 'passed', cases: 27, failed: 0 });
    expect(publishedName(report)).toBe('2026-10-24-0123456');
  });

  it('states the MAC, both per-cycle rates and no frequency in the Markdown', () => {
    const markdown = renderBenchmarkMarkdown(fixtureReport());
    expect(markdown).toContain(BENCHMARK_LABELS.mac);
    expect(markdown).toContain('utilization = macs / (ROWS · COLS · compute)');
    expect(markdown).toContain('MACs/cycle (total)');
    expect(markdown).toContain('Ops/cycle (total)');
    expect(markdown).not.toMatch(/MHz|GHz|TOPS/i);
  });

  it('writes one CSV row per size and workload under a header', () => {
    const lines = renderBenchmarkCsv(fixtureReport()).trimEnd().split('\n');
    expect(lines[0]).toBe(BENCHMARK_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(28);
    for (const line of lines) expect(line.split(',')).toHaveLength(BENCHMARK_CSV_COLUMNS.length);
  });

  it('leaves a failed case without numbers and fails the gate', () => {
    const report = fixtureReport();
    const [first, ...rest] = report.rows;
    if (first === undefined) throw new Error('no rows');
    const failed: BenchmarkRow = {
      size: first.size,
      rows: first.rows,
      cols: first.cols,
      workload: first.workload,
      dims: first.dims,
      status: 'failed',
      reason: '1 of 16 elements differ',
    };
    const broken = buildBenchmarkReport({
      provenance: PROVENANCE,
      createdAt: report.provenance.createdAt,
      sizes: SIZES,
      seed: 1,
      workloads: BENCHMARK_WORKLOADS,
      rows: [failed, ...rest],
      host: report.host,
    });
    expect(broken.verification).toMatchObject({ gate: 'failed', failedCases: ['4x4 4x4x4'] });
    expect(renderBenchmarkMarkdown(broken)).toContain('| 4 × 4 × 4 | FAILED: 1 of 16');
    expect(renderBenchmarkCsv(broken).split('\n')[1]).toBe(
      `4x4,4,4,4x4x4,4,4,4,failed${','.repeat(BENCHMARK_CSV_COLUMNS.length - 8)}`,
    );
  });
});

describe('compareBenchmarkModelled', () => {
  it('ignores provenance and host', () => {
    const a = fixtureReport('2026-10-24T00:00:00.000Z', 10);
    const b = fixtureReport('2026-10-25T12:00:00.000Z', 99);
    expect(compareBenchmarkModelled(a, b)).toEqual({ identical: true, deltas: [] });
  });

  it('names every modelled number that changed', () => {
    const a = fixtureReport();
    const b = structuredClone(a);
    const row = b.rows[0];
    if (row?.status !== 'passed') throw new Error('expected a passed row');
    row.metrics.compute += 1;
    expect(compareBenchmarkModelled(a, b)).toEqual({
      identical: false,
      deltas: [{ path: 'rows.0.metrics.compute', baseline: 12, fresh: 13 }],
    });
  });
});
