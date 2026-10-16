import { createCpu, type Cpu, type CpuMetrics, type ProgramInput } from '@vcpu/cpu-core';
import { OPCODE_IDS } from '@vcpu/shared';
import type { BenchmarkSettings, HostResult, ProgramResult, SimulatedResult } from './report.js';
import { summarize } from './stats.js';

/**
 * A monotonic clock in milliseconds. Injected so this package touches no Node or browser API:
 * the CLI passes `performance.now`, tests pass a fake.
 */
export type Clock = () => number;

/** Trace entries kept with the trace on: the CPU's own default. */
const TRACE_CAPACITY = 1024;

export const DEFAULT_BENCHMARK_SETTINGS: BenchmarkSettings = Object.freeze({
  warmupIterations: 3,
  samples: 10,
  maxInstructions: 1_000_000,
  minSampleMs: 50,
  trace: true,
});

export interface BenchmarkOptions extends Partial<BenchmarkSettings> {
  /** Name in the report, e.g. `14-fibonacci`. */
  readonly name: string;
  readonly program: ProgramInput;
  readonly clock: Clock;
}

/** Calibration never grows the runs per sample more than this factor in one step. */
const MAX_GROWTH = 10;

function checkCount(value: number, what: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${what} must be an integer ≥ ${String(min)}, got ${String(value)}`);
  }
}

/** Options merged over the defaults and validated. */
export function benchmarkSettings(options: Partial<BenchmarkSettings> = {}): BenchmarkSettings {
  const settings: BenchmarkSettings = {
    warmupIterations: options.warmupIterations ?? DEFAULT_BENCHMARK_SETTINGS.warmupIterations,
    samples: options.samples ?? DEFAULT_BENCHMARK_SETTINGS.samples,
    maxInstructions: options.maxInstructions ?? DEFAULT_BENCHMARK_SETTINGS.maxInstructions,
    minSampleMs: options.minSampleMs ?? DEFAULT_BENCHMARK_SETTINGS.minSampleMs,
    trace: options.trace ?? DEFAULT_BENCHMARK_SETTINGS.trace,
  };
  checkCount(settings.warmupIterations, 'warmupIterations', 0);
  checkCount(settings.samples, 'samples', 1);
  checkCount(settings.maxInstructions, 'maxInstructions', 1);
  if (!(Number.isFinite(settings.minSampleMs) && settings.minSampleMs >= 0)) {
    throw new RangeError(`minSampleMs must be ≥ 0, got ${String(settings.minSampleMs)}`);
  }
  return settings;
}

function simulatedResult(stopReason: SimulatedResult['stopReason'], m: CpuMetrics) {
  const opcodeCounts: SimulatedResult['opcodeCounts'] = {};
  for (const id of OPCODE_IDS) {
    if (m.opcodeCounts[id] > 0) opcodeCounts[id] = m.opcodeCounts[id];
  }
  return {
    stopReason,
    instructions: m.instructions,
    estimatedCycles: m.estimatedCycles,
    memoryReads: m.memoryReads,
    memoryWrites: m.memoryWrites,
    fetchedBytes: m.fetchedBytes,
    branchesTaken: m.branchesTaken,
    branchesNotTaken: m.branchesNotTaken,
    opcodeCounts,
  } satisfies SimulatedResult;
}

/** Host milliseconds for `runs` back-to-back program runs, each a reset plus a run to HLT. */
function timeBatch(
  cpu: Cpu,
  runs: number,
  settings: BenchmarkSettings,
  clock: Clock,
  expected: number,
) {
  const start = clock();
  for (let i = 0; i < runs; i += 1) {
    cpu.reset();
    const { executed } = cpu.run({ maxInstructions: settings.maxInstructions });
    if (executed !== expected) {
      throw new Error(
        `non-deterministic run: ${String(executed)} steps, expected ${String(expected)}`,
      );
    }
  }
  return clock() - start;
}

/** The smallest power-of-ten-bounded run count whose batch lasts at least `minSampleMs`. */
function calibrate(cpu: Cpu, settings: BenchmarkSettings, clock: Clock, expected: number): number {
  let runs = 1;
  for (;;) {
    const elapsed = timeBatch(cpu, runs, settings, clock, expected);
    if (elapsed >= settings.minSampleMs) return runs;
    const estimate =
      elapsed > 0 ? Math.ceil((runs * settings.minSampleMs * 1.1) / elapsed) : Infinity;
    runs = Math.max(runs + 1, Math.min(runs * MAX_GROWTH, estimate));
  }
}

function describeStop(cpu: Cpu, stopReason: 'faulted' | 'limit', settings: BenchmarkSettings) {
  if (stopReason === 'limit') {
    return `did not halt within ${String(settings.maxInstructions)} instructions`;
  }
  const fault = cpu.getState().fault;
  return `faulted: ${fault?.code ?? 'unknown fault'} at PC 0x${(fault?.pc ?? 0).toString(16).toUpperCase().padStart(2, '0')}: ${fault?.detail ?? ''}`;
}

/**
 * Benchmarks one program on `@vcpu/cpu-core`.
 *
 * 1. A reference run records the simulated metrics. A program that does not halt (fault or
 *    instruction limit), or does not load, is reported as an error and not timed.
 * 2. Calibration picks how many runs one sample repeats, so each sample lasts ≥ `minSampleMs`.
 * 3. `warmupIterations` untimed samples per mode, then `samples` timed samples per mode. With
 *    `trace`, trace-off and trace-on samples alternate (and alternate which goes first) so slow
 *    drift in the host affects both modes alike.
 */
export function runBenchmark(options: BenchmarkOptions): ProgramResult {
  const settings = benchmarkSettings(options);
  const { name, clock } = options;

  const plain = createCpu({ traceCapacity: 0 });
  try {
    plain.loadProgram(options.program);
  } catch (error) {
    return {
      name,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      simulated: null,
    };
  }
  const reference = plain.run({ maxInstructions: settings.maxInstructions });
  const stopReason = reference.stopReason;
  if (stopReason !== 'halted' && stopReason !== 'faulted' && stopReason !== 'limit') {
    throw new Error(`unexpected stop reason without an observer: ${stopReason}`);
  }
  const simulated = simulatedResult(stopReason, plain.getMetrics());
  if (stopReason !== 'halted') {
    return { name, status: 'error', error: describeStop(plain, stopReason, settings), simulated };
  }
  const expected = reference.executed;

  const traced = settings.trace ? createCpu({ traceCapacity: TRACE_CAPACITY }) : null;
  traced?.loadProgram(options.program);

  const runs = calibrate(plain, settings, clock, expected);
  for (let i = 0; i < settings.warmupIterations; i += 1) {
    timeBatch(plain, runs, settings, clock, expected);
    if (traced !== null) timeBatch(traced, runs, settings, clock, expected);
  }

  const toNsPerRun = (ms: number) => (ms * 1e6) / runs;
  const plainNs: number[] = [];
  const tracedNs: number[] = [];
  for (let i = 0; i < settings.samples; i += 1) {
    if (traced !== null && i % 2 === 1) {
      tracedNs.push(toNsPerRun(timeBatch(traced, runs, settings, clock, expected)));
    }
    plainNs.push(toNsPerRun(timeBatch(plain, runs, settings, clock, expected)));
    if (traced !== null && i % 2 === 0) {
      tracedNs.push(toNsPerRun(timeBatch(traced, runs, settings, clock, expected)));
    }
  }

  const timePerRunNs = summarize(plainNs);
  const tracedStats = traced === null ? null : summarize(tracedNs);
  const host: HostResult = {
    runsPerSample: runs,
    timePerRunNs,
    samplesNs: plainNs,
    instructionsPerSecond: timePerRunNs.median > 0 ? (expected * 1e9) / timePerRunNs.median : 0,
    nsPerInstruction: timePerRunNs.median / expected,
    traced: tracedStats === null ? null : { timePerRunNs: tracedStats, samplesNs: tracedNs },
  };
  const traceOverheadPct =
    tracedStats === null || timePerRunNs.median === 0
      ? null
      : ((tracedStats.median - timePerRunNs.median) / timePerRunNs.median) * 100;
  return { name, status: 'ok', host, simulated, traceOverheadPct };
}

export interface SuiteProgram {
  readonly name: string;
  readonly program: ProgramInput;
}

/** Benchmarks each program in turn; one that fails is reported as an error and the rest still run. */
export function runSuite(
  programs: readonly SuiteProgram[],
  options: Partial<BenchmarkSettings> & {
    readonly clock: Clock;
    readonly onResult?: (result: ProgramResult) => void;
  },
): ProgramResult[] {
  const { clock, onResult, ...settings } = options;
  return programs.map((program) => {
    const result = runBenchmark({ ...settings, ...program, clock });
    onResult?.(result);
    return result;
  });
}
