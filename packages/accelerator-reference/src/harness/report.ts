import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The reports of the accelerator's Node-side harness, and the provenance every one records (the
 * orchestrator decisions: the architecture revision, the git commit and dirty flag, and the tool
 * versions of `make tools-check`). `verify` writes {@link VerifyReportSchema}.
 */

/** The repository root. */
export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** hardware/accelerators/matmul, where the make targets run and build/ lives. */
export const HW_DIR = join(REPO, 'hardware', 'accelerators', 'matmul');
export const BUILD_DIR = join(HW_DIR, 'build');

/** `build/tool-versions.json`, as hardware/accelerators/matmul/scripts/tool-versions.sh writes it. */
export const ToolVersionsSchema = z.object({
  toolchain: z.object({
    name: z.string(),
    pinnedVersion: z.string(),
    path: z.string().nullable(),
  }),
  tools: z.record(z.string(), z.object({ path: z.string(), version: z.string() }).nullable()),
});

export const ProvenanceSchema = z.object({
  /** The architecture revision (hardware/accelerators/matmul/REVISION). */
  revision: z.string().min(1),
  git: z.object({
    commit: z.string().nullable(),
    /** Whether the working tree had uncommitted changes; null outside a git checkout. */
    dirty: z.boolean().nullable(),
  }),
  /** The toolchain in words, or null when build/tool-versions.json is absent. */
  toolchain: z.string().nullable(),
  /** Each tool's version line (null: missing), or null when build/tool-versions.json is absent. */
  tools: z.record(z.string(), z.string().nullable()).nullable(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

function git(args: readonly string[]): string | null {
  const run = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** The revision, the git state and the tool versions, read now. */
export function readProvenance(
  revisionFile = join(HW_DIR, 'REVISION'),
  toolVersionsFile = join(BUILD_DIR, 'tool-versions.json'),
): Provenance {
  const revision = readFileSync(revisionFile, 'utf8').trim();
  const commit = git(['rev-parse', 'HEAD']);
  const status = commit === null ? null : git(['status', '--porcelain']);
  let toolchain: string | null = null;
  let tools: Record<string, string | null> | null = null;
  if (existsSync(toolVersionsFile)) {
    const parsed = ToolVersionsSchema.parse(JSON.parse(readFileSync(toolVersionsFile, 'utf8')));
    const { pinnedVersion, path } = parsed.toolchain;
    toolchain =
      path === null
        ? `tools from PATH (not the pinned OSS CAD Suite ${pinnedVersion})`
        : `OSS CAD Suite ${pinnedVersion}`;
    tools = {};
    for (const [name, tool] of Object.entries(parsed.tools)) tools[name] = tool?.version ?? null;
  }
  return ProvenanceSchema.parse({
    revision,
    git: { commit, dirty: status === null ? null : status.length > 0 },
    toolchain,
    tools,
  });
}

/** The runner flags a case runs with (see tb/sim/matmul_sim.cpp). */
export const RunnerFlagsSchema = z.object({
  repeat: z.number().int().positive(),
  resetBetween: z.boolean(),
  abortFirst: z.boolean(),
});
export type RunnerFlags = z.infer<typeof RunnerFlagsSchema>;

/** `<case>.cycles.json`, as build/sim-<R>x<C>/matmul_sim writes it. */
export const RunnerCyclesSchema = z.object({
  schemaVersion: z.literal(1),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  maxDim: z.number().int().positive(),
  m: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
  k: z.number().int().nonnegative(),
  macs: z.number().int().nonnegative(),
  tiles: z.number().int().nonnegative(),
  transferIn: z.number().int().nonnegative(),
  compute: z.number().int().nonnegative(),
  store: z.number().int().nonnegative(),
  busy: z.number().int().nonnegative(),
  transferOut: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  stop: z.enum(['done', 'error', 'timeout']),
  error: z.string().nullable(),
  repeat: z.number().int().positive(),
  resetBetween: z.boolean(),
  abortFirst: z.boolean(),
  /** Whether the --abort-first run really was reset in STORE. */
  aborted: z.boolean(),
  runsDiffering: z.number().int().nonnegative(),
});
export type RunnerCycles = z.infer<typeof RunnerCyclesSchema>;

const DimsSchema = z.object({
  m: z.number().int().positive(),
  n: z.number().int().positive(),
  k: z.number().int().positive(),
});

const MismatchSchema = z.object({
  index: z.number().int().nonnegative(),
  i: z.number().int().nonnegative(),
  j: z.number().int().nonnegative(),
  expected: z.number().int(),
  actual: z.number().int(),
});

export const VerifyCaseResultSchema = z.object({
  /** The array, `<R>x<C>`. */
  size: z.string().regex(/^\d+x\d+$/),
  name: z.string().min(1),
  kind: z.enum(['directed', 'random']),
  generator: z.string().min(1),
  seed: z.number().int().nonnegative(),
  dims: DimsSchema,
  macs: z.number().int().positive(),
  flags: RunnerFlagsSchema,
  passed: z.boolean(),
  /** Why the case failed, or null. */
  reason: z.string().nullable(),
  /** How many elements of C differ (0 when the case could not be compared). */
  mismatches: z.number().int().nonnegative(),
  /** The first differing elements, at most {@link MAX_LISTED_MISMATCHES}. */
  firstMismatches: z.array(MismatchSchema),
  /** The runner's clock counts, or null when it wrote none. */
  cycles: RunnerCyclesSchema.nullable(),
  /** The saved failure directory, or null. */
  saved: z.string().nullable(),
});
export type VerifyCaseResult = z.infer<typeof VerifyCaseResultSchema>;

export const MAX_LISTED_MISMATCHES = 8;

const CountsSchema = z.object({
  cases: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  directed: z.number().int().nonnegative(),
  random: z.number().int().nonnegative(),
});

export const VerifyReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('matmul-verify'),
  passed: z.boolean(),
  /** The corpus seed and the random cases per array size. */
  seed: z.number().int().nonnegative(),
  countPerSize: z.number().int().nonnegative(),
  corpora: z.array(z.enum(['directed', 'random'])),
  provenance: ProvenanceSchema,
  sizes: z.array(
    CountsSchema.extend({
      size: z.string().regex(/^\d+x\d+$/),
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
      sim: z.string(),
    }),
  ),
  totals: CountsSchema,
  /** Every case, sorted by array size (smallest first) then name. */
  cases: z.array(VerifyCaseResultSchema),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

function counts(cases: readonly VerifyCaseResult[]): z.infer<typeof CountsSchema> {
  const passed = cases.filter((c) => c.passed).length;
  const random = cases.filter((c) => c.kind === 'random').length;
  return {
    cases: cases.length,
    passed,
    failed: cases.length - passed,
    directed: cases.length - random,
    random,
  };
}

function sizeOrder(size: string): number {
  const [rows = '0', cols = '0'] = size.split('x');
  return Number(rows) * 1000 + Number(cols);
}

/** Cases in report order: array size (smallest first), then name. */
export function sortCases(cases: readonly VerifyCaseResult[]): VerifyCaseResult[] {
  return [...cases].sort(
    (a, b) => sizeOrder(a.size) - sizeOrder(b.size) || a.name.localeCompare(b.name),
  );
}

export interface VerifyReportInput {
  readonly seed: number;
  readonly countPerSize: number;
  readonly corpora: readonly ('directed' | 'random')[];
  readonly provenance: Provenance;
  readonly sims: readonly { readonly rows: number; readonly cols: number; readonly sim: string }[];
  readonly cases: readonly VerifyCaseResult[];
}

/** The validated report of a verify run. */
export function buildVerifyReport(input: VerifyReportInput): VerifyReport {
  const cases = sortCases(input.cases);
  const totals = counts(cases);
  return VerifyReportSchema.parse({
    schemaVersion: 1,
    kind: 'matmul-verify',
    passed: totals.failed === 0 && totals.cases > 0,
    seed: input.seed,
    countPerSize: input.countPerSize,
    corpora: input.corpora,
    provenance: input.provenance,
    sizes: input.sims.map(({ rows, cols, sim }) => {
      const size = `${String(rows)}x${String(cols)}`;
      return { size, rows, cols, sim, ...counts(cases.filter((c) => c.size === size)) };
    }),
    totals,
    cases,
  });
}

function dims(c: VerifyCaseResult): string {
  return `${String(c.dims.m)} × ${String(c.dims.k)} · ${String(c.dims.k)} × ${String(c.dims.n)}`;
}

function flagsText(flags: RunnerFlags): string {
  const parts: string[] = [];
  if (flags.abortFirst) parts.push('reset in STORE, restart');
  if (flags.repeat > 1) parts.push(`×${String(flags.repeat)}`);
  if (flags.resetBetween) parts.push('reset between');
  return parts.join(', ');
}

/** `verify.md`: the result, the provenance, a table per array size, and the failures. */
export function formatVerifyMarkdown(report: VerifyReport): string {
  const { provenance: p, totals } = report;
  const commit =
    p.git.commit === null
      ? 'unknown commit'
      : `commit \`${p.git.commit.slice(0, 12)}\`${p.git.dirty === true ? ' (dirty working tree)' : ''}`;
  const lines = [
    '# Matmul differential verification',
    '',
    `Result: **${report.passed ? 'PASS' : 'FAIL'}**, ${String(totals.passed)}/${String(totals.cases)} cases (${String(totals.directed)} directed, ${String(totals.random)} random) match \`@vcpu/accelerator-reference\` element by element.`,
    '',
    `Revision \`${p.revision}\`, ${commit}; toolchain: ${p.toolchain ?? 'unknown (no build/tool-versions.json)'}. Corpus seed ${String(report.seed)}, ${String(report.countPerSize)} random cases per array size. Cycle counts are RTL clock edges from the Verilator runner, not wall-clock time.`,
    '',
    '| Array | Cases | Directed | Random | Passed | Failed | Runner |',
    '| ----- | ----: | -------: | -----: | -----: | -----: | ------ |',
    ...report.sizes.map(
      (s) =>
        `| ${s.size} | ${String(s.cases)} | ${String(s.directed)} | ${String(s.random)} | ${String(s.passed)} | ${String(s.failed)} | \`${s.sim}\` |`,
    ),
    '',
  ];
  const failures = report.cases.filter((c) => !c.passed);
  if (failures.length > 0) {
    lines.push(
      '## Failures',
      '',
      '| Array | Case | Reason | Saved |',
      '| ----- | ---- | ------ | ----- |',
    );
    for (const c of failures) {
      lines.push(`| ${c.size} | ${c.name} | ${c.reason ?? '-'} | ${c.saved ?? '-'} |`);
    }
    lines.push('');
  }
  for (const s of report.sizes) {
    lines.push(
      `## ${s.size} array`,
      '',
      '| Case | A · B | Runs | Result | Tiles | Transfer in | Compute | Store | Busy | Transfer out | Total |',
      '| ---- | ----- | ---- | ------ | ----: | ----------: | ------: | ----: | ---: | -----------: | ----: |',
    );
    for (const c of report.cases.filter((x) => x.size === s.size)) {
      const y = c.cycles;
      const cells =
        y === null
          ? ['-', '-', '-', '-', '-', '-', '-']
          : [y.tiles, y.transferIn, y.compute, y.store, y.busy, y.transferOut, y.total].map(String);
      lines.push(
        `| ${c.name} | ${dims(c)} | ${flagsText(c.flags) || '1'} | ${c.passed ? 'pass' : 'FAIL'} | ${cells.join(' | ')} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Benchmark

/**
 * The benchmark report: what `make benchmark` writes to build/reports/benchmark.{json,csv,md} and
 * `make benchmark-baseline` commits under research/accelerators/matmul/reports/. Everything
 * outside `provenance` and `host` is modelled accelerator behaviour, deterministic for a given
 * design, workload set and seed; `benchmark-compare` checks that two runs agree on it byte for
 * byte. Fields are only ever added; removing or redefining one bumps `schemaVersion`.
 */
export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_KIND = 'matmul-rtl-benchmark';

/** What each kind of number is, written into every report so no reader has to guess. */
export const BENCHMARK_LABELS = {
  mac: 'One MAC is one multiply plus one accumulate: a signed INT8 × INT8 product added into a signed INT32 accumulator. A workload of M × K by K × N is M · N · K MACs. Ops count each MAC as two operations (ops = 2 × MACs).',
  cycles:
    'Cycles: rising clock edges of the Verilated matmul_top, counted by the Verilator runner (tb/sim/matmul_sim.cpp). They are clocks, not time: no clock frequency is assumed, so no time or throughput per second is reported.',
  transfer:
    'Transfer in and transfer out: the simplified testbench host port (A and B written in parallel, one element per port per clock; C read one element per clock). It is a testbench convenience, not a production memory system.',
  utilization:
    'PE utilization = MACs / (ROWS · COLS · compute cycles): the fraction of PE-clocks of the compute phase (PREPARE_TILE, COMPUTE and DRAIN of every tile) that did a useful MAC. STORE, transfer and handshake clocks are not in the denominator.',
  host: 'Host: wall-clock time this machine took to run each runner process. It measures the simulator, not the accelerator, and varies from run to run.',
} as const;

/** The formulas behind the derived columns, printed in every report. */
export const BENCHMARK_FORMULAS = {
  macs: 'macs = M · N · K',
  tiles: 'tiles = ⌈M / ROWS⌉ · ⌈N / COLS⌉',
  utilization: 'utilization = macs / (ROWS · COLS · compute)',
  macsPerCycleCompute: 'macsPerCycleCompute = macs / compute',
  macsPerCycleTotal: 'macsPerCycleTotal = macs / total',
  opsPerCycleCompute: 'opsPerCycleCompute = 2 · macs / compute',
  opsPerCycleTotal: 'opsPerCycleTotal = 2 · macs / total',
  fillDrain: 'fillDrain = compute − tiles · K (the PREPARE_TILE and DRAIN clocks)',
  bytesIn: 'bytesIn = M · K + K · N (INT8 operands)',
  bytesOut: 'bytesOut = 4 · M · N (INT32 results)',
} as const;

const BenchCount = z.number().int().nonnegative();
const Ratio = z.number().nonnegative();

/** The numbers of one workload on one array size; present only when the case passed the gate. */
export const BenchmarkMetricsSchema = z.strictObject({
  macs: BenchCount,
  tiles: BenchCount,
  /** ROWS · COLS: the most MACs the array can do in one clock. */
  peakMacsPerCycle: BenchCount,
  transferIn: BenchCount,
  compute: BenchCount,
  store: BenchCount,
  /** The clocks `busy` was high: compute + store + LOAD + one NEXT_TILE per tile. */
  busy: BenchCount,
  transferOut: BenchCount,
  total: BenchCount,
  fillDrain: BenchCount,
  utilization: Ratio,
  macsPerCycleCompute: Ratio,
  macsPerCycleTotal: Ratio,
  opsPerCycleCompute: Ratio,
  opsPerCycleTotal: Ratio,
  bytesIn: BenchCount,
  bytesOut: BenchCount,
});
export type BenchmarkMetrics = z.output<typeof BenchmarkMetricsSchema>;

const BenchDims = z.strictObject({
  m: z.number().int().positive(),
  n: z.number().int().positive(),
  k: z.number().int().positive(),
});

const RowBase = {
  /** The array, `<R>x<C>`. */
  size: z.string().regex(/^\d+x\d+$/),
  rows: z.number().int().positive(),
  cols: z.number().int().positive(),
  workload: z.string().min(1),
  dims: BenchDims,
};

export const BenchmarkRowSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...RowBase, status: z.literal('passed'), metrics: BenchmarkMetricsSchema }),
  /** A case that failed the correctness gate has the reason and no numbers. */
  z.strictObject({ ...RowBase, status: z.literal('failed'), reason: z.string().min(1) }),
]);
export type BenchmarkRow = z.output<typeof BenchmarkRowSchema>;

export const BenchmarkProvenanceSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  gitCommit: z.string().nullable(),
  gitShortCommit: z.string().nullable(),
  /** Uncommitted changes in the working tree; null outside a git checkout. */
  gitDirty: z.boolean().nullable(),
  /** Array size → its runner, relative to the repository root when it is inside it. */
  runners: z.record(z.string(), z.string()),
  /** The toolchain in words, or null when build/tool-versions.json is absent. */
  toolchain: z.string().nullable(),
  /** Tool name → version line, from build/tool-versions.json; null when it was not there. */
  tools: z.record(z.string(), z.string().nullable()).nullable(),
});
export type BenchmarkProvenance = z.output<typeof BenchmarkProvenanceSchema>;

export const BenchmarkHostSchema = z.strictObject({
  label: z.literal(BENCHMARK_LABELS.host),
  runtime: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  /** Runner processes in flight at once. */
  jobs: z.number().int().positive(),
  totalWallMs: z.number().nonnegative(),
  cases: z.array(
    z.strictObject({
      size: z.string(),
      workload: z.string(),
      runnerMs: z.number().nonnegative(),
    }),
  ),
});
export type BenchmarkHost = z.output<typeof BenchmarkHostSchema>;

export const BenchmarkReportSchema = z.strictObject({
  schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
  kind: z.literal(BENCHMARK_KIND),
  /** hardware/accelerators/matmul/REVISION. */
  revision: z.string().min(1),
  /** Smallest first. */
  arraySizes: z.array(z.string().regex(/^\d+x\d+$/)),
  labels: z.strictObject({
    mac: z.literal(BENCHMARK_LABELS.mac),
    cycles: z.literal(BENCHMARK_LABELS.cycles),
    transfer: z.literal(BENCHMARK_LABELS.transfer),
    utilization: z.literal(BENCHMARK_LABELS.utilization),
  }),
  formulas: z.strictObject({
    macs: z.literal(BENCHMARK_FORMULAS.macs),
    tiles: z.literal(BENCHMARK_FORMULAS.tiles),
    utilization: z.literal(BENCHMARK_FORMULAS.utilization),
    macsPerCycleCompute: z.literal(BENCHMARK_FORMULAS.macsPerCycleCompute),
    macsPerCycleTotal: z.literal(BENCHMARK_FORMULAS.macsPerCycleTotal),
    opsPerCycleCompute: z.literal(BENCHMARK_FORMULAS.opsPerCycleCompute),
    opsPerCycleTotal: z.literal(BENCHMARK_FORMULAS.opsPerCycleTotal),
    fillDrain: z.literal(BENCHMARK_FORMULAS.fillDrain),
    bytesIn: z.literal(BENCHMARK_FORMULAS.bytesIn),
    bytesOut: z.literal(BENCHMARK_FORMULAS.bytesOut),
  }),
  config: z.strictObject({
    /** How workloads are named: M × K × N, i.e. A is M × K and B is K × N. */
    notation: z.string().min(1),
    seed: BenchCount,
    generator: z.string().min(1),
    workloads: z.array(z.strictObject({ name: z.string(), dims: BenchDims, what: z.string() })),
    correctnessGate: z.string().min(1),
  }),
  verification: z.strictObject({
    gate: z.enum(['passed', 'failed']),
    cases: BenchCount,
    passed: BenchCount,
    failed: BenchCount,
    /** `<size> <workload>` of every case that failed the gate. */
    failedCases: z.array(z.string()),
  }),
  /** Every (array size, workload), sorted by size (smallest first) then workload order. */
  rows: z.array(BenchmarkRowSchema),
  provenance: BenchmarkProvenanceSchema,
  host: BenchmarkHostSchema,
});
export type BenchmarkReport = z.output<typeof BenchmarkReportSchema>;

/** Rounded to 6 decimals, so the JSON stays readable; the rounding is deterministic. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

/** The metrics of a passed case from its array size, dimensions and the runner's clock counts. */
export function benchmarkMetrics(
  size: { readonly rows: number; readonly cols: number },
  dims: { readonly m: number; readonly n: number; readonly k: number },
  cycles: Pick<RunnerCycles, 'transferIn' | 'compute' | 'store' | 'busy' | 'transferOut' | 'total'>,
): BenchmarkMetrics {
  const { m, n, k } = dims;
  const macs = m * n * k;
  const tiles = Math.ceil(m / size.rows) * Math.ceil(n / size.cols);
  const peak = size.rows * size.cols;
  const { transferIn, compute, store, busy, transferOut, total } = cycles;
  return BenchmarkMetricsSchema.parse({
    macs,
    tiles,
    peakMacsPerCycle: peak,
    transferIn,
    compute,
    store,
    busy,
    transferOut,
    total,
    fillDrain: compute - tiles * k,
    utilization: ratio(macs, peak * compute),
    macsPerCycleCompute: ratio(macs, compute),
    macsPerCycleTotal: ratio(macs, total),
    opsPerCycleCompute: ratio(2 * macs, compute),
    opsPerCycleTotal: ratio(2 * macs, total),
    bytesIn: m * k + k * n,
    bytesOut: 4 * m * n,
  });
}

/**
 * The compute clocks docs/hardware/accelerators/controller.md gives for one run: every tile spends
 * 1 (PREPARE_TILE) + K (COMPUTE) + ROWS + COLS − 1 (DRAIN) clocks, so T · (K + ROWS + COLS).
 */
export function expectedComputeCycles(
  size: { readonly rows: number; readonly cols: number },
  dims: { readonly m: number; readonly n: number; readonly k: number },
): number {
  const tiles = Math.ceil(dims.m / size.rows) * Math.ceil(dims.n / size.cols);
  return tiles * (dims.k + size.rows + size.cols);
}

/** The report without `provenance` and `host`: what must be identical between two runs. */
export function benchmarkModelled(report: BenchmarkReport): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== 'provenance' && key !== 'host'),
  );
}

type Leaf = string | number | boolean | null;

/** Every leaf of a JSON value by its dotted path (`rows.3.metrics.compute`). */
function leaves(value: unknown, path = '', into = new Map<string, Leaf>()): Map<string, Leaf> {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      leaves(child, path === '' ? key : `${path}.${key}`, into);
    }
  } else {
    into.set(path, value as Leaf);
  }
  return into;
}

export interface BenchmarkDelta {
  readonly path: string;
  readonly baseline: Leaf | undefined;
  readonly fresh: Leaf | undefined;
}

/**
 * Whether two reports' modelled sections serialize to the same bytes, and every leaf that
 * differs when they do not.
 */
export function compareBenchmarkModelled(
  baseline: BenchmarkReport,
  fresh: BenchmarkReport,
): { readonly identical: boolean; readonly deltas: readonly BenchmarkDelta[] } {
  const a = benchmarkModelled(baseline);
  const b = benchmarkModelled(fresh);
  const identical = JSON.stringify(a) === JSON.stringify(b);
  const left = leaves(a);
  const right = leaves(b);
  const deltas = [...new Set([...left.keys(), ...right.keys()])]
    .filter((path) => left.get(path) !== right.get(path))
    .sort()
    .map((path) => ({ path, baseline: left.get(path), fresh: right.get(path) }));
  return { identical, deltas };
}

/** `M × K × N` of a workload. */
export function workloadShape(dims: {
  readonly m: number;
  readonly n: number;
  readonly k: number;
}) {
  return `${String(dims.m)} × ${String(dims.k)} × ${String(dims.n)}`;
}

const fix = (value: number, digits = 3): string => value.toFixed(digits);

/** The CSV columns, in order: one flat row per (array size, workload). */
export const BENCHMARK_CSV_COLUMNS = [
  'size',
  'rows',
  'cols',
  'workload',
  'm',
  'k',
  'n',
  'status',
  'macs',
  'tiles',
  'transfer_in',
  'compute',
  'store',
  'busy',
  'transfer_out',
  'total',
  'fill_drain',
  'utilization',
  'macs_per_cycle_compute',
  'macs_per_cycle_total',
  'ops_per_cycle_compute',
  'ops_per_cycle_total',
  'bytes_in',
  'bytes_out',
] as const;

/** `benchmark.csv`: a header row, then one row per (array size, workload); failed rows have no numbers. */
export function renderBenchmarkCsv(report: BenchmarkReport): string {
  const lines = [BENCHMARK_CSV_COLUMNS.join(',')];
  for (const row of report.rows) {
    const head = [row.size, row.rows, row.cols, row.workload, row.dims.m, row.dims.k, row.dims.n];
    const numbers =
      row.status === 'passed'
        ? [
            row.metrics.macs,
            row.metrics.tiles,
            row.metrics.transferIn,
            row.metrics.compute,
            row.metrics.store,
            row.metrics.busy,
            row.metrics.transferOut,
            row.metrics.total,
            row.metrics.fillDrain,
            row.metrics.utilization,
            row.metrics.macsPerCycleCompute,
            row.metrics.macsPerCycleTotal,
            row.metrics.opsPerCycleCompute,
            row.metrics.opsPerCycleTotal,
            row.metrics.bytesIn,
            row.metrics.bytesOut,
          ]
        : Array<string>(BENCHMARK_CSV_COLUMNS.length - 8).fill('');
    lines.push([...head, row.status, ...numbers].map(String).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function mdTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const align = header.map((_, i) => (i === 0 ? '---' : '--:'));
  return [header, align, ...rows].map((cells) => `| ${cells.join(' | ')} |`);
}

/**
 * `benchmark.md`: the result, what the numbers are, the formulas, a cross-size summary (total
 * cycles and utilization of every workload on every array size), then one table per array size.
 */
export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const { provenance: p, verification: v } = report;
  const commit =
    p.gitCommit === null
      ? 'unknown commit'
      : `commit \`${p.gitShortCommit ?? p.gitCommit}\`${p.gitDirty === true ? ' (dirty working tree)' : ''}`;
  const lines = [
    '# Matmul accelerator benchmark',
    '',
    v.gate === 'passed'
      ? `Result: **PASS**, the correctness gate passed for all ${String(v.cases)} cases: every C matched \`@vcpu/accelerator-reference\` element by element before any number was recorded.`
      : `Result: **FAIL**, ${String(v.failed)}/${String(v.cases)} cases failed the correctness gate and have no numbers: ${v.failedCases.join(', ')}.`,
    '',
    `Revision \`${report.revision}\`, ${commit}, created ${p.createdAt}; toolchain: ${p.toolchain ?? 'unknown (no build/tool-versions.json)'}. Arrays ${report.arraySizes.join(', ')}; workloads are ${report.config.notation}, operands from the \`${report.config.generator}\` generator with seed ${String(report.config.seed)}.`,
    '',
    `Tools: ${
      p.tools === null
        ? 'unknown (no build/tool-versions.json)'
        : Object.entries(p.tools)
            .map(([name, version]) => `${name} ${version ?? 'missing'}`)
            .join('; ')
    }.`,
    '',
    `- ${report.labels.mac}`,
    `- ${report.labels.cycles}`,
    `- ${report.labels.transfer}`,
    `- ${report.labels.utilization}`,
    '',
    'Formulas: ' +
      Object.values(report.formulas)
        .map((f) => `\`${f}\``)
        .join('; ') +
      '.',
    '',
    '## Summary',
    '',
    'Total cycles (transfer in + start + busy + transfer out) and PE utilization of every workload on every array size.',
    '',
  ];
  const sizes = report.arraySizes;
  const cell = (size: string, workload: string, pick: (m: BenchmarkMetrics) => string) => {
    const row = report.rows.find((r) => r.size === size && r.workload === workload);
    return row === undefined ? '-' : row.status === 'passed' ? pick(row.metrics) : 'FAILED';
  };
  lines.push(
    ...mdTable(
      [
        'Workload (M × K × N)',
        'MACs',
        ...sizes.map((s) => `Total ${s}`),
        ...sizes.map((s) => `Utilization ${s}`),
      ],
      report.config.workloads.map((w) => [
        workloadShape(w.dims),
        String(w.dims.m * w.dims.n * w.dims.k),
        ...sizes.map((s) => cell(s, w.name, (m) => String(m.total))),
        ...sizes.map((s) => cell(s, w.name, (m) => fix(m.utilization))),
      ]),
    ),
    '',
  );
  for (const size of sizes) {
    const rows = report.rows.filter((r) => r.size === size);
    const first = rows[0];
    lines.push(
      `## ${size} array`,
      '',
      first === undefined
        ? ''
        : `${String(first.rows * first.cols)} PEs: at most ${String(first.rows * first.cols)} MACs per cycle.`,
      '',
      ...mdTable(
        [
          'Workload (M × K × N)',
          'MACs',
          'Tiles',
          'Transfer in',
          'Compute',
          'Store',
          'Busy',
          'Transfer out',
          'Total',
          'Fill/drain',
          'Utilization',
          'MACs/cycle (compute)',
          'MACs/cycle (total)',
          'Ops/cycle (compute)',
          'Ops/cycle (total)',
        ],
        rows.map((r) => {
          if (r.status === 'failed') {
            return [workloadShape(r.dims), `FAILED: ${r.reason}`, ...Array<string>(13).fill('-')];
          }
          const m = r.metrics;
          return [
            workloadShape(r.dims),
            String(m.macs),
            String(m.tiles),
            String(m.transferIn),
            String(m.compute),
            String(m.store),
            String(m.busy),
            String(m.transferOut),
            String(m.total),
            String(m.fillDrain),
            fix(m.utilization),
            fix(m.macsPerCycleCompute),
            fix(m.macsPerCycleTotal),
            fix(m.opsPerCycleCompute),
            fix(m.opsPerCycleTotal),
          ];
        }),
      ),
      '',
    );
  }
  lines.push(
    '## Host',
    '',
    `${report.host.label} This run: ${fix(report.host.totalWallMs, 0)} ms for ${String(report.host.cases.length)} runner processes, ${String(report.host.jobs)} at a time, on ${report.host.platform}/${report.host.arch} (${report.host.runtime}).`,
    '',
  );
  return lines.join('\n');
}
