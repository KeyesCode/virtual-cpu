import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  type BenchmarkReport,
  BenchmarkReportSchema,
  benchmarkSettings,
  type BenchmarkSettings,
  compareReports,
  DEFAULT_BENCHMARK_SETTINGS,
  DEFAULT_REGRESSION_THRESHOLD_PCT,
  type ProgramResult,
  runBenchmark,
} from '@vcpu/benchmarks';
import { ISA_VERSION } from '@vcpu/shared';
import { HELP_OPTION, parseCommandLine, parseCount, singleFile } from '../args.js';
import { collectEnvironment } from '../benchmark/environment.js';
import {
  formatComparison,
  formatProgramResult,
  formatSettings,
  formatSuiteSimulated,
  formatTable,
  SUITE_HOST_HEADER,
  suiteHostRow,
} from '../format/benchmark.js';
import { type CliIo, ExitCode, println, resolvePath, UsageError } from '../io.js';
import { AssemblyFailed, loadProgram } from '../program.js';
import type { Command } from './command.js';

/** The repository root, so `--suite` and `--compare` find their files from any directory. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const EXAMPLES_DIR = join(REPO_ROOT, 'examples');
const RESULTS_DIR = join(REPO_ROOT, 'benchmarks', 'results');
const BASELINE = join(REPO_ROOT, 'benchmarks', 'baseline.json');

const d = DEFAULT_BENCHMARK_SETTINGS;
const help = `Usage: pnpm cpu benchmark <file.asm|file.bin> [options] [--json out.json]
       pnpm cpu benchmark --suite [options] [--json out.json]     (pnpm bench)
       pnpm cpu benchmark --compare [report.json] [--baseline file] [--threshold PCT]
                                                                 (pnpm bench:compare)

Times a program on the emulator and prints two separate sections: host time measured on
this machine (median, mean, stddev, p5/p95, min/max per run, instructions per second,
ns per instruction, trace overhead) and the simulated CPU metrics (instructions, estimated
cycles from the timing model, opcode frequencies, memory reads/writes, branches).

--suite benchmarks every examples/*.asm and writes a JSON report, by default to
benchmarks/results/<date>-<gitsha>.json. A program that faults or does not halt is
reported as an error and the suite carries on.
--compare prints each program's change in instructions per second against the baseline
(benchmarks/baseline.json); the report defaults to the newest file in benchmarks/results/.

Options:
      --warmup <N>            Untimed warm-up samples per mode (default ${String(d.warmupIterations)})
      --samples <N>           Timed samples per mode (default ${String(d.samples)})
      --max-instructions <N>  Instruction limit for one program run (default ${String(d.maxInstructions)})
      --min-sample-ms <N>     Repeat the program within a sample until it lasts N ms (default ${String(d.minSampleMs)})
      --no-trace              Skip the trace-on timing (no trace overhead)
      --json <file>           Write the JSON report (BenchmarkReportSchema) to <file>
      --suite                 Benchmark every example program
      --compare               Compare a report against the baseline
      --baseline <file>       Baseline for --compare (default benchmarks/baseline.json)
      --threshold <PCT>       IPS drop flagged as a regression (default ${String(DEFAULT_REGRESSION_THRESHOLD_PCT)})
  -h, --help                  Show this help

Exit codes: 0 ok, 1 assembly errors, 2 a program faulted or did not halt, 64 usage error.`;

function displayPath(io: CliIo, path: string): string {
  const shown = relative(io.cwd, path);
  return shown.startsWith('..') ? path : shown;
}

function readReport(io: CliIo, path: string): BenchmarkReport {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(
      `${displayPath(io, path)}: cannot read a JSON report (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const parsed = BenchmarkReportSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new UsageError(
      `${displayPath(io, path)}: not a benchmark report: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

function writeReport(path: string, report: BenchmarkReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(BenchmarkReportSchema.parse(report), null, 2)}\n`);
}

function buildReport(settings: BenchmarkSettings, programs: ProgramResult[]): BenchmarkReport {
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    isaVersion: ISA_VERSION,
    environment: collectEnvironment(REPO_ROOT),
    settings,
    programs,
  };
}

/** `2026-10-16T201502Z-ab12cd3.json`: sorts by time, safe on every file system. */
function resultFileName(report: BenchmarkReport): string {
  const stamp = report.createdAt.replace(/\.\d+Z$/, 'Z').replaceAll(':', '');
  return `${stamp}-${report.environment.gitSha ?? 'nogit'}.json`;
}

const clock = () => performance.now();

function benchmarkFile(
  io: CliIo,
  file: string,
  settings: BenchmarkSettings,
  json: string | undefined,
) {
  const program = loadProgram(io, file);
  const name = basename(file, extname(file));
  println(io.stdout, `Benchmark ${file}`);
  println(io.stdout, `  ${formatSettings(settings)}`);
  println(io.stdout);
  const result = runBenchmark({ ...settings, name, program: program.bytes, clock });
  println(io.stdout, formatProgramResult(result));
  if (json !== undefined) {
    const path = resolvePath(io, json);
    writeReport(path, buildReport(settings, [result]));
    println(io.stdout);
    println(io.stdout, `Wrote ${displayPath(io, path)}`);
  }
  return result.status === 'ok' ? ExitCode.OK : ExitCode.CPU_FAULT;
}

function benchmarkSuite(io: CliIo, settings: BenchmarkSettings, json: string | undefined) {
  const files = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.asm'))
    .sort();
  println(io.stdout, `Benchmark suite: ${String(files.length)} programs in examples/`);
  println(io.stdout, `  ${formatSettings(settings)}`);
  println(io.stdout);
  println(io.stdout, 'Host time: measured on this machine, per program run (reset + run to HLT)');
  // Rows print as programs finish, so the column widths are fixed up front.
  const widths = [Math.max(...files.map((f) => basename(f, '.asm').length)), 10, 5, 10, 8, 8];
  const tableLine = (row: readonly string[]) =>
    formatTable(SUITE_HOST_HEADER, [row], widths).split('\n')[1] ?? '';
  println(io.stdout, formatTable(SUITE_HOST_HEADER, [], widths));

  const results: ProgramResult[] = [];
  for (const file of files) {
    const name = basename(file, '.asm');
    let result: ProgramResult;
    try {
      const program = loadProgram(io, join(EXAMPLES_DIR, file));
      result = runBenchmark({ ...settings, name, program: program.bytes, clock });
    } catch (error) {
      if (!(error instanceof AssemblyFailed)) throw error;
      result = { name, status: 'error', error: error.message, simulated: null };
    }
    results.push(result);
    println(io.stdout, tableLine(suiteHostRow(result)));
  }

  println(io.stdout);
  println(
    io.stdout,
    'Simulated: deterministic CPU metrics (cycles are timing-model estimates, not measured)',
  );
  println(io.stdout, formatSuiteSimulated(results));

  const report = buildReport(settings, results);
  const path =
    json === undefined ? join(RESULTS_DIR, resultFileName(report)) : resolvePath(io, json);
  writeReport(path, report);
  println(io.stdout);
  println(io.stdout, `Wrote ${displayPath(io, path)}`);
  const errors = results.filter((r) => r.status === 'error').length;
  if (errors > 0) {
    println(
      io.stderr,
      `${String(errors)} program${errors === 1 ? '' : 's'} could not be benchmarked.`,
    );
    return ExitCode.CPU_FAULT;
  }
  return ExitCode.OK;
}

function newestResult(io: CliIo): string {
  const files = existsSync(RESULTS_DIR)
    ? readdirSync(RESULTS_DIR)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const newest = files.at(-1);
  if (newest === undefined) {
    throw new UsageError(
      `no report in ${displayPath(io, RESULTS_DIR)}: run "pnpm bench" first, or pass a report file`,
    );
  }
  return join(RESULTS_DIR, newest);
}

function compare(
  io: CliIo,
  positionals: readonly string[],
  baseline: string | undefined,
  threshold: string | undefined,
) {
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument "${positionals.slice(1).join(' ')}"`);
  }
  const currentPath =
    positionals[0] === undefined ? newestResult(io) : resolvePath(io, positionals[0]);
  const baselinePath = baseline === undefined ? BASELINE : resolvePath(io, baseline);
  const thresholdPct =
    threshold === undefined ? DEFAULT_REGRESSION_THRESHOLD_PCT : Number.parseFloat(threshold);
  if (!(Number.isFinite(thresholdPct) && thresholdPct >= 0)) {
    throw new UsageError(`--threshold must be a non-negative percentage, got "${threshold ?? ''}"`);
  }
  const comparison = compareReports(readReport(io, baselinePath), readReport(io, currentPath), {
    thresholdPct,
  });
  println(
    io.stdout,
    `Comparing ${displayPath(io, currentPath)} against ${displayPath(io, baselinePath)}`,
  );
  println(io.stdout);
  println(io.stdout, formatComparison(comparison));
  return ExitCode.OK;
}

function settingsFrom(values: {
  warmup?: string | undefined;
  samples?: string | undefined;
  'max-instructions'?: string | undefined;
  'min-sample-ms'?: string | undefined;
  'no-trace'?: boolean | undefined;
}): BenchmarkSettings {
  const count = (text: string | undefined, flag: string) =>
    text === undefined ? undefined : parseCount(text, flag);
  const options = {
    warmupIterations: count(values.warmup, '--warmup'),
    samples: count(values.samples, '--samples'),
    maxInstructions: count(values['max-instructions'], '--max-instructions'),
    minSampleMs: count(values['min-sample-ms'], '--min-sample-ms'),
    trace: values['no-trace'] === true ? false : undefined,
  };
  try {
    return benchmarkSettings(
      Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
    );
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function run(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseCommandLine(args, {
    ...HELP_OPTION,
    warmup: { type: 'string' },
    samples: { type: 'string' },
    'max-instructions': { type: 'string' },
    'min-sample-ms': { type: 'string' },
    'no-trace': { type: 'boolean' },
    json: { type: 'string' },
    suite: { type: 'boolean' },
    compare: { type: 'boolean' },
    baseline: { type: 'string' },
    threshold: { type: 'string' },
  });
  if (values.help === true) {
    println(io.stdout, help);
    return ExitCode.OK;
  }
  if (values.suite === true && values.compare === true) {
    throw new UsageError('--suite and --compare cannot be combined');
  }
  if (values.compare === true) {
    return compare(io, positionals, values.baseline, values.threshold);
  }
  if (values.baseline !== undefined || values.threshold !== undefined) {
    throw new UsageError('--baseline and --threshold only apply to --compare');
  }
  const settings = settingsFrom(values);
  if (values.suite === true) {
    if (positionals.length > 0) {
      throw new UsageError(`unexpected argument "${positionals.join(' ')}" with --suite`);
    }
    return benchmarkSuite(io, settings, values.json);
  }
  const file = singleFile(positionals, 'the <file.asm|file.bin> to benchmark');
  return benchmarkFile(io, file, settings, values.json);
}

export const benchmarkCommand: Command = {
  name: 'benchmark',
  synopsis: 'benchmark <file.asm|file.bin>',
  summary: 'Time a program; --suite runs every example, --compare diffs against the baseline',
  help,
  run,
};
