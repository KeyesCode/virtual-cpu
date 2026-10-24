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
