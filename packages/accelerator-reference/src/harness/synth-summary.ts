import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AllowEntry,
  type CellCounts,
  collectWarnings,
  compareSummaries,
  countCells,
  type CriticalPath,
  deviceName,
  fpgaCells,
  type FpgaTarget,
  formatDelta,
  type LogicDepth,
  NextpnrReportSchema,
  nextpnrVersion,
  parseAllowlist,
  parseLtp,
  parseMemoryMapping,
  placeAndRoute,
  type StatJson,
  StatJsonSchema,
  type SynthWarning,
  timingLabel,
  yosysVersion,
} from '@vcpu/rtl-tools';
import { z } from 'zod';

// The synthesis summary of the matmul accelerator: `make -C hardware/accelerators/matmul synth`
// (mk/synth.mk) runs the generic, iCE40 and ECP5 flows for each array size into
// build/synth-<R>x<C>/, then `synth-summary` reads those outputs and writes
// build/synth/summary.{json,md}. docs/hardware/accelerators/synthesis-guide.md explains every
// number. The log, stat and nextpnr-report parsers are VCPU-8's (@vcpu/rtl-tools), so both
// projects read the tools the same way.
//
// Counts are Yosys cells or FPGA primitives, never transistors; the only timing figures are
// nextpnr's estimates for a named FPGA device; power is not measured.

export const MATMUL_SYNTH_FORMAT = 'matmul-synth-summary/1';
export const POWER = 'not measured';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

/** The generic flow's top, and the FPGA wrapper every FPGA flow builds. */
const GENERIC_TOP = 'matmul_top';
const FPGA_TOP = 'matmul_fpga_wrapper';
/** matmul_top's instance inside the wrapper: FPGA memory paths start with it. */
const FPGA_CORE_INSTANCE = 'u_matmul';

// ---------------------------------------------------------------------------------------------
// The summary schema

const CountsSchema = z.object({
  cells: z.number().int(),
  flipFlops: z.number().int(),
  combinational: z.number().int(),
  memories: z.number().int(),
});
export type Counts = z.infer<typeof CountsSchema>;

const BlockSchema = CountsSchema.extend({
  /** The instance path below matmul_top, or `matmul_top` for the whole design. */
  block: z.string(),
  module: z.string(),
  /** How many instances the row stands for (all PEs in one row; one PE alone in another). */
  instances: z.number().int(),
});

const LogicDepthSchema = z.object({
  length: z.number().int(),
  from: z.string(),
  to: z.string(),
  endFlipFlop: z.string().nullable(),
  through: z.array(z.string()),
});

const MemorySchema = z.object({
  /** The buffer instance below matmul_top: u_a_buffer, u_b_buffer or u_c_buffer. */
  instance: z.string(),
  module: z.string(),
  /** How many separate memories (banks) Yosys inferred in it. */
  banks: z.number().int(),
  words: z.number().int(),
  width: z.number().int(),
  /** banks × words × width. */
  bits: z.number().int(),
  readPorts: z.number().int(),
  syncReadPorts: z.number().int(),
  writePorts: z.number().int(),
  /** Per FPGA flow, how memory_libmap mapped the banks; null when that flow did not run. */
  fpga: z.record(z.string(), z.string().nullable()),
});

const UsageSchema = z.record(z.string(), z.object({ used: z.number(), available: z.number() }));

const FpgaCellsSchema = z.object({
  luts: z.number().int(),
  carry: z.number().int(),
  flipFlops: z.number().int(),
  blockRam: z.number().int(),
  dsp: z.number().int(),
  wideMux: z.number().int(),
  other: z.number().int(),
  byType: z.record(z.string(), z.number().int()),
});

const CriticalPathSchema = z.object({
  from: z.string(),
  to: z.string(),
  delayNs: z.number(),
  logicNs: z.number(),
  routingNs: z.number(),
  logicStages: z.number().int(),
  rtlSources: z.array(z.object({ location: z.string(), nets: z.number().int() })),
});

const FpgaCommon = {
  status: z.literal('ran'),
  device: z.string(),
  top: z.string(),
  seed: z.number().int(),
  constraintMHz: z.number(),
  /** What Yosys mapped the design to, before place and route. */
  synth: FpgaCellsSchema,
  /** nextpnr's device utilisation (used / available), every resource with any use. */
  utilisation: UsageSchema,
};

const FpgaFitSchema = z.object({
  ...FpgaCommon,
  fits: z.literal(true),
  /** Fmax from nextpnr's timing model: an estimate for `timingLabel`, not a measurement. */
  fmaxMHz: z.number(),
  fmaxIsEstimate: z.literal(true),
  timingLabel: z.string(),
  meetsConstraint: z.boolean(),
  criticalPath: CriticalPathSchema.nullable(),
});

const FpgaNoFitSchema = z.object({
  ...FpgaCommon,
  fits: z.literal(false),
  /** nextpnr's error line. */
  reason: z.string(),
  /** The resources over 100 %. */
  overUtilised: z.array(z.string()),
});

const FpgaAbsentSchema = z.object({ status: z.literal('absent'), reason: z.string() });

const FpgaResultSchema = z.union([FpgaFitSchema, FpgaNoFitSchema, FpgaAbsentSchema]);
export type FpgaResult = z.infer<typeof FpgaResultSchema>;

const SizeSchema = z.object({
  size: z.string(),
  rows: z.number().int(),
  cols: z.number().int(),
  pes: z.number().int(),
  generic: z.object({
    top: z.string(),
    total: CountsSchema,
    /** Every hardware cell type of matmul_top and its count. */
    byType: z.record(z.string(), z.number().int()),
    blocks: z.array(BlockSchema),
    /** `$mul` cells as written (after constant folding, before synth maps them), by module. */
    mulCells: z.number().int(),
    mulCellsByModule: z.record(z.string(), z.number().int()),
    /** Inferred memories: separate banks, and their bits in all. */
    memoryBanks: z.number().int(),
    memoryBits: z.number().int(),
    /** Flattened and remapped to two-input gates and 2:1 muxes (memories excluded). */
    abstractGates: z.number().int(),
    gateFlipFlops: z.number().int(),
    gatesByType: z.record(z.string(), z.number().int()),
    logicDepth: LogicDepthSchema,
  }),
  memories: z.array(MemorySchema),
  fpga: z.record(z.string(), FpgaResultSchema),
});
export type SizeSummary = z.infer<typeof SizeSchema>;

const WarningSchema = z.object({
  source: z.string(),
  message: z.string(),
  count: z.number().int(),
  allowedBy: z.string().nullable(),
});

export const MatmulSynthSummarySchema = z.object({
  schemaVersion: z.literal(1),
  format: z.literal(MATMUL_SYNTH_FORMAT),
  revision: z.string(),
  /** Where the numbers came from. synth-compare reports differences here but does not count them. */
  provenance: z.object({
    gitSha: z.string(),
    gitDirty: z.boolean(),
    toolchain: z.string(),
    tools: z.record(z.string(), z.string().nullable()),
  }),
  /** Identical for every size. */
  settings: z.object({
    generic: z.string(),
    freqMHz: z.number(),
    seed: z.number().int(),
    ice40: z.string(),
    ecp5: z.string(),
    power: z.literal(POWER),
  }),
  sizes: z.array(SizeSchema),
  warnings: z.array(WarningSchema),
  gate: z.object({
    passed: z.boolean(),
    failures: z.array(z.string()),
    /** Allowlist patterns that matched nothing in this run. */
    unusedAllowEntries: z.array(z.string()),
  }),
});
export type MatmulSynthSummary = z.infer<typeof MatmulSynthSummarySchema>;

// ---------------------------------------------------------------------------------------------
// The hierarchy: instance names from the netlist, counts from `stat -json`

const NetlistSchema = z.object({
  modules: z.record(
    z.string(),
    z.object({
      cells: z.record(z.string(), z.object({ type: z.string() })).optional(),
    }),
  ),
});
type Netlist = z.infer<typeof NetlistSchema>;

/** `$paramod$<hash>\input_buffer` → `input_buffer`; `\matmul_top` → `matmul_top`. */
export function plainModuleName(raw: string): string {
  const paramod = /^\$paramod(?:\$[0-9a-f]+)?\\([^\\]+)/.exec(raw);
  if (paramod?.[1] !== undefined) return paramod[1];
  return raw.startsWith('\\') ? raw.slice(1) : raw;
}

/** The raw (Yosys) name of a module: a top module is `matmul_top` in JSON, `\matmul_top` in stat. */
function findModule(names: Iterable<string>, raw: string): string | undefined {
  for (const name of names) {
    if (name === raw || name === `\\${raw}` || `\\${name}` === raw) return name;
  }
  return undefined;
}

/** The submodule instances of a module: instance name → raw module name. */
function instancesOf(netlist: Netlist, raw: string): [string, string][] {
  const name = findModule(Object.keys(netlist.modules), raw);
  const cells = name === undefined ? {} : (netlist.modules[name]?.cells ?? {});
  return Object.entries(cells)
    .filter(([, cell]) => findModule(Object.keys(netlist.modules), cell.type) !== undefined)
    .map(([instance, cell]): [string, string] => [instance, cell.type])
    .sort(([a], [b]) => (a < b ? -1 : 1));
}

function addCounts(a: Counts, b: Counts, times = 1): Counts {
  return {
    cells: a.cells + b.cells * times,
    flipFlops: a.flipFlops + b.flipFlops * times,
    combinational: a.combinational + b.combinational * times,
    memories: a.memories + b.memories * times,
  };
}
const ZERO: Counts = { cells: 0, flipFlops: 0, combinational: 0, memories: 0 };
const plain = (c: CellCounts): Counts => ({
  cells: c.cells,
  flipFlops: c.flipFlops,
  combinational: c.combinational,
  memories: c.memories,
});

/** Per-module local counts, keyed by raw module name, excluding submodule instances. */
function localCounts(stat: StatJson): Map<string, CellCounts> {
  const names = Object.keys(stat.modules);
  const isSubmodule = (type: string): boolean => findModule(names, type) !== undefined;
  return new Map(
    Object.entries(stat.modules).map(([name, module]) => [
      name,
      countCells(module.num_cells_by_type, undefined, isSubmodule),
    ]),
  );
}

interface Hierarchy {
  /** Counts of a module with every submodule, by raw name. */
  readonly subtree: (raw: string) => Counts;
  /** Local counts of a module, by raw name. */
  readonly local: (raw: string) => CellCounts;
  /** Every hardware cell type of a module's subtree, with counts. */
  readonly byType: (raw: string) => Record<string, number>;
  /**
   * How many times each module occurs below `raw`, counting `raw` itself once, keyed by its raw
   * name as `stat -json` spells it: two parameterisations of one module count separately.
   */
  readonly occurrences: (raw: string) => Map<string, number>;
}

function hierarchy(stat: StatJson, netlist: Netlist): Hierarchy {
  const locals = localCounts(stat);
  const statNames = [...locals.keys()];
  const local = (raw: string): CellCounts => {
    const name = findModule(statNames, raw);
    const counts = name === undefined ? undefined : locals.get(name);
    if (counts === undefined) throw new Error(`stat -json: no module ${raw}`);
    return counts;
  };
  const subtree = (raw: string): Counts =>
    instancesOf(netlist, raw).reduce(
      (sum, [, child]) => addCounts(sum, subtree(child)),
      plain(local(raw)),
    );
  const byType = (raw: string): Record<string, number> => {
    const types = new Map(Object.entries(local(raw).byType));
    for (const [, child] of instancesOf(netlist, raw)) {
      for (const [type, n] of Object.entries(byType(child))) {
        types.set(type, (types.get(type) ?? 0) + n);
      }
    }
    return Object.fromEntries([...types].sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  const occurrences = (raw: string): Map<string, number> => {
    const out = new Map<string, number>([[findModule(statNames, raw) ?? raw, 1]]);
    for (const [, child] of instancesOf(netlist, raw)) {
      for (const [name, n] of occurrences(child)) out.set(name, (out.get(name) ?? 0) + n);
    }
    return out;
  };
  return { subtree, local, byType, occurrences };
}

/**
 * The blocks of matmul_top: the whole design, each top-level instance with its submodules, and,
 * below an instance whose children are all one module (the array of PEs), all of them together
 * and one alone.
 */
function blocks(h: Hierarchy, netlist: Netlist, top: string): z.infer<typeof BlockSchema>[] {
  const rows: z.infer<typeof BlockSchema>[] = [
    { block: top, module: top, instances: 1, ...h.subtree(top) },
  ];
  for (const [instance, raw] of instancesOf(netlist, top)) {
    rows.push({ block: instance, module: plainModuleName(raw), instances: 1, ...h.subtree(raw) });
    const children = instancesOf(netlist, raw);
    const kinds = new Set(children.map(([, child]) => child));
    const [only] = kinds;
    if (kinds.size === 1 && only !== undefined) {
      const one = h.subtree(only);
      const module = plainModuleName(only);
      rows.push({
        block: `${instance}: all ${module}`,
        module,
        instances: children.length,
        ...addCounts(ZERO, one, children.length),
      });
      rows.push({ block: `${instance}: one ${module}`, module, instances: 1, ...one });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Memories

const MemCellSchema = z.object({ type: z.string(), parameters: z.record(z.string(), z.string()) });
const MemJsonSchema = z.object({
  modules: z.record(
    z.string(),
    z.object({ cells: z.record(z.string(), MemCellSchema).optional() }),
  ),
});

function binaryParameter(parameters: Readonly<Record<string, string>>, key: string): number {
  const value = parameters[key];
  if (value === undefined || !/^[01]+$/.test(value)) {
    throw new Error(`memory cell: parameter ${key} is ${String(value)}`);
  }
  return parseInt(value, 2);
}

/** Instance paths below `top` of every raw module, from the hierarchical netlist. */
function rawInstancePaths(netlist: Netlist, top: string): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const walk = (raw: string, prefix: string): void => {
    const name = findModule(Object.keys(netlist.modules), raw) ?? raw;
    paths.set(name, [...(paths.get(name) ?? []), prefix]);
    for (const [instance, child] of instancesOf(netlist, raw)) {
      walk(child, prefix === '' ? instance : `${prefix}.${instance}`);
    }
  };
  walk(top, '');
  return paths;
}

/**
 * The memories `memory -nomap` inferred, one entry per buffer instance (its banks together), with
 * how each FPGA flow's memory_libmap mapped them (`mappings`: parseMemoryMapping per family, null
 * for a flow that did not run).
 */
export function bufferMemories(
  memJson: unknown,
  netlist: unknown,
  top: string,
  mappings: Readonly<Record<string, Readonly<Record<string, string>> | null>>,
): z.infer<typeof MemorySchema>[] {
  const parsed = MemJsonSchema.parse(memJson);
  const paths = rawInstancePaths(NetlistSchema.parse(netlist), top);
  const groups = new Map<string, z.infer<typeof MemorySchema> & { names: string[] }>();
  for (const [rawModule, module] of Object.entries(parsed.modules)) {
    const instances = paths.get(rawModule) ?? paths.get(`\\${rawModule}`) ?? [];
    if (instances.length === 0) throw new Error(`memories: no instance of ${rawModule}`);
    for (const cell of Object.values(module.cells ?? {})) {
      if (cell.type !== '$mem_v2') continue;
      const p = cell.parameters;
      const memid = (p.MEMID ?? '').replace(/^\\/, '');
      const words = binaryParameter(p, 'SIZE');
      const width = binaryParameter(p, 'WIDTH');
      const readPorts = binaryParameter(p, 'RD_PORTS');
      const writePorts = binaryParameter(p, 'WR_PORTS');
      const syncReadPorts = (p.RD_CLK_ENABLE ?? '').replace(/0/g, '').length;
      for (const instance of instances) {
        const shape = `${instance}|${String(words)}|${String(width)}|${String(readPorts)}|${String(syncReadPorts)}|${String(writePorts)}`;
        const group = groups.get(shape) ?? {
          instance,
          module: plainModuleName(rawModule),
          banks: 0,
          words,
          width,
          bits: 0,
          readPorts,
          syncReadPorts,
          writePorts,
          fpga: {},
          names: [],
        };
        group.banks += 1;
        group.bits += words * width;
        group.names.push(instance === '' ? memid : `${instance}.${memid}`);
        groups.set(shape, group);
      }
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0))
    .map(({ names, ...group }) => {
      const fpga: Record<string, string | null> = {};
      for (const [family, mapping] of Object.entries(mappings)) {
        if (mapping === null) {
          fpga[family] = null;
          continue;
        }
        const found = new Set<string>();
        for (const name of names) {
          const mapped = mapping[`${FPGA_CORE_INSTANCE}.${name}`];
          found.add(mapped ?? 'not reported by memory_libmap');
        }
        fpga[family] = [...found].sort().join('; ');
      }
      return { ...group, fpga };
    });
}

// ---------------------------------------------------------------------------------------------
// nextpnr: the utilisation it prints, which is all there is when the design does not fit

/** The first `Device utilisation:` block of a nextpnr log, resources with any use. */
export function parseUtilisation(log: string): Record<string, { used: number; available: number }> {
  const lines = log.split('\n');
  const start = lines.findIndex((line) => /^Info: Device utilisation:/.test(line));
  if (start < 0) throw new Error('nextpnr log: no "Device utilisation:" block');
  const usage: Record<string, { used: number; available: number }> = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^Info:\s+(\S+):\s+(\d+)\/\s*(\d+)\s+\d+%$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) break;
    const used = Number(match[2]);
    if (used > 0) usage[match[1]] = { used, available: Number(match[3]) };
  }
  return Object.fromEntries(Object.entries(usage).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export interface FpgaFlowFiles {
  readonly target: FpgaTarget;
  readonly seed: number;
  readonly constraintMHz: number;
  readonly stat: StatJson;
  readonly nextpnrLog: string;
  /** The nextpnr report, or null when the design did not fit (with `noFit`, the error line). */
  readonly report: unknown;
  readonly noFit: string | null;
}

export function fpgaResult(files: FpgaFlowFiles, repoRoot: string): FpgaResult {
  const common = {
    status: 'ran' as const,
    device: `${deviceName(files.target)} ${files.target.package.toUpperCase()}`,
    top: FPGA_TOP,
    seed: files.seed,
    constraintMHz: files.constraintMHz,
    synth: fpgaCells(files.stat),
  };
  if (files.noFit !== null) {
    const utilisation = parseUtilisation(files.nextpnrLog);
    const overUtilised = Object.entries(utilisation)
      .filter(([, u]) => u.used > u.available)
      .map(([resource]) => resource);
    // Only a placement failure on a resource the design over-uses is a "does not fit"; the same
    // error on a resource within its count is a constraint or legalisation problem.
    const cellType = /cell type '([^']+)'/.exec(files.noFit)?.[1];
    if (cellType === undefined || !overUtilised.includes(cellType)) {
      throw new Error(
        `${files.target.family}: nextpnr failed to place a ${String(cellType)} cell, which the design ` +
          `does not over-use (over: ${overUtilised.join(', ') || 'nothing'}): ${files.noFit.trim()}`,
      );
    }
    return {
      ...common,
      utilisation,
      fits: false,
      reason: files.noFit.trim(),
      overUtilised,
    };
  }
  const pnr = placeAndRoute(NextpnrReportSchema.parse(files.report), repoRoot);
  const criticalPath: CriticalPath | null = pnr.criticalPath;
  return {
    ...common,
    utilisation: pnr.utilisation,
    fits: true,
    fmaxMHz: pnr.fmaxMHz,
    fmaxIsEstimate: true,
    timingLabel: timingLabel(files.target),
    meetsConstraint: pnr.meetsConstraint,
    criticalPath:
      criticalPath === null ? null : { ...criticalPath, rtlSources: [...criticalPath.rtlSources] },
  };
}

// ---------------------------------------------------------------------------------------------
// One size

export interface SizeFiles {
  readonly rows: number;
  readonly cols: number;
  readonly genericStat: StatJson;
  readonly mulStat: StatJson;
  readonly gatesStat: StatJson;
  readonly ltp: string;
  readonly memories: unknown;
  readonly netlist: unknown;
  /** Per FPGA family, the flow's outputs, or why it did not run. */
  readonly fpga: Readonly<Record<string, FpgaFlowFiles | { readonly absent: string }>>;
  /** Per FPGA family that ran, its Yosys log (for the memory mapping). */
  readonly fpgaYosysLogs: Readonly<Record<string, string>>;
}

export function sizeSummary(files: SizeFiles, repoRoot: string): SizeSummary {
  const netlist = NetlistSchema.parse(files.netlist);
  const h = hierarchy(files.genericStat, netlist);
  const total = h.subtree(GENERIC_TOP);

  // $mul cells as written, counted through the hierarchy of the pre-synth design.
  const mulNetlist = statHierarchyAsNetlist(files.mulStat);
  const mulTree = hierarchy(files.mulStat, mulNetlist);
  const occurrences = mulTree.occurrences(GENERIC_TOP);
  const mulCellsByModule: Record<string, number> = {};
  for (const [raw, module] of Object.entries(files.mulStat.modules)) {
    const local = module.num_cells_by_type.$mul ?? 0;
    const name = plainModuleName(raw);
    if (local > 0) {
      mulCellsByModule[name] = (mulCellsByModule[name] ?? 0) + local * (occurrences.get(raw) ?? 0);
    }
  }

  const gateModules = Object.values(files.gatesStat.modules);
  if (gateModules.length !== 1 || gateModules[0] === undefined) {
    throw new Error('abstract-gate stat -json: expected one flattened module');
  }
  const gates = countCells(gateModules[0].num_cells_by_type);
  const logicDepth: LogicDepth = parseLtp(files.ltp);

  const fpga: Record<string, FpgaResult> = {};
  const mappings: Record<string, Record<string, string> | null> = {};
  for (const [family, flow] of Object.entries(files.fpga)) {
    if ('absent' in flow) {
      fpga[family] = { status: 'absent', reason: flow.absent };
      mappings[family] = null;
    } else {
      fpga[family] = fpgaResult(flow, repoRoot);
      mappings[family] = parseMemoryMapping(files.fpgaYosysLogs[family] ?? '');
    }
  }
  const memories = bufferMemories(files.memories, files.netlist, GENERIC_TOP, mappings);

  return {
    size: `${String(files.rows)}x${String(files.cols)}`,
    rows: files.rows,
    cols: files.cols,
    pes: files.rows * files.cols,
    generic: {
      top: GENERIC_TOP,
      total,
      byType: h.byType(GENERIC_TOP),
      blocks: blocks(h, netlist, GENERIC_TOP),
      mulCells: Object.values(mulCellsByModule).reduce((a, b) => a + b, 0),
      mulCellsByModule,
      memoryBanks: memories.reduce((n, m) => n + m.banks, 0),
      memoryBits: memories.reduce((n, m) => n + m.bits, 0),
      abstractGates: gates.combinational,
      gateFlipFlops: gates.flipFlops,
      gatesByType: { ...gates.byType },
      logicDepth: { ...logicDepth, through: [...logicDepth.through] },
    },
    memories,
    fpga,
  };
}

/**
 * A netlist-shaped view of a hierarchical `stat -json` (instances numbered, not named), enough to
 * count module occurrences in the pre-synth design, which has no netlist of its own.
 */
function statHierarchyAsNetlist(stat: StatJson): Netlist {
  const names = Object.keys(stat.modules);
  const modules: Netlist['modules'] = {};
  for (const [name, module] of Object.entries(stat.modules)) {
    const cells: Record<string, { type: string }> = {};
    for (const [type, count] of Object.entries(module.num_cells_by_type)) {
      const child = findModule(names, type);
      if (child === undefined) continue;
      for (let i = 0; i < count; i++) cells[`${type}#${String(i)}`] = { type: child };
    }
    modules[name] = { cells };
  }
  return { modules };
}

// ---------------------------------------------------------------------------------------------
// The whole summary

export interface SummaryInputs {
  readonly revision: string;
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly toolchain: string;
  readonly tools: Readonly<Record<string, string | null>>;
  readonly freqMHz: number;
  readonly seed: number;
  readonly targets: { readonly ice40: FpgaTarget; readonly ecp5: FpgaTarget };
  readonly sizes: readonly SizeSummary[];
  readonly warnings: readonly SynthWarning[];
  readonly allow: readonly AllowEntry[];
}

export function buildMatmulSummary(inputs: SummaryInputs): MatmulSynthSummary {
  const failures = inputs.warnings
    .filter((warning) => warning.allowedBy === null)
    .map((warning) => `${warning.source}: ${warning.message}`);
  const used = new Set(inputs.warnings.map((warning) => warning.allowedBy));
  const label = (target: FpgaTarget): string =>
    `${deviceName(target)} ${target.package.toUpperCase()}` +
    (target.speed === null ? '' : `, speed grade ${target.speed}`);
  return MatmulSynthSummarySchema.parse({
    schemaVersion: 1,
    format: MATMUL_SYNTH_FORMAT,
    revision: inputs.revision,
    provenance: {
      gitSha: inputs.gitSha,
      gitDirty: inputs.gitDirty,
      toolchain: inputs.toolchain,
      tools: inputs.tools,
    },
    settings: {
      generic: 'Yosys internal cells, no technology library; inferred memories kept as $mem_v2',
      freqMHz: inputs.freqMHz,
      seed: inputs.seed,
      ice40: `${label(inputs.targets.ice40)}, pins from hardware/fpga/matmul_up5k_sg48.pcf`,
      ecp5: `${label(inputs.targets.ecp5)}, IO placed by nextpnr`,
      power: POWER,
    },
    sizes: inputs.sizes,
    warnings: inputs.warnings,
    gate: {
      passed: failures.length === 0,
      failures,
      unusedAllowEntries: inputs.allow.map((e) => e.pattern).filter((p) => !used.has(p)),
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Markdown

const fmt = (n: number): string => n.toLocaleString('en-US');
const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;
const pct = (used: number, available: number): string =>
  `${String(Math.round((100 * used) / available))} %`;

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** The FPGA resources the table shows, by family: nextpnr's names for logic, flops, RAM, DSP. */
const PNR_RESOURCES: Readonly<Record<string, readonly [string, string, string]>> = {
  ice40: ['ICESTORM_LC', 'ICESTORM_RAM', 'ICESTORM_DSP'],
  ecp5: ['TRELLIS_COMB', 'DP16KD', 'MULT18X18D'],
};

function usageCell(result: FpgaResult & { status: 'ran' }, resource: string): string {
  const u = result.utilisation[resource];
  if (u === undefined) return '0';
  const text = `${fmt(u.used)} / ${fmt(u.available)} (${pct(u.used, u.available)})`;
  return u.used > u.available ? `**${text}**` : text;
}

export function renderMatmulSummaryMarkdown(summary: MatmulSynthSummary): string {
  const out: string[] = [];
  const tools = Object.entries(summary.provenance.tools)
    .map(([tool, version]) => `${tool}: ${version ?? 'not installed'}`)
    .join('; ');
  const sizes = summary.sizes;
  out.push(
    '# INT8 matmul accelerator synthesis summary',
    '',
    `Revision ${code(summary.revision)}, generated by \`make -C hardware/accelerators/matmul synth\` at git ` +
      `${code(summary.provenance.gitSha.slice(0, 12))}${summary.provenance.gitDirty ? ' (with uncommitted changes)' : ''}, ` +
      `${summary.provenance.toolchain}: ${tools}.`,
    '',
    'Cell counts are Yosys cells or FPGA primitives, not transistors, and no area is measured. ' +
      'The only timing figures are nextpnr place-and-route **estimates** for the FPGA device named beside them. ' +
      `**Power: ${summary.settings.power}.** See \`docs/hardware/accelerators/synthesis-guide.md\`.`,
    '',
    '## Settings (identical for every size)',
    '',
    `- Generic: ${summary.settings.generic}.`,
    `- iCE40: ${summary.settings.ice40}.`,
    `- ECP5: ${summary.settings.ecp5}.`,
    `- Timing constraint ${String(summary.settings.freqMHz)} MHz, nextpnr seed ${String(summary.settings.seed)}, top ${code(FPGA_TOP)}.`,
    '',
    '## Scaling with the array size (generic synthesis of `matmul_top`)',
    '',
    table(
      [
        'Array',
        'PEs',
        'Cells',
        'Flip-flops',
        'Combinational',
        '`$mul` (PE / other)',
        'Memory banks',
        'Memory bits',
        'Abstract gates',
        'Logic depth',
      ],
      sizes.map((s) => {
        const pe = s.generic.mulCellsByModule.processing_element ?? 0;
        return [
          `${String(s.rows)} × ${String(s.cols)}`,
          fmt(s.pes),
          fmt(s.generic.total.cells),
          fmt(s.generic.total.flipFlops),
          fmt(s.generic.total.combinational),
          `${fmt(s.generic.mulCells)} (${fmt(pe)} / ${fmt(s.generic.mulCells - pe)})`,
          fmt(s.generic.memoryBanks),
          fmt(s.generic.memoryBits),
          fmt(s.generic.abstractGates),
          `${String(s.generic.logicDepth.length)} gates`,
        ];
      }),
    ),
    '',
    '`$mul` counts the multipliers as written, after constant folding and before synthesis maps them to gates. ' +
      'Each inferred memory bank counts as one cell, its storage only under memory bits. ' +
      'Abstract gates: the flattened design remapped by `abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX` (ABC adds `NOT`), flip-flops not included. ' +
      'Logic depth is a gate count on the longest path (`ltp -noff`, memories excluded), not a delay.',
    '',
  );

  out.push('## FPGA synthesis and place-and-route', '');
  const rows: string[][] = [];
  for (const s of sizes) {
    for (const [family, result] of Object.entries(s.fpga)) {
      const array = `${String(s.rows)} × ${String(s.cols)}`;
      if (result.status === 'absent') {
        rows.push([array, family, `not run: ${result.reason}`, '', '', '', '', '', '', '']);
        continue;
      }
      const [lc, ram, dsp] = PNR_RESOURCES[family] ?? ['', '', ''];
      rows.push([
        array,
        family,
        result.fits ? 'yes' : '**no**',
        fmt(result.synth.luts),
        fmt(result.synth.flipFlops),
        usageCell(result, lc),
        usageCell(result, ram),
        usageCell(result, dsp),
        result.fits ? `${result.fmaxMHz.toFixed(2)} MHz (estimate)` : 'n/a: not placed',
        result.fits ? (result.meetsConstraint ? 'yes' : '**no**') : 'n/a',
      ]);
    }
  }
  out.push(
    table(
      [
        'Array',
        'Flow',
        'Fits',
        'LUTs (Yosys)',
        'Flip-flops (Yosys)',
        'Logic cells (nextpnr)',
        'Block RAM (nextpnr)',
        'DSP (nextpnr)',
        'Fmax',
        `Meets ${String(summary.settings.freqMHz)} MHz`,
      ],
      rows,
    ),
    '',
    'Bold utilisation is over 100 %: nextpnr reports it before placement and stops, so a design that does not fit has no Fmax.',
    '',
  );
  for (const s of sizes) {
    for (const [family, result] of Object.entries(s.fpga)) {
      if (result.status !== 'ran') continue;
      const header = `### ${String(s.rows)} × ${String(s.cols)}, ${family}: ${result.device}`;
      if (!result.fits) {
        out.push(
          header,
          '',
          `Does not fit: over ${result.overUtilised.map(code).join(', ')}. nextpnr: ${code(result.reason)}.`,
          '',
        );
        continue;
      }
      const cp = result.criticalPath;
      out.push(
        header,
        '',
        `Fmax ${result.fmaxMHz.toFixed(2)} MHz is an estimate for ${result.timingLabel} only (seed ${String(result.seed)}).` +
          (cp === null
            ? ''
            : ` Critical path ${cp.delayNs.toFixed(2)} ns (${cp.logicNs.toFixed(2)} ns logic in ${String(cp.logicStages)} stages, ` +
              `${cp.routingNs.toFixed(2)} ns routing), ${code(cp.from)} → ${code(cp.to)}; RTL lines on it: ` +
              `${cp.rtlSources.map((r) => `${code(r.location)} (${String(r.nets)})`).join(', ') || 'none recorded'}.`),
        '',
      );
    }
  }

  out.push('## Generic synthesis by block', '');
  for (const s of sizes) {
    out.push(
      `### ${String(s.rows)} × ${String(s.cols)}`,
      '',
      table(
        ['Block', 'Module', 'Instances', 'Cells', 'Flip-flops', 'Combinational', 'Memories'],
        s.generic.blocks.map((b) => [
          b.block === s.generic.top ? `**${b.block}** (whole design)` : code(b.block),
          code(b.module),
          fmt(b.instances),
          fmt(b.cells),
          fmt(b.flipFlops),
          fmt(b.combinational),
          fmt(b.memories),
        ]),
      ),
      '',
      `Longest gate path: ${String(s.generic.logicDepth.length)} gates from ${code(s.generic.logicDepth.from)} to ` +
        `${code(s.generic.logicDepth.to)}${s.generic.logicDepth.endFlipFlop === null ? '' : ` (into ${code(s.generic.logicDepth.endFlipFlop)})`}` +
        `${s.generic.logicDepth.through.length > 0 ? `, through ${s.generic.logicDepth.through.map(code).join(' → ')}` : ''}.`,
      '',
    );
  }

  out.push('## Memories', '');
  const families = [...new Set(sizes.flatMap((s) => Object.keys(s.fpga)))];
  out.push(
    table(
      ['Array', 'Buffer', 'Banks', 'Shape per bank', 'Bits', 'Read ports (sync)', ...families],
      sizes.flatMap((s) =>
        s.memories.map((m) => [
          `${String(s.rows)} × ${String(s.cols)}`,
          `${code(m.instance)} (${code(m.module)})`,
          fmt(m.banks),
          `${fmt(m.words)} × ${String(m.width)}`,
          fmt(m.bits),
          `${String(m.readPorts)} (${String(m.syncReadPorts)})`,
          ...families.map((f) => m.fpga[f] ?? 'flow absent'),
        ]),
      ),
    ),
    '',
  );

  out.push('## Warnings', '');
  if (summary.warnings.length === 0) {
    out.push('None.', '');
  } else {
    out.push(
      table(
        ['Log', 'Warning', 'Count', 'Allowed by'],
        summary.warnings.map((w) => [
          w.source,
          code(w.message),
          String(w.count),
          w.allowedBy === null ? '**not allowed: gate failure**' : code(w.allowedBy),
        ]),
      ),
      '',
    );
  }
  out.push(
    `Gate: **${summary.gate.passed ? 'passed' : 'FAILED'}**` +
      (summary.gate.failures.length > 0
        ? `; ${String(summary.gate.failures.length)} unreviewed warnings.`
        : '.') +
      ' The structural gates (hierarchy, no latch, no loop, no multiple driver, no undriven net) ran in every Yosys run; `make synth` stops before this summary if one fails.',
    '',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The commands

export interface SynthSummaryOptions {
  /** build/, holding build/synth-<R>x<C>/ for each size; the summary goes to build/synth/. */
  readonly dir: string;
  readonly sizes: readonly number[];
  /** synth/warnings.allow. */
  readonly allow: string;
  /** The Makefile's TOOLCHAIN: the pinned OSS CAD Suite's directory, or `PATH`. */
  readonly toolchain: string;
  readonly toolchainVersion: string;
  readonly revision: string;
  readonly freqMHz: number;
  readonly seed: number;
  readonly ice40: FpgaTarget;
  readonly ecp5: FpgaTarget;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(args: readonly string[]): string {
  const run = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * Build build/synth/summary.json and summary.md from the outputs of `make synth`. Returns the
 * exit code: 0 when every gate passed, 1 when a warning is not in the allowlist.
 */
export function runMatmulSynthSummary(
  options: SynthSummaryOptions,
  write: (text: string) => void,
): number {
  const allow = parseAllowlist(readFileSync(options.allow, 'utf8'));
  // Absolute paths in warnings and sources are machine-specific; report them repository-relative.
  const strip = [`${REPO_ROOT}/`, `${options.toolchain}/`].filter((p) => p !== 'PATH/');
  const warnings: SynthWarning[] = [];
  const summaryDir = join(options.dir, 'synth');
  const tools: Record<string, string | null> = {};
  for (const family of ['ice40', 'ecp5']) {
    const file = join(summaryDir, `nextpnr-${family}.version`);
    tools[`nextpnr-${family}`] = existsSync(file)
      ? nextpnrVersion(readFileSync(file, 'utf8'))
      : null;
  }

  const sizes: SizeSummary[] = [];
  for (const n of options.sizes) {
    const size = `${String(n)}x${String(n)}`;
    const dir = join(options.dir, `synth-${size}`);
    const at = (file: string): string => join(dir, file);
    const log = (file: string): string => {
      const text = readFileSync(at(file), 'utf8');
      warnings.push(...collectWarnings(`${size}/${file}`, text, allow, strip));
      return text;
    };
    log('generic.log');
    const genericStat = StatJsonSchema.parse(readJson(at('generic.stat.json')));
    tools.yosys ??= yosysVersion(genericStat.creator);

    const fpga: Record<string, FpgaFlowFiles | { absent: string }> = {};
    const fpgaYosysLogs: Record<string, string> = {};
    for (const target of [options.ice40, options.ecp5]) {
      const family = target.family;
      const tool = `nextpnr-${family}`;
      if (!existsSync(at(`${tool}.log`))) {
        // make synth fails before this point when nextpnr-ice40 is missing; ECP5 is optional.
        if (family === 'ice40')
          throw new Error(`${at(`${tool}.log`)} is missing: did ${tool} run?`);
        fpga[family] = { absent: `${tool} is not installed` };
        continue;
      }
      fpgaYosysLogs[family] = log(`${family}.log`);
      const nextpnrLog = log(`${tool}.log`);
      const noFit = existsSync(at(`${tool}.nofit`))
        ? readFileSync(at(`${tool}.nofit`), 'utf8')
        : null;
      if (noFit === null && !existsSync(at(`${tool}.report.json`))) {
        throw new Error(`${at(`${tool}.report.json`)} is missing, and the run left no .nofit`);
      }
      fpga[family] = {
        target,
        seed: options.seed,
        constraintMHz: options.freqMHz,
        stat: StatJsonSchema.parse(readJson(at(`${family}.stat.json`))),
        nextpnrLog,
        report: noFit === null ? readJson(at(`${tool}.report.json`)) : null,
        noFit,
      };
    }

    sizes.push(
      sizeSummary(
        {
          rows: n,
          cols: n,
          genericStat,
          mulStat: StatJsonSchema.parse(readJson(at('generic.mul.stat.json'))),
          gatesStat: StatJsonSchema.parse(readJson(at('generic.gates.stat.json'))),
          ltp: readFileSync(at('generic.ltp.txt'), 'utf8'),
          memories: readJson(at('generic.memories.json')),
          netlist: readJson(at('generic.json')),
          fpga,
          fpgaYosysLogs,
        },
        REPO_ROOT,
      ),
    );
  }

  const summary = buildMatmulSummary({
    revision: options.revision,
    gitSha: git(['rev-parse', 'HEAD']),
    gitDirty: git(['status', '--porcelain']) !== '',
    toolchain:
      options.toolchain === 'PATH'
        ? `tools from PATH (not the pinned OSS CAD Suite ${options.toolchainVersion})`
        : `OSS CAD Suite ${options.toolchainVersion}`,
    tools: Object.fromEntries(Object.entries(tools).sort(([a], [b]) => (a < b ? -1 : 1))),
    freqMHz: options.freqMHz,
    seed: options.seed,
    targets: { ice40: options.ice40, ecp5: options.ecp5 },
    sizes,
    warnings,
    allow,
  });

  mkdirSync(summaryDir, { recursive: true });
  writeFileSync(join(summaryDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(summaryDir, 'summary.md'), renderMatmulSummaryMarkdown(summary));

  for (const s of summary.sizes) {
    const g = s.generic;
    write(
      `synth ${s.size}: ${fmt(g.total.cells)} generic cells (${fmt(g.total.flipFlops)} flip-flops), ` +
        `${String(g.mulCells)} $mul, ${String(g.memoryBanks)} memory banks (${fmt(g.memoryBits)} bits), ` +
        `${fmt(g.abstractGates)} abstract gates, logic depth ${String(g.logicDepth.length)}\n`,
    );
    for (const [family, r] of Object.entries(s.fpga)) {
      write(
        r.status === 'absent'
          ? `synth ${s.size}: ${family} not run: ${r.reason}\n`
          : r.fits
            ? `synth ${s.size}: ${family} ${r.device}: fits; ${fmt(r.synth.luts)} LUTs, ${fmt(r.synth.flipFlops)} FFs, ` +
              `${String(r.synth.blockRam)} block RAM, ${String(r.synth.dsp)} DSP; Fmax ${r.fmaxMHz.toFixed(2)} MHz estimate ` +
              `(target ${String(r.constraintMHz)} MHz, ${r.meetsConstraint ? 'met' : 'NOT met'})\n`
            : `synth ${s.size}: ${family} ${r.device}: does not fit (over ${r.overUtilised.join(', ')})\n`,
      );
    }
  }
  write(`synth: power ${POWER}; wrote ${join(summaryDir, 'summary.json')} and summary.md\n`);
  if (!summary.gate.passed) {
    write(
      `synth: FAILED: ${String(summary.gate.failures.length)} warnings not in ${options.allow}:\n` +
        summary.gate.failures.map((failure) => `  ${failure}\n`).join(''),
    );
    return 1;
  }
  write(
    `synth: gates passed; ${String(warnings.reduce((n, w) => n + w.count, 0))} warnings, all in the reviewed allowlist\n`,
  );
  return 0;
}

/**
 * Compare a fresh summary with the committed baseline: 0 when every metric matches, 1 on any
 * difference (provenance differences are printed, never counted) or an unreadable file.
 */
export function runMatmulSynthCompare(
  baselinePath: string,
  summaryPath: string,
  write: (text: string) => void,
): number {
  if (!existsSync(baselinePath)) {
    write(`synth-compare: no baseline at ${baselinePath}; run make synth-baseline and commit it\n`);
    return 1;
  }
  const files = { baseline: baselinePath, summary: summaryPath };
  const parsed: Partial<Record<keyof typeof files, MatmulSynthSummary>> = {};
  for (const [name, path] of Object.entries(files) as [keyof typeof files, string][]) {
    const result = MatmulSynthSummarySchema.safeParse(readJson(path));
    if (!result.success) {
      write(
        `synth-compare: the ${name} ${path} is not a ${MATMUL_SYNTH_FORMAT} file: ${result.error.message}\n`,
      );
      return 1;
    }
    parsed[name] = result.data;
  }
  const { deltas, provenance } = compareSummaries(parsed.baseline, parsed.summary);
  for (const delta of provenance) {
    write(`synth-compare: note: ${formatDelta(delta).trim()}\n`);
  }
  const name = relative(REPO_ROOT, baselinePath);
  if (deltas.length === 0) {
    write(`synth-compare: 0 deltas: the fresh summary matches ${name}\n`);
    return 0;
  }
  write(
    `synth-compare: FAILED: ${String(deltas.length)} deltas against ${name} (baseline → fresh):\n`,
  );
  for (const delta of deltas) write(`${formatDelta(delta)}\n`);
  write(
    'synth-compare: if the change is intended, run make synth-baseline from a clean tree and commit the new baseline\n',
  );
  return 1;
}
