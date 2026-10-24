import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createCpu } from '@vcpu/cpu-core';
import { type RtlTraceStep, runRtl } from '@vcpu/rtl-tools';
import { CpuStatus, formatMemoryHex, MEMORY_SIZE, opcodeByByte } from '@vcpu/shared';
import { z } from 'zod';
import { type MatmulDims, matmulInt8, validateDims } from '../model/matmul.js';
import { generateOperands } from '../model/prng.js';
import {
  CPU_STACK_BYTES,
  type CpuProgram,
  generateCpuProgram,
  readCpuResult,
} from './cpu-program.js';
import { benchmarkMetrics, BUILD_DIR, type Provenance, readProvenance, REPO } from './report.js';
import { writeCase } from './vectors.js';
import { type ArraySize, cycleLimit, judge, runnerInfo, runRunner, sizeName } from './verify.js';

/**
 * The CPU comparison (`make -C hardware/accelerators/matmul compare-cpu`, brief §13): the same
 * INT8 → INT32 products on VCPU-8 (Project 2) and on the 4 × 4 accelerator. Each CPU workload is
 * a program from {@link generateCpuProgram}, run on the emulator (`@vcpu/cpu-core`: result,
 * retired instructions, data-memory accesses, the ISA timing model's estimate) and on the Project
 * 2 RTL runner (hardware/rtl/vcpu8/build/sim/vcpu8_sim: clock cycles, and the same counts from
 * its trace); the accelerator runs the same operands through the benchmark path (benchmark.ts).
 * A row has numbers only when C equals the reference on every machine that ran it and the
 * emulator and the RTL agree. A workload whose program does not fit in the CPU's 256 bytes is
 * listed as unsupported with the byte counts. Resources come from the two committed synthesis
 * baselines. Written as build/reports/cpu-comparison.{json,md};
 * docs/hardware/accelerators/cpu-comparison.md explains the method.
 */

export const CPU_COMPARISON_SCHEMA_VERSION = 1;
export const CPU_COMPARISON_KIND = 'vcpu8-vs-matmul-comparison';

/** The accelerator configuration the comparison runs on: one 4 × 4 tile covers every CPU workload. */
export const COMPARE_ARRAY: ArraySize = { rows: 4, cols: 4 };

export const COMPARE_BASELINES = {
  cpu: 'research/cpu/synth/baseline.json',
  accelerator: 'research/accelerators/matmul/synth/baseline.json',
} as const;

export interface CompareWorkload {
  /** `<M>x<K>x<N>-<generator>`. */
  readonly name: string;
  readonly dims: MatmulDims;
  readonly generator: 'random' | 'min';
  readonly what: string;
}

function workload(
  m: number,
  k: number,
  n: number,
  generator: CompareWorkload['generator'],
  what: string,
): CompareWorkload {
  return {
    name: `${String(m)}x${String(k)}x${String(n)}-${generator}`,
    dims: { m, n, k },
    generator,
    what,
  };
}

/**
 * The workloads, M × K × N: the cubes that fit in VCPU-8 memory with random operands, the
 * largest one again with every operand −128 (every product is 16 384, the largest, and every C
 * element 65 536, which carries into its third byte), then the smallest cube that does not fit
 * and two of the accelerator benchmark's cubes, which the CPU cannot hold.
 */
export const COMPARE_WORKLOADS: readonly CompareWorkload[] = [
  workload(2, 2, 2, 'random', 'cube'),
  workload(3, 3, 3, 'random', 'cube'),
  workload(4, 4, 4, 'random', 'cube: the largest that fits in 256 bytes'),
  workload(
    4,
    4,
    4,
    'min',
    'every operand −128: the largest products, so every sum carries into byte 2',
  ),
  workload(5, 5, 5, 'random', 'cube: the smallest that does not fit'),
  workload(8, 8, 8, 'random', 'benchmark cube'),
  workload(16, 16, 16, 'random', 'benchmark cube'),
];

export const COMPARE_DEFAULTS = {
  work: join(BUILD_DIR, 'compare-cpu'),
  out: join(BUILD_DIR, 'reports'),
  seed: 1,
} as const;

/** What each number is, written into every report. */
export const COMPARE_LABELS = {
  mac: 'One MAC is one signed INT8 × INT8 multiply plus one add into a signed INT32 accumulator that wraps; a workload of M × K by K × N is M · N · K MACs on both machines.',
  cpuCycles:
    'CPU cycles: clock cycles of the Verilated Project 2 RTL (vcpu8_top) from reset release to HLT, counted by hardware/rtl/vcpu8/tb/sim/vcpu8_sim.cpp. The emulator column is the ISA timing model’s estimate (docs/instruction-set.md), shown beside it, not a measurement.',
  cpuMemory:
    'CPU memory accesses: data-memory reads (LOAD, POP, RET) and writes (STORE, PUSH, CALL) of retired instructions, from the opcode table over the RTL trace and from the emulator’s counters. Instruction fetches are counted separately as fetched bytes.',
  acceleratorCycles:
    'Accelerator cycles: rising clock edges of the Verilated matmul_top at 4 × 4, counted by tb/sim/matmul_sim.cpp: transfer in (A and B through the testbench host port, one element of each per clock), compute (PREPARE_TILE, COMPUTE, DRAIN), store (the controller writing C into its output buffer), handshake (the start clock, LOAD and one NEXT_TILE per tile), transfer out (C through the host port) and their total, which the five parts add up to. Busy is the clocks `busy` was high: compute + store + LOAD + NEXT_TILE.',
  acceleratorMemory:
    'Accelerator memory accesses: host-port element transfers, M · K + K · N INT8 writes into the input buffers and M · N INT32 reads of C. The controller’s reads of its own banked buffers are not counted by the runner and not included.',
  ratio:
    'Cycle ratio = CPU RTL cycles ÷ accelerator total cycles. Both are clock counts of different designs at an unspecified clock; the ratio is not a speed-up.',
} as const;

/** The differences every reader must keep in mind, printed in every report. */
export const COMPARE_CAVEATS = [
  {
    topic: 'ISA vs fixed function',
    text: 'VCPU-8 is a programmable 8-bit CPU running a generated program (loops, address arithmetic, branches); the accelerator is fixed-function hardware for exactly this operation. The CPU cycles include all of the program’s control overhead.',
  },
  {
    topic: 'Numeric format',
    text: 'VCPU-8’s MUL is unsigned 8 × 8 and keeps only the low byte of the product, so the program forms each signed 16-bit product by shift-and-add (one loop pass per multiplier bit up to its highest set bit, eight for a negative multiplier) and corrects for a negative multiplier. The accelerator’s processing element multiplies signed INT8 directly. The CPU’s cycles therefore depend on the operand values; the accelerator’s do not.',
  },
  {
    topic: 'INT32 accumulation',
    text: 'The CPU keeps each INT32 accumulator as 4 bytes in memory and adds the sign-extended product byte by byte, rippling the carry with branches because the ISA has no add-with-carry. The accelerator has a 32-bit adder per processing element. Both wrap on overflow like the reference.',
  },
  {
    topic: 'Memory',
    text: 'VCPU-8 has 256 bytes for code, data and stack together, so only products up to 4 × 4 × 4 fit (unsupported workloads list their byte counts). The accelerator has separate on-chip buffers (A and B 64 × 64 INT8 elements each, banked one bank per array row or column, C 64 × 64 INT32) behind a simplified testbench host port, and its totals include the transfers through that port.',
  },
  {
    topic: 'No clock frequency',
    text: 'Cycles are clocks, not time. The two designs would not run at the same clock, and no clock frequency is assumed for either, so no time, throughput per second or speed-up is reported. The synthesis baselines record Fmax estimates for named FPGAs; converting cycles with them later would give labelled estimates, and this report does not do it.',
  },
  {
    topic: 'No power',
    text: 'Power was not measured for either design, so the report makes no energy or efficiency claim.',
  },
  {
    topic: 'Memory accesses',
    text: 'The two access counts measure different things: the CPU’s are every data-memory read and write of the program (operands, the accumulator read-modify-write, the cptr variable and the one PUSH/POP), the accelerator’s are host-port transfers only.',
  },
  {
    topic: 'Resources',
    text: 'The generic Yosys flows differ: the CPU baseline maps its 256-byte memory to flip-flops (2048 of its flip-flops), while the accelerator baseline keeps its buffers as memory cells outside the cell count. The ECP5 rows (both designs’ memories in block RAM, multipliers in DSP blocks) are the closest like-for-like resource comparison.',
  },
] as const;

const Count = z.number().int().nonnegative();
const Ratio = z.number().nonnegative();
const Dims = z.strictObject({
  m: z.number().int().positive(),
  n: z.number().int().positive(),
  k: z.number().int().positive(),
});

const CpuMeasuredSchema = z.strictObject({
  status: z.literal('measured'),
  program: z.strictObject({
    codeBytes: Count,
    dataBytes: Count,
    stackBytes: Count,
    totalBytes: Count,
    /** Addresses of the cptr variable and of A, B and C. */
    layout: z.strictObject({ cptr: Count, a: Count, b: Count, c: Count, end: Count }),
  }),
  emulator: z.strictObject({
    instructions: Count,
    estimatedCycles: Count,
    memoryReads: Count,
    memoryWrites: Count,
    fetchedBytes: Count,
  }),
  rtl: z.strictObject({
    cycles: Count,
    instructions: Count,
    memoryReads: Count,
    memoryWrites: Count,
    fetchedBytes: Count,
    cpi: Ratio,
  }),
  macsPerCycle: Ratio,
  cyclesPerMac: Ratio,
  /** The emulator's and the RTL's end memories are identical, all 256 bytes. */
  endMemoryAgrees: z.literal(true),
});

const CpuSideSchema = z.discriminatedUnion('status', [
  CpuMeasuredSchema,
  z.strictObject({
    status: z.literal('unsupported'),
    codeBytes: Count,
    dataBytes: Count,
    stackBytes: Count,
    totalBytes: Count,
    memoryBytes: z.literal(MEMORY_SIZE),
    reason: z.string().min(1),
  }),
  z.strictObject({ status: z.literal('failed'), reason: z.string().min(1) }),
]);

const AcceleratorSideSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('measured'),
    size: z.string(),
    tiles: Count,
    transferIn: Count,
    compute: Count,
    store: Count,
    /** total − transferIn − compute − store − transferOut: start, LOAD and NEXT_TILE. */
    handshake: Count,
    busy: Count,
    transferOut: Count,
    total: Count,
    utilization: Ratio,
    macsPerCycleCompute: Ratio,
    macsPerCycleTotal: Ratio,
    hostWrites: Count,
    hostReads: Count,
  }),
  z.strictObject({ status: z.literal('failed'), reason: z.string().min(1) }),
]);

export const CompareRowSchema = z.strictObject({
  workload: z.string().min(1),
  dims: Dims,
  generator: z.string().min(1),
  what: z.string(),
  macs: Count,
  cpu: CpuSideSchema,
  accelerator: AcceleratorSideSchema,
  /** CPU RTL cycles ÷ accelerator total cycles, when both were measured. */
  cycleRatio: Ratio.nullable(),
});
export type CompareRow = z.output<typeof CompareRowSchema>;

const FpgaResourcesSchema = z.strictObject({
  device: z.string(),
  luts: Count,
  carry: Count,
  flipFlops: Count,
  blockRam: Count,
  dsp: Count,
  /** Whether nextpnr placed and routed the design on the device. */
  fits: z.boolean(),
});

const GenericResourcesSchema = z.strictObject({
  cells: Count,
  flipFlops: Count,
  combinational: Count,
  memories: Count,
});

export const CompareResourcesSchema = z.strictObject({
  cpu: z.strictObject({
    source: z.literal(COMPARE_BASELINES.cpu),
    gitSha: z.string(),
    top: z.string(),
    generic: GenericResourcesSchema,
    /** vcpu8_core: the CPU without its 256-byte memory. */
    core: GenericResourcesSchema,
    ice40: FpgaResourcesSchema,
    ecp5: FpgaResourcesSchema,
  }),
  accelerator: z.strictObject({
    source: z.literal(COMPARE_BASELINES.accelerator),
    gitSha: z.string(),
    size: z.string(),
    top: z.string(),
    generic: GenericResourcesSchema,
    /** The systolic array and the controller: the accelerator without its buffers. */
    compute: GenericResourcesSchema,
    memoryBits: Count,
    multipliers: Count,
    ice40: FpgaResourcesSchema,
    ecp5: FpgaResourcesSchema,
  }),
});
export type CompareResources = z.output<typeof CompareResourcesSchema>;

export const CompareReportSchema = z.strictObject({
  schemaVersion: z.literal(CPU_COMPARISON_SCHEMA_VERSION),
  kind: z.literal(CPU_COMPARISON_KIND),
  /** hardware/accelerators/matmul/REVISION. */
  revision: z.string().min(1),
  /** hardware/rtl/vcpu8/REVISION. */
  cpuRevision: z.string().min(1),
  labels: z.strictObject({
    mac: z.literal(COMPARE_LABELS.mac),
    cpuCycles: z.literal(COMPARE_LABELS.cpuCycles),
    cpuMemory: z.literal(COMPARE_LABELS.cpuMemory),
    acceleratorCycles: z.literal(COMPARE_LABELS.acceleratorCycles),
    acceleratorMemory: z.literal(COMPARE_LABELS.acceleratorMemory),
    ratio: z.literal(COMPARE_LABELS.ratio),
  }),
  config: z.strictObject({
    notation: z.string().min(1),
    seed: Count,
    acceleratorArray: z.string(),
    memoryBytes: z.literal(MEMORY_SIZE),
    correctnessGate: z.string().min(1),
  }),
  verification: z.strictObject({
    gate: z.enum(['passed', 'failed']),
    /** CPU workloads measured on both the emulator and the RTL, every one correct. */
    cpuMeasured: Count,
    cpuUnsupported: Count,
    acceleratorMeasured: Count,
    failed: z.array(z.string()),
  }),
  rows: z.array(CompareRowSchema),
  /** The largest cube M = N = K that fits in VCPU-8 memory, and its byte count. */
  largestCpuCube: z.strictObject({ side: Count, totalBytes: Count }),
  unsupported: z.array(
    z.strictObject({ workload: z.string(), totalBytes: Count, reason: z.string() }),
  ),
  resources: CompareResourcesSchema,
  caveats: z.array(z.strictObject({ topic: z.string(), text: z.string() })),
  provenance: z.strictObject({
    createdAt: z.iso.datetime(),
    gitCommit: z.string().nullable(),
    gitShortCommit: z.string().nullable(),
    gitDirty: z.boolean().nullable(),
    runners: z.strictObject({ vcpu8: z.string(), accelerator: z.string() }),
    toolchain: z.string().nullable(),
    tools: z.record(z.string(), z.string().nullable()).nullable(),
  }),
});
export type CompareReport = z.output<typeof CompareReportSchema>;

export const COMPARE_GATE =
  'A CPU workload has numbers only when its program halted on both the emulator and the Project 2 RTL, C read back from memory equals @vcpu/accelerator-reference element by element on both, both retired the same number of instructions with the same data reads, data writes and fetched bytes, and their end memories are identical. An accelerator workload has numbers only when the 4 × 4 runner reached done and C equals the reference. Any failure leaves the reason, no numbers, and exit 1.';

/** A path relative to the repository root when it is inside it. */
function repoPath(path: string): string {
  const rel = relative(REPO, resolve(path));
  return rel.startsWith('..') ? path : rel;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(6));
}

// ---- resources from the committed synthesis baselines ----

const CellsSchema = z.object({
  cells: Count,
  flipFlops: Count,
  combinational: Count,
  memories: Count,
});
const FpgaSynthSchema = z.object({
  luts: Count,
  carry: Count,
  flipFlops: Count,
  blockRam: Count,
  dsp: Count,
});
/** A flow that ran (an absent one fails to parse): nextpnr placed and routed it. */
const CpuFpgaFlowSchema = z.object({
  status: z.literal('ran'),
  device: z.string(),
  synth: FpgaSynthSchema,
  pnr: z.object({
    utilisation: z.record(z.string(), z.object({ used: Count, available: Count })),
  }),
});

/** Whether every resource nextpnr placed is within the device's count. */
function withinDevice(flow: z.output<typeof CpuFpgaFlowSchema>): boolean {
  return Object.values(flow.pnr.utilisation).every((u) => u.used <= u.available);
}

const CpuBaselineSchema = z.object({
  provenance: z.object({ gitSha: z.string() }),
  generic: z.object({
    top: z.string(),
    total: CellsSchema,
    subtrees: z.object({ vcpu8_core: CellsSchema }),
  }),
  fpga: z.object({
    ice40: CpuFpgaFlowSchema,
    ecp5: CpuFpgaFlowSchema,
  }),
});
const AccelFpgaSchema = z.object({ device: z.string(), synth: FpgaSynthSchema, fits: z.boolean() });
const AccelBaselineSchema = z.object({
  provenance: z.object({ gitSha: z.string() }),
  sizes: z.array(
    z.object({
      size: z.string(),
      generic: z.object({
        top: z.string(),
        total: CellsSchema,
        blocks: z.array(CellsSchema.extend({ block: z.string() })),
        mulCells: Count,
        memoryBits: Count,
      }),
      fpga: z.object({ ice40: AccelFpgaSchema, ecp5: AccelFpgaSchema }),
    }),
  ),
});

function cells(c: z.output<typeof CellsSchema>) {
  return {
    cells: c.cells,
    flipFlops: c.flipFlops,
    combinational: c.combinational,
    memories: c.memories,
  };
}

function fpga(device: string, synth: z.output<typeof FpgaSynthSchema>, fits: boolean) {
  const { luts, carry, flipFlops, blockRam, dsp } = synth;
  return { device, luts, carry, flipFlops, blockRam, dsp, fits };
}

/** The resource section from the two committed baselines (paths relative to `repo`). */
export function readCompareResources(
  repo = REPO,
  size = sizeName(COMPARE_ARRAY),
): CompareResources {
  const read = (file: string) => JSON.parse(readFileSync(join(repo, file), 'utf8')) as unknown;
  const cpu = CpuBaselineSchema.parse(read(COMPARE_BASELINES.cpu));
  const accel = AccelBaselineSchema.parse(read(COMPARE_BASELINES.accelerator));
  const entry = accel.sizes.find((s) => s.size === size);
  if (entry === undefined) {
    throw new Error(`${COMPARE_BASELINES.accelerator} has no ${size} entry`);
  }
  const block = (name: string) => {
    const found = entry.generic.blocks.find((b) => b.block === name);
    if (found === undefined) {
      throw new Error(`${COMPARE_BASELINES.accelerator} ${size} has no block ${name}`);
    }
    return found;
  };
  const array = block('u_array');
  const controller = block('u_controller');
  return CompareResourcesSchema.parse({
    cpu: {
      source: COMPARE_BASELINES.cpu,
      gitSha: cpu.provenance.gitSha,
      top: cpu.generic.top,
      generic: cells(cpu.generic.total),
      core: cells(cpu.generic.subtrees.vcpu8_core),
      ice40: fpga(cpu.fpga.ice40.device, cpu.fpga.ice40.synth, withinDevice(cpu.fpga.ice40)),
      ecp5: fpga(cpu.fpga.ecp5.device, cpu.fpga.ecp5.synth, withinDevice(cpu.fpga.ecp5)),
    },
    accelerator: {
      source: COMPARE_BASELINES.accelerator,
      gitSha: accel.provenance.gitSha,
      size,
      top: entry.generic.top,
      generic: cells(entry.generic.total),
      compute: {
        cells: array.cells + controller.cells,
        flipFlops: array.flipFlops + controller.flipFlops,
        combinational: array.combinational + controller.combinational,
        memories: array.memories + controller.memories,
      },
      memoryBits: entry.generic.memoryBits,
      multipliers: entry.generic.mulCells,
      ice40: fpga(entry.fpga.ice40.device, entry.fpga.ice40.synth, entry.fpga.ice40.fits),
      ecp5: fpga(entry.fpga.ecp5.device, entry.fpga.ecp5.synth, entry.fpga.ecp5.fits),
    },
  });
}

// ---- running the CPU side ----

/** Data reads, writes and fetched bytes of the retired steps of an RTL trace. */
export function traceAccesses(
  trace: readonly RtlTraceStep[],
  instructions: number,
): { memoryReads: number; memoryWrites: number; fetchedBytes: number } {
  let memoryReads = 0;
  let memoryWrites = 0;
  let fetchedBytes = 0;
  for (const step of trace.slice(0, instructions)) {
    const info = opcodeByByte[step.ir[0] ?? -1];
    if (info === undefined) throw new Error(`step ${String(step.step)} retired an invalid opcode`);
    memoryReads += info.dataReads;
    memoryWrites += info.dataWrites;
    fetchedBytes += info.length;
  }
  return { memoryReads, memoryWrites, fetchedBytes };
}

function sameValues(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function firstDifference(expected: Int32Array, actual: Int32Array): string {
  const i = expected.findIndex((v, index) => v !== actual[index]);
  return `C[${String(i)}] = ${String(actual[i])}, the reference has ${String(expected[i])}`;
}

/** Runs one program on the emulator and the RTL; the CPU side of its row. */
async function runCpu(
  program: CpuProgram,
  expected: Int32Array,
  vcpu8Sim: string,
  dir: string,
  name: string,
): Promise<z.input<typeof CpuSideSchema>> {
  writeFileSync(join(dir, `${name}.asm`), program.source);
  const cpu = createCpu({ traceCapacity: 0 });
  cpu.loadProgram(program.image);
  const run = cpu.run({ maxInstructions: 10_000_000 });
  const emu = cpu.getState();
  if (run.stopReason !== 'halted') {
    return {
      status: 'failed',
      reason: `the emulator stopped with ${run.stopReason}${emu.fault === null ? '' : ` (${emu.fault.code} at ${String(emu.fault.pc)})`}`,
    };
  }
  const emuC = readCpuResult(emu.memory, program);
  if (!sameValues(emuC, expected)) {
    return { status: 'failed', reason: `emulator: ${firstDifference(expected, emuC)}` };
  }
  const metrics = cpu.getMetrics();

  const files = {
    image: join(dir, `${name}.mem.hex`),
    state: join(dir, `${name}.state.json`),
    trace: join(dir, `${name}.trace.jsonl`),
  };
  writeFileSync(files.image, formatMemoryHex(Array.from(program.image)));
  const rtl = await runRtl(vcpu8Sim, files, 2 * metrics.instructions + 64);
  if (!rtl.ok) return { status: 'failed', reason: `RTL: ${rtl.error}` };
  const { state, trace } = rtl;
  if (state.status !== CpuStatus.HALTED) {
    return {
      status: 'failed',
      reason: `the RTL stopped ${state.status} (${state.stopReason})${state.fault === null ? '' : `, ${state.fault.code}`}`,
    };
  }
  const rtlC = readCpuResult(state.memory, program);
  if (!sameValues(rtlC, expected)) {
    return { status: 'failed', reason: `RTL: ${firstDifference(expected, rtlC)}` };
  }
  if (state.instructions !== metrics.instructions) {
    return {
      status: 'failed',
      reason: `the RTL retired ${String(state.instructions)} instructions, the emulator ${String(metrics.instructions)}`,
    };
  }
  if (!sameValues(state.memory, emu.memory)) {
    const i = emu.memory.findIndex((v, index) => v !== state.memory[index]);
    return {
      status: 'failed',
      reason: `the end memories differ at 0x${i.toString(16)}: RTL ${String(state.memory[i])}, emulator ${String(emu.memory[i])}`,
    };
  }
  const accesses = traceAccesses(trace, state.instructions);
  for (const [what, rtlCount, emuCount] of [
    ['data reads', accesses.memoryReads, metrics.memoryReads],
    ['data writes', accesses.memoryWrites, metrics.memoryWrites],
    ['fetched bytes', accesses.fetchedBytes, metrics.fetchedBytes],
  ] as const) {
    if (rtlCount !== emuCount) {
      return {
        status: 'failed',
        reason: `the RTL trace has ${String(rtlCount)} ${what}, the emulator ${String(emuCount)}`,
      };
    }
  }
  const macs = program.dims.m * program.dims.n * program.dims.k;
  return {
    status: 'measured',
    program: {
      codeBytes: program.layout.codeBytes,
      dataBytes: program.dataBytes,
      stackBytes: CPU_STACK_BYTES,
      totalBytes: program.totalBytes,
      layout: {
        cptr: program.layout.cptr,
        a: program.layout.a,
        b: program.layout.b,
        c: program.layout.c,
        end: program.layout.end,
      },
    },
    emulator: {
      instructions: metrics.instructions,
      estimatedCycles: metrics.estimatedCycles,
      memoryReads: metrics.memoryReads,
      memoryWrites: metrics.memoryWrites,
      fetchedBytes: metrics.fetchedBytes,
    },
    rtl: {
      cycles: state.cycles,
      instructions: state.instructions,
      ...accesses,
      cpi: ratio(state.cycles, state.instructions),
    },
    macsPerCycle: ratio(macs, state.cycles),
    cyclesPerMac: ratio(state.cycles, macs),
    endMemoryAgrees: true,
  };
}

/** Runs one workload on the 4 × 4 runner; the accelerator side of its row. */
async function runAccelerator(
  w: CompareWorkload,
  operands: { a: Int8Array; b: Int8Array },
  sim: string,
  size: ArraySize,
  dir: string,
  seed: number,
): Promise<z.input<typeof AcceleratorSideSchema>> {
  const written = writeCase(
    dir,
    w.name,
    { ...w.dims, ...operands },
    { seed, generator: w.generator },
  );
  const files = {
    expected: written.expected,
    out: join(dir, `${w.name}.out`),
    cycles: join(dir, `${w.name}.cycles.json`),
  };
  const run = await runRunner(sim, [
    '--case',
    written.input,
    '--out',
    files.out,
    '--cycles',
    files.cycles,
    '--max-cycles',
    String(cycleLimit(size, w.dims)),
    '--quiet',
  ]);
  const outcome = judge(
    { dims: w.dims, flags: { repeat: 1, resetBetween: false, abortFirst: false } },
    run,
    files,
  );
  if (outcome.reason !== null || outcome.cycles === null) {
    return { status: 'failed', reason: outcome.reason ?? 'no clock counts' };
  }
  const m = benchmarkMetrics(size, w.dims, outcome.cycles);
  const { m: rows, n, k } = w.dims;
  return {
    status: 'measured',
    size: sizeName(size),
    tiles: m.tiles,
    transferIn: m.transferIn,
    compute: m.compute,
    store: m.store,
    handshake: m.total - m.transferIn - m.compute - m.store - m.transferOut,
    busy: m.busy,
    transferOut: m.transferOut,
    total: m.total,
    utilization: m.utilization,
    macsPerCycleCompute: m.macsPerCycleCompute,
    macsPerCycleTotal: m.macsPerCycleTotal,
    hostWrites: rows * k + k * n,
    hostReads: rows * n,
  };
}

/** The largest M = N = K whose program fits in memory. */
export function largestCpuCube(): { side: number; totalBytes: number } {
  let best = { side: 0, totalBytes: 0 };
  for (let side = 1; side <= 16; side += 1) {
    const dims = { m: side, n: side, k: side };
    const length = side * side;
    const result = generateCpuProgram(dims, new Int8Array(length), new Int8Array(length));
    if (!result.ok) break;
    best = { side, totalBytes: result.program.totalBytes };
  }
  return best;
}

export interface CompareOptions {
  readonly vcpu8Sim: string;
  readonly acceleratorSim: string;
  readonly seed: number;
  readonly workloads?: readonly CompareWorkload[];
  readonly work: string;
  readonly out: string;
  /** A directory to also write `<date>-<shortsha>.{json,md}` into. */
  readonly publish?: string | undefined;
  readonly allowDirty?: boolean;
  readonly provenance?: Provenance;
  readonly now?: Date;
}

export interface CompareOutcome {
  readonly exitCode: number;
  readonly report: CompareReport | null;
}

/** `2026-10-24-ab12cd3`: the published report's base name (the UTC date of `createdAt`). */
export function comparePublishedName(report: CompareReport): string {
  return `${report.provenance.createdAt.slice(0, 10)}-${report.provenance.gitShortCommit ?? 'nogit'}`;
}

/** Writes `<base>.json` and `<base>.md`. */
export function writeCompareFiles(base: string, report: CompareReport): void {
  writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${base}.md`, renderCompareMarkdown(report));
}

/**
 * Runs every workload on both machines, gates each on the reference and writes the report.
 * Exit code 0 when every row that ran passed, 1 when any failed (the report is still written,
 * without numbers for those), 2 when the run could not start.
 */
export async function runCompareCpu(
  options: CompareOptions,
  write: (text: string) => void,
): Promise<CompareOutcome> {
  const workloads = options.workloads ?? COMPARE_WORKLOADS;
  for (const [what, sim] of [
    ['VCPU-8 RTL runner', options.vcpu8Sim],
    ['accelerator runner', options.acceleratorSim],
  ] as const) {
    if (!existsSync(sim)) {
      write(`compare-cpu: no ${what} at ${sim}\n`);
      return { exitCode: 2, report: null };
    }
  }
  const provenance = options.provenance ?? readProvenance();
  if (
    options.publish !== undefined &&
    provenance.git.dirty !== false &&
    options.allowDirty !== true
  ) {
    write(
      `compare-cpu: refusing to publish from ${provenance.git.dirty === null ? 'outside a git checkout' : 'a dirty working tree'}; commit first (or ALLOW_DIRTY=1, and do not commit the result)\n`,
    );
    return { exitCode: 2, report: null };
  }
  let size: ArraySize;
  try {
    size = await runnerInfo(options.acceleratorSim);
  } catch (error) {
    write(`compare-cpu: ${(error as Error).message}\n`);
    return { exitCode: 2, report: null };
  }
  if (sizeName(size) !== sizeName(COMPARE_ARRAY)) {
    write(
      `compare-cpu: ${options.acceleratorSim} is the ${sizeName(size)} runner; the comparison uses ${sizeName(COMPARE_ARRAY)}\n`,
    );
    return { exitCode: 2, report: null };
  }
  rmSync(options.work, { recursive: true, force: true });
  const cpuDir = join(options.work, 'cpu');
  const accelDir = join(options.work, 'accelerator');
  mkdirSync(cpuDir, { recursive: true });
  mkdirSync(accelDir, { recursive: true });
  write(
    `compare-cpu: ${String(workloads.length)} workloads (seed ${String(options.seed)}) on VCPU-8 (emulator + RTL) and the ${sizeName(size)} accelerator\n`,
  );

  const rows: CompareRow[] = [];
  for (const w of workloads) {
    validateDims(w.dims);
    const operands = generateOperands(w.generator, options.seed, w.dims);
    const expected = matmulInt8(operands.a, operands.b, w.dims);
    const macs = w.dims.m * w.dims.n * w.dims.k;
    const generated = generateCpuProgram(w.dims, operands.a, operands.b);
    const cpu: z.input<typeof CpuSideSchema> = generated.ok
      ? await runCpu(generated.program, expected, options.vcpu8Sim, cpuDir, w.name)
      : {
          status: 'unsupported',
          codeBytes: generated.codeBytes,
          dataBytes: generated.dataBytes,
          stackBytes: generated.stackBytes,
          totalBytes: generated.totalBytes,
          memoryBytes: MEMORY_SIZE,
          reason: generated.reason,
        };
    const accelerator = await runAccelerator(
      w,
      operands,
      options.acceleratorSim,
      size,
      accelDir,
      options.seed,
    );
    const cycleRatio =
      cpu.status === 'measured' && accelerator.status === 'measured'
        ? ratio(cpu.rtl.cycles, accelerator.total)
        : null;
    rows.push(
      CompareRowSchema.parse({
        workload: w.name,
        dims: w.dims,
        generator: w.generator,
        what: w.what,
        macs,
        cpu,
        accelerator,
        cycleRatio,
      }),
    );
    const cpuText =
      cpu.status === 'measured'
        ? `CPU ${String(cpu.rtl.cycles)} cycles (RTL), ${String(cpu.rtl.instructions)} instructions`
        : cpu.status === 'unsupported'
          ? `CPU unsupported (${String(cpu.totalBytes)} bytes > ${String(MEMORY_SIZE)})`
          : `CPU FAILED: ${cpu.reason}`;
    const accelText =
      accelerator.status === 'measured'
        ? `accelerator ${String(accelerator.total)} cycles total`
        : `accelerator FAILED: ${accelerator.reason}`;
    write(`  ${w.name.padEnd(16)} ${cpuText}; ${accelText}\n`);
  }

  const failed = rows.flatMap((r) => [
    ...(r.cpu.status === 'failed' ? [`${r.workload} on the CPU: ${r.cpu.reason}`] : []),
    ...(r.accelerator.status === 'failed'
      ? [`${r.workload} on the accelerator: ${r.accelerator.reason}`]
      : []),
  ]);
  const cpuMeasured = rows.filter((r) => r.cpu.status === 'measured').length;
  const createdAt = (options.now ?? new Date()).toISOString();
  const report = CompareReportSchema.parse({
    schemaVersion: CPU_COMPARISON_SCHEMA_VERSION,
    kind: CPU_COMPARISON_KIND,
    revision: provenance.revision,
    cpuRevision: readFileSync(join(REPO, 'hardware', 'rtl', 'vcpu8', 'REVISION'), 'utf8').trim(),
    labels: COMPARE_LABELS,
    config: {
      notation: 'M × K × N (A is M × K, B is K × N, C is M × N), then the operand generator',
      seed: options.seed,
      acceleratorArray: sizeName(size),
      memoryBytes: MEMORY_SIZE,
      correctnessGate: COMPARE_GATE,
    },
    verification: {
      gate: failed.length === 0 && cpuMeasured > 0 ? 'passed' : 'failed',
      cpuMeasured,
      cpuUnsupported: rows.filter((r) => r.cpu.status === 'unsupported').length,
      acceleratorMeasured: rows.filter((r) => r.accelerator.status === 'measured').length,
      failed,
    },
    rows,
    largestCpuCube: largestCpuCube(),
    unsupported: rows.flatMap((r) =>
      r.cpu.status === 'unsupported'
        ? [{ workload: r.workload, totalBytes: r.cpu.totalBytes, reason: r.cpu.reason }]
        : [],
    ),
    resources: readCompareResources(),
    caveats: COMPARE_CAVEATS,
    provenance: {
      createdAt,
      gitCommit: provenance.git.commit,
      gitShortCommit: provenance.git.commit?.slice(0, 7) ?? null,
      gitDirty: provenance.git.dirty,
      runners: {
        vcpu8: repoPath(options.vcpu8Sim),
        accelerator: repoPath(options.acceleratorSim),
      },
      toolchain: provenance.toolchain,
      tools: provenance.tools,
    },
  });

  mkdirSync(options.out, { recursive: true });
  const base = join(options.out, 'cpu-comparison');
  writeCompareFiles(base, report);
  write(`wrote ${base}.json and cpu-comparison.md\n`);
  if (report.verification.gate === 'failed') {
    write(
      `compare-cpu: FAIL${failed.length === 0 ? ', no CPU workload was measured' : `: ${failed.join('; ')}`}\n`,
    );
    if (options.publish !== undefined) write('compare-cpu: nothing published\n');
    return { exitCode: 1, report };
  }
  if (options.publish !== undefined) {
    mkdirSync(options.publish, { recursive: true });
    const published = join(options.publish, comparePublishedName(report));
    writeCompareFiles(published, report);
    write(`wrote ${published}.json and .md\n`);
  }
  write(
    `compare-cpu: PASS, ${String(cpuMeasured)} CPU workloads correct on the emulator and the RTL, ${String(report.verification.cpuUnsupported)} unsupported, ${String(report.verification.acceleratorMeasured)} accelerator workloads correct\n`,
  );
  return { exitCode: 0, report };
}

// ---- Markdown ----

function fmt(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function table(header: readonly string[], body: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ];
}

export function renderCompareMarkdown(report: CompareReport): string {
  const { provenance: p, resources: r } = report;
  const measured = report.rows.filter(
    (row): row is CompareRow & { cpu: z.output<typeof CpuMeasuredSchema> } =>
      row.cpu.status === 'measured',
  );
  const lines: string[] = [
    '# VCPU-8 vs the INT8 matmul accelerator',
    '',
    `Accelerator revision \`${report.revision}\` on the ${report.config.acceleratorArray} array, VCPU-8 revision \`${report.cpuRevision}\`; seed ${String(report.config.seed)}; commit \`${p.gitShortCommit ?? 'none'}\`${p.gitDirty === true ? ' (dirty working tree)' : ''}; ${p.createdAt}.`,
    'Produced by `make -C hardware/accelerators/matmul compare-cpu`; docs/hardware/accelerators/cpu-comparison.md explains the method.',
    '',
    `**Correctness gate: ${report.verification.gate}.** ${report.config.correctnessGate}`,
    '',
    `${String(report.verification.cpuMeasured)} CPU workloads measured, ${String(report.verification.cpuUnsupported)} unsupported on the CPU, ${String(report.verification.acceleratorMeasured)} measured on the accelerator.`,
  ];
  if (report.verification.failed.length > 0) {
    lines.push('', 'Failed:', ...report.verification.failed.map((f) => `- ${f}`));
  }
  lines.push(
    '',
    '## Side by side',
    '',
    ...table(
      [
        'Workload',
        'MACs',
        'CPU cycles (RTL)',
        'CPU MACs/cycle',
        'Accelerator total cycles',
        'Accelerator MACs/cycle (total)',
        'Cycle ratio',
      ],
      report.rows.map((row) => [
        row.workload,
        String(row.macs),
        row.cpu.status === 'measured'
          ? String(row.cpu.rtl.cycles)
          : row.cpu.status === 'unsupported'
            ? `unsupported (${String(row.cpu.totalBytes)} B)`
            : 'FAILED',
        row.cpu.status === 'measured' ? fmt(row.cpu.macsPerCycle, 4) : '—',
        row.accelerator.status === 'measured' ? String(row.accelerator.total) : 'FAILED',
        row.accelerator.status === 'measured' ? fmt(row.accelerator.macsPerCycleTotal) : '—',
        row.cycleRatio === null ? '—' : fmt(row.cycleRatio, 1),
      ]),
    ),
    '',
    COMPARE_LABELS.ratio,
    '',
    '## VCPU-8',
    '',
    ...table(
      [
        'Workload',
        'Program bytes (code + data + stack)',
        'Instructions (RTL = emulator)',
        'Cycles (RTL)',
        'Estimated cycles (emulator model)',
        'CPI',
        'Data reads',
        'Data writes',
        'Fetched bytes',
        'Cycles per MAC',
      ],
      measured.map((row) => [
        row.workload,
        `${String(row.cpu.program.totalBytes)} (${String(row.cpu.program.codeBytes)} + ${String(row.cpu.program.dataBytes)} + ${String(row.cpu.program.stackBytes)})`,
        String(row.cpu.rtl.instructions),
        String(row.cpu.rtl.cycles),
        String(row.cpu.emulator.estimatedCycles),
        fmt(row.cpu.rtl.cpi),
        String(row.cpu.rtl.memoryReads),
        String(row.cpu.rtl.memoryWrites),
        String(row.cpu.rtl.fetchedBytes),
        fmt(row.cpu.cyclesPerMac, 1),
      ]),
    ),
    '',
    COMPARE_LABELS.cpuCycles,
    COMPARE_LABELS.cpuMemory,
    'The emulator’s instruction count, data reads, data writes and fetched bytes equal the RTL trace’s for every row (the gate checks it, and identical end memories).',
    '',
    `Largest cube that fits in ${String(report.config.memoryBytes)} bytes: ${String(report.largestCpuCube.side)} × ${String(report.largestCpuCube.side)} × ${String(report.largestCpuCube.side)} (${String(report.largestCpuCube.totalBytes)} bytes).`,
  );
  if (report.unsupported.length > 0) {
    lines.push(
      '',
      'Unsupported on the CPU:',
      '',
      ...report.unsupported.map((u) => `- ${u.workload}: ${u.reason}.`),
    );
  }
  lines.push(
    '',
    `## Accelerator (${report.config.acceleratorArray})`,
    '',
    ...table(
      [
        'Workload',
        'Tiles',
        'Transfer in',
        'Compute',
        'Store',
        'Start, LOAD, NEXT_TILE',
        'Transfer out',
        'Total',
        'Busy',
        'PE utilization',
        'MACs/cycle (compute)',
        'MACs/cycle (total)',
        'Host writes',
        'Host reads',
      ],
      report.rows.map((row) =>
        row.accelerator.status === 'measured'
          ? [
              row.workload,
              String(row.accelerator.tiles),
              String(row.accelerator.transferIn),
              String(row.accelerator.compute),
              String(row.accelerator.store),
              String(row.accelerator.handshake),
              String(row.accelerator.transferOut),
              String(row.accelerator.total),
              String(row.accelerator.busy),
              fmt(row.accelerator.utilization),
              fmt(row.accelerator.macsPerCycleCompute),
              fmt(row.accelerator.macsPerCycleTotal),
              String(row.accelerator.hostWrites),
              String(row.accelerator.hostReads),
            ]
          : [row.workload, `FAILED: ${row.accelerator.reason}`, ...new Array<string>(12).fill('')],
      ),
    ),
    '',
    COMPARE_LABELS.acceleratorCycles,
    COMPARE_LABELS.acceleratorMemory,
    '',
    '## Resources',
    '',
    `From the committed synthesis baselines: \`${r.cpu.source}\` (commit \`${r.cpu.gitSha.slice(0, 7)}\`) and \`${r.accelerator.source}\` (${r.accelerator.size}, commit \`${r.accelerator.gitSha.slice(0, 7)}\`).`,
    '',
    ...table(
      ['Design', 'Generic cells', 'Generic flip-flops', 'Memory cells', 'Notes'],
      [
        [
          `VCPU-8 (${r.cpu.top})`,
          String(r.cpu.generic.cells),
          String(r.cpu.generic.flipFlops),
          String(r.cpu.generic.memories),
          'the 256-byte memory is mapped to flip-flops in the generic flow',
        ],
        [
          'VCPU-8 core (no memory)',
          String(r.cpu.core.cells),
          String(r.cpu.core.flipFlops),
          String(r.cpu.core.memories),
          'vcpu8_core',
        ],
        [
          `Accelerator ${r.accelerator.size} (${r.accelerator.top})`,
          String(r.accelerator.generic.cells),
          String(r.accelerator.generic.flipFlops),
          String(r.accelerator.generic.memories),
          `buffers kept as memory cells (${String(r.accelerator.memoryBits)} bits, not in the cell count); ${String(r.accelerator.multipliers)} multipliers`,
        ],
        [
          'Accelerator array + controller',
          String(r.accelerator.compute.cells),
          String(r.accelerator.compute.flipFlops),
          String(r.accelerator.compute.memories),
          'systolic_array and matmul_controller',
        ],
      ],
    ),
    '',
    ...table(
      ['Design', 'FPGA', 'LUTs', 'Carry', 'Flip-flops', 'Block RAM', 'DSP', 'Fits'],
      (
        [
          { design: 'VCPU-8', d: r.cpu.ice40 },
          { design: 'VCPU-8', d: r.cpu.ecp5 },
          { design: `Accelerator ${r.accelerator.size}`, d: r.accelerator.ice40 },
          { design: `Accelerator ${r.accelerator.size}`, d: r.accelerator.ecp5 },
        ] as const
      ).map(({ design, d }) => {
        return [
          design,
          d.device,
          String(d.luts),
          String(d.carry),
          String(d.flipFlops),
          String(d.blockRam),
          String(d.dsp),
          d.fits ? 'yes' : 'no',
        ];
      }),
    ),
    '',
    '## What differs',
    '',
    ...report.caveats.map((c) => `- **${c.topic}.** ${c.text}`),
    '',
    '## Provenance',
    '',
    `- Commit: \`${p.gitCommit ?? 'none'}\`${p.gitDirty === null ? '' : `, working tree ${p.gitDirty ? 'dirty' : 'clean'}`}`,
    `- Runners: VCPU-8 \`${p.runners.vcpu8}\`, accelerator \`${p.runners.accelerator}\``,
    `- Toolchain: ${p.toolchain ?? 'unknown (build/tool-versions.json absent)'}`,
  );
  if (p.tools !== null) {
    for (const [tool, version] of Object.entries(p.tools)) {
      lines.push(`- ${tool}: ${version ?? 'not found'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function defaultCompareOptions(vcpu8Sim: string, acceleratorSim: string): CompareOptions {
  return { ...COMPARE_DEFAULTS, vcpu8Sim, acceleratorSim };
}
