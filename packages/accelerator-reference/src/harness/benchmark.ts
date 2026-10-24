import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { type MatmulDims, validateDims } from '../model/matmul.js';
import { generateOperands } from '../model/prng.js';
import {
  BENCHMARK_FORMULAS,
  BENCHMARK_KIND,
  BENCHMARK_LABELS,
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkHost,
  benchmarkMetrics,
  type BenchmarkReport,
  BenchmarkReportSchema,
  type BenchmarkRow,
  BUILD_DIR,
  compareBenchmarkModelled,
  type Provenance,
  readProvenance,
  REPO,
  renderBenchmarkCsv,
  renderBenchmarkMarkdown,
} from './report.js';
import { writeCase } from './vectors.js';
import { type ArraySize, cycleLimit, judge, runnerInfo, runRunner, sizeName } from './verify.js';

/**
 * The accelerator benchmark (`make -C hardware/accelerators/matmul benchmark`): every workload of
 * {@link BENCHMARK_WORKLOADS} on every array size's Verilator runner, each gated on an element by
 * element match with the reference model before any number is recorded, written as
 * build/reports/benchmark.{json,csv,md}. `make benchmark-baseline` publishes a copy under
 * research/accelerators/matmul/reports/; docs/hardware/accelerators/performance-analysis.md
 * explains the numbers.
 */

export interface BenchmarkWorkload {
  /** `<M>x<K>x<N>`. */
  readonly name: string;
  readonly dims: MatmulDims;
  readonly what: string;
}

function workload(m: number, k: number, n: number, what: string): BenchmarkWorkload {
  return { name: `${String(m)}x${String(k)}x${String(n)}`, dims: { m, n, k }, what };
}

/**
 * The benchmark workloads, M × K × N (A is M × K, B is K × N): the cubes of the brief, then the
 * non-square set: edge tiles in every dimension, a short reduction, few output rows and a single
 * dot product.
 */
export const BENCHMARK_WORKLOADS: readonly BenchmarkWorkload[] = [
  workload(4, 4, 4, 'cube: one 4 × 4 tile'),
  workload(8, 8, 8, 'cube'),
  workload(16, 16, 16, 'cube'),
  workload(32, 32, 32, 'cube'),
  workload(64, 64, 64, 'cube: the largest product within capacity'),
  workload(13, 19, 11, 'non-square, edge tiles in M and N on every array'),
  workload(64, 8, 64, 'large C, short reduction (K = 8)'),
  workload(8, 64, 64, 'few output rows, long reduction'),
  workload(1, 64, 1, 'one dot product of length 64'),
];

export const BENCHMARK_DEFAULTS = {
  work: join(BUILD_DIR, 'benchmark'),
  out: join(BUILD_DIR, 'reports'),
  seed: 1,
} as const;

export interface BenchmarkOptions {
  /** One runner per array size; each says its size with --info. */
  readonly sims: readonly string[];
  readonly seed: number;
  readonly workloads?: readonly BenchmarkWorkload[];
  /** Where the case files and runner outputs go. */
  readonly work: string;
  /** Where benchmark.{json,csv,md} go. */
  readonly out: string;
  /** A directory to also write `<date>-<shortsha>.{json,csv,md}` into. */
  readonly publish?: string | undefined;
  /** Publish from a dirty working tree anyway. */
  readonly allowDirty?: boolean;
  /** Runner processes in flight at once. */
  readonly jobs: number;
  /** Read once per run; tests pass a fixed one. */
  readonly provenance?: Provenance;
  readonly now?: Date;
}

export interface BenchmarkOutcome {
  readonly exitCode: number;
  readonly report: BenchmarkReport | null;
}

/** A path relative to the repository root when it is inside it. */
function repoPath(path: string): string {
  const rel = relative(REPO, resolve(path));
  return rel.startsWith('..') ? path : rel;
}

/** `2026-10-24-ab12cd3`: the published report's base name (the date of `createdAt`, in UTC). */
export function publishedName(report: BenchmarkReport): string {
  return `${report.provenance.createdAt.slice(0, 10)}-${report.provenance.gitShortCommit ?? 'nogit'}`;
}

export const CORRECTNESS_GATE =
  'Every case is generated from the seed, its C computed by @vcpu/accelerator-reference and run on the runner; a case gets numbers only when the controller reached done and every element of C equals the reference. A case that fails has the reason and no numbers, and the benchmark exits 1.';

/** The report of a run: the modelled sections from the rows, plus provenance and host. */
export function buildBenchmarkReport(input: {
  readonly provenance: Provenance;
  readonly createdAt: string;
  readonly sizes: readonly { readonly size: ArraySize; readonly sim: string }[];
  readonly seed: number;
  readonly workloads: readonly BenchmarkWorkload[];
  readonly rows: readonly BenchmarkRow[];
  readonly host: BenchmarkHost;
}): BenchmarkReport {
  const order = (r: BenchmarkRow) =>
    (r.rows * 1000 + r.cols) * 1000 + input.workloads.findIndex((w) => w.name === r.workload);
  const rows = [...input.rows].sort((a, b) => order(a) - order(b));
  const failed = rows.filter((r) => r.status === 'failed');
  const { provenance: p } = input;
  return BenchmarkReportSchema.parse({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    kind: BENCHMARK_KIND,
    revision: p.revision,
    arraySizes: input.sizes.map((s) => sizeName(s.size)),
    labels: {
      mac: BENCHMARK_LABELS.mac,
      cycles: BENCHMARK_LABELS.cycles,
      transfer: BENCHMARK_LABELS.transfer,
      utilization: BENCHMARK_LABELS.utilization,
    },
    formulas: BENCHMARK_FORMULAS,
    config: {
      notation: 'M × K × N (A is M × K, B is K × N, C is M × N)',
      seed: input.seed,
      generator: 'random',
      workloads: input.workloads.map((w) => ({ name: w.name, dims: w.dims, what: w.what })),
      correctnessGate: CORRECTNESS_GATE,
    },
    verification: {
      gate: failed.length === 0 && rows.length > 0 ? 'passed' : 'failed',
      cases: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      failedCases: failed.map((r) => `${r.size} ${r.workload}`),
    },
    rows,
    provenance: {
      createdAt: input.createdAt,
      gitCommit: p.git.commit,
      gitShortCommit: p.git.commit?.slice(0, 7) ?? null,
      gitDirty: p.git.dirty,
      runners: Object.fromEntries(input.sizes.map((s) => [sizeName(s.size), repoPath(s.sim)])),
      toolchain: p.toolchain,
      tools: p.tools,
    },
    host: input.host,
  });
}

/** Writes `<base>.json`, `<base>.csv` and `<base>.md`. */
export function writeBenchmarkFiles(base: string, report: BenchmarkReport): void {
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.csv`, renderBenchmarkCsv(report));
  writeFileSync(`${base}.md`, renderBenchmarkMarkdown(report));
}

interface Task {
  readonly size: ArraySize;
  readonly sim: string;
  readonly workload: BenchmarkWorkload;
}

/**
 * Runs every workload on every runner, gates each case on the reference, and writes the report.
 * Exit code 0 only when every case passed the gate; 1 when any failed (the report is still
 * written, without numbers for those cases); 2 when the run could not start.
 */
export async function runBenchmark(
  options: BenchmarkOptions,
  write: (text: string) => void,
): Promise<BenchmarkOutcome> {
  const workloads = options.workloads ?? BENCHMARK_WORKLOADS;
  if (options.sims.length === 0) {
    write('benchmark: no runner given (--sim build/sim-<R>x<C>/matmul_sim)\n');
    return { exitCode: 2, report: null };
  }
  const provenance = options.provenance ?? readProvenance();
  if (
    options.publish !== undefined &&
    provenance.git.dirty !== false &&
    options.allowDirty !== true
  ) {
    write(
      `benchmark: refusing to publish from ${provenance.git.dirty === null ? 'outside a git checkout' : 'a dirty working tree'}; commit first (or ALLOW_DIRTY=1, and do not commit the result)\n`,
    );
    return { exitCode: 2, report: null };
  }
  const sizes: { size: ArraySize; sim: string }[] = [];
  for (const sim of options.sims) {
    if (!existsSync(sim)) {
      write(`benchmark: no runner at ${sim}; run 'make -C hardware/accelerators/matmul sim-all'\n`);
      return { exitCode: 2, report: null };
    }
    let size: ArraySize;
    try {
      size = await runnerInfo(sim);
    } catch (error) {
      write(`benchmark: ${(error as Error).message}\n`);
      return { exitCode: 2, report: null };
    }
    if (sizes.some((s) => sizeName(s.size) === sizeName(size))) {
      write(`benchmark: two runners for the ${sizeName(size)} array\n`);
      return { exitCode: 2, report: null };
    }
    sizes.push({ size, sim });
  }
  sizes.sort((a, b) => a.size.rows - b.size.rows || a.size.cols - b.size.cols);

  const tasks: Task[] = [];
  for (const { size, sim } of sizes) {
    rmSync(join(options.work, sizeName(size)), { recursive: true, force: true });
    for (const w of workloads) tasks.push({ size, sim, workload: w });
  }
  const jobs = Math.max(1, options.jobs);
  write(
    `benchmark: ${String(workloads.length)} workloads (seed ${String(options.seed)}) on ${sizes.map((s) => sizeName(s.size)).join(', ')}: ${String(tasks.length)} cases, ${String(jobs)} jobs\n`,
  );

  const started = Date.now();
  const rows: BenchmarkRow[] = [];
  const hostCases: BenchmarkHost['cases'][number][] = [];
  let next = 0;
  const worker = async () => {
    for (let task = tasks[next++]; task !== undefined; task = tasks[next++]) {
      const { size, sim, workload: w } = task;
      validateDims(w.dims);
      const dir = join(options.work, sizeName(size));
      const name = `${w.name}-s${String(options.seed)}`;
      const written = writeCase(
        dir,
        name,
        { ...w.dims, ...generateOperands('random', options.seed, w.dims) },
        { seed: options.seed, generator: 'random' },
      );
      const files = {
        expected: written.expected,
        out: join(dir, `${name}.out`),
        cycles: join(dir, `${name}.cycles.json`),
      };
      const flags = { repeat: 1, resetBetween: false, abortFirst: false };
      const t0 = performance.now();
      const run = await runRunner(sim, [
        '--case',
        written.input,
        '--out',
        files.out,
        '--cycles',
        files.cycles,
        '--max-cycles',
        String(cycleLimit(size, w.dims)),
        '--quiet',
      ]);
      hostCases.push({
        size: sizeName(size),
        workload: w.name,
        runnerMs: Number((performance.now() - t0).toFixed(1)),
      });
      const outcome = judge({ dims: w.dims, flags }, run, files);
      const base = { size: sizeName(size), ...size, workload: w.name, dims: w.dims };
      if (outcome.reason !== null || outcome.cycles === null) {
        rows.push({ ...base, status: 'failed', reason: outcome.reason ?? 'no clock counts' });
        write(
          `FAIL ${sizeName(size)} ${w.name}: ${outcome.reason ?? 'no clock counts'}\n  case ${written.input}\n`,
        );
      } else {
        rows.push({
          ...base,
          status: 'passed',
          metrics: benchmarkMetrics(size, w.dims, outcome.cycles),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: jobs }, () => worker()));
  const order = (c: { size: string; workload: string }) =>
    `${c.size.padStart(8, '0')} ${String(workloads.findIndex((w) => w.name === c.workload)).padStart(4, '0')}`;
  hostCases.sort((a, b) => order(a).localeCompare(order(b)));
  const cpu = cpus()[0];
  const report = buildBenchmarkReport({
    provenance,
    createdAt: (options.now ?? new Date()).toISOString(),
    sizes,
    seed: options.seed,
    workloads,
    rows,
    host: {
      label: BENCHMARK_LABELS.host,
      runtime: `node ${process.versions.node}`,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpu?.model.trim() ?? 'unknown',
      jobs,
      totalWallMs: Number((Date.now() - started).toFixed(0)),
      cases: hostCases,
    },
  });

  for (const size of report.arraySizes) {
    write(`  ${size}\n`);
    for (const r of report.rows.filter((x) => x.size === size)) {
      if (r.status === 'failed') {
        write(`    ${r.workload.padEnd(10)} FAILED: ${r.reason}\n`);
        continue;
      }
      const m = r.metrics;
      write(
        `    ${r.workload.padEnd(10)} total ${String(m.total).padStart(6)}  compute ${String(m.compute).padStart(6)}  utilization ${m.utilization.toFixed(3)}  MACs/cycle ${m.macsPerCycleTotal.toFixed(3)} (total) ${m.macsPerCycleCompute.toFixed(3)} (compute)\n`,
      );
    }
  }
  write(
    'cycles: RTL clock edges, not time; utilization = MACs / (ROWS · COLS · compute); ops = 2 × MACs\n',
  );
  mkdirSync(options.out, { recursive: true });
  const base = join(options.out, 'benchmark');
  writeBenchmarkFiles(base, report);
  write(`wrote ${base}.json, benchmark.csv and benchmark.md\n`);
  const { verification: v } = report;
  if (v.gate === 'failed') {
    write(
      `benchmark: FAIL, ${String(v.failed)}/${String(v.cases)} cases failed the correctness gate and have no numbers: ${v.failedCases.join(', ')}\n`,
    );
    if (options.publish !== undefined) write('benchmark: nothing published\n');
    return { exitCode: 1, report };
  }
  // Only a report whose every case passed the gate is published.
  if (options.publish !== undefined) {
    mkdirSync(options.publish, { recursive: true });
    const published = join(options.publish, publishedName(report));
    writeBenchmarkFiles(published, report);
    write(`wrote ${published}.json, .csv and .md\n`);
  }
  write(`benchmark: PASS, the correctness gate passed for all ${String(v.cases)} cases\n`);
  return { exitCode: 0, report };
}

/** Reads and validates a benchmark report; throws naming the first schema problem. */
export function readBenchmarkReport(file: string): BenchmarkReport {
  const parsed = BenchmarkReportSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${file} does not match the benchmark report schema: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

/**
 * The newest committed report in `dir`: of the `*.json` files git tracks there (an uncommitted
 * report, such as one written with --allow-dirty, never counts), the one with the latest
 * `provenance.createdAt`. Null when there is none.
 */
export function newestCommittedReport(dir: string): string | null {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*.json'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (listed.status !== 0) return null;
  let newest: { file: string; createdAt: string } | null = null;
  for (const name of listed.stdout.split('\0').filter((n) => n !== '' && !n.includes('/'))) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const { createdAt } = readBenchmarkReport(file).provenance;
    if (newest === null || createdAt > newest.createdAt) newest = { file, createdAt };
  }
  return newest?.file ?? null;
}

/**
 * Exit code 0 when the two reports' modelled sections (all but provenance and host) are
 * byte-identical, 1 (listing what differs) when they are not.
 */
export function compareBenchmarkFiles(
  baselineFile: string,
  reportFile: string,
  write: (text: string) => void,
): number {
  const baseline = readBenchmarkReport(baselineFile);
  write(
    `${baselineFile}: valid benchmark report (schemaVersion ${String(baseline.schemaVersion)})\n`,
  );
  const report = readBenchmarkReport(reportFile);
  write(`${reportFile}: valid benchmark report (schemaVersion ${String(report.schemaVersion)})\n`);
  const { identical, deltas } = compareBenchmarkModelled(baseline, report);
  if (identical) {
    write(
      'benchmark-compare: the modelled sections are byte-identical (provenance and host removed)\n',
    );
    return 0;
  }
  const show = (leaf: unknown) => (leaf === undefined ? '(absent)' : JSON.stringify(leaf));
  write(
    `benchmark-compare: the modelled sections differ${deltas.length === 0 ? ' in key order only' : ` in ${String(deltas.length)} fields`}:\n`,
  );
  for (const d of deltas.slice(0, 50)) {
    write(`  ${d.path}: ${show(d.baseline)} → ${show(d.fresh)}\n`);
  }
  if (deltas.length > 50) write(`  … ${String(deltas.length - 50)} more\n`);
  return 1;
}

export function defaultBenchmarkOptions(sims: readonly string[]): BenchmarkOptions {
  return { ...BENCHMARK_DEFAULTS, sims, jobs: availableParallelism() };
}
