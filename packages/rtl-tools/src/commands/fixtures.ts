import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type FixtureKind,
  FixtureSchemaV1,
  type FixtureTraceStep,
  type FixtureV1,
  opcodeByByte,
  parseTraceJsonl,
} from '@vcpu/shared';
import {
  compareEndState,
  compareTrace,
  formatFailureReport,
  type Mismatch,
  parseRtlState,
  parseRtlTraceJsonl,
  type RtlState,
  type RtlTraceStep,
} from '../verify/compare.js';

const HW_BUILD = fileURLToPath(new URL('../../../../hardware/rtl/vcpu8/build/', import.meta.url));

/** Where `fixtures` reads and writes unless told otherwise. */
export const FIXTURES_DEFAULTS = {
  dir: fileURLToPath(new URL('../../../../fixtures/v1/', import.meta.url)),
  sim: join(HW_BUILD, 'sim', 'vcpu8_sim'),
  work: join(HW_BUILD, 'fixtures'),
  report: join(HW_BUILD, 'reports', 'fixtures.json'),
} as const;

export interface FixturesOptions {
  /** Directory holding `<name>.json`, `.mem.hex` and `.trace.jsonl`. */
  readonly dir: string;
  /** Only fixtures whose name matches this glob (`*` and `?`). */
  readonly filter?: string | undefined;
  /** The RTL runner binary. */
  readonly sim: string;
  /** Where the runner's state and trace files go. */
  readonly work: string;
  /** The JSON report. */
  readonly report: string;
}

export interface FixtureResult {
  readonly name: string;
  readonly kind: FixtureKind | null;
  readonly passed: boolean;
  /** Why the fixture could not be run at all (unreadable files, runner error). */
  readonly error: string | null;
  readonly mismatches: readonly Mismatch[];
  readonly instructions: number | null;
  readonly steps: number | null;
  readonly cycles: number | null;
  readonly stopReason: string | null;
}

/** Clocks per instruction measured by the RTL, per opcode id. */
export type ClocksByOpcode = Record<string, { min: number; max: number; count: number }>;

export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`);
}

/** Fixture names in `dir`, sorted, filtered by `filter`. */
export function listFixtures(dir: string, filter?: string): string[] {
  const match = filter === undefined ? null : globToRegExp(filter);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json') && file !== 'fixture.schema.json')
    .map((file) => file.slice(0, -'.json'.length))
    .filter((name) => match === null || match.test(name))
    .sort();
}

/**
 * The clocks each retired instruction took: the cycle count at its retirement minus the previous
 * step's. A final precise fault retires nothing, so it is left out.
 */
export function addClocks(
  clocks: ClocksByOpcode,
  trace: readonly RtlTraceStep[],
  state: RtlState,
): void {
  const retired = state.instructions;
  let previous = 0;
  trace.slice(0, retired).forEach((step) => {
    const id = opcodeByByte[step.ir[0] ?? 0]?.id ?? 'invalid';
    const spent = step.cycle - previous;
    previous = step.cycle;
    const entry = clocks[id];
    if (entry === undefined) {
      clocks[id] = { min: spent, max: spent, count: 1 };
    } else {
      entry.min = Math.min(entry.min, spent);
      entry.max = Math.max(entry.max, spent);
      entry.count += 1;
    }
  });
}

interface RunOutcome {
  readonly result: FixtureResult;
  readonly report: string | null;
  readonly trace: readonly RtlTraceStep[];
  readonly state: RtlState | null;
}

function failed(name: string, kind: FixtureKind | null, error: string): RunOutcome {
  return {
    result: {
      name,
      kind,
      passed: false,
      error,
      mismatches: [],
      instructions: null,
      steps: null,
      cycles: null,
      stopReason: null,
    },
    report: `FAIL ${name}: ${error}\n`,
    trace: [],
    state: null,
  };
}

function runOne(name: string, options: FixturesOptions): RunOutcome {
  const base = join(options.dir, name);
  let fixture: FixtureV1;
  let expectedTrace: FixtureTraceStep[];
  try {
    fixture = FixtureSchemaV1.parse(JSON.parse(readFileSync(`${base}.json`, 'utf8')));
    expectedTrace = parseTraceJsonl(readFileSync(`${base}.trace.jsonl`, 'utf8'));
  } catch (error) {
    return failed(name, null, `cannot read the fixture: ${(error as Error).message}`);
  }

  const statePath = join(options.work, `${name}.state.json`);
  const tracePath = join(options.work, `${name}.trace.jsonl`);
  const run = spawnSync(
    options.sim,
    [
      '--image',
      `${base}.mem.hex`,
      '--max-steps',
      String(fixture.maxInstructions),
      '--state',
      statePath,
      '--trace',
      tracePath,
      '--quiet',
    ],
    { encoding: 'utf8' },
  );
  if (run.error !== undefined || run.status !== 0) {
    const why = run.error?.message ?? `exit ${String(run.status)}: ${run.stderr.trim()}`;
    return failed(name, fixture.kind, `the RTL runner failed (${why})`);
  }

  let state: RtlState;
  let trace: RtlTraceStep[];
  try {
    state = parseRtlState(readFileSync(statePath, 'utf8'));
    trace = parseRtlTraceJsonl(readFileSync(tracePath, 'utf8'));
  } catch (error) {
    return failed(
      name,
      fixture.kind,
      `cannot read the runner's output: ${(error as Error).message}`,
    );
  }

  // Lock-step first: its first difference points at the instruction that went wrong.
  const mismatches = [
    ...compareTrace(expectedTrace, trace),
    ...compareEndState(fixture.expected, state),
  ];
  const passed = mismatches.length === 0;
  return {
    result: {
      name,
      kind: fixture.kind,
      passed,
      error: null,
      mismatches,
      instructions: state.instructions,
      steps: state.steps,
      cycles: state.cycles,
      stopReason: state.stopReason,
    },
    report: passed
      ? null
      : formatFailureReport(name, mismatches, {
          expectedTrace,
          actualTrace: trace,
          expected: fixture.expected,
          actual: state,
        }),
    trace,
    state,
  };
}

function summaryTable(results: readonly FixtureResult[]): string {
  const kinds: (FixtureKind | 'total')[] = ['example', 'instruction', 'fault', 'total'];
  const header = ['kind', 'fixtures', 'passed', 'failed', 'instructions', 'cycles'];
  const rows = kinds.map((kind) => {
    const group = results.filter((r) => kind === 'total' || r.kind === kind);
    const passed = group.filter((r) => r.passed);
    const sum = (key: 'instructions' | 'cycles') =>
      passed.reduce((total, r) => total + (r[key] ?? 0), 0);
    return [
      kind,
      String(group.length),
      String(passed.length),
      String(group.length - passed.length),
      String(sum('instructions')),
      String(sum('cycles')),
    ];
  });
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const format = (cells: readonly string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join('  ');
  return [format(header), ...rows.map(format)].join('\n');
}

/**
 * Runs every selected fixture on the RTL and compares the end state and the trace in lock-step.
 * Prints a failure report per failing fixture and a summary table, writes the JSON report, and
 * returns the exit code: 0 when every fixture passed, 1 otherwise.
 */
export function runFixtures(options: FixturesOptions, write: (text: string) => void): number {
  const names = listFixtures(options.dir, options.filter);
  if (names.length === 0) {
    write(`fixtures: no fixture in ${options.dir} matches ${options.filter ?? '*'}\n`);
    return 1;
  }
  mkdirSync(options.work, { recursive: true });

  const results: FixtureResult[] = [];
  const clocks: ClocksByOpcode = {};
  for (const name of names) {
    const outcome = runOne(name, options);
    results.push(outcome.result);
    if (outcome.report !== null) {
      write(outcome.report);
    } else if (outcome.state !== null) {
      addClocks(clocks, outcome.trace, outcome.state);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  write(`${summaryTable(results)}\n`);
  if (passed === results.length) {
    write(`${String(passed)}/${String(results.length)} fixtures passed (end state + lock-step)\n`);
  } else {
    const failures = results.filter((r) => !r.passed).map((r) => r.name);
    write(
      `${String(passed)}/${String(results.length)} fixtures passed; FAILED: ${failures.join(', ')}\n`,
    );
  }

  mkdirSync(dirname(options.report), { recursive: true });
  const sortedClocks = Object.fromEntries(
    Object.entries(clocks).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(
    options.report,
    `${JSON.stringify(
      {
        format: 'vcpu8-rtl-fixtures/1',
        dir: options.dir,
        filter: options.filter ?? null,
        total: results.length,
        passed,
        failed: results.length - passed,
        clocksByOpcode: sortedClocks,
        fixtures: results,
      },
      null,
      2,
    )}\n`,
  );
  write(`wrote ${options.report}\n`);
  return passed === results.length ? 0 : 1;
}
