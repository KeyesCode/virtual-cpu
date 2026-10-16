import { OPCODE_IDS } from '@vcpu/shared';
import { z } from 'zod';

/**
 * The benchmark report: what `pnpm bench`, `pnpm cpu benchmark --json` and
 * `benchmarks/baseline.json` hold. Fields are only ever added; a change that removes or redefines
 * one bumps `schemaVersion`. docs/benchmarks.md documents it.
 */
export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;

const Count = z.number().int().nonnegative();

/** `SampleStats` from stats.ts. */
export const SampleStatsSchema = z.strictObject({
  n: Count.min(1),
  min: z.number(),
  max: z.number(),
  mean: z.number(),
  median: z.number(),
  stddev: z.number().nonnegative(),
  p5: z.number(),
  p95: z.number(),
});

/** What the host (this machine) measured. Wall-clock time; it varies from run to run. */
export const HostResultSchema = z.strictObject({
  /** Program runs (reset, then run to HLT) timed together as one sample. */
  runsPerSample: Count.min(1),
  /** Host nanoseconds per program run, trace off: one value per sample, summarized. */
  timePerRunNs: SampleStatsSchema,
  /** The per-sample values behind `timePerRunNs`, in the order they were taken. */
  samplesNs: z.array(z.number().nonnegative()).min(1),
  /** Simulated instructions per host second, from the median time per run. */
  instructionsPerSecond: z.number().nonnegative(),
  /** Host nanoseconds per simulated instruction, from the median time per run. */
  nsPerInstruction: z.number().nonnegative(),
  /** The same program with the execution trace on; `null` when trace timing was off. */
  traced: z
    .strictObject({
      timePerRunNs: SampleStatsSchema,
      samplesNs: z.array(z.number().nonnegative()).min(1),
    })
    .nullable(),
});
export type HostResult = z.infer<typeof HostResultSchema>;

/**
 * What the simulated CPU did in one run. Deterministic: the same program gives the same numbers on
 * every machine. Cycles are estimates from the ISA timing model, not measured clock cycles.
 */
export const SimulatedResultSchema = z.strictObject({
  stopReason: z.enum(['halted', 'faulted', 'limit']),
  instructions: Count,
  estimatedCycles: Count,
  memoryReads: Count,
  memoryWrites: Count,
  fetchedBytes: Count,
  branchesTaken: Count,
  branchesNotTaken: Count,
  /** Retired instructions per opcode id; ids that never ran are left out. */
  opcodeCounts: z.partialRecord(z.enum(OPCODE_IDS), Count.min(1)),
});
export type SimulatedResult = z.infer<typeof SimulatedResultSchema>;

export const ProgramResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    name: z.string().min(1),
    status: z.literal('ok'),
    host: HostResultSchema,
    simulated: SimulatedResultSchema,
    /** (traced median − untraced median) / untraced median × 100; `null` when trace timing was off. */
    traceOverheadPct: z.number().nullable(),
  }),
  z.strictObject({
    name: z.string().min(1),
    /** The program did not load, faulted or hit the instruction limit; it was not timed. */
    status: z.literal('error'),
    error: z.string().min(1),
    /** The run that failed, when the program loaded. */
    simulated: SimulatedResultSchema.nullable(),
  }),
]);
export type ProgramResult = z.infer<typeof ProgramResultSchema>;

export const BenchmarkSettingsSchema = z.strictObject({
  /** Untimed samples run before measuring, per mode (trace off and trace on). */
  warmupIterations: Count,
  /** Timed samples per mode. */
  samples: Count.min(1),
  /** Instruction limit for one program run. */
  maxInstructions: Count.min(1),
  /** Each sample repeats the program until it lasts at least this long. */
  minSampleMs: z.number().nonnegative(),
  /** Whether the trace-on timing (and so trace overhead) was measured. */
  trace: z.boolean(),
});
export type BenchmarkSettings = z.infer<typeof BenchmarkSettingsSchema>;

/** Where the numbers were measured. The CLI fills it in; nothing here reads the host itself. */
export const BenchmarkEnvironmentSchema = z.strictObject({
  /** Runtime and version, e.g. `node v24.15.0`. */
  runtime: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  osRelease: z.string(),
  cpuModel: z.string(),
  cpuCount: Count,
  totalMemoryBytes: Count,
  /** Commit the code was measured at; `null` outside a git checkout. */
  gitSha: z.string().nullable(),
  /** Whether the working tree had uncommitted changes; `null` outside a git checkout. */
  gitDirty: z.boolean().nullable(),
  /** Workspace package versions, by package name. */
  packages: z.record(z.string(), z.string()),
});
export type BenchmarkEnvironment = z.infer<typeof BenchmarkEnvironmentSchema>;

export const BenchmarkReportSchema = z.strictObject({
  schemaVersion: z.literal(BENCHMARK_REPORT_SCHEMA_VERSION),
  createdAt: z.iso.datetime(),
  isaVersion: z.string().min(1),
  environment: BenchmarkEnvironmentSchema,
  settings: BenchmarkSettingsSchema,
  programs: z.array(ProgramResultSchema),
});
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;
