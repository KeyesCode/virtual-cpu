import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISA_VERSION } from '@vcpu/shared';
import { z } from 'zod';
import { defaultVerifyOptions, runVerify, VERIFY_DEFAULTS } from '../commands/verify.js';
import { CORPORA, HW_DIR, REPO } from '../verify/corpora.js';
import {
  BENCHMARK_DEFAULTS,
  gitState,
  readRevision,
  readSynthesis,
  readToolVersions,
  repoPath,
  runBenchmark,
  writeJsonAndMarkdown,
} from './benchmark.js';
import {
  fixed,
  type RtlBenchmarkReport,
  renderBenchmarkMarkdown,
  type Synthesis,
  suiteTotals,
  timeEstimates,
} from './report.js';
import {
  buildRunner,
  contentHash,
  coreSources,
  synthMakeArgs,
  type Variant,
  variantDir,
  variantHash,
  VariantSchema,
} from './variant.js';

/**
 * A microarchitecture experiment: `research/cpu/experiments/<name>/experiment.json` lists design
 * variants, and each one is verified (it must pass), benchmarked and synthesised, in that order.
 * The comparison goes to `<name>/results/<date>-<shortsha>.{json,md}`; the full per-variant
 * reports and logs stay in build/experiments/<name>/. research/cpu/experiments/README.md
 * documents the format.
 */

export const EXPERIMENTS_DIR = join(REPO, 'research', 'cpu', 'experiments');
export const EXPERIMENT_SCHEMA_VERSION = 1;
export const EXPERIMENT_RESULT_KIND = 'vcpu8-experiment';

export const ExperimentSpecSchema = z.strictObject({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  description: z.string().min(1),
  /** The differential verification each variant must pass first. */
  verify: z
    .strictObject({
      seed: z.number().int().min(0).default(VERIFY_DEFAULTS.seed),
      count: z.number().int().min(0).default(VERIFY_DEFAULTS.count),
    })
    .default({ seed: VERIFY_DEFAULTS.seed, count: VERIFY_DEFAULTS.count }),
  /** The variant the others are compared with; the first one when omitted. */
  baseline: z.string().optional(),
  variants: z.array(VariantSchema).min(1),
});
export type ExperimentSpec = z.output<typeof ExperimentSpecSchema>;

const Stage = z.enum(['build', 'verify', 'benchmark', 'synth']);

const VariantResultSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  hash: z.string(),
  defines: z.record(z.string(), z.union([z.literal(true), z.number(), z.string()])),
  parameters: z.record(z.string(), z.number()),
  status: z.enum(['passed', 'failed']),
  failedStage: Stage.nullable(),
  reason: z.string().nullable(),
  verify: z
    .strictObject({
      passed: z.boolean(),
      cases: z.number().int(),
      failedCases: z.number().int(),
      coverageGaps: z.array(z.string()),
      firstFailures: z.array(z.string()),
    })
    .nullable(),
  /** Null unless the variant passed verify and the benchmark's correctness gate. */
  benchmark: z
    .strictObject({
      cycles: z.number().int(),
      instructions: z.number().int(),
      cpi: z.number().nullable(),
      /** The program that retires the most DIV instructions, if any does. */
      divHeavy: z
        .strictObject({
          program: z.string(),
          divInstructions: z.number().int(),
          cycles: z.number().int(),
        })
        .nullable(),
      programs: z.array(
        z.strictObject({
          name: z.string(),
          cycles: z.number().int(),
          instructions: z.number().int(),
          cpi: z.number().nullable(),
        }),
      ),
    })
    .nullable(),
  /** Null unless every stage passed. */
  synth: z
    .strictObject({
      cells: z.number().int(),
      flipFlops: z.number().int(),
      fpga: z.array(
        z.strictObject({
          family: z.string(),
          device: z.string(),
          luts: z.number().int(),
          flipFlops: z.number().int(),
          fmaxMHz: z.number(),
          /** The suite's RTL cycles / this Fmax. */
          suiteMicroseconds: z.number(),
        }),
      ),
    })
    .nullable(),
  /** The full reports, in the git-ignored build/ tree. */
  reports: z.strictObject({ benchmark: z.string().nullable(), synth: z.string().nullable() }),
  cached: z.strictObject({ runner: z.boolean(), synth: z.boolean() }),
});
export type VariantResult = z.output<typeof VariantResultSchema>;

export const ExperimentResultSchema = z.strictObject({
  schemaVersion: z.literal(EXPERIMENT_SCHEMA_VERSION),
  kind: z.literal(EXPERIMENT_RESULT_KIND),
  experiment: z.string(),
  description: z.string(),
  createdAt: z.iso.datetime(),
  revision: z.string(),
  isaVersion: z.string(),
  git: z.strictObject({
    sha: z.string().nullable(),
    shortSha: z.string().nullable(),
    dirty: z.boolean().nullable(),
  }),
  toolchain: z.string().nullable(),
  tools: z.record(z.string(), z.string().nullable()).nullable(),
  config: z.strictObject({
    verify: z.strictObject({
      corpora: z.array(z.string()),
      seed: z.number().int(),
      count: z.number().int(),
    }),
    benchmark: z.strictObject({ programDir: z.string(), programs: z.number().int() }),
    baseline: z.string(),
  }),
  passed: z.boolean(),
  variants: z.array(VariantResultSchema),
});
export type ExperimentResult = z.output<typeof ExperimentResultSchema>;

export interface ExperimentOptions {
  /** The experiment's directory under research/cpu/experiments/ (or an absolute path). */
  readonly dir: string;
  readonly verilator: string;
  readonly make: string;
}

/** Everything `make synth` reads, so an unchanged variant reuses its synthesis. */
function synthInputs(): string[] {
  const synth = join(HW_DIR, 'synth');
  const fpga = join(REPO, 'hardware', 'fpga');
  return [
    ...coreSources(),
    join(fpga, 'vcpu8_fpga_wrapper.sv'),
    join(fpga, 'vcpu8_up5k_sg48.pcf'),
    join(synth, 'generic.ys'),
    join(synth, 'ice40.ys'),
    join(synth, 'ecp5.ys'),
    join(synth, 'warnings.allow'),
    join(HW_DIR, 'tb', 'programs', 'wave-demo.asm'),
    join(HW_DIR, 'mk', 'synth.mk'),
  ].filter((file) => existsSync(file));
}

/**
 * This process's environment without the variables of the `pnpm --filter … cli` run that
 * started it. make synth calls `pnpm --filter @vcpu/rtl-tools cli assemble` itself, and a pnpm
 * that inherits the outer run's `npm_config_*` settings finds no `cli` script and fails (silently,
 * under the outer `--silent`).
 */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(npm_|pnpm_)/i.test(key) && key !== 'INIT_CWD' && key !== 'PNPM_SCRIPT_SRC_DIR',
    ),
  );
}

/** `make synth` for one variant into build/variants/<hash>/synth/, reused when nothing changed. */
function synthesise(
  variant: Variant,
  options: ExperimentOptions,
  toolchain: string | null,
): { ok: true; summary: string; cached: boolean } | { ok: false; error: string } {
  const dir = join(variantDir(variant), 'synth');
  const summary = join(dir, 'summary.json');
  const stamp = join(variantDir(variant), 'synth.inputs.sha256');
  const key = contentHash(synthInputs(), [variantHash(variant), toolchain ?? 'unknown']);
  if (existsSync(summary) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === key) {
    return { ok: true, summary, cached: true };
  }
  const run = spawnSync(
    options.make,
    ['-C', HW_DIR, '--no-print-directory', 'synth', `SYNTH_DIR=${dir}`, ...synthMakeArgs(variant)],
    { encoding: 'utf8', maxBuffer: 256 << 20, env: cleanEnv() },
  );
  const log = join(variantDir(variant), 'synth.log');
  writeFileSync(log, `${run.stdout}${run.stderr}`);
  if (run.error !== undefined || run.status !== 0 || !existsSync(summary)) {
    return {
      ok: false,
      error: `make synth failed (${run.error?.message ?? `exit ${String(run.status)}`}); see ${repoPath(log)}`,
    };
  }
  writeFileSync(stamp, `${key}\n`);
  return { ok: true, summary, cached: false };
}

/** The report with its synthesis section and time estimates replaced. */
export function withSynthesis(
  report: RtlBenchmarkReport,
  synthesis: Synthesis,
): RtlBenchmarkReport {
  return {
    ...report,
    synthesis,
    programs: report.programs.map((p) =>
      p.status === 'ok' ? { ...p, estimatedTime: timeEstimates(synthesis, p.rtl.cycles) } : p,
    ),
  };
}

function benchmarkSummary(report: RtlBenchmarkReport): NonNullable<VariantResult['benchmark']> {
  const totals = suiteTotals(report.programs);
  if (totals === null) throw new Error('benchmarkSummary needs a report that passed its gate');
  let divHeavy: NonNullable<VariantResult['benchmark']>['divHeavy'] = null;
  for (const p of report.programs) {
    if (p.status !== 'ok') continue;
    const div = p.rtl.byOpcode.DIV?.instructions ?? 0;
    if (div > 0 && (divHeavy === null || div > divHeavy.divInstructions)) {
      divHeavy = { program: p.name, divInstructions: div, cycles: p.rtl.cycles };
    }
  }
  return {
    cycles: totals.cycles,
    instructions: totals.instructions,
    cpi: totals.cpi,
    divHeavy,
    programs: report.programs.flatMap((p) =>
      p.status === 'ok'
        ? [
            {
              name: p.name,
              cycles: p.rtl.cycles,
              instructions: p.rtl.instructions,
              cpi: p.rtl.cpi,
            },
          ]
        : [],
    ),
  };
}

function synthSummary(
  synthesis: Synthesis,
  cycles: number,
): NonNullable<VariantResult['synth']> | null {
  if (!synthesis.available) return null;
  return {
    cells: synthesis.generic.cells,
    flipFlops: synthesis.generic.flipFlops,
    fpga: synthesis.fpga.flatMap((f) =>
      f.status === 'ran'
        ? [
            {
              family: f.family,
              device: f.device,
              luts: f.luts,
              flipFlops: f.flipFlops,
              fmaxMHz: f.fmaxMHz,
              suiteMicroseconds: cycles / f.fmaxMHz,
            },
          ]
        : [],
    ),
  };
}

async function runVariant(
  experiment: string,
  spec: ExperimentSpec,
  variant: Variant,
  options: ExperimentOptions,
  toolchain: string | null,
  write: (text: string) => void,
): Promise<VariantResult> {
  const work = join(HW_DIR, 'build', 'experiments', experiment, variant.name);
  mkdirSync(work, { recursive: true });
  const result: VariantResult = {
    name: variant.name,
    description: variant.description,
    hash: variantHash(variant),
    defines: variant.defines,
    parameters: variant.parameters,
    status: 'failed',
    failedStage: null,
    reason: null,
    verify: null,
    benchmark: null,
    synth: null,
    reports: { benchmark: null, synth: null },
    cached: { runner: false, synth: false },
  };
  const fail = (stage: z.output<typeof Stage>, reason: string): VariantResult => {
    write(`  ${variant.name}: FAILED at ${stage}: ${reason}\n`);
    return { ...result, failedStage: stage, reason };
  };

  write(`  ${variant.name} (${result.hash}): build the runner\n`);
  const runner = buildRunner(variant, options.verilator);
  if (!runner.ok) return fail('build', runner.error);
  result.cached.runner = runner.cached;

  write(
    `  ${variant.name}: verify (all corpora, ${String(spec.verify.count)} random from seed ${String(spec.verify.seed)})\n`,
  );
  let verifyLog = '';
  const verify = await runVerify(
    {
      ...defaultVerifyOptions(),
      corpora: CORPORA,
      requireCoverage: true,
      seed: spec.verify.seed,
      count: spec.verify.count,
      sim: runner.sim,
      work: join(work, 'verify', 'work'),
      failures: join(work, 'verify', 'failures'),
      reports: join(work, 'verify', 'reports'),
    },
    (text) => {
      verifyLog += text;
    },
  );
  writeFileSync(join(work, 'verify.log'), verifyLog);
  const cases = verify.summaries.reduce((sum, s) => sum + s.cases, 0);
  result.verify = {
    passed: verify.exitCode === 0,
    cases,
    failedCases: verify.failures.length,
    coverageGaps: [...verify.gaps],
    firstFailures: verify.failures.slice(0, 5).map((f) => f.name),
  };
  if (verify.exitCode !== 0) {
    return fail(
      'verify',
      `${String(verify.failures.length)}/${String(cases)} cases differ${verify.gaps.length > 0 ? `; coverage gaps: ${verify.gaps.join('; ')}` : ''}; see ${repoPath(join(work, 'verify.log'))}`,
    );
  }
  write(`  ${variant.name}: verify passed, ${String(cases)} cases\n`);

  write(`  ${variant.name}: benchmark\n`);
  let benchLog = '';
  const out = join(work, 'benchmark.json');
  const bench = await runBenchmark(
    {
      ...BENCHMARK_DEFAULTS,
      sim: runner.sim,
      variant,
      synth: null,
      work: join(work, 'benchmark'),
      out,
    },
    (text) => {
      benchLog += text;
    },
  );
  writeFileSync(join(work, 'benchmark.log'), benchLog);
  if (bench.report === null || bench.exitCode !== 0) {
    return fail(
      'benchmark',
      `the benchmark exited ${String(bench.exitCode)}; see ${repoPath(join(work, 'benchmark.log'))}`,
    );
  }
  result.reports.benchmark = repoPath(out);

  write(`  ${variant.name}: synth\n`);
  const synth = synthesise(variant, options, toolchain);
  if (!synth.ok) return fail('synth', synth.error);
  result.cached.synth = synth.cached;
  result.reports.synth = repoPath(synth.summary);
  const synthesis = readSynthesis(synth.summary);
  if (!synthesis.available) return fail('synth', synthesis.reason);

  const report = withSynthesis(bench.report, synthesis);
  writeJsonAndMarkdown(out.replace(/\.json$/, ''), report, renderBenchmarkMarkdown(report));
  const benchmark = benchmarkSummary(report);
  write(
    `  ${variant.name}: passed: ${String(benchmark.cycles)} cycles, CPI ${fixed(benchmark.cpi)}, ${String(synthesis.generic.cells)} cells\n`,
  );
  return {
    ...result,
    status: 'passed',
    benchmark,
    synth: synthSummary(synthesis, benchmark.cycles),
  };
}

const delta = (value: number, base: number | undefined, digits = 0): string => {
  if (base === undefined || value === base) return '';
  const d = value - base;
  return ` (${d > 0 ? '+' : ''}${digits === 0 ? String(d) : d.toFixed(digits)})`;
};

/** The comparison as Markdown: one row per variant, deltas against the baseline variant. */
export function renderExperimentMarkdown(result: ExperimentResult): string {
  const base = result.variants.find((v) => v.name === result.config.baseline);
  const families = [
    ...new Set(result.variants.flatMap((v) => v.synth?.fpga.map((f) => f.family) ?? [])),
  ];
  const lines = [
    `# Experiment: ${result.experiment}`,
    '',
    result.description,
    '',
    `Revision \`${result.revision}\`, ISA ${result.isaVersion}, commit \`${result.git.sha ?? 'unknown'}\`${result.git.dirty === true ? ' (dirty working tree)' : ''}, ${result.createdAt}. Toolchain: ${result.toolchain ?? 'unknown'}.`,
    '',
    `Each variant ran \`verify\` (${result.config.verify.corpora.join(', ')}; ${String(result.config.verify.count)} random programs from seed ${String(result.config.verify.seed)}), then the benchmark (${String(result.config.benchmark.programs)} programs in \`${result.config.benchmark.programDir}\`), then \`make synth\`. A variant that fails a stage gets no metrics. Deltas are against \`${result.config.baseline}\`. Cycles are RTL clock edges; Fmax is nextpnr's estimate for the named device; cells are generic Yosys cells, not transistors.`,
    '',
    `| Variant | Result | Verify cases | Cycles | CPI | DIV-heavy program cycles | Cells | FFs |${families.map((f) => ` ${f} LUTs | ${f} Fmax (MHz) |`).join('')}`,
    `| ------- | ------ | -----------: | -----: | --: | -----------------------: | ----: | --: |${families.map(() => ' ---: | ---: |').join('')}`,
  ];
  for (const v of result.variants) {
    if (v.status === 'failed' || v.benchmark === null || v.synth === null) {
      lines.push(
        `| ${v.name} | FAILED at ${v.failedStage ?? '?'}: ${v.reason ?? ''} | ${v.verify === null ? '-' : String(v.verify.cases)} | | | | | |${families.map(() => ' | |').join('')}`,
      );
      continue;
    }
    const b = v.benchmark;
    const s = v.synth;
    const isBase = v === base;
    const div =
      b.divHeavy === null
        ? '-'
        : `${String(b.divHeavy.cycles)}${isBase ? '' : delta(b.divHeavy.cycles, base?.benchmark?.divHeavy?.cycles)} (${b.divHeavy.program})`;
    const fpga = families.map((family) => {
      const f = s.fpga.find((x) => x.family === family);
      const bf = base?.synth?.fpga.find((x) => x.family === family);
      return f === undefined
        ? ' - | - |'
        : ` ${String(f.luts)}${isBase ? '' : delta(f.luts, bf?.luts)} | ${fixed(f.fmaxMHz, 2)}${isBase ? '' : delta(f.fmaxMHz, bf?.fmaxMHz, 2)} |`;
    });
    lines.push(
      `| ${v.name} | passed | ${String(v.verify?.cases ?? 0)} | ${String(b.cycles)}${isBase ? '' : delta(b.cycles, base?.benchmark?.cycles)} | ${fixed(b.cpi)} | ${div} | ${String(s.cells)}${isBase ? '' : delta(s.cells, base?.synth?.cells)} | ${String(s.flipFlops)}${isBase ? '' : delta(s.flipFlops, base?.synth?.flipFlops)} |${fpga.join('')}`,
    );
  }
  lines.push('');
  const passed = result.variants.filter((v) => v.benchmark !== null);
  if (passed.length > 0) {
    lines.push(
      '## Cycles per program',
      '',
      `| Program |${passed.map((v) => ` ${v.name} |`).join('')}`,
      `| ------- |${passed.map(() => ' ---: |').join('')}`,
    );
    const names = passed[0]?.benchmark?.programs.map((p) => p.name) ?? [];
    for (const name of names) {
      lines.push(
        `| ${name} |${passed
          .map((v) => {
            const cycles = v.benchmark?.programs.find((p) => p.name === name)?.cycles;
            return ` ${cycles === undefined ? '-' : String(cycles)} |`;
          })
          .join('')}`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Variants',
    '',
    ...result.variants.map(
      (v) =>
        `- **${v.name}** (\`${v.hash}\`): ${v.description === '' ? '(no description)' : v.description} Defines: ${JSON.stringify(v.defines)}; parameters: ${JSON.stringify(v.parameters)}.`,
    ),
    '',
  );
  return lines.join('\n');
}

/**
 * Runs an experiment and writes its comparison. Exit code 0 when every variant passed every
 * stage, 1 when one failed (the comparison still names it), 2 for an unreadable experiment.
 */
export async function runExperiment(
  options: ExperimentOptions,
  write: (text: string) => void,
): Promise<number> {
  const dir = options.dir.includes('/') ? options.dir : join(EXPERIMENTS_DIR, options.dir);
  const name = dir.replace(/\/+$/, '').split('/').at(-1) ?? 'experiment';
  const file = join(dir, 'experiment.json');
  if (!existsSync(file)) {
    write(`experiment: no ${repoPath(file)}; see research/cpu/experiments/README.md\n`);
    return 2;
  }
  const parsed = ExperimentSpecSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    write(
      `experiment: ${repoPath(file)}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n`,
    );
    return 2;
  }
  const spec = parsed.data;
  const names = spec.variants.map((v) => v.name);
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate !== undefined) {
    write(`experiment: variant ${duplicate} appears twice in ${repoPath(file)}\n`);
    return 2;
  }
  const baseline = spec.baseline ?? names[0] ?? 'default';
  if (!names.includes(baseline)) {
    write(`experiment: baseline ${baseline} is not one of the variants (${names.join(', ')})\n`);
    return 2;
  }

  const createdAt = new Date().toISOString();
  const git = gitState();
  const revision = readRevision(BENCHMARK_DEFAULTS.revision);
  const { toolchain, tools } = readToolVersions(BENCHMARK_DEFAULTS.toolVersions);
  write(
    `experiment ${name}: ${String(spec.variants.length)} variants (revision ${revision}, commit ${git.shortSha ?? '?'}${git.dirty === true ? ', dirty' : ''})\n`,
  );
  const variants: VariantResult[] = [];
  for (const variant of spec.variants) {
    variants.push(await runVariant(name, spec, variant, options, toolchain, write));
  }
  const programs = variants.find((v) => v.benchmark !== null)?.benchmark?.programs.length ?? 0;
  const result = ExperimentResultSchema.parse({
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    kind: EXPERIMENT_RESULT_KIND,
    experiment: name,
    description: spec.description,
    createdAt,
    revision,
    isaVersion: ISA_VERSION,
    git,
    toolchain,
    tools,
    config: {
      verify: { corpora: [...CORPORA], seed: spec.verify.seed, count: spec.verify.count },
      benchmark: { programDir: repoPath(BENCHMARK_DEFAULTS.examples), programs },
      baseline,
    },
    passed: variants.every((v) => v.status === 'passed'),
    variants,
  } satisfies ExperimentResult);

  const base = join(dir, 'results', `${createdAt.slice(0, 10)}-${git.shortSha ?? 'nogit'}`);
  writeJsonAndMarkdown(base, result, renderExperimentMarkdown(result));
  write(`wrote ${repoPath(base)}.json and ${repoPath(base)}.md\n`);
  const failed = variants.filter((v) => v.status === 'failed');
  if (failed.length > 0) {
    write(
      `experiment ${name}: FAIL, ${failed.map((v) => `${v.name} at ${v.failedStage ?? '?'}`).join(', ')}\n`,
    );
    return 1;
  }
  write(`experiment ${name}: PASS, every variant verified, benchmarked and synthesised\n`);
  return 0;
}
