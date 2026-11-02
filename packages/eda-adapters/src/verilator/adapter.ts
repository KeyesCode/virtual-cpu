import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  classifyCommand,
  type CommandRecord,
  type FailureClass,
  type StageResult,
} from '@vcpu/research-core';
import type { CommandRunner } from '../runner/command-runner.js';
import { HostCommandRunner } from '../runner/host-runner.js';
import {
  isDesignError,
  isInterfaceWarning,
  isRunnerFailure,
  parsePeUnitLog,
  parseToolVersions,
  parseVerifyReport,
  parseVerilatorDiagnostics,
  type PeMismatch,
  type VerifyCase,
  type VerifyCounts,
  type VerifyReport,
  type VerilatorDiagnostic,
} from './parsers.js';

const MATMUL_DIR = join('hardware', 'accelerators', 'matmul');
const INSTALL_HINT =
  "Verilator is not available: run 'pnpm hardware:setup' to install the pinned OSS CAD Suite";
const DEFAULT_MAX_LOG_BYTES = 1 << 20;

/**
 * Every recipe builds with -Wall, which makes a warning fatal. A warning is not a verdict on a
 * candidate (a mutant may add one: `pe-clear-ignored` leaves `clear` unused), so the adapter records
 * warnings instead. This is expanded by Make, after the Makefile has resolved TOOL_BIN.
 */
const VERILATOR_OVERRIDE = 'VERILATOR=$(TOOL_BIN)verilator -Wno-fatal';

/** One candidate evaluation: where it is, where its outputs go, and how it is seeded. */
export interface VerilatorRunContext {
  /** Holds `hardware/accelerators/matmul/`, a full copy with the candidate's RTL. */
  readonly workspaceRoot: string;
  /** Everything the stages write goes here: `build/`, `logs/` and `unit/`. */
  readonly outDir: string;
  readonly campaignSeed: number;
  readonly experimentSeed: number;
  /** The random cases of the differential run. */
  readonly count: number;
  /** The wall-clock limit of each stage, all of its commands together. */
  readonly timeoutMs: number;
  readonly maxLogBytes?: number;
  /** The array side of the differential run; 4 unless set. */
  readonly rows?: number;
  /** The random clocks of the unit test; the Makefile's default unless set. */
  readonly peRandomClocks?: number;
}

export interface LintOutcome {
  readonly errors: readonly VerilatorDiagnostic[];
  readonly warnings: readonly VerilatorDiagnostic[];
}

export interface UnitRun {
  readonly seed: number;
  readonly passed: boolean;
  readonly checks: number;
  readonly randomClocks: number | null;
  readonly vectorFile: string;
}

export interface UnitFirstFailure extends PeMismatch {
  readonly seed: number;
  readonly failedChecks: number | null;
  readonly vectorFile: string;
}

export interface UnitOutcome {
  /** The clocks checked, over every seed that ran. */
  readonly checks: number;
  readonly runs: readonly UnitRun[];
  readonly firstFailure: UnitFirstFailure | null;
}

export interface DifferentialFirstFailure {
  readonly size: string;
  readonly name: string;
  readonly kind: VerifyCase['kind'];
  readonly generator: string;
  readonly seed: number;
  readonly dims: VerifyCase['dims'];
  readonly reason: string | null;
  readonly mismatches: number;
  readonly firstMismatches: VerifyCase['firstMismatches'];
  /** The saved failure directory under the output directory, and what it holds. */
  readonly savedDir: string | null;
  readonly files: readonly string[];
  /** The `.in` file of the case, what {@link VerilatorAdapter.wave} takes. */
  readonly caseFile: string | null;
}

export interface DifferentialOutcome {
  /** From `verify.json`; null when no report was written. */
  readonly totals: VerifyCounts | null;
  /** The cases that failed, by corpus: the `differential` and `randomized` gates. */
  readonly failedDirected: number;
  readonly failedRandom: number;
  readonly reportFile: string | null;
  readonly firstFailure: DifferentialFirstFailure | null;
}

export interface WaveOutcome {
  readonly waveFile: string | null;
  readonly bytes: number;
}

/** One stage in progress: its commands, its warnings and what is left of its time. */
class StageRun {
  readonly commands: CommandRecord[] = [];
  readonly warnings = new Set<string>();
  toolVersion: string | null = null;
  private readonly deadline: number;

  constructor(
    private readonly runner: CommandRunner,
    private readonly stage: string,
    private readonly context: VerilatorRunContext,
  ) {
    this.deadline = Date.now() + context.timeoutMs;
  }

  async exec(
    label: string,
    command: string,
    args: readonly string[],
    cwd: string,
  ): Promise<CommandRecord> {
    const name = `${this.stage}-${String(this.commands.length + 1)}-${label}`;
    const logs = join(this.context.outDir, 'logs');
    const record = await this.runner.run(command, args, {
      cwd,
      timeoutMs: Math.max(1, this.deadline - Date.now()),
      maxLogBytes: this.context.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES,
      stdoutPath: join(logs, `${name}.stdout.log`),
      stderrPath: join(logs, `${name}.stderr.log`),
    });
    this.commands.push(record);
    return record;
  }

  addWarnings(diagnostics: readonly VerilatorDiagnostic[]): void {
    for (const d of diagnostics) {
      if (d.severity !== 'warning') continue;
      const at = d.file === null ? '' : ` ${basename(d.file)}:${String(d.line)}`;
      this.warnings.add(`${d.code ?? 'warning'}${at}: ${d.message}`);
    }
  }

  result<T>(failureClass: FailureClass | null, message: string | null, outcome: T): StageResult<T> {
    return {
      stage: this.stage,
      ok: failureClass === null,
      failureClass,
      message,
      commands: this.commands,
      toolVersion: this.toolVersion,
      wallTimeMs: this.commands.reduce((total, c) => total + c.wallTimeMs, 0),
      warnings: [...this.warnings],
      outcome,
    };
  }
}

function logs(record: CommandRecord): string {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
  return `${read(record.stdout.path)}\n${read(record.stderr.path)}`;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

function ended(record: CommandRecord, what: string): string {
  if (record.spawnError !== null) return `${what} could not start: ${record.spawnError}`;
  if (record.timedOut) return `${what} overran the stage timeout and was killed`;
  return `${what} exited ${String(record.exitCode ?? record.signal)}`;
}

/** Why a Verilator build or lint command failed, or null when it did not. */
function classifyVerilator(
  record: CommandRecord,
  diagnostics: readonly VerilatorDiagnostic[],
  what: string,
): { failureClass: FailureClass; message: string } | null {
  const base = classifyCommand(record);
  if (base === 'timeout' || base === 'infrastructure-failure') {
    return { failureClass: base, message: ended(record, what) };
  }
  const blocking = diagnostics.find((d) => isDesignError(d) || isInterfaceWarning(d));
  if (blocking !== undefined) {
    return {
      failureClass: 'unsupported-design',
      message: `${blocking.code ?? 'Error'}: ${blocking.message}`,
    };
  }
  return base === null ? null : { failureClass: base, message: ended(record, what) };
}

function failedCaseFiles(savedDir: string | null): {
  files: readonly string[];
  caseFile: string | null;
} {
  if (savedDir === null || !existsSync(savedDir)) return { files: [], caseFile: null };
  const files = readdirSync(savedDir)
    .sort()
    .map((file) => join(savedDir, file));
  return { files, caseFile: files.find((file) => extname(file) === '.in') ?? null };
}

/**
 * Answers "is this PE candidate correct?" by running the Project 3 flows on a candidate copy:
 * docs/research-engine/eda-adapters.md lists the commands, the outputs and the classification.
 * Each method is one stage, and none of them stops a later one: ordering the gates is the pipeline's
 * job. A failed candidate is a result; only misuse of the adapter rejects.
 */
export class VerilatorAdapter {
  private readonly repoRoot: string;
  private readonly runner: CommandRunner;

  constructor(options: { readonly repoRoot: string; readonly runner?: CommandRunner }) {
    this.repoRoot = resolve(options.repoRoot);
    this.runner = options.runner ?? new HostCommandRunner();
  }

  /** `make lint`: Verilator --lint-only -Wall over the RTL from matmul_top. */
  async lint(context: VerilatorRunContext): Promise<StageResult<LintOutcome>> {
    const empty: LintOutcome = { errors: [], warnings: [] };
    return this.stage('lint', context, empty, async (run) => {
      const record = await this.make(run, context, 'lint');
      const diagnostics = parseVerilatorDiagnostics(logs(record));
      run.addWarnings(diagnostics);
      const failure = classifyVerilator(record, diagnostics, 'make lint');
      return run.result(failure?.failureClass ?? null, failure?.message ?? null, {
        errors: diagnostics.filter((d) => d.severity === 'error'),
        warnings: diagnostics.filter((d) => d.severity === 'warning'),
      });
    });
  }

  /** `make test-pe`, with the campaign's seed and then the experiment's. */
  async unitTestPe(context: VerilatorRunContext): Promise<StageResult<UnitOutcome>> {
    const empty: UnitOutcome = { checks: 0, runs: [], firstFailure: null };
    return this.stage('unit', context, empty, async (run) => {
      const runs: UnitRun[] = [];
      const outcome = (firstFailure: UnitFirstFailure | null): UnitOutcome => ({
        checks: runs.reduce((total, r) => total + r.checks, 0),
        runs,
        firstFailure,
      });
      for (const seed of new Set([context.campaignSeed, context.experimentSeed])) {
        const vectorFile = join(context.outDir, 'unit', `seed-${String(seed)}`, 'pe.vec');
        mkdirSync(dirname(vectorFile), { recursive: true });
        const record = await this.make(run, context, 'test-pe', [
          `PE_SEED=${String(seed)}`,
          `PE_VECTORS=${vectorFile}`,
          ...(context.peRandomClocks === undefined
            ? []
            : [`PE_RANDOM_CLOCKS=${String(context.peRandomClocks)}`]),
        ]);
        const text = logs(record);
        const log = parsePeUnitLog(text);
        const diagnostics = parseVerilatorDiagnostics(text);
        run.addWarnings(diagnostics);
        runs.push({
          seed,
          passed: log.passed && record.exitCode === 0,
          checks: log.checks ?? 0,
          randomClocks: log.randomClocks,
          vectorFile,
        });

        const first = log.mismatches[0];
        if (!record.timedOut && (first !== undefined || log.failedChecks !== null)) {
          const firstFailure = {
            seed,
            line: first?.line ?? 0,
            segment: first?.segment ?? '',
            detail: first?.detail ?? 'the testbench reported failed checks',
            failedChecks: log.failedChecks,
            vectorFile,
          };
          return run.result(
            'incorrect-design',
            `${String(log.failedChecks ?? log.mismatches.length)} PE checks failed with seed ${String(seed)}, first on line ${String(firstFailure.line)}`,
            outcome(firstFailure),
          );
        }
        const failure = classifyVerilator(record, diagnostics, 'make test-pe');
        if (failure !== null) {
          return run.result(failure.failureClass, failure.message, outcome(null));
        }
        if (!log.passed) {
          return run.result(
            'tool-failure',
            'make test-pe exited 0 without the PASS line',
            outcome(null),
          );
        }
      }
      return run.result(null, null, outcome(null));
    });
  }

  /**
   * The directed corpus and `count` random cases on the candidate's runner. This is `make sim` and
   * then the `verify` command `make verify-size` wraps: that target passes only --reports, so verify
   * would use (and first delete) the failure directories of the repository's own build/.
   */
  async differentialVerify(
    context: VerilatorRunContext,
  ): Promise<StageResult<DifferentialOutcome>> {
    const empty: DifferentialOutcome = {
      totals: null,
      failedDirected: 0,
      failedRandom: 0,
      reportFile: null,
      firstFailure: null,
    };
    return this.stage('differential', context, empty, async (run) => {
      const build = await this.make(run, context, 'sim');
      const diagnostics = parseVerilatorDiagnostics(logs(build));
      run.addWarnings(diagnostics);
      const buildFailure = classifyVerilator(build, diagnostics, 'make sim');
      if (buildFailure !== null) {
        return run.result(buildFailure.failureClass, buildFailure.message, empty);
      }

      const buildDir = this.buildDir(context);
      const size = `${String(this.rows(context))}x${String(this.rows(context))}`;
      const reports = join(buildDir, 'reports', `verify-${size}`);
      const reportFile = join(reports, 'verify.json');
      rmSync(reportFile, { force: true });
      const verify = await run.exec(
        'verify',
        'pnpm',
        [
          '--silent',
          '--filter',
          '@vcpu/accelerator-reference',
          'cli',
          'verify',
          '--sim',
          join(buildDir, `sim-${size}`, 'matmul_sim'),
          '--seed',
          String(context.experimentSeed),
          '--count',
          String(context.count),
          '--work',
          join(buildDir, 'verify'),
          '--failures',
          join(buildDir, 'failures'),
          '--reports',
          reports,
        ],
        this.repoRoot,
      );
      const base = classifyCommand(verify);
      if (base === 'timeout' || base === 'infrastructure-failure') {
        return run.result(base, ended(verify, 'verify'), empty);
      }
      if (!existsSync(reportFile)) {
        return run.result(
          'tool-failure',
          `${ended(verify, 'verify')} without a report: ${firstLine(logs(verify))}`,
          empty,
        );
      }

      let report: VerifyReport;
      try {
        report = parseVerifyReport(readFileSync(reportFile, 'utf8'));
      } catch (error) {
        return run.result('tool-failure', `unreadable verify.json: ${String(error)}`, empty);
      }
      const failed = report.cases.filter((c) => !c.passed);
      const first = failed.find((c) => c.saved !== null) ?? failed[0];
      const outcome: DifferentialOutcome = {
        totals: report.totals,
        failedDirected: failed.filter((c) => c.kind === 'directed').length,
        failedRandom: failed.filter((c) => c.kind === 'random').length,
        reportFile,
        firstFailure:
          first === undefined
            ? null
            : {
                size: first.size,
                name: first.name,
                kind: first.kind,
                generator: first.generator,
                seed: first.seed,
                dims: first.dims,
                reason: first.reason,
                mismatches: first.mismatches,
                firstMismatches: first.firstMismatches,
                savedDir: first.saved,
                ...failedCaseFiles(first.saved),
              },
      };
      if (report.passed) {
        return verify.exitCode === 0
          ? run.result(null, null, outcome)
          : run.result('tool-failure', `${ended(verify, 'verify')} on a passing report`, outcome);
      }
      const message = `${String(report.totals.failed)}/${String(report.totals.cases)} cases failed, first ${first?.size ?? '?'} ${first?.name ?? '?'}: ${first?.reason ?? '-'}`;
      return run.result(
        failed.every(isRunnerFailure) ? 'tool-failure' : 'incorrect-design',
        message,
        outcome,
      );
    });
  }

  /** `make wave` on one case (a `caseFile` of a failure): an FST of every signal. Optional. */
  async wave(context: VerilatorRunContext, caseFile: string): Promise<StageResult<WaveOutcome>> {
    const empty: WaveOutcome = { waveFile: null, bytes: 0 };
    return this.stage('wave', context, empty, async (run) => {
      const record = await this.make(run, context, 'wave', [`CASE=${resolve(caseFile)}`]);
      const diagnostics = parseVerilatorDiagnostics(logs(record));
      run.addWarnings(diagnostics);
      const failure = classifyVerilator(record, diagnostics, 'make wave');
      if (failure !== null) return run.result(failure.failureClass, failure.message, empty);
      const name = basename(caseFile, extname(caseFile));
      const waveFile = join(this.buildDir(context), 'waves', `${name}.fst`);
      return run.result(null, null, { waveFile, bytes: statSync(waveFile).size });
    });
  }

  private rows(context: VerilatorRunContext): number {
    return context.rows ?? 4;
  }

  private buildDir(context: VerilatorRunContext): string {
    return join(resolve(context.outDir), 'build');
  }

  private make(
    run: StageRun,
    context: VerilatorRunContext,
    target: string,
    variables: readonly string[] = [],
  ): Promise<CommandRecord> {
    return run.exec(
      target,
      'make',
      [
        target,
        // The workspace's Makefile derives HW_DIR from itself, so it builds the candidate's RTL;
        // REPO_ROOT reaches toolchain.env and the harness, which are never copied.
        `REPO_ROOT=${this.repoRoot}`,
        `BUILD_DIR=${this.buildDir(context)}`,
        `ROWS=${String(this.rows(context))}`,
        VERILATOR_OVERRIDE,
        ...variables,
      ],
      join(resolve(context.workspaceRoot), MATMUL_DIR),
    );
  }

  /** The version check every stage starts with; a failure here ends the stage. */
  private async checkTools(
    run: StageRun,
    context: VerilatorRunContext,
  ): Promise<{ failureClass: FailureClass; message: string } | null> {
    const file = join(this.buildDir(context), 'tool-versions.json');
    if (!existsSync(file)) {
      // tools-check also exits non-zero for a tool this stage does not use, so its file decides.
      const record = await this.make(run, context, 'tools-check');
      const base = classifyCommand(record);
      if (base === 'timeout' || base === 'infrastructure-failure') {
        return { failureClass: base, message: ended(record, 'make tools-check') };
      }
    }
    if (!existsSync(file)) {
      return { failureClass: 'infrastructure-failure', message: INSTALL_HINT };
    }
    const { toolchain, tools } = parseToolVersions(readFileSync(file, 'utf8'));
    const verilator = tools['verilator'];
    if (verilator === undefined || verilator === null) {
      return { failureClass: 'infrastructure-failure', message: INSTALL_HINT };
    }
    run.toolVersion = verilator.version;
    if (toolchain.path === null) {
      run.warnings.add(
        `Verilator from PATH, not the pinned OSS CAD Suite ${toolchain.pinnedVersion}`,
      );
    }
    return null;
  }

  private async stage<T>(
    name: string,
    context: VerilatorRunContext,
    empty: T,
    body: (run: StageRun) => Promise<StageResult<T>>,
  ): Promise<StageResult<T>> {
    this.assertCandidateCopy(context);
    const run = new StageRun(this.runner, name, context);
    try {
      const failure = await this.checkTools(run, context);
      if (failure !== null) return run.result(failure.failureClass, failure.message, empty);
      return await body(run);
    } catch (error) {
      return run.result('infrastructure-failure', (error as Error).message, empty);
    }
  }

  /** The repository's own Project 3 tree is never built in or written to. */
  private assertCandidateCopy(context: VerilatorRunContext): void {
    const workspace = resolve(context.workspaceRoot);
    if (workspace === this.repoRoot) {
      throw new Error('the workspace must be a candidate copy, not the repository');
    }
    const inside = relative(join(this.repoRoot, MATMUL_DIR), resolve(context.outDir));
    if (!inside.startsWith('..')) {
      throw new Error(`outDir must be outside ${MATMUL_DIR}: ${context.outDir}`);
    }
  }
}
