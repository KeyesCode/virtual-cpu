import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_DIM, type MatmulDims } from '../model/matmul.js';
import {
  BENCHMARK_DEFAULTS,
  BENCHMARK_WORKLOADS,
  type BenchmarkWorkload,
  runBenchmark,
  workload,
} from './benchmark.js';
import {
  BENCHMARK_LABELS,
  BenchmarkMetricsSchema,
  BUILD_DIR,
  HW_DIR,
  type Provenance,
  readProvenance,
  REPO,
  workloadShape,
} from './report.js';
import { MatmulSynthSummarySchema, POWER } from './synth-summary.js';
import { defaultVerifyOptions, runVerify, VERIFY_DEFAULTS } from './verify.js';

/**
 * The accelerator's design-space exploration (`make -C hardware/accelerators/matmul experiment
 * NAME=<name>`): `research/accelerators/matmul/experiments/<name>/experiment.json` lists design
 * variants (top-level parameters such as ROWS, COLS and MAX_DIM, and Verilog defines). Each one is
 * built, verified against the reference (it must pass), benchmarked on the benchmark workloads and
 * synthesised with every flow of `make synth`, in that order, and the comparison, with the
 * Pareto-optimal variants on (total cycles, generic cells), goes to
 * `<name>/results/<date>-<shortsha>.{json,md}`. research/accelerators/matmul/experiments/README.md
 * documents the format. Power is not measured, so nothing is ranked on it.
 */

export const EXPERIMENTS_DIR = join(REPO, 'research', 'accelerators', 'matmul', 'experiments');
export const EXPERIMENT_SCHEMA_VERSION = 1;
export const EXPERIMENT_KIND = 'matmul-experiment';

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case letters, digits and dashes');
const Identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a Verilog identifier');
const Define = z.union([z.literal(true), z.number().int(), Identifier]);

export const VariantSpecSchema = z.strictObject({
  name: Slug,
  description: z.string().default(''),
  /**
   * Integer top-level parameters: ROWS (required), COLS (default ROWS) and MAX_DIM (default 64),
   * set with Verilator -G on matmul_sim_top and Yosys chparam on matmul_top and
   * matmul_fpga_wrapper, so any other parameter must be declared on all three.
   */
  parameters: z.record(Identifier, z.number().int()).refine((p) => 'ROWS' in p, 'ROWS is required'),
  /** `NAME: true` passes -DNAME, `NAME: value` -DNAME=value, to Verilator and Yosys alike. */
  defines: z.record(Identifier, Define).default({}),
});
export type VariantSpec = z.output<typeof VariantSpecSchema>;

const Dim = z.number().int().min(1).max(0xffff);

export const ExperimentSpecSchema = z.strictObject({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  /** The experiment's name: the first half of every run's experiment ID. */
  id: Slug,
  description: z.string().min(1),
  /** The differential verification each variant must pass first (as `make verify`). */
  verify: z
    .strictObject({
      seed: z.number().int().min(0).default(VERIFY_DEFAULTS.seed),
      count: z.number().int().min(0).default(VERIFY_DEFAULTS.count),
    })
    .default({ seed: VERIFY_DEFAULTS.seed, count: VERIFY_DEFAULTS.count }),
  /** The operand seed of the benchmark workloads (as `make benchmark`). */
  benchmark: z
    .strictObject({ seed: z.number().int().min(0).default(BENCHMARK_DEFAULTS.seed) })
    .default({ seed: BENCHMARK_DEFAULTS.seed }),
  /**
   * The workloads, M × K × N, in place of the benchmark's own. A workload with a dimension above
   * a variant's MAX_DIM is "not supported by this variant" there, not a failure.
   */
  workloads: z
    .array(z.strictObject({ m: Dim, k: Dim, n: Dim, what: z.string().default('') }))
    .min(1)
    .optional(),
  /** The variant the deltas are against; the first one when omitted. */
  baseline: Slug.optional(),
  variants: z.array(VariantSpecSchema).min(1),
});
export type ExperimentSpec = z.output<typeof ExperimentSpecSchema>;

/** A variant's parameters with the defaults filled in, in key order. */
export function resolvedParameters(variant: VariantSpec): Record<string, number> {
  const rows = variant.parameters.ROWS ?? 0;
  const all: Record<string, number> = {
    ...variant.parameters,
    COLS: variant.parameters.COLS ?? rows,
    MAX_DIM: variant.parameters.MAX_DIM ?? MAX_DIM,
  };
  return Object.fromEntries(Object.entries(all).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/**
 * Why r1 cannot build these parameters, or null. ROWS, COLS and MAX_DIM are powers of two (the
 * buffers are banked by address bits), ROWS = COLS (the synthesis flow builds square arrays) and
 * at most MAX_DIM, and MAX_DIM is 32 … 128 (the FPGA wrapper writes the address a byte at a time,
 * the bits above 8 in one more byte, and the dimensions as one byte).
 */
export function parameterProblem(parameters: Readonly<Record<string, number>>): string | null {
  const { ROWS: rows = 0, COLS: cols = 0, MAX_DIM: maxDim = 0 } = parameters;
  if (!isPowerOfTwo(maxDim) || maxDim < 32 || maxDim > 128) {
    return `MAX_DIM must be 32, 64 or 128, got ${String(maxDim)}`;
  }
  if (!isPowerOfTwo(rows) || rows < 2 || rows > maxDim) {
    return `ROWS must be a power of two from 2 to MAX_DIM (${String(maxDim)}), got ${String(rows)}`;
  }
  if (cols !== rows) {
    return `COLS must equal ROWS (the synthesis flow builds square arrays), got ${String(cols)} for ROWS ${String(rows)}`;
  }
  return null;
}

const sorted = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));

/** `-DNAME` / `-DNAME=value`, in key order; Verilator and Yosys spell them the same. */
export function defineFlags(defines: VariantSpec['defines']): string[] {
  return sorted(defines).map(([name, value]) =>
    value === true ? `-D${name}` : `-D${name}=${String(value)}`,
  );
}

/**
 * 12 hex digits of the SHA-256 of the resolved parameters and the defines: the name and the
 * description do not change the hardware, so they do not change the build directory.
 */
export function variantHash(variant: VariantSpec): string {
  const canonical = JSON.stringify({
    defines: sorted(variant.defines),
    parameters: sorted(resolvedParameters(variant)),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** Why a variant of capacity `maxDim` cannot run a workload, or null when it can. */
export function unsupportedReason(dims: MatmulDims, maxDim: number): string | null {
  const over = (['m', 'k', 'n'] as const).filter((d) => dims[d] > maxDim);
  if (over.length === 0) return null;
  return `not supported by this variant: ${over.map((d) => d.toUpperCase()).join(', ')} above MAX_DIM ${String(maxDim)}`;
}

export interface ParetoPoint {
  readonly name: string;
  readonly cycles: number;
  readonly cells: number;
}

/**
 * The Pareto-optimal points, in input order: a point is optimal when no other point has at most
 * its cycles and at most its cells and fewer of one. Two identical points are both optimal.
 */
export function paretoOptimal(points: readonly ParetoPoint[]): string[] {
  const dominates = (q: ParetoPoint, p: ParetoPoint): boolean =>
    q.cycles <= p.cycles && q.cells <= p.cells && (q.cycles < p.cycles || q.cells < p.cells);
  return points.filter((p) => !points.some((q) => dominates(q, p))).map((p) => p.name);
}

export const PARETO_RULE =
  'A variant is Pareto-optimal when no other variant has at most its total cycles and at most its generic cells, and fewer of one. Total cycles are summed over the workloads every passed variant ran; failed variants are left out.';

// ---------------------------------------------------------------------------------------------
// The result

const Stage = z.enum(['config', 'build', 'verify', 'benchmark', 'synth']);
type Stage = z.output<typeof Stage>;
const STAGES = Stage.options;

const StageResultSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'skipped', 'not-run']),
  /** Why it failed or was skipped. */
  detail: z.string().nullable(),
});

const DimsSchema = z.strictObject({ m: Dim, n: Dim, k: Dim });

const BenchmarkRowSchema = z.discriminatedUnion('status', [
  z.strictObject({
    workload: z.string(),
    dims: DimsSchema,
    status: z.literal('passed'),
    metrics: BenchmarkMetricsSchema,
  }),
  z.strictObject({
    workload: z.string(),
    dims: DimsSchema,
    status: z.literal('unsupported'),
    reason: z.string(),
  }),
]);

const FpgaSummarySchema = z.strictObject({
  family: z.string(),
  status: z.enum(['fits', 'does-not-fit', 'absent']),
  device: z.string().nullable(),
  /** What Yosys mapped the design to; null when the flow did not run. */
  luts: z.number().int().nullable(),
  flipFlops: z.number().int().nullable(),
  blockRam: z.number().int().nullable(),
  dsp: z.number().int().nullable(),
  /** nextpnr's estimate for the device, only when the design fits. */
  fmaxMHz: z.number().nullable(),
  meetsConstraint: z.boolean().nullable(),
  /** The resources over 100 % when it does not fit. */
  overUtilised: z.array(z.string()),
  reason: z.string().nullable(),
});
export type FpgaSummary = z.output<typeof FpgaSummarySchema>;

const VariantResultSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  hash: z.string(),
  parameters: z.record(z.string(), z.number().int()),
  defines: z.record(z.string(), Define),
  /** incomplete: a stage was skipped because a tool is missing; nothing failed. */
  status: z.enum(['passed', 'failed', 'incomplete']),
  failedStage: Stage.nullable(),
  reason: z.string().nullable(),
  stages: z.strictObject(
    Object.fromEntries(STAGES.map((s) => [s, StageResultSchema])) as Record<
      Stage,
      typeof StageResultSchema
    >,
  ),
  verify: z
    .strictObject({
      passed: z.boolean(),
      cases: z.number().int(),
      directed: z.number().int(),
      random: z.number().int(),
      failed: z.number().int(),
      firstFailures: z.array(z.string()),
    })
    .nullable(),
  /** Null unless the variant passed every stage that ran. */
  benchmark: z.strictObject({ rows: z.array(BenchmarkRowSchema) }).nullable(),
  /** Null unless the variant passed every stage that ran and synthesis ran. */
  synth: z
    .strictObject({
      cells: z.number().int(),
      flipFlops: z.number().int(),
      mulCells: z.number().int(),
      memoryBanks: z.number().int(),
      memoryBits: z.number().int(),
      abstractGates: z.number().int(),
      logicDepth: z.number().int(),
      fpga: z.array(FpgaSummarySchema),
    })
    .nullable(),
  /** The allowlisted synthesis warnings and anything else worth a reader's attention. */
  warnings: z.array(z.string()),
});
export type VariantResult = z.output<typeof VariantResultSchema>;

export const ExperimentResultSchema = z.strictObject({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  kind: z.literal(EXPERIMENT_KIND),
  /** `<id>/<runId>`: unique per experiment, commit and day. */
  experimentId: z.string(),
  experiment: z.string(),
  /** `<date>-<shortsha>`, the results' file name. */
  runId: z.string(),
  description: z.string(),
  revision: z.string(),
  labels: z.strictObject({
    mac: z.string(),
    cycles: z.string(),
    utilization: z.string(),
    synthesis: z.string(),
    power: z.literal(POWER),
  }),
  config: z.strictObject({
    verify: z.strictObject({ seed: z.number().int(), count: z.number().int() }),
    benchmark: z.strictObject({
      seed: z.number().int(),
      workloads: z.array(z.strictObject({ name: z.string(), dims: DimsSchema, what: z.string() })),
    }),
    baseline: z.string(),
  }),
  passed: z.boolean(),
  variants: z.array(VariantResultSchema),
  pareto: z.strictObject({
    axes: z.tuple([z.string(), z.string()]),
    rule: z.literal(PARETO_RULE),
    commonWorkloads: z.array(z.string()),
    points: z.array(
      z.strictObject({
        variant: z.string(),
        totalCycles: z.number().int(),
        cells: z.number().int(),
        optimal: z.boolean(),
      }),
    ),
  }),
  /** Where and when the numbers came from: everything a rerun of the same design may change. */
  provenance: z.strictObject({
    createdAt: z.iso.datetime(),
    gitCommit: z.string().nullable(),
    gitShortCommit: z.string().nullable(),
    gitDirty: z.boolean().nullable(),
    toolchain: z.string().nullable(),
    tools: z.record(z.string(), z.string().nullable()).nullable(),
    host: z.strictObject({
      label: z.string(),
      runtime: z.string(),
      platform: z.string(),
      arch: z.string(),
      cpuModel: z.string(),
      jobs: z.number().int().positive(),
      /** Wall-clock seconds of each stage that ran, per variant. */
      stageSeconds: z.record(z.string(), z.record(z.string(), z.number().nonnegative())),
    }),
  }),
});
export type ExperimentResult = z.output<typeof ExperimentResultSchema>;

// ---------------------------------------------------------------------------------------------
// The stages

export interface ExperimentOptions {
  /** experiment.json. */
  readonly spec: string;
  /** Where `<runId>.{json,md}` go. */
  readonly out: string;
  /** GNU Make, for the runner build and the synthesis (mk/sim.mk, mk/synth.mk). */
  readonly make: string;
  readonly jobs: number;
  /** Write results from a dirty working tree anyway (they record it; do not commit them). */
  readonly allowDirty: boolean;
}

export function defaultExperimentOptions(spec: string, out: string): ExperimentOptions {
  return { spec, out, make: 'make', jobs: availableParallelism(), allowDirty: false };
}

/** A path relative to the repository root when it is inside it. */
function repoPath(path: string): string {
  const rel = relative(REPO, resolve(path));
  return rel.startsWith('..') ? path : rel;
}

/**
 * This process's environment without the variables of the `pnpm --filter … cli` run that started
 * it: make synth runs `pnpm --filter … cli synth-summary` itself, and a pnpm that inherits the
 * outer run's `npm_config_*` settings fails (the same as Project 2's experiment runner).
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(npm_|pnpm_)/i.test(key) && key !== 'INIT_CWD' && key !== 'PNPM_SCRIPT_SRC_DIR',
    ),
  );
}

interface MakeRun {
  readonly ok: boolean;
  /** The tool `need` reported missing, if that is why it failed. */
  readonly missingTool: string | null;
  readonly status: string;
}

/** Runs `make -C hardware/accelerators/matmul <args>`, its output into `log`. */
function runMake(make: string, args: readonly string[], log: string): MakeRun {
  const run = spawnSync(make, ['-C', HW_DIR, '--no-print-directory', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    env: cleanEnv(),
  });
  const text = `${run.stdout}${run.stderr}`;
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, text);
  const missing = /^(\S+) not found\. Run 'pnpm hardware:setup'/m.exec(text);
  return {
    ok: run.error === undefined && run.status === 0,
    missingTool: missing?.[1] ?? null,
    status: run.error?.message ?? `exit ${String(run.status)}`,
  };
}

/** The first error line of a log, for a failure reason. */
function firstError(log: string): string {
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const line = text.split('\n').find((l) => /%Error|ERROR|error:/.test(l));
  return line === undefined ? '' : `: ${line.trim().slice(0, 200)}`;
}

function fpgaSummaries(
  fpga: Readonly<
    Record<string, z.output<typeof MatmulSynthSummarySchema>['sizes'][number]['fpga'][string]>
  >,
): FpgaSummary[] {
  return sorted(fpga).map(([family, r]): FpgaSummary => {
    if (r.status === 'absent') {
      return {
        family,
        status: 'absent',
        device: null,
        luts: null,
        flipFlops: null,
        blockRam: null,
        dsp: null,
        fmaxMHz: null,
        meetsConstraint: null,
        overUtilised: [],
        reason: r.reason,
      };
    }
    const common = {
      family,
      device: r.device,
      luts: r.synth.luts,
      flipFlops: r.synth.flipFlops,
      blockRam: r.synth.blockRam,
      dsp: r.synth.dsp,
    };
    return r.fits
      ? {
          ...common,
          status: 'fits',
          fmaxMHz: r.fmaxMHz,
          meetsConstraint: r.meetsConstraint,
          overUtilised: [],
          reason: null,
        }
      : {
          ...common,
          status: 'does-not-fit',
          fmaxMHz: null,
          meetsConstraint: null,
          overUtilised: [...r.overUtilised],
          reason: r.reason,
        };
  });
}

interface VariantContext {
  readonly spec: ExperimentSpec;
  readonly workloads: readonly BenchmarkWorkload[];
  readonly options: ExperimentOptions;
  readonly provenance: Provenance;
  readonly now: Date;
  readonly write: (text: string) => void;
}

async function runVariant(
  variant: VariantSpec,
  context: VariantContext,
  seconds: Record<string, number>,
): Promise<VariantResult> {
  const { spec, workloads, options, write } = context;
  const parameters = resolvedParameters(variant);
  const hash = variantHash(variant);
  const variantDir = join(BUILD_DIR, 'variants', hash);
  const work = join(BUILD_DIR, 'experiments', spec.id, variant.name);
  const stages = Object.fromEntries(
    STAGES.map((s) => [s, { status: 'not-run' as const, detail: null }]),
  ) as VariantResult['stages'];
  const result: VariantResult = {
    name: variant.name,
    description: variant.description,
    hash,
    parameters,
    defines: variant.defines,
    status: 'passed',
    failedStage: null,
    reason: null,
    stages,
    verify: null,
    benchmark: null,
    synth: null,
    warnings: [],
  };
  const fail = (stage: Stage, reason: string): VariantResult => {
    write(`  ${variant.name}: FAILED at ${stage}: ${reason}\n`);
    stages[stage] = { status: 'failed', detail: reason };
    // A failed variant has no metrics.
    return {
      ...result,
      status: 'failed',
      failedStage: stage,
      reason,
      benchmark: null,
      synth: null,
    };
  };
  const timed = async <T>(stage: Stage, run: () => T | Promise<T>): Promise<T> => {
    const t0 = performance.now();
    try {
      return await run();
    } finally {
      seconds[stage] = Number(((performance.now() - t0) / 1000).toFixed(1));
    }
  };
  const label = sorted(parameters)
    .map(([k, v]) => `${k}=${String(v)}`)
    .concat(defineFlags(variant.defines))
    .join(' ');
  write(`  ${variant.name} (${hash}): ${label}\n`);

  const problem = parameterProblem(parameters);
  if (problem !== null) return fail('config', problem);
  stages.config = { status: 'passed', detail: null };
  const maxDim = parameters.MAX_DIM ?? MAX_DIM;
  const rows = parameters.ROWS ?? 0;

  // Build: mk/sim.mk's sim-variant, every parameter as -G and every define as -D.
  const simDir = join(variantDir, 'sim');
  const sim = join(simDir, 'matmul_sim');
  const buildLog = join(variantDir, 'sim-build.log');
  const build = await timed('build', () =>
    runMake(
      options.make,
      [
        'sim-variant',
        `SIM_DIR=${simDir}`,
        `SIM_GFLAGS=${sorted(parameters)
          .map(([k, v]) => `-G${k}=${String(v)}`)
          .join(' ')}`,
        `SIM_DEFINES=${defineFlags(variant.defines).join(' ')}`,
      ],
      buildLog,
    ),
  );
  if (!build.ok || !existsSync(sim)) {
    const log = existsSync(join(simDir, 'build.log')) ? join(simDir, 'build.log') : buildLog;
    return fail(
      'build',
      `the runner does not build (${build.status})${firstError(log)}; see ${repoPath(log)}`,
    );
  }
  stages.build = { status: 'passed', detail: null };

  // Verify: the directed corpus and the random cases, as `make verify`, at this MAX_DIM.
  write(
    `  ${variant.name}: verify (directed + ${String(spec.verify.count)} random from seed ${String(spec.verify.seed)})\n`,
  );
  let verifyLog = '';
  const verify = await timed('verify', () =>
    runVerify(
      {
        ...defaultVerifyOptions([sim]),
        seed: spec.verify.seed,
        count: spec.verify.count,
        maxDim,
        jobs: options.jobs,
        work: join(work, 'verify', 'cases'),
        failures: join(work, 'verify', 'failures'),
        reports: join(work, 'verify'),
        provenance: context.provenance,
      },
      (text) => {
        verifyLog += text;
      },
    ),
  );
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, 'verify.log'), verifyLog);
  const totals = verify.report?.totals;
  result.verify = {
    passed: verify.exitCode === 0,
    cases: totals?.cases ?? 0,
    directed: totals?.directed ?? 0,
    random: totals?.random ?? 0,
    failed: totals?.failed ?? 0,
    firstFailures: verify.failures.slice(0, 5).map((f) => `${f.size} ${f.name}`),
  };
  if (verify.exitCode !== 0) {
    return fail(
      'verify',
      verify.report === null
        ? `verify could not run (exit ${String(verify.exitCode)}); see ${repoPath(join(work, 'verify.log'))}`
        : `${String(result.verify.failed)}/${String(result.verify.cases)} cases differ from the reference; see ${repoPath(join(work, 'verify.log'))}`,
    );
  }
  stages.verify = { status: 'passed', detail: null };
  write(`  ${variant.name}: verify passed, ${String(result.verify.cases)} cases\n`);

  // Benchmark: the workloads this capacity supports; the others are recorded as unsupported.
  const supported = workloads.filter((w) => unsupportedReason(w.dims, maxDim) === null);
  const benchRows: z.output<typeof BenchmarkRowSchema>[] = [];
  if (supported.length === 0) {
    stages.benchmark = { status: 'skipped', detail: `no workload fits MAX_DIM ${String(maxDim)}` };
  } else {
    write(`  ${variant.name}: benchmark (${String(supported.length)} workloads)\n`);
    let benchLog = '';
    const bench = await timed('benchmark', () =>
      runBenchmark(
        {
          ...BENCHMARK_DEFAULTS,
          sims: [sim],
          seed: spec.benchmark.seed,
          workloads: supported,
          maxDim,
          jobs: options.jobs,
          work: join(work, 'benchmark', 'cases'),
          out: join(work, 'benchmark'),
          provenance: context.provenance,
          now: context.now,
        },
        (text) => {
          benchLog += text;
        },
      ),
    );
    writeFileSync(join(work, 'benchmark.log'), benchLog);
    if (bench.report === null || bench.exitCode !== 0) {
      const failed = bench.report?.verification.failedCases ?? [];
      return fail(
        'benchmark',
        `${failed.length > 0 ? `${failed.join(', ')} failed the correctness gate` : `the benchmark exited ${String(bench.exitCode)}`}; see ${repoPath(join(work, 'benchmark.log'))}`,
      );
    }
    stages.benchmark = { status: 'passed', detail: null };
    for (const r of bench.report.rows) {
      if (r.status === 'passed') {
        benchRows.push({
          workload: r.workload,
          dims: r.dims,
          status: 'passed',
          metrics: r.metrics,
        });
      }
    }
  }
  const benchmark = {
    rows: workloads.map((w) => {
      const reason = unsupportedReason(w.dims, maxDim);
      if (reason !== null) {
        return { workload: w.name, dims: w.dims, status: 'unsupported' as const, reason };
      }
      const row = benchRows.find((r) => r.workload === w.name);
      if (row === undefined) throw new Error(`benchmark: no row for ${w.name}`);
      return row;
    }),
  };

  // Synth: make synth for this one size, with the variant's other parameters and its defines.
  write(`  ${variant.name}: synth\n`);
  const synthLog = join(variantDir, 'synth.log');
  const synth = await timed('synth', () =>
    runMake(
      options.make,
      [
        'synth',
        `SYNTH_SIZES=${String(rows)}`,
        `SYNTH_ROOT=${variantDir}`,
        `SYNTH_PARAMS=${sorted(parameters)
          .filter(([k]) => k !== 'ROWS' && k !== 'COLS')
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' ')}`,
        `SYNTH_DEFINES=${defineFlags(variant.defines).join(' ')}`,
      ],
      synthLog,
    ),
  );
  const summaryFile = join(variantDir, 'synth', 'summary.json');
  if (!synth.ok && synth.missingTool !== null) {
    const detail = `${synth.missingTool} is not installed (pnpm hardware:setup)`;
    stages.synth = { status: 'skipped', detail };
    write(`  ${variant.name}: synth skipped: ${detail}\n`);
    return {
      ...result,
      status: 'incomplete',
      benchmark,
      warnings: [...result.warnings, `synth skipped: ${detail}`],
    };
  }
  if (!synth.ok || !existsSync(summaryFile)) {
    return fail(
      'synth',
      `make synth failed (${synth.status})${firstError(synthLog)}; see ${repoPath(synthLog)}`,
    );
  }
  const summary = MatmulSynthSummarySchema.parse(JSON.parse(readFileSync(summaryFile, 'utf8')));
  const size = summary.sizes[0];
  if (size === undefined) return fail('synth', `${repoPath(summaryFile)} has no size`);
  stages.synth = { status: 'passed', detail: null };
  const g = size.generic;
  const fpga = fpgaSummaries(size.fpga);
  const warnings = [
    ...summary.warnings.map(
      (w) => `synth warning (allowlisted): ${w.source}: ${w.message} (×${String(w.count)})`,
    ),
    ...fpga
      .filter((f) => f.status === 'absent')
      .map((f) => `${f.family} flow not run: ${f.reason ?? ''}`),
  ];
  write(
    `  ${variant.name}: passed: ${String(g.total.cells)} generic cells, ${String(g.memoryBits)} memory bits\n`,
  );
  return {
    ...result,
    benchmark,
    synth: {
      cells: g.total.cells,
      flipFlops: g.total.flipFlops,
      mulCells: g.mulCells,
      memoryBanks: g.memoryBanks,
      memoryBits: g.memoryBits,
      abstractGates: g.abstractGates,
      logicDepth: g.logicDepth.length,
      fpga,
    },
    warnings,
  };
}

/** The Pareto section: Σ total cycles over the workloads every passed variant ran, and cells. */
export function paretoSection(variants: readonly VariantResult[]): ExperimentResult['pareto'] {
  const measured = variants.filter(
    (v) => v.status === 'passed' && v.benchmark !== null && v.synth !== null,
  );
  const names = measured[0]?.benchmark?.rows.map((r) => r.workload) ?? [];
  const common = names.filter((name) =>
    measured.every((v) => v.benchmark?.rows.find((r) => r.workload === name)?.status === 'passed'),
  );
  const points = measured.map((v) => ({
    name: v.name,
    cycles: (v.benchmark?.rows ?? []).reduce(
      (sum, r) =>
        sum + (r.status === 'passed' && common.includes(r.workload) ? r.metrics.total : 0),
      0,
    ),
    cells: v.synth?.cells ?? 0,
  }));
  const optimal = new Set(paretoOptimal(points));
  return {
    axes: ['total cycles summed over the common workloads', 'generic cells'],
    rule: PARETO_RULE,
    commonWorkloads: common,
    points: points.map((p) => ({
      variant: p.name,
      totalCycles: p.cycles,
      cells: p.cells,
      optimal: optimal.has(p.name),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// The Markdown

/** A Markdown table: the first `textColumns` columns left-aligned, the others right-aligned. */
function mdTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  textColumns = 1,
): string[] {
  const align = header.map((_, i) => (i < textColumns ? '---' : '--:'));
  return [header, align, ...rows].map((cells) => `| ${cells.join(' | ')} |`);
}

/** ` (+12, +3.4 %)` against the baseline's value; empty for the baseline or without one. */
function delta(value: number, base: number | null | undefined, digits: number, isBase: boolean) {
  if (isBase || base === null || base === undefined) return '';
  const d = value - base;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
  const abs = Math.abs(d).toFixed(digits);
  const rel = base === 0 ? '' : `, ${sign}${Math.abs((100 * d) / base).toFixed(1)} %`;
  return ` (${sign}${abs}${rel})`;
}

const num = (value: number, digits: number): string =>
  digits === 0 ? value.toLocaleString('en-US') : value.toFixed(digits);

/** The comparison: summary, one table per metric with deltas against the baseline, Pareto. */
export function renderExperimentMarkdown(result: ExperimentResult): string {
  const base = result.variants.find((v) => v.name === result.config.baseline);
  const names = result.variants.map((v) => v.name);
  const pareto = new Map(result.pareto.points.map((p) => [p.variant, p]));
  const p = result.provenance;
  const params = (v: VariantResult) =>
    [...sorted(v.parameters).map(([k, x]) => `${k}=${String(x)}`), ...defineFlags(v.defines)].join(
      ' ',
    );
  const lines = [
    `# Experiment: ${result.experiment}`,
    '',
    result.description,
    '',
    `Experiment ID \`${result.experimentId}\`. Revision \`${result.revision}\`, commit \`${p.gitShortCommit ?? 'unknown'}\`${p.gitDirty === true ? ' (dirty working tree)' : ''}. ${result.passed ? 'Every variant passed every stage.' : 'Not every variant passed every stage (see the Result column).'}`,
    '',
    `Each variant was built, then verified against \`@vcpu/accelerator-reference\` (the directed corpus and ${String(result.config.verify.count)} random cases from seed ${String(result.config.verify.seed)}), then benchmarked (operand seed ${String(result.config.benchmark.seed)}, every case gated on the reference), then synthesised with every flow of \`make synth\`. A variant that fails a stage has no metrics. Deltas are against the baseline, \`${result.config.baseline}\`.`,
    '',
    `- ${result.labels.cycles}`,
    `- ${result.labels.mac}`,
    `- ${result.labels.utilization}`,
    `- ${result.labels.synthesis}`,
    `- Power: ${result.labels.power}. No variant is ranked on power.`,
    '',
    '## Summary',
    '',
    ...mdTable(
      [
        'Variant',
        'Parameters',
        'Result',
        'Verify cases',
        'Workloads run',
        'Σ total cycles (common workloads)',
        'Generic cells',
        'Pareto-optimal',
      ],
      result.variants.map((v) => {
        const point = pareto.get(v.name);
        const basePoint = base === undefined ? undefined : pareto.get(base.name);
        const isBase = v === base;
        return [
          `${v.name}${isBase ? ' (baseline)' : ''}`,
          `\`${params(v)}\``,
          v.status === 'failed'
            ? `FAILED at ${v.failedStage ?? '?'}: ${v.reason ?? ''}`
            : v.status === 'incomplete'
              ? `incomplete: ${Object.entries(v.stages)
                  .filter(([, s]) => s.status === 'skipped')
                  .map(([stage, s]) => `${stage} skipped (${s.detail ?? ''})`)
                  .join('; ')}`
              : 'passed',
          v.verify === null
            ? '-'
            : `${String(v.verify.cases)}${v.verify.passed ? '' : ` (${String(v.verify.failed)} failed)`}`,
          v.benchmark === null
            ? '-'
            : `${String(v.benchmark.rows.filter((r) => r.status === 'passed').length)} of ${String(v.benchmark.rows.length)}`,
          point === undefined
            ? '-'
            : `${num(point.totalCycles, 0)}${delta(point.totalCycles, basePoint?.totalCycles, 0, isBase)}`,
          v.synth === null
            ? '-'
            : `${num(v.synth.cells, 0)}${delta(v.synth.cells, base?.synth?.cells, 0, isBase)}`,
          point === undefined ? '-' : point.optimal ? '**yes**' : 'no',
        ];
      }),
      3,
    ),
    '',
  ];

  // One table per benchmark metric: workloads down, variants across.
  const workloads = result.config.benchmark.workloads;
  const metric = (
    title: string,
    note: string,
    pick: (m: z.output<typeof BenchmarkMetricsSchema>) => number,
    digits: number,
  ) => {
    lines.push(`## ${title}`, '', note, '');
    lines.push(
      ...mdTable(
        ['Workload (M × K × N)', 'MACs', ...names],
        workloads.map((w) => [
          workloadShape(w.dims),
          num(w.dims.m * w.dims.n * w.dims.k, 0),
          ...result.variants.map((v) => {
            if (v.benchmark === null) return '-';
            const row = v.benchmark.rows.find((r) => r.workload === w.name);
            if (row === undefined) return '-';
            if (row.status === 'unsupported') return 'not supported';
            const baseRow = base?.benchmark?.rows.find((r) => r.workload === w.name);
            const baseValue = baseRow?.status === 'passed' ? pick(baseRow.metrics) : undefined;
            const value = pick(row.metrics);
            return `${num(value, digits)}${delta(value, baseValue, digits, v === base)}`;
          }),
        ]),
      ),
      '',
    );
  };
  metric(
    'Total cycles',
    'Transfer in + start + busy + transfer out, in RTL clock edges.',
    (m) => m.total,
    0,
  );
  metric('Compute cycles', 'PREPARE_TILE, COMPUTE and DRAIN of every tile.', (m) => m.compute, 0);
  metric('PE utilization', 'MACs / (ROWS · COLS · compute cycles).', (m) => m.utilization, 3);
  metric(
    'MACs per cycle (total)',
    'MACs / total cycles; ops per cycle are twice this.',
    (m) => m.macsPerCycleTotal,
    3,
  );

  // Synthesis: metrics down, variants across.
  const synthRow = (label: string, pick: (s: NonNullable<VariantResult['synth']>) => number) => [
    label,
    ...result.variants.map((v) =>
      v.synth === null
        ? '-'
        : `${num(pick(v.synth), 0)}${delta(pick(v.synth), base?.synth === null || base?.synth === undefined ? undefined : pick(base.synth), 0, v === base)}`,
    ),
  ];
  lines.push(
    '## Synthesis (generic Yosys flow)',
    '',
    "matmul_top at the variant's parameters, Yosys internal cells with no technology library (inferred memories kept as `$mem_v2`): cells, not transistors. Logic depth is the gates on the longest path of the flattened netlist, not a delay.",
    '',
    ...mdTable(
      ['Metric', ...names],
      [
        synthRow('Generic cells', (s) => s.cells),
        synthRow('Flip-flops', (s) => s.flipFlops),
        synthRow('`$mul` cells', (s) => s.mulCells),
        synthRow('Memory bits', (s) => s.memoryBits),
        synthRow('Memory banks', (s) => s.memoryBanks),
        synthRow('Abstract gates', (s) => s.abstractGates),
        synthRow('Logic depth', (s) => s.logicDepth),
      ],
    ),
    '',
  );
  const families = [
    ...new Set(result.variants.flatMap((v) => v.synth?.fpga.map((f) => f.family) ?? [])),
  ];
  if (families.length > 0) {
    const fpgaOf = (v: VariantResult | undefined, family: string) =>
      v?.synth?.fpga.find((f) => f.family === family);
    const fpgaRow = (
      family: string,
      label: string,
      pick: (f: FpgaSummary) => number | null,
      digits: number,
    ) => [
      `${family} ${label}`,
      ...result.variants.map((v) => {
        const f = fpgaOf(v, family);
        const value = f === undefined ? null : pick(f);
        if (value === null) return '-';
        const b = fpgaOf(base, family);
        return `${num(value, digits)}${delta(value, b === undefined ? undefined : pick(b), digits, v === base)}`;
      }),
    ];
    const rows: string[][] = [];
    for (const family of families) {
      rows.push([
        `${family} device`,
        ...result.variants.map((v) => fpgaOf(v, family)?.device ?? '-'),
      ]);
      rows.push([
        `${family} fits`,
        ...result.variants.map((v) => {
          const f = fpgaOf(v, family);
          if (f === undefined) return '-';
          if (f.status === 'absent') return `not run: ${f.reason ?? ''}`;
          return f.status === 'fits' ? 'yes' : `no (over ${f.overUtilised.join(', ')})`;
        }),
      ]);
      rows.push(fpgaRow(family, 'LUTs', (f) => f.luts, 0));
      rows.push(fpgaRow(family, 'flip-flops', (f) => f.flipFlops, 0));
      rows.push(fpgaRow(family, 'block RAM', (f) => f.blockRam, 0));
      rows.push(fpgaRow(family, 'DSP', (f) => f.dsp, 0));
      rows.push(fpgaRow(family, 'Fmax estimate (MHz)', (f) => f.fmaxMHz, 2));
    }
    lines.push(
      '## FPGA flows',
      '',
      "The FPGA wrapper at the variant's parameters, mapped by Yosys and placed and routed by nextpnr with the settings of `make synth`. LUTs, flip-flops, block RAM and DSP are what Yosys mapped the design to. Fmax is nextpnr's timing estimate for the named device, only for a design that fits: an estimate, not a measurement.",
      '',
      ...mdTable(['Metric', ...names], rows),
      '',
    );
  }

  const optimal = result.pareto.points.filter((x) => x.optimal).map((x) => x.variant);
  lines.push(
    '## Pareto-optimal variants',
    '',
    `Axes: (1) ${result.pareto.axes[0]} and (2) ${result.pareto.axes[1]}; lower is better on both. ${result.pareto.rule}`,
    '',
    result.pareto.points.length === 0
      ? 'No variant passed every stage, so there is no frontier.'
      : `Common workloads (${String(result.pareto.commonWorkloads.length)}): ${result.pareto.commonWorkloads.map((w) => `\`${w}\``).join(', ')}. Pareto-optimal: **${optimal.join(', ')}**.`,
    '',
    '## Variants',
    '',
  );
  for (const v of result.variants) {
    lines.push(
      `- **${v.name}** (\`${v.hash}\`): ${v.description === '' ? '(no description)' : v.description} \`${params(v)}\`. Stages: ${STAGES.map((s) => `${s} ${v.stages[s].status}`).join(', ')}.${v.reason === null ? '' : ` ${v.reason}`}`,
      ...v.warnings.map((w) => `  - ${w}`),
    );
  }
  lines.push(
    '',
    '## Provenance',
    '',
    `Created ${p.createdAt}, commit \`${p.gitCommit ?? 'unknown'}\`${p.gitDirty === true ? ' (dirty working tree)' : ''}. Toolchain: ${p.toolchain ?? 'unknown (no build/tool-versions.json)'}. Tools: ${
      p.tools === null
        ? 'unknown'
        : sorted(p.tools)
            .map(([name, version]) => `${name} ${version ?? 'missing'}`)
            .join('; ')
    }.`,
    '',
    `${p.host.label} This run, on ${p.host.platform}/${p.host.arch} (${p.host.runtime}, ${String(p.host.jobs)} jobs), in seconds per stage: ${Object.entries(
      p.host.stageSeconds,
    )
      .filter(([, stages]) => Object.keys(stages).length > 0)
      .map(
        ([name, stages]) =>
          `${name} ${Object.entries(stages)
            .map(([stage, s]) => `${stage} ${s.toFixed(1)}`)
            .join(', ')}`,
      )
      .join('; ')}.`,
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The run

/** Reads and validates experiment.json; throws naming every problem. */
export function readExperimentSpec(file: string): ExperimentSpec {
  const parsed = ExperimentSpecSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(
      `${repoPath(file)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const spec = parsed.data;
  const names = spec.variants.map((v) => v.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate !== undefined)
    throw new Error(`${repoPath(file)}: variant ${duplicate} appears twice`);
  if (spec.baseline !== undefined && !names.includes(spec.baseline)) {
    throw new Error(
      `${repoPath(file)}: baseline ${spec.baseline} is not one of the variants (${names.join(', ')})`,
    );
  }
  const workloads = (spec.workloads ?? []).map(
    (w) => `${String(w.m)}x${String(w.k)}x${String(w.n)}`,
  );
  const twice = workloads.find((n, i) => workloads.indexOf(n) !== i);
  if (twice !== undefined) throw new Error(`${repoPath(file)}: workload ${twice} appears twice`);
  return spec;
}

/**
 * Runs an experiment and writes its comparison. Exit code 0 when no variant failed a stage (a
 * stage skipped for a missing tool is reported, not failed), 1 when one failed (the comparison
 * still names it), 2 when the experiment could not start.
 */
export async function runExperiment(
  options: ExperimentOptions,
  write: (text: string) => void,
): Promise<number> {
  let spec: ExperimentSpec;
  try {
    spec = readExperimentSpec(options.spec);
  } catch (error) {
    write(`experiment: ${(error as Error).message}\n`);
    return 2;
  }
  const provenance = readProvenance();
  if (provenance.git.dirty !== false && !options.allowDirty) {
    write(
      `experiment: refusing to run from ${provenance.git.dirty === null ? 'outside a git checkout' : 'a dirty working tree'}; commit first (or ALLOW_DIRTY=1, and do not commit the result)\n`,
    );
    return 2;
  }
  const now = new Date();
  const createdAt = now.toISOString();
  const shortSha = provenance.git.commit?.slice(0, 7) ?? null;
  const runId = `${createdAt.slice(0, 10)}-${shortSha ?? 'nogit'}`;
  const baseline = spec.baseline ?? spec.variants[0]?.name ?? '';
  const workloads =
    spec.workloads?.map((w) => workload(w.m, w.k, w.n, w.what)) ?? BENCHMARK_WORKLOADS;
  write(
    `experiment ${spec.id}: ${String(spec.variants.length)} variants, ${String(workloads.length)} workloads (revision ${provenance.revision}, commit ${shortSha ?? '?'}${provenance.git.dirty === true ? ', dirty' : ''})\n`,
  );

  const context: VariantContext = { spec, workloads, options, provenance, now, write };
  const variants: VariantResult[] = [];
  const stageSeconds: Record<string, Record<string, number>> = {};
  for (const variant of spec.variants) {
    const seconds: Record<string, number> = {};
    variants.push(await runVariant(variant, context, seconds));
    stageSeconds[variant.name] = seconds;
  }

  const cpu = cpus()[0];
  const result = ExperimentResultSchema.parse({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    kind: EXPERIMENT_KIND,
    experimentId: `${spec.id}/${runId}`,
    experiment: spec.id,
    runId,
    description: spec.description,
    revision: provenance.revision,
    labels: {
      mac: BENCHMARK_LABELS.mac,
      cycles: BENCHMARK_LABELS.cycles,
      utilization: BENCHMARK_LABELS.utilization,
      synthesis:
        "Synthesis: generic cells are Yosys internal cells, FPGA counts are what Yosys mapped the design to, and Fmax is nextpnr's estimate for a named device, all with the identical settings of `make synth` (docs/hardware/accelerators/synthesis-guide.md).",
      power: POWER,
    },
    config: {
      verify: { seed: spec.verify.seed, count: spec.verify.count },
      benchmark: {
        seed: spec.benchmark.seed,
        workloads: workloads.map((w) => ({ name: w.name, dims: w.dims, what: w.what })),
      },
      baseline,
    },
    passed: variants.every((v) => v.status !== 'failed'),
    variants,
    pareto: paretoSection(variants),
    provenance: {
      createdAt,
      gitCommit: provenance.git.commit,
      gitShortCommit: shortSha,
      gitDirty: provenance.git.dirty,
      toolchain: provenance.toolchain,
      tools: provenance.tools,
      host: {
        label: BENCHMARK_LABELS.host,
        runtime: `node ${process.versions.node}`,
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpu?.model.trim() ?? 'unknown',
        jobs: Math.max(1, options.jobs),
        stageSeconds,
      },
    },
  } satisfies ExperimentResult);

  mkdirSync(options.out, { recursive: true });
  const base = join(options.out, runId);
  writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderExperimentMarkdown(result));
  write(`wrote ${repoPath(base)}.json and ${repoPath(base)}.md\n`);
  const optimal = result.pareto.points.filter((p) => p.optimal).map((p) => p.variant);
  if (optimal.length > 0)
    write(`Pareto-optimal on (total cycles, generic cells): ${optimal.join(', ')}\n`);
  const failed = variants.filter((v) => v.status === 'failed');
  if (failed.length > 0) {
    write(
      `experiment ${spec.id}: FAIL, ${failed.map((v) => `${v.name} at ${v.failedStage ?? '?'}`).join(', ')}\n`,
    );
    return 1;
  }
  const incomplete = variants.filter((v) => v.status === 'incomplete');
  write(
    incomplete.length > 0
      ? `experiment ${spec.id}: PASS with skipped stages (${incomplete.map((v) => v.name).join(', ')}): install the missing tools to complete it\n`
      : `experiment ${spec.id}: PASS, every variant verified, benchmarked and synthesised\n`,
  );
  return 0;
}
