import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { createCpu } from '@vcpu/cpu-core';
import { CpuStatus, formatMemoryHex, ISA_VERSION } from '@vcpu/shared';
import { describeMismatch } from '../commands/verify.js';
import { compareEnd, compareTrace } from '../verify/compare.js';
import { CORPUS_DIRS, exampleCases, HW_DIR, REPO, type VerifyCase } from '../verify/corpora.js';
import { runReference } from '../verify/reference.js';
import { runRtl } from '../verify/rtl.js';
import { rtlMetrics } from './metrics.js';
import {
  fixed,
  LABELS,
  type ProgramResult,
  RTL_BENCHMARK_KIND,
  RTL_BENCHMARK_SCHEMA_VERSION,
  type RtlBenchmarkReport,
  RtlBenchmarkReportSchema,
  renderBenchmarkMarkdown,
  suiteTotals,
  type Synthesis,
  synthesisFromSummary,
  timeEstimates,
  ToolVersionsSchema,
} from './report.js';
import { type Variant, variantHash } from './variant.js';

const BUILD = join(HW_DIR, 'build');

/** Where `benchmark` reads and writes unless told otherwise; mk/benchmark.mk uses the same. */
export const BENCHMARK_DEFAULTS = {
  sim: join(BUILD, 'sim', 'vcpu8_sim'),
  examples: CORPUS_DIRS.examples,
  synth: join(REPO, 'research', 'cpu', 'synth', 'baseline.json'),
  toolVersions: join(BUILD, 'tool-versions.json'),
  revision: join(HW_DIR, 'REVISION'),
  work: join(BUILD, 'benchmark'),
  out: join(BUILD, 'reports', 'benchmark.json'),
} as const;

export interface BenchmarkOptions {
  readonly sim: string;
  readonly variant: Variant;
  /** The program set: every `*.asm` here with its `.expect.json`, the `@vcpu/benchmarks` suite. */
  readonly examples: string;
  /** A synthesis summary for the cell counts and Fmax; null for none. */
  readonly synth: string | null;
  readonly toolVersions: string;
  readonly revision: string;
  readonly work: string;
  /** The JSON report; the Markdown goes beside it. */
  readonly out: string;
  /** Also write `<date>-<shortsha>-<variant>.{json,md}` here (make benchmark-baseline). */
  readonly publish?: string | undefined;
}

/** A path relative to the repository root when it is inside it. */
export function repoPath(path: string): string {
  const rel = relative(REPO, path);
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel;
}

export function git(args: readonly string[]): string | null {
  const run = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

export function gitState(): RtlBenchmarkReport['provenance']['git'] {
  const sha = git(['rev-parse', 'HEAD']);
  const status = sha === null ? null : git(['status', '--porcelain']);
  return {
    sha,
    shortSha: sha === null ? null : sha.slice(0, 7),
    dirty: status === null ? null : status.length > 0,
  };
}

export function readRevision(path: string): string {
  const revision = readFileSync(path, 'utf8').trim();
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(revision)) {
    throw new Error(`${path} must hold one revision name, e.g. vcpu8-mc-r1; found "${revision}"`);
  }
  return revision;
}

/** Tool versions from `make tools-check`'s JSON, or null (with the reason) when it is absent. */
export function readToolVersions(path: string): {
  toolchain: string | null;
  tools: Record<string, string | null> | null;
} {
  if (!existsSync(path)) return { toolchain: null, tools: null };
  const parsed = ToolVersionsSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const tools: Record<string, string | null> = {};
  for (const [name, tool] of Object.entries(parsed.tools)) tools[name] = tool?.version ?? null;
  const { pinnedVersion, path: dir } = parsed.toolchain;
  return {
    toolchain:
      dir === null
        ? `tools from PATH (not the pinned OSS CAD Suite ${pinnedVersion})`
        : `OSS CAD Suite ${pinnedVersion}`,
    tools,
  };
}

export function readSynthesis(path: string | null): Synthesis {
  if (path === null) {
    return { available: false, source: null, reason: 'no synthesis summary was given' };
  }
  return synthesisFromSummary(repoPath(path), existsSync(path) ? readFileSync(path, 'utf8') : null);
}

interface Measured {
  readonly result: ProgramResult;
  readonly referenceMs: number;
  readonly rtlMs: number | null;
}

/**
 * One program: the live reference run and the emulator's own metrics, then the RTL run, then the
 * correctness gate (lock-step trace and end state, as `verify` compares them). Only a program
 * that matches and halts gets numbers. The RTL-side branch and data counts must also equal the
 * emulator's counters, so a wrong metric cannot pass silently.
 */
async function measure(
  c: VerifyCase,
  sim: string,
  slot: string,
  synthesis: Synthesis,
): Promise<Measured> {
  const name = c.name.replace(/^examples\//, '');
  const common = { name, source: c.origin, maxSteps: c.maxSteps };
  const fail = (reason: string, mismatches: readonly string[] = []): ProgramResult => ({
    ...common,
    status: 'failed',
    reason,
    mismatches: [...mismatches],
  });

  const referenceStart = performance.now();
  const ref = runReference(c.image, c.maxSteps);
  const emulator = createCpu({ traceCapacity: 0 });
  emulator.loadProgram(c.image);
  emulator.run({ maxInstructions: c.maxSteps });
  const model = emulator.getMetrics();
  const referenceMs = performance.now() - referenceStart;

  const files = {
    image: `${slot}.mem.hex`,
    state: `${slot}.state.json`,
    trace: `${slot}.trace.jsonl`,
  };
  writeFileSync(files.image, formatMemoryHex([...c.image]));
  const rtlStart = performance.now();
  const rtl = await runRtl(sim, files, c.maxSteps);
  const rtlMs = performance.now() - rtlStart;
  if (!rtl.ok) {
    return { result: fail(rtl.error), referenceMs, rtlMs };
  }
  const mismatches = [...compareTrace(ref.trace, rtl.trace), ...compareEnd(ref.end, rtl.state)];
  if (mismatches.length > 0) {
    return {
      result: fail(
        `the RTL does not match @vcpu/cpu-core (${String(mismatches.length)} differences); replay with make verify`,
        mismatches.slice(0, 8).map((m) => describeMismatch(m)),
      ),
      referenceMs,
      rtlMs,
    };
  }
  if (rtl.state.status !== CpuStatus.HALTED) {
    const why =
      rtl.state.stopReason === 'faulted'
        ? `faulted (${rtl.state.fault?.code ?? '?'} at PC 0x${(rtl.state.fault?.pc ?? 0).toString(16).toUpperCase().padStart(2, '0')})`
        : `did not halt within ${String(c.maxSteps)} steps (${rtl.state.stopReason})`;
    return { result: fail(`the program ${why}; a benchmark must halt`), referenceMs, rtlMs };
  }

  const metrics = rtlMetrics(rtl.trace, rtl.state);
  const disagreements = (
    [
      ['instructions', metrics.instructions, model.instructions],
      ['branches taken', metrics.branches.taken, model.branchesTaken],
      ['branches not taken', metrics.branches.notTaken, model.branchesNotTaken],
      ['data reads', metrics.dataReads, model.memoryReads],
      ['data writes', metrics.dataWrites, model.memoryWrites],
      ['fetched bytes', metrics.fetchedBytes, model.fetchedBytes],
    ] as const
  ).filter(([, rtlValue, modelValue]) => rtlValue !== modelValue);
  if (disagreements.length > 0) {
    return {
      result: fail(
        'the metrics extracted from the RTL trace disagree with the emulator’s counters',
        disagreements.map(([what, r, m]) => `${what}: RTL ${String(r)}, emulator ${String(m)}`),
      ),
      referenceMs,
      rtlMs,
    };
  }
  return {
    result: {
      ...common,
      status: 'ok',
      rtl: metrics,
      instructionalModel: {
        estimatedCycles: model.estimatedCycles,
        estimatedCpi: model.instructions === 0 ? null : model.estimatedCycles / model.instructions,
      },
      estimatedTime: timeEstimates(synthesis, metrics.cycles),
    },
    referenceMs,
    rtlMs,
  };
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const format = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ');
  return [format(header), ...rows.map(format)].join('\n');
}

/** `2026-10-16-ab12cd3-default`: the published report's base name. */
export function publishedName(report: RtlBenchmarkReport): string {
  return `${report.provenance.createdAt.slice(0, 10)}-${report.provenance.git.shortSha ?? 'nogit'}-${report.variant.name}`;
}

export function writeJsonAndMarkdown(base: string, json: unknown, markdown: string): void {
  mkdirSync(dirname(base), { recursive: true });
  writeFileSync(`${base}.json`, `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(`${base}.md`, markdown);
}

export interface BenchmarkOutcome {
  readonly exitCode: number;
  readonly report: RtlBenchmarkReport | null;
}

/**
 * Runs the benchmark suite on the RTL runner, gates every program on the differential
 * comparison, and writes the JSON and Markdown report. Exit code 0 only when every program
 * passed the gate; 1 when any failed (it still gets a report, without numbers); 2 when the run
 * could not start.
 */
export async function runBenchmark(
  options: BenchmarkOptions,
  write: (text: string) => void,
): Promise<BenchmarkOutcome> {
  if (!existsSync(options.sim)) {
    write(`benchmark: no RTL runner at ${options.sim}; run 'make -C hardware/rtl/vcpu8 sim'\n`);
    return { exitCode: 2, report: null };
  }
  const pending = exampleCases(options.examples);
  if (pending.length === 0) {
    write(`benchmark: no programs in ${options.examples}\n`);
    return { exitCode: 2, report: null };
  }
  const revision = readRevision(options.revision);
  const synthesis = readSynthesis(options.synth);
  const { toolchain, tools } = readToolVersions(options.toolVersions);
  const createdAt = new Date().toISOString();
  const started = performance.now();
  write(
    `benchmark: ${String(pending.length)} programs from ${repoPath(options.examples)} on ${repoPath(options.sim)} (revision ${revision}, variant ${options.variant.name})\n`,
  );
  if (!synthesis.available) write(`benchmark: no Fmax or time estimates: ${synthesis.reason}\n`);
  if (tools === null) {
    write(
      `benchmark: no tool versions: ${repoPath(options.toolVersions)} is missing (make tools-check writes it)\n`,
    );
  }

  mkdirSync(options.work, { recursive: true });
  const slot = join(options.work, 'program');
  const measured: Measured[] = [];
  for (const p of pending) {
    let c: VerifyCase;
    try {
      c = p.load();
    } catch (error) {
      const name = p.name.replace(/^examples\//, '');
      measured.push({
        result: {
          name,
          source: repoPath(join(options.examples, `${name}.asm`)),
          maxSteps: 1,
          status: 'failed',
          reason: `cannot build the program: ${(error as Error).message}`,
          mismatches: [],
        },
        referenceMs: 0,
        rtlMs: null,
      });
      continue;
    }
    const m = await measure(c, options.sim, slot, synthesis);
    measured.push(m);
    if (m.result.status === 'failed') {
      write(`FAIL ${m.result.name}: ${m.result.reason}\n`);
      for (const line of m.result.mismatches) write(`  ${line}\n`);
    }
  }
  const totalWallMs = performance.now() - started;

  const programs = measured.map((m) => m.result);
  const failed = programs.filter((p) => p.status === 'failed');
  const report: RtlBenchmarkReport = RtlBenchmarkReportSchema.parse({
    schemaVersion: RTL_BENCHMARK_SCHEMA_VERSION,
    kind: RTL_BENCHMARK_KIND,
    revision,
    isaVersion: ISA_VERSION,
    variant: { ...options.variant, hash: variantHash(options.variant) },
    labels: {
      rtl: LABELS.rtl,
      instructionalModel: LABELS.instructionalModel,
      estimatedTime: LABELS.estimatedTime,
    },
    config: {
      suite: 'examples (the @vcpu/benchmarks program set)',
      programDir: repoPath(options.examples),
      programs: programs.map((p) => p.name),
      stepLimit: 'each program’s .expect.json maxInstructions, for both CPUs',
      correctnessGate:
        'Each program runs on @vcpu/cpu-core (live) and on the RTL runner; every trace step and the full end state (registers, flags, PC, SP, SD, status, fault, all 256 memory bytes) must match, and the program must halt. A program that fails gets no numbers.',
    },
    verification: {
      gate: failed.length === 0 ? 'passed' : 'failed',
      programs: programs.length,
      passed: programs.length - failed.length,
      failed: failed.length,
      failedPrograms: failed.map((p) => p.name),
    },
    synthesis,
    totals: suiteTotals(programs),
    programs,
    provenance: {
      createdAt,
      git: gitState(),
      runner: repoPath(options.sim),
      toolchain,
      tools,
    },
    host: {
      label: LABELS.host,
      runtime: `node ${process.version}`,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model.trim() ?? 'unknown',
      totalWallMs,
      programs: measured.map((m) => ({
        name: m.result.name,
        referenceMs: m.referenceMs,
        rtlMs: m.rtlMs,
      })),
    },
  } satisfies RtlBenchmarkReport);

  const markdown = renderBenchmarkMarkdown(report);
  writeJsonAndMarkdown(options.out.replace(/\.json$/, ''), report, markdown);

  const rows = programs.map((p) =>
    p.status === 'ok'
      ? [
          p.name,
          String(p.rtl.instructions),
          String(p.rtl.cycles),
          fixed(p.rtl.cpi),
          String(p.instructionalModel.estimatedCycles),
          ...p.estimatedTime.map((e) => fixed(e.microseconds, 2)),
        ]
      : [p.name, 'FAILED', '-', '-', '-'],
  );
  const t = report.totals;
  if (t !== null) {
    rows.push([
      'total',
      String(t.instructions),
      String(t.cycles),
      fixed(t.cpi),
      String(t.instructionalModelCycles),
      ...(synthesis.available
        ? synthesis.fpga.flatMap((f) =>
            f.status === 'ran' ? [fixed(t.cycles / f.fmaxMHz, 2)] : [],
          )
        : []),
    ]);
  }
  const fpgaHeads = synthesis.available
    ? synthesis.fpga.flatMap((f) => (f.status === 'ran' ? [`µs@${f.family}`] : []))
    : [];
  write(`${table(['program', 'instret', 'cycles', 'CPI', 'model cycles', ...fpgaHeads], rows)}\n`);
  write(
    'cycles: RTL clock edges; model cycles: the emulator’s instructional estimate, not a circuit; µs: cycles / nextpnr Fmax\n',
  );
  write(
    `host (simulator wall-clock, not processor performance): ${fixed(totalWallMs, 0)} ms for the suite\n`,
  );
  write(`wrote ${options.out} and ${options.out.replace(/\.json$/, '.md')}\n`);
  if (options.publish !== undefined) {
    const base = join(options.publish, publishedName(report));
    writeJsonAndMarkdown(base, report, markdown);
    write(`wrote ${base}.json and ${base}.md\n`);
  }
  if (failed.length > 0) {
    write(
      `benchmark: FAIL, ${String(failed.length)}/${String(programs.length)} programs failed the correctness gate and have no numbers: ${failed.map((p) => p.name).join(', ')}\n`,
    );
    return { exitCode: 1, report };
  }
  write(
    `benchmark: PASS, the correctness gate passed for all ${String(programs.length)} programs\n`,
  );
  return { exitCode: 0, report };
}
