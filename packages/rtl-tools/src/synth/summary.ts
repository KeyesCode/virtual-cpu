import { z } from 'zod';

// Parsers for the outputs of `make synth` (hardware/rtl/vcpu8/mk/synth.mk) and the summary built
// from them. Everything here is pure: commands/synth.ts reads the files and writes the results.
//
// Counts are Yosys cells or FPGA primitives, never transistors, and the only timing figures are
// nextpnr's estimates for a named FPGA device. docs/hardware/synthesis-guide.md explains both.

export const SYNTH_SUMMARY_FORMAT = 'vcpu8-synth-summary/1';

/** Cell types that are bookkeeping, not hardware: Yosys keeps one per flattened instance. */
const NON_HARDWARE_CELLS = new Set(['$scopeinfo']);

// ---------------------------------------------------------------------------------------------
// Yosys `stat -json`

const StatModuleSchema = z.object({
  num_cells: z.number().int(),
  num_cells_by_type: z.record(z.string(), z.number().int()),
});

export const StatJsonSchema = z.object({
  creator: z.string(),
  modules: z.record(z.string(), StatModuleSchema),
});
export type StatJson = z.output<typeof StatJsonSchema>;

/** `\vcpu8_top` → `vcpu8_top`; `$paramod\vcpu8_memory\INIT_FILE=…` → `vcpu8_memory`. */
export function moduleName(raw: string): string {
  const paramod = /^\$paramod(?:\$[0-9a-f]+)?\\([^\\]+)/.exec(raw);
  if (paramod?.[1] !== undefined) {
    return paramod[1];
  }
  return raw.startsWith('\\') ? raw.slice(1) : raw;
}

/** Generic Yosys flip-flops: every `$_…DFF…_` cell and `$_FF_`. Latches never reach here. */
const GENERIC_FF = /^\$_(DFF|DFFE|SDFF|SDFFE|SDFFCE|DFFSR|DFFSRE|ALDFF|ALDFFE)_|^\$_FF_$/;
const GENERIC_MEMORY = /^\$mem(_v2)?$/;

export interface CellCounts {
  /** Hardware cells: flip-flops, memories and combinational cells. */
  readonly cells: number;
  readonly flipFlops: number;
  readonly combinational: number;
  readonly memories: number;
  /** Every hardware cell type and its count, sorted by type. */
  readonly byType: Readonly<Record<string, number>>;
}

function sortedRecord(entries: Iterable<[string, number]>): Record<string, number> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Count a cell-type histogram, leaving out submodule instances and non-hardware cells. */
export function countCells(
  byType: Readonly<Record<string, number>>,
  isFlipFlop: (type: string) => boolean = (type) => GENERIC_FF.test(type),
  isSubmodule: (type: string) => boolean = () => false,
): CellCounts {
  const kept = new Map<string, number>();
  let flipFlops = 0;
  let memories = 0;
  let cells = 0;
  for (const [type, count] of Object.entries(byType)) {
    if (NON_HARDWARE_CELLS.has(type) || isSubmodule(type)) {
      continue;
    }
    kept.set(type, (kept.get(type) ?? 0) + count);
    cells += count;
    if (isFlipFlop(type)) {
      flipFlops += count;
    } else if (GENERIC_MEMORY.test(type)) {
      memories += count;
    }
  }
  return {
    cells,
    flipFlops,
    combinational: cells - flipFlops - memories,
    memories,
    byType: sortedRecord(kept),
  };
}

function addCounts(a: CellCounts, b: CellCounts, times: number): CellCounts {
  const byType = new Map(Object.entries(a.byType));
  for (const [type, count] of Object.entries(b.byType)) {
    byType.set(type, (byType.get(type) ?? 0) + count * times);
  }
  return {
    cells: a.cells + b.cells * times,
    flipFlops: a.flipFlops + b.flipFlops * times,
    combinational: a.combinational + b.combinational * times,
    memories: a.memories + b.memories * times,
    byType: sortedRecord(byType),
  };
}

export interface ModuleStats {
  /** Each module's own cells, excluding its submodules. */
  readonly local: Readonly<Record<string, CellCounts>>;
  /** Each module that has submodules, with all of them included. */
  readonly subtrees: Readonly<Record<string, CellCounts>>;
  /** Each module's submodules, by module name, with instance counts. */
  readonly children: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Per-module and per-subtree counts from a hierarchical `stat -json`. */
export function moduleStats(stat: StatJson): ModuleStats {
  const raw = new Map<string, Readonly<Record<string, number>>>();
  for (const [name, module] of Object.entries(stat.modules)) {
    raw.set(moduleName(name), module.num_cells_by_type);
  }
  const isSubmodule = (type: string): boolean => raw.has(moduleName(type));

  const local: Record<string, CellCounts> = {};
  const children: Record<string, Record<string, number>> = {};
  for (const [name, byType] of [...raw].sort(([a], [b]) => (a < b ? -1 : 1))) {
    local[name] = countCells(byType, undefined, isSubmodule);
    const subs: Record<string, number> = {};
    for (const [type, count] of Object.entries(byType)) {
      if (isSubmodule(type)) {
        subs[moduleName(type)] = (subs[moduleName(type)] ?? 0) + count;
      }
    }
    children[name] = subs;
  }

  const totals = new Map<string, CellCounts>();
  const total = (name: string, path: readonly string[]): CellCounts => {
    const done = totals.get(name);
    if (done !== undefined) return done;
    if (path.includes(name)) throw new Error(`stat -json: module ${name} instantiates itself`);
    let sum = local[name];
    if (sum === undefined) throw new Error(`stat -json: no module ${name}`);
    for (const [child, count] of Object.entries(children[name] ?? {})) {
      sum = addCounts(sum, total(child, [...path, name]), count);
    }
    totals.set(name, sum);
    return sum;
  };

  const subtrees: Record<string, CellCounts> = {};
  for (const name of Object.keys(local)) {
    if (Object.keys(children[name] ?? {}).length > 0) {
      subtrees[name] = total(name, []);
    }
  }
  return { local, subtrees, children };
}

/** `Yosys 0.70+145 (git sha1 a31d95ea0, Release, Clang …)` → `Yosys 0.70+145 (git sha1 a31d95ea0)`. */
export function yosysVersion(creator: string): string {
  const match = /^(Yosys \S+)(?: \((git sha1 [0-9a-f]+))?/.exec(creator);
  if (match?.[1] === undefined) return creator;
  return match[2] === undefined ? match[1] : `${match[1]} (${match[2]})`;
}

/** `"nextpnr-ice40" -- Next Generation Place and Route (Version nextpnr-0.11.1-63-g44a6c739)`. */
export function nextpnrVersion(text: string): string {
  const match = /\(Version ([^)]+)\)/.exec(text);
  return match?.[1] ?? text.trim().split('\n')[0] ?? '';
}

// ---------------------------------------------------------------------------------------------
// Yosys `ltp -noff`: the longest topological path, counted in cells

export interface LogicDepth {
  /** Cells on the longest combinational path between flip-flops and ports. */
  readonly length: number;
  readonly from: string;
  readonly to: string;
  /** The flip-flop the path ends at, if it ends at one. */
  readonly endFlipFlop: string | null;
  /** The named (public) signals along the path, in order. */
  readonly through: readonly string[];
}

function ltpNode(text: string): { name: string; public: boolean } {
  const name = text.replace(/ \(via .*\)$/, '').trim();
  const isPublic = name.startsWith('\\');
  return {
    name: (isPublic ? name.slice(1) : name).replace(/ \[(\d+)\]$/, '[$1]'),
    public: isPublic,
  };
}

export function parseLtp(text: string): LogicDepth {
  const header = /Longest topological path in \S+ \(length=(\d+)\):/.exec(text);
  if (header?.[1] === undefined) {
    throw new Error('ltp: no "Longest topological path" line');
  }
  const nodes: { name: string; public: boolean }[] = [];
  let endFlipFlop: string | null = null;
  for (const line of text.slice(header.index).split('\n').slice(1)) {
    const match = /^\s+(\d+|ff): (.*)$/.exec(line);
    if (match?.[2] === undefined) {
      if (nodes.length > 0) break;
      continue;
    }
    if (match[1] === 'ff') {
      endFlipFlop = ltpNode(match[2]).name;
    } else {
      nodes.push(ltpNode(match[2]));
    }
  }
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('ltp: the path lists no cells');
  }
  return {
    length: Number(header[1]),
    from: first.name,
    to: last.name,
    endFlipFlop,
    through: nodes.filter((node) => node.public).map((node) => node.name),
  };
}

// ---------------------------------------------------------------------------------------------
// Memory inference: `write_json -selected` of the $mem_v2 cells after `memory -nomap`

const MemJsonSchema = z.object({
  modules: z.record(
    z.string(),
    z.object({
      cells: z
        .record(
          z.string(),
          z.object({ type: z.string(), parameters: z.record(z.string(), z.string()) }),
        )
        .optional(),
    }),
  ),
});

export interface InferredMemory {
  readonly module: string;
  /** The array's name in the RTL; for ROMs, how many Yosys built from the module's case tables. */
  readonly name: string;
  /** `ram` has a write port; `rom` is read-only (constant tables Yosys extracted with proc_rom). */
  readonly kind: 'ram' | 'rom';
  /** How many memories the entry stands for: 1 for a RAM, every ROM of the module for `rom`. */
  readonly count: number;
  readonly words: number;
  /** Bits per word; for ROMs, the widths of all of them added together. */
  readonly width: number;
  readonly readPorts: number;
  /** Read ports with a clock (registered reads); the rest are combinational. */
  readonly syncReadPorts: number;
  readonly writePorts: number;
}

function binary(parameters: Readonly<Record<string, string>>, key: string): string {
  const value = parameters[key];
  if (value === undefined || !/^[01]+$/.test(value)) {
    throw new Error(`memory cell: parameter ${key} is ${String(value)}`);
  }
  return value;
}

/**
 * The memories `memory -nomap` inferred. RAMs are listed one by one; the ROMs of a module are
 * one entry, because Yosys names them by an internal counter that differs from run to run.
 */
export function parseMemories(json: unknown): InferredMemory[] {
  const parsed = MemJsonSchema.parse(json);
  const rams: InferredMemory[] = [];
  const roms = new Map<string, InferredMemory>();
  for (const [rawModule, module] of Object.entries(parsed.modules)) {
    for (const cell of Object.values(module.cells ?? {})) {
      if (cell.type !== '$mem_v2') continue;
      const p = cell.parameters;
      const memid = p.MEMID ?? '';
      const memory: InferredMemory = {
        module: moduleName(rawModule),
        name: memid.startsWith('\\') ? memid.slice(1) : memid,
        kind: parseInt(binary(p, 'WR_PORTS'), 2) > 0 ? 'ram' : 'rom',
        count: 1,
        words: parseInt(binary(p, 'SIZE'), 2),
        width: parseInt(binary(p, 'WIDTH'), 2),
        readPorts: parseInt(binary(p, 'RD_PORTS'), 2),
        syncReadPorts: binary(p, 'RD_CLK_ENABLE').replace(/0/g, '').length,
        writePorts: parseInt(binary(p, 'WR_PORTS'), 2),
      };
      if (memory.kind === 'ram') {
        rams.push(memory);
        continue;
      }
      const group = roms.get(memory.module);
      const count = (group?.count ?? 0) + 1;
      roms.set(memory.module, {
        ...memory,
        name: `${String(count)} ROM${count === 1 ? '' : 's'}`,
        count,
        words: Math.max(group?.words ?? 0, memory.words),
        width: (group?.width ?? 0) + memory.width,
        readPorts: (group?.readPorts ?? 0) + memory.readPorts,
        syncReadPorts: (group?.syncReadPorts ?? 0) + memory.syncReadPorts,
      });
    }
  }
  const byName = (a: InferredMemory, b: InferredMemory): number =>
    `${a.module}.${a.name}` < `${b.module}.${b.name}` ? -1 : 1;
  return [...rams.sort(byName), ...[...roms.values()].sort(byName)];
}

/**
 * How an FPGA flow's memory_libmap mapped each memory, keyed by its instance path below the top
 * module with Yosys's `$flatten` and backslashes removed (`u_cpu.u_core.u_registers.r`):
 * `via $__ICE40_RAM4K_` is a block RAM, `FF mapping` is flip-flops and logic.
 */
export function parseMemoryMapping(log: string): Record<string, string> {
  const mapping: Record<string, string> = {};
  const key = (path: string): string => path.replace(/^\$flatten/, '').replace(/\\/g, '');
  for (const line of log.split('\n')) {
    const via = /^mapping memory [^.]+\.(\S+) via (\S+)$/.exec(line);
    const ff = /^using FF mapping for memory [^.]+\.(\S+)$/.exec(line);
    if (via?.[1] !== undefined && via[2] !== undefined) {
      mapping[key(via[1])] = `block RAM (${via[2]})`;
    } else if (ff?.[1] !== undefined) {
      mapping[key(ff[1])] = 'flip-flops and logic (FF mapping)';
    }
  }
  return mapping;
}

/** The mapping of a memory found at one of `paths` (instance paths of its module). */
function mappingOf(
  memory: InferredMemory,
  paths: readonly string[],
  mapping: Readonly<Record<string, string>>,
): string {
  const under = (instance: string, path: string): boolean =>
    instance === path || instance.endsWith(`.${path}`);
  const found = new Set<string>();
  for (const [key, value] of Object.entries(mapping)) {
    const rom = /^(.*)\.\$auto\$proc_rom/.exec(key);
    const hit =
      memory.kind === 'rom'
        ? rom?.[1] !== undefined && paths.some((path) => under(rom[1] ?? '', path))
        : paths.some((path) => under(key, path === '' ? memory.name : `${path}.${memory.name}`));
    if (hit) found.add(value);
  }
  if (found.size === 0) return 'not reported by memory_libmap';
  // A ROM has nothing to store, so its "FF mapping" is a table of constants: logic only.
  return [...found]
    .sort()
    .map((value) =>
      memory.kind === 'rom' ? value.replace('flip-flops and logic', 'logic') : value,
    )
    .join('; ');
}

/** Instance paths below `top` for every module, from a hierarchical Yosys JSON netlist. */
export function instancePaths(netlist: unknown, top: string): Record<string, string[]> {
  const parsed = z
    .object({
      modules: z.record(
        z.string(),
        z.object({ cells: z.record(z.string(), z.object({ type: z.string() })).optional() }),
      ),
    })
    .parse(netlist);
  const modules = new Map(
    Object.entries(parsed.modules).map(([name, module]) => [moduleName(name), module]),
  );
  const paths: Record<string, string[]> = {};
  const walk = (name: string, prefix: string): void => {
    (paths[name] ??= []).push(prefix);
    for (const [cell, { type }] of Object.entries(modules.get(name)?.cells ?? {})) {
      const child = moduleName(type);
      if (modules.has(child)) {
        walk(child, prefix === '' ? cell : `${prefix}.${cell}`);
      }
    }
  };
  walk(top, '');
  return paths;
}

// ---------------------------------------------------------------------------------------------
// Warnings and the reviewed allowlist

export interface AllowEntry {
  readonly pattern: string;
  /** The comment block above the pattern in warnings.allow. */
  readonly review: string;
}

export function parseAllowlist(text: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  let comment: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      comment = [];
    } else if (line.startsWith('#')) {
      comment.push(line.replace(/^#\s?/, ''));
    } else {
      new RegExp(line); // a malformed expression fails here, not at match time
      entries.push({ pattern: line, review: comment.join(' ') });
      comment = [];
    }
  }
  return entries;
}

export interface SynthWarning {
  /** The log the warning came from. */
  readonly source: string;
  readonly message: string;
  readonly count: number;
  /** The allowlist pattern it matched, or null: a gate failure. */
  readonly allowedBy: string | null;
}

/** Every `Warning:` (and `ABC: Warning:`) line of a log, counted, with `strip` removed. */
export function collectWarnings(
  source: string,
  log: string,
  allow: readonly AllowEntry[],
  strip: readonly string[] = [],
): SynthWarning[] {
  const counts = new Map<string, number>();
  for (const raw of log.split('\n')) {
    if (!/^(ABC: )?Warning: /.test(raw)) continue;
    let message = raw.trimEnd();
    for (const prefix of strip) message = message.split(prefix).join('');
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([message, count]) => ({
      source,
      message,
      count,
      allowedBy: allow.find((entry) => new RegExp(entry.pattern).test(message))?.pattern ?? null,
    }));
}

// ---------------------------------------------------------------------------------------------
// FPGA flows: Yosys primitive counts and the nextpnr report

/** FPGA primitive categories, by cell type. Anything else is counted under `other`. */
const FPGA_CATEGORIES: readonly [Exclude<keyof FpgaCells, 'byType' | 'other'>, RegExp][] = [
  ['luts', /^(SB_LUT4|LUT4)$/],
  ['carry', /^(SB_CARRY|CCU2C)$/],
  ['flipFlops', /^(SB_DFF\w*|TRELLIS_FF)$/],
  ['blockRam', /^(SB_RAM40_4K\w*|DP16KD|PDPW16KD)$/],
  ['dsp', /^(SB_MAC16|MULT18X18D|ALU54B)$/],
  ['wideMux', /^(PFUMX|L6MUX21)$/],
];

export interface FpgaCells {
  readonly luts: number;
  readonly carry: number;
  readonly flipFlops: number;
  readonly blockRam: number;
  readonly dsp: number;
  readonly wideMux: number;
  readonly other: number;
  readonly byType: Readonly<Record<string, number>>;
}

export function fpgaCells(stat: StatJson): FpgaCells {
  const byType = new Map<string, number>();
  for (const module of Object.values(stat.modules)) {
    for (const [type, count] of Object.entries(module.num_cells_by_type)) {
      if (!NON_HARDWARE_CELLS.has(type)) byType.set(type, (byType.get(type) ?? 0) + count);
    }
  }
  const sums = { luts: 0, carry: 0, flipFlops: 0, blockRam: 0, dsp: 0, wideMux: 0, other: 0 };
  for (const [type, count] of byType) {
    const category = FPGA_CATEGORIES.find(([, pattern]) => pattern.test(type))?.[0] ?? 'other';
    sums[category] += count;
  }
  return { ...sums, byType: sortedRecord(byType) };
}

const NextpnrEndpointSchema = z.object({ cell: z.string() });
export const NextpnrReportSchema = z.object({
  fmax: z.record(z.string(), z.object({ achieved: z.number(), constraint: z.number() })),
  utilization: z.record(z.string(), z.object({ available: z.number(), used: z.number() })),
  critical_paths: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      path: z.array(
        z.object({
          delay: z.number(),
          type: z.string(),
          from: NextpnrEndpointSchema,
          to: NextpnrEndpointSchema,
          sources: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});
export type NextpnrReport = z.output<typeof NextpnrReportSchema>;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface CriticalPath {
  readonly from: string;
  readonly to: string;
  readonly delayNs: number;
  readonly logicNs: number;
  readonly routingNs: number;
  /** Logic elements (LUTs, carries) the path passes through. */
  readonly logicStages: number;
  /** The RTL lines the path's nets come from, by number of nets, most first. */
  readonly rtlSources: readonly { readonly location: string; readonly nets: number }[];
}

export interface PlaceAndRoute {
  readonly clock: string;
  readonly fmaxMHz: number;
  readonly constraintMHz: number;
  readonly meetsConstraint: boolean;
  /** Every resource nextpnr placed at least one of: used / available. */
  readonly utilisation: Readonly<
    Record<string, { readonly used: number; readonly available: number }>
  >;
  readonly criticalPath: CriticalPath | null;
}

/**
 * The clock's Fmax and the register-to-register critical path. `rtlRoot` is the absolute path
 * prefix of the repository: only sources under it count as RTL lines, reported relative to it.
 */
export function placeAndRoute(report: NextpnrReport, rtlRoot: string): PlaceAndRoute {
  const clocks = Object.entries(report.fmax);
  const clock = clocks[0];
  if (clock === undefined || clocks.length !== 1) {
    throw new Error(`nextpnr report: expected one clock, found ${String(clocks.length)}`);
  }
  const [name, { achieved, constraint }] = clock;
  const utilisation: Record<string, { used: number; available: number }> = {};
  for (const [resource, { used, available }] of Object.entries(report.utilization).sort(
    ([a], [b]) => (a < b ? -1 : 1),
  )) {
    if (used > 0) utilisation[resource] = { used, available };
  }

  const regToReg = report.critical_paths.find(
    (path) => /^(pos|neg)edge /.test(path.from) && /^(pos|neg)edge /.test(path.to),
  );
  let criticalPath: CriticalPath | null = null;
  const first = regToReg?.path[0];
  const last = regToReg?.path[regToReg.path.length - 1];
  if (regToReg !== undefined && first !== undefined && last !== undefined) {
    const sources = new Map<string, number>();
    for (const step of regToReg.path) {
      for (const source of step.sources ?? []) {
        const match = /^(.*\.s?v):(\d+)\./.exec(source);
        if (match?.[1]?.startsWith(rtlRoot) === true && match[2] !== undefined) {
          const location = `${match[1].slice(rtlRoot.length).replace(/^\//, '')}:${match[2]}`;
          sources.set(location, (sources.get(location) ?? 0) + 1);
        }
      }
    }
    const sum = (type: string): number =>
      round2(regToReg.path.filter((s) => s.type === type).reduce((t, s) => t + s.delay, 0));
    criticalPath = {
      from: first.from.cell,
      to: last.to.cell,
      delayNs: round2(regToReg.path.reduce((t, s) => t + s.delay, 0)),
      logicNs: sum('logic'),
      routingNs: sum('routing'),
      logicStages: regToReg.path.filter((s) => s.type === 'logic').length,
      rtlSources: [...sources]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
        .map(([location, nets]) => ({ location, nets })),
    };
  }
  return {
    clock: name,
    fmaxMHz: round2(achieved),
    constraintMHz: constraint,
    meetsConstraint: achieved >= constraint,
    utilisation,
    criticalPath,
  };
}

// ---------------------------------------------------------------------------------------------
// Devices

export interface FpgaTarget {
  readonly family: 'ice40' | 'ecp5';
  /** The nextpnr device flag without its dashes, e.g. `up5k` or `25k`. */
  readonly device: string;
  readonly package: string;
  /** The ECP5 speed grade passed to nextpnr; the iCE40 flow has none. */
  readonly speed: string | null;
}

/** The part name for a nextpnr device flag: up5k → iCE40UP5K, 25k → LFE5U-25F, um-45k → LFE5UM-45F. */
export function deviceName(target: FpgaTarget): string {
  if (target.family === 'ice40') {
    return `iCE40${target.device.toUpperCase()}`;
  }
  const match = /^(?:(um5g|um)-)?(\d+)k$/.exec(target.device);
  if (match?.[2] === undefined) return `ECP5 ${target.device}`;
  return `LFE5${(match[1] ?? 'u').toUpperCase()}-${match[2]}F`;
}

/** How the timing figure must be labelled: the device, package and speed grade it holds for. */
export function timingLabel(target: FpgaTarget): string {
  const part = `${deviceName(target)} ${target.package.toUpperCase()}`;
  return target.speed === null
    ? `${part}, nextpnr-${target.family} timing model (the device has a single speed grade)`
    : `${part}, speed grade ${target.speed}, nextpnr-${target.family} timing model`;
}

// ---------------------------------------------------------------------------------------------
// The summary

export interface MemorySummary extends InferredMemory {
  /** The generic flow has no RAM cells, so memory_map always builds memories from cells. */
  readonly generic: string;
  /** Per FPGA flow, how memory_libmap mapped the memory; null when that flow did not run. */
  readonly fpga: Readonly<Record<string, string | null>>;
}

export interface FpgaFlow {
  readonly status: 'ran';
  readonly device: string;
  readonly package: string;
  readonly speedGrade: string | null;
  readonly timingLabel: string;
  readonly top: string;
  readonly initFile: string;
  readonly seed: number;
  readonly synth: FpgaCells;
  readonly pnr: PlaceAndRoute;
}

export interface AbsentFlow {
  readonly status: 'absent';
  readonly reason: string;
}

export interface SynthSummary {
  readonly format: typeof SYNTH_SUMMARY_FORMAT;
  /** Where the numbers came from. synth-compare reports differences here but does not count them. */
  readonly provenance: {
    readonly gitSha: string;
    readonly gitDirty: boolean;
    readonly toolchain: string;
    readonly tools: Readonly<Record<string, string | null>>;
  };
  readonly generic: {
    readonly top: string;
    readonly total: CellCounts;
    readonly subtrees: Readonly<Record<string, CellCounts>>;
    readonly modules: Readonly<Record<string, CellCounts>>;
    readonly gates: CellCounts & { readonly logicDepth: LogicDepth };
  };
  readonly memories: readonly MemorySummary[];
  readonly fpga: Readonly<Record<string, FpgaFlow | AbsentFlow>>;
  readonly warnings: readonly SynthWarning[];
  readonly gate: {
    readonly passed: boolean;
    readonly failures: readonly string[];
    /** Allowlist patterns that matched nothing in this run. */
    readonly unusedAllowEntries: readonly string[];
  };
}

export interface FpgaInputs {
  readonly target: FpgaTarget;
  readonly top: string;
  readonly initFile: string;
  readonly seed: number;
  readonly stat: StatJson;
  readonly report: NextpnrReport;
  readonly yosysLog: string;
}

export interface SummaryInputs {
  readonly gitSha: string;
  readonly gitDirty: boolean;
  readonly toolchain: string;
  readonly tools: Readonly<Record<string, string | null>>;
  readonly top: string;
  readonly genericStat: StatJson;
  readonly gatesStat: StatJson;
  readonly ltp: string;
  readonly memories: unknown;
  /** The hierarchical generic netlist, for each module's instance path. */
  readonly netlist: unknown;
  /** Per FPGA family, the flow's outputs, or why it did not run. */
  readonly fpga: Readonly<Record<string, FpgaInputs | { readonly absent: string }>>;
  readonly warnings: readonly SynthWarning[];
  readonly allow: readonly AllowEntry[];
  /** The repository's absolute path, stripped from every reported source location. */
  readonly repoRoot: string;
}

export function buildSummary(inputs: SummaryInputs): SynthSummary {
  const stats = moduleStats(inputs.genericStat);
  const total = stats.subtrees[inputs.top] ?? stats.local[inputs.top];
  if (total === undefined) {
    throw new Error(`stat -json: no top module ${inputs.top}`);
  }
  const gateModules = Object.values(inputs.gatesStat.modules);
  if (gateModules.length !== 1 || gateModules[0] === undefined) {
    throw new Error('abstract-gate stat -json: expected one flattened module');
  }
  const gates = countCells(gateModules[0].num_cells_by_type);

  const paths = instancePaths(inputs.netlist, inputs.top);
  const fpga: Record<string, FpgaFlow | AbsentFlow> = {};
  const mappings: Record<string, Record<string, string> | null> = {};
  for (const [family, flow] of Object.entries(inputs.fpga)) {
    if ('absent' in flow) {
      fpga[family] = { status: 'absent', reason: flow.absent };
      mappings[family] = null;
      continue;
    }
    fpga[family] = {
      status: 'ran',
      device: `${deviceName(flow.target)} ${flow.target.package.toUpperCase()}`,
      package: flow.target.package,
      speedGrade: flow.target.speed,
      timingLabel: timingLabel(flow.target),
      top: flow.top,
      initFile: flow.initFile,
      seed: flow.seed,
      synth: fpgaCells(flow.stat),
      pnr: placeAndRoute(flow.report, inputs.repoRoot),
    };
    mappings[family] = parseMemoryMapping(flow.yosysLog);
  }

  const memories = parseMemories(inputs.memories).map((memory): MemorySummary => {
    const mapped: Record<string, string | null> = {};
    for (const [family, mapping] of Object.entries(mappings)) {
      mapped[family] =
        mapping === null ? null : mappingOf(memory, paths[memory.module] ?? [], mapping);
    }
    const generic =
      memory.kind === 'rom' ? 'logic (memory_map)' : 'flip-flops and logic (memory_map)';
    return { ...memory, generic, fpga: mapped };
  });

  const failures = inputs.warnings
    .filter((warning) => warning.allowedBy === null)
    .map((warning) => `${warning.source}: ${warning.message}`);
  const used = new Set(inputs.warnings.map((warning) => warning.allowedBy));

  return {
    format: SYNTH_SUMMARY_FORMAT,
    provenance: {
      gitSha: inputs.gitSha,
      gitDirty: inputs.gitDirty,
      toolchain: inputs.toolchain,
      tools: inputs.tools,
    },
    generic: {
      top: inputs.top,
      total,
      subtrees: stats.subtrees,
      modules: stats.local,
      gates: { ...gates, logicDepth: parseLtp(inputs.ltp) },
    },
    memories,
    fpga,
    warnings: inputs.warnings,
    gate: {
      passed: failures.length === 0,
      failures,
      unusedAllowEntries: inputs.allow.map((e) => e.pattern).filter((p) => !used.has(p)),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Markdown

const fmt = (n: number): string => n.toLocaleString('en-US');

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

export function renderSummaryMarkdown(summary: SynthSummary): string {
  const { generic } = summary;
  const out: string[] = [];
  const tools = Object.entries(summary.provenance.tools)
    .map(([tool, version]) => `${tool}: ${version ?? 'not installed'}`)
    .join('; ');
  out.push(
    '# VCPU-8 synthesis summary',
    '',
    `Generated by \`make -C hardware/rtl/vcpu8 synth\` at git ${code(summary.provenance.gitSha.slice(0, 12))}` +
      `${summary.provenance.gitDirty ? ' (with uncommitted changes)' : ''}, ${summary.provenance.toolchain}: ${tools}.`,
    '',
    'Cell counts are Yosys cells or FPGA primitives, not transistors, and no area or power is measured. ' +
      'The only timing figures are nextpnr place-and-route estimates for the FPGA device named beside them. ' +
      'See `docs/hardware/synthesis-guide.md`.',
    '',
    `## Generic synthesis (\`synth -top ${generic.top}\`)`,
    '',
    'Technology-independent Yosys internal cells. With no target library, the 256-byte RAM becomes flip-flops here.',
    '',
    table(
      ['Module', 'Cells', 'Flip-flops', 'Combinational'],
      [
        ...Object.entries(generic.subtrees).map(([name, c]) => [
          `**${name}** (with submodules)`,
          fmt(c.cells),
          fmt(c.flipFlops),
          fmt(c.combinational),
        ]),
        ...Object.entries(generic.modules).map(([name, c]) => [
          name,
          fmt(c.cells),
          fmt(c.flipFlops),
          fmt(c.combinational),
        ]),
      ],
    ),
    '',
    `Cell types in ${generic.top}: ${Object.entries(generic.total.byType)
      .map(([type, n]) => `${code(type)} ${fmt(n)}`)
      .join(', ')}.`,
    '',
    '### Abstract gates (flattened, `abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX`)',
    '',
    `${fmt(generic.gates.cells)} cells: ${fmt(generic.gates.flipFlops)} flip-flops and ${fmt(generic.gates.combinational)} gates ` +
      `(${Object.entries(generic.gates.byType)
        .filter(([type]) => !GENERIC_FF.test(type))
        .map(([type, n]) => `${code(type)} ${fmt(n)}`)
        .join(', ')}).`,
    '',
    `Logic depth (\`ltp -noff\`): **${String(generic.gates.logicDepth.length)} gates** on the longest path, ` +
      `from ${code(generic.gates.logicDepth.from)} to ${code(generic.gates.logicDepth.to)}` +
      `${generic.gates.logicDepth.endFlipFlop === null ? '' : ` (into ${code(generic.gates.logicDepth.endFlipFlop)})`}, ` +
      `through ${generic.gates.logicDepth.through.map(code).join(' → ')}. ` +
      'A gate count, not a delay: no cell library gives these gates a time.',
    '',
    '## Memory inference',
    '',
  );
  const families = Object.keys(summary.fpga);
  out.push(
    table(
      ['Memory', 'Kind', 'Shape', 'Read ports (sync)', 'Write ports', 'Generic', ...families],
      summary.memories.map((m) => [
        m.kind === 'rom' ? `${code(m.module)}: ${m.name}` : code(`${m.module}.${m.name}`),
        m.kind === 'ram' ? 'RAM' : 'ROM (case table)',
        m.kind === 'rom'
          ? `${String(m.count)} × ${String(m.words)} words, ${String(m.width)} bits in all`
          : `${String(m.words)} × ${String(m.width)}`,
        `${String(m.readPorts)} (${String(m.syncReadPorts)})`,
        String(m.writePorts),
        m.generic,
        ...families.map((f) => m.fpga[f] ?? 'flow absent'),
      ]),
    ),
    '',
    '## FPGA synthesis and place-and-route',
    '',
  );
  const ran = Object.entries(summary.fpga).filter(
    (entry): entry is [string, FpgaFlow] => entry[1].status === 'ran',
  );
  if (ran.length > 0) {
    out.push(
      table(
        [
          'Flow',
          'Device',
          'LUTs',
          'Carry',
          'Flip-flops',
          'Block RAM',
          'DSP',
          'Fmax (MHz)',
          'Target (MHz)',
          'Met',
        ],
        ran.map(([family, f]) => [
          family,
          f.device,
          fmt(f.synth.luts),
          fmt(f.synth.carry),
          fmt(f.synth.flipFlops),
          fmt(f.synth.blockRam),
          fmt(f.synth.dsp),
          f.pnr.fmaxMHz.toFixed(2),
          String(f.pnr.constraintMHz),
          f.pnr.meetsConstraint ? 'yes' : '**no**',
        ]),
      ),
      '',
    );
  }
  for (const [family, flow] of Object.entries(summary.fpga)) {
    if (flow.status === 'absent') {
      out.push(`### ${family}`, '', `Not run: ${flow.reason}.`, '');
      continue;
    }
    const cp = flow.pnr.criticalPath;
    out.push(
      `### ${family}: ${flow.device}`,
      '',
      `Top ${code(flow.top)}, RAM initialised from ${code(flow.initFile)}, nextpnr seed ${String(flow.seed)}. ` +
        `Fmax ${flow.pnr.fmaxMHz.toFixed(2)} MHz is an estimate for ${flow.timingLabel} only.`,
      '',
      `Utilisation: ${Object.entries(flow.pnr.utilisation)
        .map(([r, u]) => `${r} ${fmt(u.used)}/${fmt(u.available)}`)
        .join(', ')}. Yosys primitives: ${Object.entries(flow.synth.byType)
        .map(([type, n]) => `${code(type)} ${fmt(n)}`)
        .join(', ')}.`,
      '',
    );
    if (cp !== null) {
      out.push(
        `Critical path: ${cp.delayNs.toFixed(2)} ns (${cp.logicNs.toFixed(2)} ns logic in ${String(cp.logicStages)} stages, ` +
          `${cp.routingNs.toFixed(2)} ns routing), ${code(cp.from)} → ${code(cp.to)}. RTL lines on it: ` +
          `${cp.rtlSources.map((s) => `${code(s.location)} (${String(s.nets)} net${s.nets === 1 ? '' : 's'})`).join(', ') || 'none recorded'}.`,
        '',
      );
    }
  }
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
        : '.'),
    '',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Comparison with the baseline

export type Leaf = string | number | boolean | null;

/** Every leaf of a JSON value, keyed by its path (`generic.total.cells`, `warnings[0].count`). */
export function flattenLeaves(
  value: unknown,
  prefix = '',
  out = new Map<string, Leaf>(),
): Map<string, Leaf> {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenLeaves(item, `${prefix}[${String(i)}]`, out));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flattenLeaves(item, prefix === '' ? key : `${prefix}.${key}`, out);
    }
  } else if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    out.set(prefix, value);
  }
  return out;
}

export interface SummaryDelta {
  readonly path: string;
  /** undefined: the value is absent on that side. */
  readonly baseline: Leaf | undefined;
  readonly fresh: Leaf | undefined;
}

export interface SummaryComparison {
  readonly deltas: readonly SummaryDelta[];
  /** Provenance differences: informational, never deltas. */
  readonly provenance: readonly SummaryDelta[];
}

export function compareSummaries(baseline: unknown, fresh: unknown): SummaryComparison {
  const split = (value: unknown): [Map<string, Leaf>, Map<string, Leaf>] => {
    const all = flattenLeaves(value);
    const metrics = new Map<string, Leaf>();
    const provenance = new Map<string, Leaf>();
    for (const [path, leaf] of all) {
      (path.startsWith('provenance.') ? provenance : metrics).set(path, leaf);
    }
    return [metrics, provenance];
  };
  const diff = (a: Map<string, Leaf>, b: Map<string, Leaf>): SummaryDelta[] =>
    [...new Set([...a.keys(), ...b.keys()])]
      .filter((path) => a.get(path) !== b.get(path))
      .sort()
      .map((path) => ({ path, baseline: a.get(path), fresh: b.get(path) }));
  const [baseMetrics, baseProvenance] = split(baseline);
  const [freshMetrics, freshProvenance] = split(fresh);
  return {
    deltas: diff(baseMetrics, freshMetrics),
    provenance: diff(baseProvenance, freshProvenance),
  };
}

export function formatDelta(delta: SummaryDelta): string {
  const show = (leaf: Leaf | undefined): string =>
    leaf === undefined ? '(absent)' : JSON.stringify(leaf);
  const change =
    typeof delta.baseline === 'number' && typeof delta.fresh === 'number'
      ? ` (${delta.fresh - delta.baseline > 0 ? '+' : ''}${String(round2(delta.fresh - delta.baseline))})`
      : '';
  return `  ${delta.path}: ${show(delta.baseline)} → ${show(delta.fresh)}${change}`;
}
