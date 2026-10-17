import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { formatMemoryHex, formatTraceJsonl } from '@vcpu/shared';
import {
  CASE_FORMAT,
  type CaseFile,
  caseDirName,
  CORPORA,
  CORPUS_DIRS,
  type Corpus,
  exampleCases,
  fixtureCases,
  HW_DIR,
  type PendingCase,
  programCases,
  randomCases,
  readCaseDir,
  regressionCases,
  type VerifyCase,
} from '../verify/corpora.js';
import {
  compareEnd,
  compareTrace,
  formatFailureReport,
  type Mismatch,
  type RtlState,
} from '../verify/compare.js';
import {
  addCoverage,
  type Coverage,
  coverageGaps,
  emptyCoverage,
  formatCoverage,
  mergeCoverage,
} from '../verify/coverage.js';
import { type ReferenceRun, runReference } from '../verify/reference.js';
import { runRtl } from '../verify/rtl.js';

const BUILD = join(HW_DIR, 'build');

/** Where `verify` reads and writes unless told otherwise; `make verify` uses the same. */
export const VERIFY_DEFAULTS = {
  ...CORPUS_DIRS,
  sim: join(BUILD, 'sim', 'vcpu8_sim'),
  work: join(BUILD, 'verify'),
  failures: join(BUILD, 'failures'),
  reports: join(BUILD, 'reports'),
  seed: 1,
  count: 1000,
  /** Failing cases saved to `failures/` and printed in full; the rest get one line each. */
  keepFailures: 25,
} as const;

export interface VerifyOptions {
  readonly corpora: readonly Corpus[];
  /** First random seed and how many seeds. */
  readonly seed: number;
  readonly count: number;
  /** Fail when an opcode was never retired or a fault code never hit (the default full run). */
  readonly requireCoverage: boolean;
  readonly sim: string;
  readonly work: string;
  readonly failures: string;
  readonly reports: string;
  readonly fixtures: string;
  readonly examples: string;
  readonly programs: string;
  readonly regressions: string;
  /** Cases in flight at once (RTL runner processes). */
  readonly jobs: number;
  readonly keepFailures: number;
}

export function defaultVerifyOptions(): VerifyOptions {
  return {
    ...VERIFY_DEFAULTS,
    corpora: CORPORA,
    requireCoverage: true,
    jobs: availableParallelism(),
  };
}

/** One case's outcome. */
export interface CaseResult {
  readonly name: string;
  readonly corpus: Corpus;
  readonly seed: number | null;
  readonly shape: string | null;
  readonly passed: boolean;
  /** Why the case could not be compared at all (it did not build, or the runner failed). */
  readonly error: string | null;
  readonly mismatches: readonly Mismatch[];
  readonly instructions: number | null;
  readonly steps: number | null;
  readonly stopReason: string | null;
  /** The saved failure directory, if it was saved. */
  readonly saved: string | null;
}

export interface CorpusSummary {
  readonly corpus: Corpus;
  cases: number;
  passed: number;
  failed: number;
  readonly coverage: Coverage;
}

export interface VerifyOutcome {
  readonly exitCode: number;
  readonly summaries: readonly CorpusSummary[];
  readonly coverage: Coverage;
  readonly gaps: readonly string[];
  readonly failures: readonly CaseResult[];
}

/** `make -C hardware/rtl/vcpu8 replay CASE=…` for a saved case directory. */
export function replayCommand(dir: string): string {
  const rel = relative(HW_DIR, dir);
  const path = rel.startsWith('..') ? dir : rel;
  return `make -C hardware/rtl/vcpu8 replay CASE=${path}`;
}

/** One line for a mismatch: where, which field, both values. */
export function describeMismatch(m: Mismatch | undefined): string {
  if (m === undefined) return '-';
  const where = m.step === null ? 'end' : `step ${String(m.step)}`;
  return `${where} ${m.field}: expected ${String(m.expected)}, actual ${String(m.actual)}`;
}

function caseDetails(c: VerifyCase): string[] {
  const parts = [`corpus ${c.corpus}`];
  if (c.seed !== null) parts.push(`seed ${String(c.seed)}`);
  if (c.shape !== null) parts.push(`shape ${c.shape}`);
  parts.push(`max steps ${String(c.maxSteps)}`);
  return [parts.join(' · '), `from ${c.origin}`];
}

interface Compared {
  readonly ref: ReferenceRun;
  readonly mismatches: readonly Mismatch[];
  readonly error: string | null;
  readonly rtlState: RtlState | null;
  readonly report: string | null;
}

/** Runs one case on both sides, in lock-step, then the end state; never throws. */
async function compareCase(
  c: VerifyCase,
  sim: string,
  slot: string,
  replayDir: string,
): Promise<Compared> {
  const ref = runReference(c.image, c.maxSteps);
  const files = {
    image: `${slot}.mem.hex`,
    state: `${slot}.state.json`,
    trace: `${slot}.trace.jsonl`,
  };
  writeFileSync(files.image, formatMemoryHex([...c.image]));
  const rtl = await runRtl(sim, files, c.maxSteps);
  if (!rtl.ok) {
    const report = [
      `FAIL ${c.name}: ${rtl.error}`,
      ...caseDetails(c).map((line) => `  ${line}`),
      `  replay: ${replayCommand(replayDir)}`,
    ].join('\n');
    return { ref, mismatches: [], error: rtl.error, rtlState: null, report: `${report}\n` };
  }
  // Lock-step first: its first difference points at the instruction that went wrong.
  const mismatches = [...compareTrace(ref.trace, rtl.trace), ...compareEnd(ref.end, rtl.state)];
  const report =
    mismatches.length === 0
      ? null
      : formatFailureReport(c.name, mismatches, {
          expectedTrace: ref.trace,
          actualTrace: rtl.trace,
          expected: ref.end,
          actual: rtl.state,
          details: caseDetails(c),
          replay: replayCommand(replayDir),
        });
  return { ref, mismatches, error: null, rtlState: rtl.state, report };
}

/** Writes everything needed to understand and rerun a failing case into `dir`. */
function saveFailure(dir: string, c: VerifyCase, compared: Compared, slot: string, sim: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const caseFile: CaseFile = {
    format: CASE_FORMAT,
    name: c.name,
    corpus: c.corpus,
    seed: c.seed,
    shape: c.shape,
    maxSteps: c.maxSteps,
    origin: c.origin,
    sim,
    firstMismatch: compared.error ?? describeMismatch(compared.mismatches[0]),
  };
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify(caseFile, null, 2)}\n`);
  writeFileSync(join(dir, 'program.hex'), formatMemoryHex([...c.image]));
  if (c.source !== null) writeFileSync(join(dir, 'program.asm'), c.source);
  writeFileSync(join(dir, 'ref.trace.jsonl'), formatTraceJsonl(compared.ref.trace));
  writeFileSync(join(dir, 'ref.state.json'), `${JSON.stringify(compared.ref.end, null, 2)}\n`);
  for (const [from, to] of [
    [`${slot}.trace.jsonl`, 'rtl.trace.jsonl'],
    [`${slot}.state.json`, 'rtl.state.json'],
  ] as const) {
    if (existsSync(from)) copyFileSync(from, join(dir, to));
  }
  writeFileSync(join(dir, 'report.txt'), compared.report ?? '');
  // Absolute paths, so the script runs from anywhere.
  writeFileSync(join(dir, 'replay.sh'), `#!/bin/sh\nexec make -C ${HW_DIR} replay CASE=${dir}\n`, {
    mode: 0o755,
  });
}

function pendingCases(options: VerifyOptions): Iterable<PendingCase> {
  const { corpora } = options;
  return (function* () {
    if (corpora.includes('fixtures')) yield* fixtureCases(options.fixtures);
    if (corpora.includes('examples')) yield* exampleCases(options.examples);
    if (corpora.includes('programs')) yield* programCases(options.programs);
    if (corpora.includes('regressions')) yield* regressionCases(options.regressions);
    if (corpora.includes('random')) yield* randomCases(options.seed, options.count);
  })();
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const format = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ');
  return [format(header), ...rows.map(format)].join('\n');
}

function summaryRows(summaries: readonly CorpusSummary[], total: CorpusSummary): string[][] {
  return [...summaries, total].map((s) => [
    s === total ? 'total' : s.corpus,
    String(s.cases),
    String(s.passed),
    String(s.failed),
    String(s.coverage.steps),
    String(s.coverage.retired),
  ]);
}

function markdownReport(
  options: VerifyOptions,
  summaries: readonly CorpusSummary[],
  total: CorpusSummary,
  gaps: readonly string[],
  failures: readonly CaseResult[],
  passed: boolean,
): string {
  const c = total.coverage;
  const lines = [
    '# Differential verification report',
    '',
    `Result: **${passed ? 'PASS' : 'FAIL'}**. RTL runner \`${options.sim}\`; random seeds ${String(options.seed)}–${String(options.seed + options.count - 1)} (${String(options.count)} programs).`,
    '',
    '| Corpus | Cases | Passed | Failed | Steps | Retired |',
    '| ------ | ----: | -----: | -----: | ----: | ------: |',
    ...summaryRows(summaries, total).map((r) => `| ${r.join(' | ')} |`),
    '',
    '## Coverage',
    '',
    '| Opcode | Retired |',
    '| ------ | ------: |',
    ...Object.entries(c.opcodes).map(([id, n]) => `| ${id} | ${String(n)} |`),
    '',
    '| Fault | Runs ending in it |',
    '| ----- | ----------------: |',
    ...Object.entries(c.faults).map(([code, n]) => `| ${code} | ${String(n)} |`),
    '',
    '| Branch | Taken | Not taken |',
    '| ------ | ----: | --------: |',
    ...Object.entries(c.branches).map(
      ([id, b]) => `| ${id} | ${String(b.taken)} | ${String(b.notTaken)} |`,
    ),
    '',
    `Stops: ${String(c.stops.halted)} halted, ${String(c.stops.faulted)} faulted, ${String(c.stops.max_steps)} at the step limit. Maximum stack depth: ${String(c.maxStackDepth)}.`,
    '',
    gaps.length === 0
      ? 'Every opcode was retired and every fault code was hit.'
      : `Gaps: ${gaps.join('; ')}.`,
    '',
  ];
  if (failures.length > 0) {
    lines.push(
      '## Failures',
      '',
      '| Case | First difference | Saved |',
      '| ---- | ---------------- | ----- |',
    );
    for (const f of failures) {
      lines.push(
        `| ${f.name} | ${f.error ?? describeMismatch(f.mismatches[0])} | ${f.saved ?? '-'} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Runs every selected case on `@vcpu/cpu-core` (live) and on the RTL runner, compares them in
 * lock-step and at the end, and keeps going after a failure. Prints a report per failing case, a
 * summary per corpus and the coverage; saves failing cases to `failures/` with a replay command;
 * writes `verify.json` and `verify.md` to `reports/`. Exit code 0 only when every case matched
 * (and, with `requireCoverage`, every opcode and fault code was exercised).
 */
export async function runVerify(
  options: VerifyOptions,
  write: (text: string) => void,
): Promise<VerifyOutcome> {
  if (!existsSync(options.sim)) {
    write(`verify: no RTL runner at ${options.sim}; run 'make -C hardware/rtl/vcpu8 sim'\n`);
    return { exitCode: 2, summaries: [], coverage: emptyCoverage(), gaps: [], failures: [] };
  }
  const started = Date.now();
  rmSync(options.failures, { recursive: true, force: true });
  mkdirSync(options.work, { recursive: true });
  const randomRange =
    options.corpora.includes('random') && options.count > 0
      ? ` (seeds ${String(options.seed)}–${String(options.seed + options.count - 1)})`
      : '';
  write(
    `verify: ${options.corpora.join(', ')}${randomRange} on ${options.sim}, ${String(options.jobs)} jobs\n`,
  );

  const summaries = new Map<Corpus, CorpusSummary>(
    options.corpora.map((corpus) => [
      corpus,
      { corpus, cases: 0, passed: 0, failed: 0, coverage: emptyCoverage() },
    ]),
  );
  const results: CaseResult[] = [];
  const failures: CaseResult[] = [];
  const iterator = pendingCases(options)[Symbol.iterator]();

  const worker = async (slotIndex: number) => {
    const slot = join(options.work, `slot-${String(slotIndex)}`);
    for (let next = iterator.next(); next.done !== true; next = iterator.next()) {
      const pending = next.value;
      const summary = summaries.get(pending.corpus);
      if (summary === undefined) continue;
      summary.cases += 1;
      let c: VerifyCase;
      try {
        c = pending.load();
      } catch (error) {
        const message = `cannot build the case: ${(error as Error).message}`;
        summary.failed += 1;
        const result: CaseResult = {
          name: pending.name,
          corpus: pending.corpus,
          seed: null,
          shape: null,
          passed: false,
          error: message,
          mismatches: [],
          instructions: null,
          steps: null,
          stopReason: null,
          saved: null,
        };
        results.push(result);
        failures.push(result);
        write(`FAIL ${pending.name}: ${message}\n`);
        continue;
      }
      const dir = join(options.failures, caseDirName(c.name));
      const compared = await compareCase(c, options.sim, slot, dir);
      addCoverage(summary.coverage, compared.ref);
      const passed = compared.report === null;
      let saved: string | null = null;
      if (passed) {
        summary.passed += 1;
      } else {
        summary.failed += 1;
        if (failures.length < options.keepFailures) {
          saveFailure(dir, c, compared, slot, options.sim);
          saved = dir;
          write(compared.report);
        } else {
          write(
            `FAIL ${c.name}: ${compared.error ?? describeMismatch(compared.mismatches[0])} (not saved)\n`,
          );
        }
      }
      const result: CaseResult = {
        name: c.name,
        corpus: c.corpus,
        seed: c.seed,
        shape: c.shape,
        passed,
        error: compared.error,
        mismatches: compared.mismatches.slice(0, 16),
        instructions: compared.ref.end.instructions,
        steps: compared.ref.trace.length,
        stopReason: compared.ref.end.stopReason,
        saved,
      };
      if (c.corpus !== 'random' || !passed) results.push(result);
      if (!passed) failures.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.jobs) }, (_, i) => worker(i)));

  const ordered = options.corpora.flatMap((corpus) => {
    const s = summaries.get(corpus);
    return s === undefined ? [] : [s];
  });
  const total: CorpusSummary = {
    corpus: 'random',
    cases: 0,
    passed: 0,
    failed: 0,
    coverage: emptyCoverage(),
  };
  for (const s of ordered) {
    total.cases += s.cases;
    total.passed += s.passed;
    total.failed += s.failed;
    mergeCoverage(total.coverage, s.coverage);
  }
  const gaps = coverageGaps(total.coverage);
  const coverageFailed = options.requireCoverage && gaps.length > 0;
  const passed = total.failed === 0 && !coverageFailed;

  write(
    `${table(['corpus', 'cases', 'passed', 'failed', 'steps', 'retired'], summaryRows(ordered, total))}\n`,
  );
  write(formatCoverage(total.coverage));
  if (gaps.length > 0) {
    write(`coverage gaps: ${gaps.join('; ')}${options.requireCoverage ? '' : ' (not required)'}\n`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (passed) {
    write(
      `verify: PASS, ${String(total.passed)}/${String(total.cases)} cases match the reference in lock-step and at the end (${seconds} s)\n`,
    );
  } else {
    const names = failures.slice(0, 10).map((f) => f.name);
    const more = failures.length > 10 ? `, … ${String(failures.length - 10)} more` : '';
    write(
      `verify: FAIL, ${String(total.failed)}/${String(total.cases)} cases differ${failures.length > 0 ? `: ${names.join(', ')}${more}` : ''}${coverageFailed ? '; coverage incomplete' : ''} (${seconds} s)\n`,
    );
    if (failures.some((f) => f.saved !== null)) {
      write(`failing cases saved under ${options.failures}/; each has a replay.sh\n`);
    }
  }

  mkdirSync(options.reports, { recursive: true });
  const json = join(options.reports, 'verify.json');
  writeFileSync(
    json,
    `${JSON.stringify(
      {
        format: 'vcpu8-rtl-verify/1',
        passed,
        sim: options.sim,
        corpora: options.corpora,
        random: { seed: options.seed, count: options.count },
        seconds: Number(seconds),
        summary: ordered.map(({ coverage, ...rest }) => ({
          ...rest,
          steps: coverage.steps,
          retired: coverage.retired,
        })),
        total: { cases: total.cases, passed: total.passed, failed: total.failed },
        coverage: total.coverage,
        coverageGaps: gaps,
        failures,
        cases: results
          .filter((r) => r.corpus !== 'random')
          .sort(
            (a, b) =>
              CORPORA.indexOf(a.corpus) - CORPORA.indexOf(b.corpus) || a.name.localeCompare(b.name),
          ),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(options.reports, 'verify.md'),
    markdownReport(options, ordered, total, gaps, failures, passed),
  );
  write(`wrote ${json} and verify.md\n`);
  return { exitCode: passed ? 0 : 1, summaries: ordered, coverage: total.coverage, gaps, failures };
}

/**
 * Reruns a saved failure (or a committed regression) on both sides with the same image, step
 * limit and RTL runner, prints the report, and says whether it matches the saved one. Exit code
 * 1 while the case still fails, 0 once it passes.
 */
export async function replayCase(
  dir: string,
  sim: string | undefined,
  work: string,
  write: (text: string) => void,
): Promise<number> {
  const { file, image, source } = readCaseDir(dir);
  const runner = sim ?? file.sim ?? VERIFY_DEFAULTS.sim;
  const c: VerifyCase = {
    name: file.name,
    corpus: file.corpus,
    image,
    maxSteps: file.maxSteps,
    seed: file.seed,
    shape: file.shape,
    source,
    origin: file.origin,
  };
  mkdirSync(work, { recursive: true });
  write(`replay ${file.name} on ${runner}\n`);
  const compared = await compareCase(c, runner, join(work, 'replay'), resolve(dir));
  if (compared.report === null) {
    write(`PASS ${file.name}: the RTL matches the reference in lock-step and at the end\n`);
    return 0;
  }
  write(compared.report);
  const savedPath = join(dir, 'report.txt');
  if (existsSync(savedPath)) {
    const same = readFileSync(savedPath, 'utf8') === compared.report;
    write(
      same
        ? 'replay: the same mismatch as the saved report.txt\n'
        : 'replay: the report differs from the saved report.txt\n',
    );
  }
  return 1;
}

/**
 * Copies a saved failure into the committed regression corpus (`tb/regressions/<name>/`), which
 * every `make verify` replays: `case.json` (without the runner path), `program.hex`,
 * `program.asm` and the original report as `found.txt`.
 */
export function promoteCase(dir: string, regressions: string, write: (text: string) => void) {
  const { file, image, source } = readCaseDir(dir);
  const target = join(regressions, basename(resolve(dir)));
  if (existsSync(target)) {
    write(`promote: ${target} already exists\n`);
    return 1;
  }
  mkdirSync(target, { recursive: true });
  const promoted: CaseFile = {
    ...file,
    name: `regressions/${basename(target)}`,
    corpus: 'regressions',
    promotedFrom: file.name,
    ...(file.sim === undefined ? {} : { foundOn: relative(HW_DIR, file.sim) }),
  };
  delete promoted.sim;
  writeFileSync(join(target, 'case.json'), `${JSON.stringify(promoted, null, 2)}\n`);
  writeFileSync(join(target, 'program.hex'), formatMemoryHex(image));
  if (source !== null) writeFileSync(join(target, 'program.asm'), source);
  const report = join(dir, 'report.txt');
  if (existsSync(report)) copyFileSync(report, join(target, 'found.txt'));
  write(`promoted ${file.name} to ${target}; make verify now replays it\n`);
  return 0;
}
