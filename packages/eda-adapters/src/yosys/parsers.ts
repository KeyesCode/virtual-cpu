import type { FailureClass } from '@vcpu/research-core';
import {
  type AllowEntry,
  type CellCounts,
  countCells,
  moduleName,
  StatJsonSchema,
} from '@vcpu/rtl-tools';
import { z } from 'zod';

// What Yosys writes, read strictly: `stat -json`, `write_json -selected` of the memories, and the
// log, which decides only why a run failed. Counts never come from console text. The counting rules
// and the ltp and warnings parsers are @vcpu/rtl-tools's, so these numbers mean what Project 3's do.

const StatBlockSchema = z.object({
  num_cells: z.number().int(),
  num_cells_by_type: z.record(z.string(), z.number().int()),
});

/** `design` is the whole hierarchy, each module multiplied by its instances. */
const YosysStatSchema = StatJsonSchema.extend({ design: StatBlockSchema });
export type YosysStat = z.output<typeof YosysStatSchema>;

/** `stat -liberty -json` of the pinned Yosys. Another shape fails here rather than reading as 0. */
const LibertyStatSchema = YosysStatSchema.extend({
  design: StatBlockSchema.extend({ area: z.number().positive() }),
});
export type LibertyStat = z.output<typeof LibertyStatSchema>;

function checkedStat<T extends YosysStat>(schema: z.ZodType<T>, text: string, top: string): T {
  const stat = schema.parse(JSON.parse(text));
  if (!Object.keys(stat.modules).some((name) => moduleName(name) === top)) {
    throw new Error(`stat lists no module ${top}`);
  }
  return stat;
}

export function parseStat(text: string, top: string): YosysStat {
  return checkedStat(YosysStatSchema, text, top);
}

export function parseLibertyStat(text: string, top: string): LibertyStat {
  return checkedStat(LibertyStatSchema, text, top);
}

/** The whole design's cells, leaving out the instances of its own submodules. */
export function designCells(stat: YosysStat): CellCounts {
  return countCells(stat.design.num_cells_by_type, undefined, (type) => type in stat.modules);
}

/** `$mul` cells as written, in the stat taken before `alumacc`. */
export function mulCells(stat: YosysStat): number {
  return stat.design.num_cells_by_type['$mul'] ?? 0;
}

/** How many times each module occurs below the top, from a hierarchical stat. */
function moduleInstances(stat: YosysStat, top: string): Map<string, number> {
  const instances = new Map<string, number>();
  const visit = (name: string, times: number): void => {
    instances.set(name, (instances.get(name) ?? 0) + times);
    const types = stat.modules[name]?.num_cells_by_type ?? {};
    for (const [type, count] of Object.entries(types)) {
      if (type in stat.modules) visit(type, times * count);
    }
  };
  const root = Object.keys(stat.modules).find((name) => moduleName(name) === top);
  if (root !== undefined) visit(root, 1);
  return instances;
}

const MemoriesJsonSchema = z.object({
  modules: z.record(
    z.string(),
    z.object({
      cells: z
        .record(
          z.string(),
          z.object({
            type: z.string(),
            parameters: z.object({ SIZE: z.string(), WIDTH: z.string() }).loose(),
          }),
        )
        .optional(),
    }),
  ),
});

/** The bits of every inferred memory, each module multiplied by its instances. */
export function memoryBits(text: string, stat: YosysStat, top: string): number {
  const instances = moduleInstances(stat, top);
  let bits = 0;
  for (const [name, module] of Object.entries(MemoriesJsonSchema.parse(JSON.parse(text)).modules)) {
    for (const cell of Object.values(module.cells ?? {})) {
      if (cell.type !== '$mem_v2') continue;
      const { SIZE, WIDTH } = cell.parameters;
      bits += (instances.get(name) ?? 0) * parseInt(SIZE, 2) * parseInt(WIDTH, 2);
    }
  }
  return bits;
}

export const SYNTHESIS_GATES = [
  'elaboration',
  'hierarchy',
  'latch',
  'loop',
  'multi-driver',
  'undriven',
  // A `check -assert` problem that is none of the three named ones.
  'check',
  'warnings',
  'unmapped-cells',
] as const;
export type SynthesisGateName = (typeof SYNTHESIS_GATES)[number];

export interface YosysFailure {
  readonly failureClass: FailureClass;
  /** The gates the design failed: empty when the fault is not the design's. */
  readonly gates: readonly SynthesisGateName[];
  readonly message: string;
}

const ERROR_LINE = /^(?:(\S+):\d[\d.-]*: )?ERROR: (.*)$/m;

/** What `check -assert` reported: it prints each problem as a warning, then one ERROR. */
function checkGates(log: string): SynthesisGateName[] {
  const gates = new Set<SynthesisGateName>();
  for (const line of log.split('\n')) {
    if (!line.startsWith('Warning: ')) continue;
    if (line.includes('found logic loop')) gates.add('loop');
    if (/conflicting|conflicts with/.test(line)) gates.add('multi-driver');
    if (line.includes('has no driver')) gates.add('undriven');
  }
  return gates.size === 0 ? ['check'] : [...gates];
}

function design(gates: readonly SynthesisGateName[], error: string): YosysFailure {
  return {
    failureClass: 'unsupported-design',
    gates,
    message: `failed the ${gates.join(', ')} gate: ${error}`,
  };
}

/** Why a Yosys run with a non-zero exit failed, from the first ERROR line of its log. */
export function classifyYosysLog(log: string): YosysFailure {
  const match = ERROR_LINE.exec(log);
  const file = match?.[1];
  const error = match?.[2];
  if (error === undefined) {
    return { failureClass: 'tool-failure', gates: [], message: 'no ERROR line in the log' };
  }
  if (error.startsWith('File `') && error.includes('not found')) {
    return { failureClass: 'infrastructure-failure', gates: [], message: error };
  }
  if (file !== undefined && !file.endsWith('.ys')) return design(['elaboration'], error);
  if (
    error.startsWith('Latch inferred') ||
    error.startsWith('Assertion failed: selection is not')
  ) {
    return design(['latch'], error);
  }
  if (/^Found \d+ problems in 'check -assert'/.test(error)) return design(checkGates(log), error);
  if (error.startsWith('Module `')) return design(['hierarchy'], error);
  return { failureClass: 'tool-failure', gates: [], message: error };
}

/**
 * The warnings only a liberty flow prints, reviewed as synth/warnings.allow reviews its own. That
 * file belongs to Project 3 and its flows, which map to no library, so it stays as it is.
 */
export const MAPPED_WARNING_ALLOW: readonly AllowEntry[] = [
  {
    pattern: String.raw`^ABC: Warning: Detected [0-9]+ multi-output cells \(for example, "\S+"\)\.$`,
    review:
      "ABC notes that it leaves the library's multi-output cells (sky130's full and half adders) out of mapping. It limits the optimisation, not the design: the netlist is correct, and it uses single-output cells instead.",
  },
];
