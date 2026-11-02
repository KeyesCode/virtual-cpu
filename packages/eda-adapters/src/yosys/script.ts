import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** What to synthesise: the sources in read order, the top module and its parameters. */
export interface SynthesisDesign {
  readonly top: string;
  readonly params: Readonly<Record<string, number>>;
  /** Packages first, as `read_verilog` needs them. */
  readonly sources: readonly string[];
}

const MATMUL_RTL = join('hardware', 'accelerators', 'matmul', 'rtl');

/**
 * ORFS's sky130hd `DONT_USE_CELLS` (flow/platforms/sky130hd/config.mk): the probe cells have metal on
 * every layer and the lpflow cells are for multiple power domains. The liberty file does not mark
 * them, so ABC would otherwise pick lpflow isolation cells as ordinary logic gates.
 */
export const SKY130HD_DONT_USE: readonly string[] = [
  'sky130_fd_sc_hd__probe_p_*',
  'sky130_fd_sc_hd__probec_p_*',
  'sky130_fd_sc_hd__lpflow_*',
];

/** `rtl/*.sv` in the Makefile's RTL_SRCS order: packages first, then the rest, each sorted. */
export function matmulRtlSources(workspaceRoot: string): string[] {
  const dir = join(resolve(workspaceRoot), MATMUL_RTL);
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sv'))
    .sort();
  return [
    ...files.filter((file) => file.endsWith('_pkg.sv')),
    ...files.filter((file) => !file.endsWith('_pkg.sv')),
  ].map((file) => join(dir, file));
}

/** The Tier 0 and Tier 1 target: one processing element at its frozen widths. */
export function peDesign(workspaceRoot: string): SynthesisDesign {
  return {
    top: 'processing_element',
    params: { DATA_W: 8, ACC_W: 32 },
    sources: matmulRtlSources(workspaceRoot),
  };
}

/** The system-level view: a square array, 4 × 4 unless set. */
export function matmulTopDesign(workspaceRoot: string, rows = 4): SynthesisDesign {
  return {
    top: 'matmul_top',
    params: { ROWS: rows, COLS: rows },
    sources: matmulRtlSources(workspaceRoot),
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A character that would split, quote or end a word of a Yosys script. */
const UNSAFE_PATH = /[\s"'#;\\]/;

function path(file: string): string {
  if (UNSAFE_PATH.test(file)) {
    throw new Error(`a Yosys script cannot name this path: ${JSON.stringify(file)}`);
  }
  return resolve(file);
}

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`not a module or parameter name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** What a flow writes into its directory, and runs with `yosys -s script.ys`. */
export interface YosysScripts {
  /** `script.ys`: reads the design, sets its parameters and runs the steps. */
  readonly entry: string;
  /** The file holding the steps, in the same directory. */
  readonly stepsFile: string;
  readonly steps: string;
}

/**
 * The steps must stay in their own file, run by the `script` command, as Project 3 runs generic.ys.
 * The same passes pasted into one script give a different netlist: `techmap` expands the PE's
 * `$macc_v2` differently (894 cells instead of 1,008, 6,287 µm² instead of 7,020 on sky130hd). See
 * "Script form" in docs/research-engine/eda-adapters.md.
 */
function scripts(
  design: SynthesisDesign,
  stepsFile: string,
  steps: readonly string[],
): YosysScripts {
  return {
    entry: `${[...readDesign(design), `script ${stepsFile}`].join('\n')}\n`,
    stepsFile,
    steps: `${steps.join('\n')}\n`,
  };
}

function readDesign({ top, params, sources }: SynthesisDesign): string[] {
  if (sources.length === 0) throw new Error('a design needs at least one source');
  const sets = Object.entries(params).map(([name, value]) => {
    if (!Number.isSafeInteger(value)) throw new Error(`parameter ${name} is not an integer`);
    return `-set ${identifier(name)} ${String(value)}`;
  });
  return [
    `read_verilog -sv -D SYNTHESIS ${sources.map(path).join(' ')}`,
    ...(sets.length === 0 ? [] : [`chparam ${sets.join(' ')} ${identifier(top)}`]),
  ];
}

/** The structural gates of synth/generic.ys, on the design exactly as written. */
function structuralGates(top: string): string[] {
  return [
    `hierarchy -check -top ${identifier(top)}`,
    'proc',
    'check -assert',
    'select -assert-none t:$dlatch t:$adlatch t:$dlatchsr t:$_DLATCH_* t:$_DLATCHSR_*',
  ];
}

/**
 * The steps of hardware/accelerators/matmul/synth/generic.ys with the top parameterised, in the same
 * order and writing the same files, so the numbers compare with Project 3's. That file explains each
 * step; `yosys.test.ts` fails if the two drift apart.
 */
export function buildGenericScript(design: SynthesisDesign): YosysScripts {
  const top = identifier(design.top);
  return scripts(design, 'generic.ys', [
    ...structuralGates(top),
    'opt_expr',
    'opt_clean',
    'tee -q -o generic.mul.stat.json stat -json',
    'memory -nomap',
    'select t:$mem_v2',
    'write_json -selected generic.memories.json',
    'select -clear',
    `synth -top ${top} -run begin:fine`,
    'opt -fast -full',
    'opt -full',
    'techmap',
    'opt -fast',
    'abc',
    'opt -fast',
    'hierarchy -check',
    'check -assert',
    'tee -q -o generic.stat.txt stat -width',
    'tee -q -o generic.stat.json stat -json',
    'write_json generic.json',
    'flatten',
    'abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX',
    'opt_clean',
    'tee -q -o generic.gates.stat.json stat -json',
    'tee -q -o generic.ltp.txt ltp -noff t:$mem_v2 %n',
  ]);
}

/**
 * Technology mapping onto a liberty file. The flip-flops are counted before dfflibmap, where they are
 * still generic cells: a liberty cell's name does not say what it is.
 */
export function buildMappedScript(
  design: SynthesisDesign,
  liberty: string,
  dontUse: readonly string[],
): YosysScripts {
  const top = identifier(design.top);
  const lib = path(liberty);
  const avoid = dontUse.map((pattern) => {
    if (UNSAFE_PATH.test(pattern)) throw new Error(`not a cell pattern: ${pattern}`);
    return ` -dont_use ${pattern}`;
  });
  return scripts(design, 'mapped.ys', [
    ...structuralGates(top),
    `synth -top ${top}`,
    'tee -q -o mapped.ff.stat.json stat -json',
    `dfflibmap${avoid.join('')} -liberty ${lib}`,
    `abc${avoid.join('')} -liberty ${lib}`,
    'opt_clean',
    `tee -q -o mapped.stat.json stat -liberty ${lib} -json`,
    'write_verilog -noattr mapped.v',
    'write_json mapped.json',
  ]);
}
