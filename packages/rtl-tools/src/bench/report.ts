import { OPCODE_IDS } from '@vcpu/shared';
import { z } from 'zod';
import { flattenLeaves, type Leaf, SYNTH_SUMMARY_FORMAT } from '../synth/summary.js';
import { type ClockGroup, INSTRUCTION_CLASSES } from './metrics.js';

/**
 * The RTL benchmark report: what `make benchmark` writes to build/reports/benchmark.json and
 * `make benchmark-baseline` commits under research/cpu/reports/. Everything outside `provenance`
 * and `host` is modelled processor behaviour, deterministic for a given design, program set and
 * synthesis summary; `benchmark-compare` checks that two runs agree on it byte for byte.
 * Fields are only ever added; removing or redefining one bumps `schemaVersion`.
 */
export const RTL_BENCHMARK_SCHEMA_VERSION = 1;
export const RTL_BENCHMARK_KIND = 'vcpu8-rtl-benchmark';

/** What each kind of number is, written into every report so no reader has to guess. */
export const LABELS = {
  rtl: 'RTL: clock cycles counted at real clock edges of the Verilated vcpu8_top, from reset release to the stop.',
  instructionalModel:
    'Instructional model: the emulator’s teaching estimate (@vcpu/cpu-core estimatedCycles, the ISA timing model). It is not a circuit and was not measured.',
  estimatedTime:
    'Estimated time: RTL cycles / nextpnr Fmax for the named device and timing model, at the place-and-route seed in the synthesis summary. A static timing estimate, not a measurement on hardware.',
  host: 'Host: wall-clock time this machine took to simulate. It measures the simulator, not the processor, and varies from run to run.',
} as const;

const Count = z.number().int().nonnegative();
const Classes = z.enum(INSTRUCTION_CLASSES);
const Opcodes = z.enum(OPCODE_IDS);

export const ClockGroupSchema = z.strictObject({
  instructions: Count.min(1),
  cycles: Count,
  cpi: z.number().nonnegative(),
  minClocks: Count,
  maxClocks: Count,
});

const BranchCountsSchema = z.strictObject({ taken: Count, notTaken: Count });

export const RtlMetricsSchema = z.strictObject({
  cycles: Count,
  instructions: Count,
  cpi: z.number().nonnegative().nullable(),
  byClass: z.partialRecord(Classes, ClockGroupSchema),
  byOpcode: z.partialRecord(Opcodes, ClockGroupSchema),
  branches: z.strictObject({
    taken: Count,
    notTaken: Count,
    byOpcode: z.partialRecord(Opcodes, BranchCountsSchema),
  }),
  jumps: Count,
  calls: Count,
  returns: Count,
  dataReads: Count,
  dataWrites: Count,
  fetchedBytes: Count,
});

export const InstructionalModelSchema = z.strictObject({
  estimatedCycles: Count,
  estimatedCpi: z.number().nonnegative().nullable(),
});

export const TimeEstimateSchema = z.strictObject({
  family: z.string().min(1),
  device: z.string().min(1),
  timingLabel: z.string().min(1),
  fmaxMHz: z.number().positive(),
  /** cycles / Fmax in MHz. */
  microseconds: z.number().nonnegative(),
});
export type TimeEstimate = z.output<typeof TimeEstimateSchema>;

const ProgramCommon = {
  name: z.string().min(1),
  /** The assembly source, relative to the repository root. */
  source: z.string().min(1),
  /** The step limit both CPUs ran under: the program's `.expect.json` `maxInstructions`. */
  maxSteps: Count.min(1),
};

export const ProgramResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...ProgramCommon,
    status: z.literal('ok'),
    rtl: RtlMetricsSchema,
    instructionalModel: InstructionalModelSchema,
    estimatedTime: z.array(TimeEstimateSchema),
  }),
  z.strictObject({
    ...ProgramCommon,
    /** It failed the correctness gate, did not halt or could not run: no numbers are reported. */
    status: z.literal('failed'),
    reason: z.string().min(1),
    /** The first differences from the reference, one line each. */
    mismatches: z.array(z.string()),
  }),
]);
export type ProgramResult = z.output<typeof ProgramResultSchema>;

const FpgaFlowSchema = z.discriminatedUnion('status', [
  z.strictObject({
    family: z.string().min(1),
    status: z.literal('ran'),
    device: z.string().min(1),
    timingLabel: z.string().min(1),
    luts: Count,
    flipFlops: Count,
    blockRam: Count,
    fmaxMHz: z.number().positive(),
    constraintMHz: z.number().positive(),
  }),
  z.strictObject({ family: z.string().min(1), status: z.literal('absent'), reason: z.string() }),
]);
export type FpgaFlowSummary = z.output<typeof FpgaFlowSchema>;

export const SynthesisSchema = z.discriminatedUnion('available', [
  z.strictObject({
    available: z.literal(true),
    /** The synthesis summary read, relative to the repository root. */
    source: z.string().min(1),
    /** The commit it was synthesised at. */
    gitSha: z.string().min(1),
    gitDirty: z.boolean(),
    generic: z.strictObject({
      top: z.string().min(1),
      cells: Count,
      flipFlops: Count,
      combinational: Count,
    }),
    fpga: z.array(FpgaFlowSchema),
  }),
  z.strictObject({
    available: z.literal(false),
    source: z.string().nullable(),
    /** Why there are no cell counts, Fmax or time estimates. */
    reason: z.string().min(1),
  }),
]);
export type Synthesis = z.output<typeof SynthesisSchema>;

export const VariantReportSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  hash: z.string().regex(/^[0-9a-f]{12}$/),
  defines: z.record(z.string(), z.union([z.literal(true), z.number(), z.string()])),
  parameters: z.record(z.string(), z.number()),
});

export const TotalsSchema = z.strictObject({
  programs: Count,
  cycles: Count,
  instructions: Count,
  cpi: z.number().nonnegative().nullable(),
  byClass: z.partialRecord(Classes, ClockGroupSchema),
  byOpcode: z.partialRecord(Opcodes, ClockGroupSchema),
  branchesTaken: Count,
  branchesNotTaken: Count,
  jumps: Count,
  calls: Count,
  returns: Count,
  dataReads: Count,
  dataWrites: Count,
  instructionalModelCycles: Count,
});
export type Totals = z.output<typeof TotalsSchema>;

export const ToolVersionsSchema = z.object({
  toolchain: z.object({ name: z.string(), pinnedVersion: z.string(), path: z.string().nullable() }),
  tools: z.record(z.string(), z.object({ path: z.string(), version: z.string() }).nullable()),
});

export const ProvenanceSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  git: z.strictObject({
    sha: z.string().nullable(),
    shortSha: z.string().nullable(),
    /** Uncommitted changes in the working tree; recorded, never blocking. */
    dirty: z.boolean().nullable(),
  }),
  /** The RTL runner, relative to the repository root when it is inside it. */
  runner: z.string().min(1),
  toolchain: z.string().nullable(),
  /** Tool name → version line, from build/tool-versions.json; null when it was not there. */
  tools: z.record(z.string(), z.string().nullable()).nullable(),
});

export const HostSchema = z.strictObject({
  label: z.literal(LABELS.host),
  runtime: z.string(),
  platform: z.string(),
  arch: z.string(),
  cpuModel: z.string(),
  totalWallMs: z.number().nonnegative(),
  programs: z.array(
    z.strictObject({
      name: z.string(),
      /** @vcpu/cpu-core, live, with the trace. */
      referenceMs: z.number().nonnegative(),
      /** The RTL runner process, start to exit. */
      rtlMs: z.number().nonnegative().nullable(),
    }),
  ),
});

export const RtlBenchmarkReportSchema = z.strictObject({
  schemaVersion: z.literal(RTL_BENCHMARK_SCHEMA_VERSION),
  kind: z.literal(RTL_BENCHMARK_KIND),
  /** hardware/rtl/vcpu8/REVISION. */
  revision: z.string().min(1),
  isaVersion: z.string().min(1),
  variant: VariantReportSchema,
  labels: z.strictObject({
    rtl: z.literal(LABELS.rtl),
    instructionalModel: z.literal(LABELS.instructionalModel),
    estimatedTime: z.literal(LABELS.estimatedTime),
  }),
  config: z.strictObject({
    suite: z.string().min(1),
    programDir: z.string().min(1),
    programs: z.array(z.string()),
    stepLimit: z.string().min(1),
    correctnessGate: z.string().min(1),
  }),
  verification: z.strictObject({
    gate: z.enum(['passed', 'failed']),
    programs: Count,
    passed: Count,
    failed: Count,
    failedPrograms: z.array(z.string()),
  }),
  synthesis: SynthesisSchema,
  /** The whole suite; null unless every program passed the gate. */
  totals: TotalsSchema.nullable(),
  programs: z.array(ProgramResultSchema),
  provenance: ProvenanceSchema,
  host: HostSchema,
});
export type RtlBenchmarkReport = z.output<typeof RtlBenchmarkReportSchema>;

// ---------------------------------------------------------------------------------------------
// Synthesis summary

/** The part of a synthesis summary (synth/summary.ts, `vcpu8-synth-summary/1`) a report uses. */
const SynthSummarySubsetSchema = z.object({
  format: z.literal(SYNTH_SUMMARY_FORMAT),
  provenance: z.object({ gitSha: z.string(), gitDirty: z.boolean() }),
  generic: z.object({
    top: z.string(),
    total: z.object({ cells: Count, flipFlops: Count, combinational: Count }),
  }),
  fpga: z.record(
    z.string(),
    z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ran'),
        device: z.string(),
        timingLabel: z.string(),
        synth: z.object({ luts: Count, flipFlops: Count, blockRam: Count }),
        pnr: z.object({ fmaxMHz: z.number().positive(), constraintMHz: z.number().positive() }),
      }),
      z.object({ status: z.literal('absent'), reason: z.string() }),
    ]),
  ),
  gate: z.object({ passed: z.boolean() }),
});

/** The synthesis section from a summary's JSON text, or why it cannot be used. */
export function synthesisFromSummary(source: string, text: string | null): Synthesis {
  if (text === null) {
    return { available: false, source, reason: `no synthesis summary at ${source}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { available: false, source, reason: `${source}: ${(error as Error).message}` };
  }
  const parsed = SynthSummarySubsetSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      available: false,
      source,
      reason: `${source} is not a synthesis summary: ${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`,
    };
  }
  const summary = parsed.data;
  if (!summary.gate.passed) {
    return { available: false, source, reason: `${source} failed its synthesis gate` };
  }
  return {
    available: true,
    source,
    gitSha: summary.provenance.gitSha,
    gitDirty: summary.provenance.gitDirty,
    generic: { top: summary.generic.top, ...summary.generic.total },
    fpga: Object.entries(summary.fpga).map(([family, flow]) =>
      flow.status === 'ran'
        ? {
            family,
            status: 'ran' as const,
            device: flow.device,
            timingLabel: flow.timingLabel,
            luts: flow.synth.luts,
            flipFlops: flow.synth.flipFlops,
            blockRam: flow.synth.blockRam,
            fmaxMHz: flow.pnr.fmaxMHz,
            constraintMHz: flow.pnr.constraintMHz,
          }
        : { family, status: 'absent' as const, reason: flow.reason },
    ),
  };
}

/** cycles / Fmax for every FPGA flow that ran; empty without a synthesis summary. */
export function timeEstimates(synthesis: Synthesis, cycles: number): TimeEstimate[] {
  if (!synthesis.available) return [];
  return synthesis.fpga.flatMap((flow) =>
    flow.status === 'ran'
      ? [
          {
            family: flow.family,
            device: flow.device,
            timingLabel: flow.timingLabel,
            fmaxMHz: flow.fmaxMHz,
            microseconds: cycles / flow.fmaxMHz,
          },
        ]
      : [],
  );
}

// ---------------------------------------------------------------------------------------------
// Totals

type Group = z.output<typeof ClockGroupSchema>;

function mergeGroups<K extends string>(
  order: readonly K[],
  all: readonly Partial<Record<K, ClockGroup>>[],
): Partial<Record<K, Group>> {
  const out: Partial<Record<K, Group>> = {};
  for (const key of order) {
    const groups = all.flatMap((g) => (g[key] === undefined ? [] : [g[key]]));
    if (groups.length === 0) continue;
    const instructions = groups.reduce((sum, g) => sum + g.instructions, 0);
    const cycles = groups.reduce((sum, g) => sum + g.cycles, 0);
    out[key] = {
      instructions,
      cycles,
      cpi: cycles / instructions,
      minClocks: Math.min(...groups.map((g) => g.minClocks)),
      maxClocks: Math.max(...groups.map((g) => g.maxClocks)),
    };
  }
  return out;
}

/** The suite's totals, or null when any program failed: no aggregate over a partial suite. */
export function suiteTotals(programs: readonly ProgramResult[]): Totals | null {
  const ok = programs.flatMap((p) => (p.status === 'ok' ? [p] : []));
  if (ok.length !== programs.length || ok.length === 0) return null;
  const sum = (pick: (p: (typeof ok)[number]) => number) => ok.reduce((s, p) => s + pick(p), 0);
  const cycles = sum((p) => p.rtl.cycles);
  const instructions = sum((p) => p.rtl.instructions);
  return {
    programs: ok.length,
    cycles,
    instructions,
    cpi: instructions === 0 ? null : cycles / instructions,
    byClass: mergeGroups(
      INSTRUCTION_CLASSES,
      ok.map((p) => p.rtl.byClass),
    ),
    byOpcode: mergeGroups(
      OPCODE_IDS,
      ok.map((p) => p.rtl.byOpcode),
    ),
    branchesTaken: sum((p) => p.rtl.branches.taken),
    branchesNotTaken: sum((p) => p.rtl.branches.notTaken),
    jumps: sum((p) => p.rtl.jumps),
    calls: sum((p) => p.rtl.calls),
    returns: sum((p) => p.rtl.returns),
    dataReads: sum((p) => p.rtl.dataReads),
    dataWrites: sum((p) => p.rtl.dataWrites),
    instructionalModelCycles: sum((p) => p.instructionalModel.estimatedCycles),
  };
}

// ---------------------------------------------------------------------------------------------
// Reproducibility

/** The report without `provenance` and `host`: what must be identical between two runs. */
export function modelledSection(report: RtlBenchmarkReport): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== 'provenance' && key !== 'host'),
  );
}

export interface ModelledDelta {
  readonly path: string;
  readonly baseline: Leaf | undefined;
  readonly fresh: Leaf | undefined;
}

/**
 * Whether two reports' modelled sections serialize to the same bytes, and every leaf that
 * differs when they do not.
 */
export function compareModelled(
  baseline: RtlBenchmarkReport,
  fresh: RtlBenchmarkReport,
): { readonly identical: boolean; readonly deltas: readonly ModelledDelta[] } {
  const a = modelledSection(baseline);
  const b = modelledSection(fresh);
  const identical = JSON.stringify(a) === JSON.stringify(b);
  const left = flattenLeaves(a);
  const right = flattenLeaves(b);
  const deltas = [...new Set([...left.keys(), ...right.keys()])]
    .filter((path) => left.get(path) !== right.get(path))
    .sort()
    .map((path) => ({ path, baseline: left.get(path), fresh: right.get(path) }));
  return { identical, deltas };
}

// ---------------------------------------------------------------------------------------------
// Markdown

export const fixed = (value: number | null, digits = 3): string =>
  value === null ? '-' : value.toFixed(digits);

function groupRows<K extends string>(
  order: readonly K[],
  groups: Partial<Record<K, Group>>,
): string[] {
  return order.flatMap((key) => {
    const g = groups[key];
    return g === undefined
      ? []
      : [
          `| ${key} | ${String(g.instructions)} | ${String(g.cycles)} | ${fixed(g.cpi)} | ${String(g.minClocks)} | ${String(g.maxClocks)} |`,
        ];
  });
}

/** The report as Markdown: modelled sections first, the host section last and labelled. */
export function renderBenchmarkMarkdown(report: RtlBenchmarkReport): string {
  const { provenance: p, synthesis: s, totals: t } = report;
  const fpga = s.available ? s.fpga.filter((f) => f.status === 'ran') : [];
  const lines = [
    `# RTL benchmark: ${report.variant.name}`,
    '',
    `Revision \`${report.revision}\`, ISA ${report.isaVersion}, variant \`${report.variant.name}\` (\`${report.variant.hash}\`). Commit \`${p.git.sha ?? 'unknown'}\`${p.git.dirty === true ? ' (dirty working tree)' : ''}, ${p.createdAt}.`,
    '',
    `Correctness gate: **${report.verification.gate === 'passed' ? 'PASSED' : 'FAILED'}**, ${String(report.verification.passed)}/${String(report.verification.programs)} programs. ${report.config.correctnessGate}`,
    '',
    `- ${LABELS.rtl}`,
    `- ${LABELS.instructionalModel}`,
    `- ${LABELS.estimatedTime}`,
    '',
    '## Programs',
    '',
    'CPI = total clock cycles / retired instructions.',
    '',
    `| Program | Instructions | RTL cycles | RTL CPI | Branches taken / not | Calls / returns | Data reads / writes | Model cycles | Model CPI |${fpga.map((f) => ` µs @ ${f.family} |`).join('')}`,
    `| ------- | -----------: | ---------: | ------: | -------------------: | --------------: | ------------------: | -----------: | --------: |${fpga.map(() => ' -----: |').join('')}`,
  ];
  for (const program of report.programs) {
    if (program.status === 'failed') {
      lines.push(
        `| ${program.name} | FAILED: ${program.reason} | | | | | | | |${fpga.map(() => ' |').join('')}`,
      );
      continue;
    }
    const r = program.rtl;
    const m = program.instructionalModel;
    lines.push(
      `| ${program.name} | ${String(r.instructions)} | ${String(r.cycles)} | ${fixed(r.cpi)} | ${String(r.branches.taken)} / ${String(r.branches.notTaken)} | ${String(r.calls)} / ${String(r.returns)} | ${String(r.dataReads)} / ${String(r.dataWrites)} | ${String(m.estimatedCycles)} | ${fixed(m.estimatedCpi)} |${program.estimatedTime.map((e) => ` ${fixed(e.microseconds, 2)} |`).join('')}`,
    );
  }
  if (t !== null) {
    lines.push(
      `| **total** | ${String(t.instructions)} | ${String(t.cycles)} | ${fixed(t.cpi)} | ${String(t.branchesTaken)} / ${String(t.branchesNotTaken)} | ${String(t.calls)} / ${String(t.returns)} | ${String(t.dataReads)} / ${String(t.dataWrites)} | ${String(t.instructionalModelCycles)} | ${fixed(t.instructions === 0 ? null : t.instructionalModelCycles / t.instructions)} |${fpga.map((f) => ` ${fixed(t.cycles / f.fmaxMHz, 2)} |`).join('')}`,
    );
  }
  lines.push('');
  if (t !== null) {
    lines.push(
      '## Cycles per instruction class (whole suite)',
      '',
      'Clocks between consecutive `retire` pulses, grouped by the ISA class of the instruction that retired.',
      '',
      '| Class | Instructions | Cycles | CPI | Min clocks | Max clocks |',
      '| ----- | -----------: | -----: | --: | ---------: | ---------: |',
      ...groupRows(INSTRUCTION_CLASSES, t.byClass),
      '',
      '## Cycles per opcode (whole suite)',
      '',
      '| Opcode | Instructions | Cycles | CPI | Min clocks | Max clocks |',
      '| ------ | -----------: | -----: | --: | ---------: | ---------: |',
      ...groupRows(OPCODE_IDS, t.byOpcode),
      '',
    );
  } else {
    lines.push(
      'No suite totals: at least one program failed the correctness gate, and no aggregate is reported over a partial suite.',
      '',
    );
  }
  const failed = report.programs.flatMap((pr) => (pr.status === 'failed' ? [pr] : []));
  if (failed.length > 0) {
    lines.push('## Failed programs', '', 'These programs get no numbers.', '');
    for (const f of failed) {
      lines.push(`- **${f.name}**: ${f.reason}`, ...f.mismatches.map((m) => `  - \`${m}\``));
    }
    lines.push('');
  }
  lines.push('## Synthesis', '');
  if (s.available) {
    lines.push(
      `From \`${s.source}\` (synthesised at \`${s.gitSha}\`${s.gitDirty ? ', dirty' : ''}). Generic Yosys \`${s.generic.top}\`: ${String(s.generic.cells)} cells, ${String(s.generic.flipFlops)} flip-flops, ${String(s.generic.combinational)} combinational cells. These are generic Yosys cells, not transistors.`,
      '',
      '| FPGA flow | Device and timing model | LUTs | FFs | Block RAM | Fmax (MHz) |',
      '| --------- | ----------------------- | ---: | --: | --------: | ---------: |',
      ...s.fpga.map((f) =>
        f.status === 'ran'
          ? `| ${f.family} | ${f.timingLabel} | ${String(f.luts)} | ${String(f.flipFlops)} | ${String(f.blockRam)} | ${fixed(f.fmaxMHz, 2)} |`
          : `| ${f.family} | absent: ${f.reason} | | | | |`,
      ),
      '',
    );
  } else {
    lines.push(`No synthesis data: ${s.reason}. Fmax and time estimates are omitted.`, '');
  }
  const h = report.host;
  lines.push(
    '## Host (simulator wall-clock, not processor performance)',
    '',
    `${h.label} ${h.runtime} on ${h.platform}/${h.arch}, ${h.cpuModel}. Total ${fixed(h.totalWallMs, 0)} ms.`,
    '',
    '| Program | Reference (ms) | RTL runner (ms) |',
    '| ------- | -------------: | --------------: |',
    ...h.programs.map(
      (row) => `| ${row.name} | ${fixed(row.referenceMs, 1)} | ${fixed(row.rtlMs, 1)} |`,
    ),
    '',
    `Runner \`${p.runner}\`; toolchain ${p.toolchain ?? 'unknown'}.`,
    '',
  );
  return lines.join('\n');
}
