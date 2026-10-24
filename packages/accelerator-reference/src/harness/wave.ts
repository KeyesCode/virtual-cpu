import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { matmulInt8, type MatmulDims } from '../model/matmul.js';
import { formatCaseInput, formatOutput } from './vectors.js';
import { HW_DIR } from './report.js';
import { filterName, renderWaveFilters } from './wave-filters.js';

/**
 * Waveforms of the matmul runner (`make -C hardware/accelerators/matmul wave`): the demo case, a
 * minimal VCD reader, `wave-check` (the demo's dump holds every signal the GTKWave save file and
 * the simulation guide name, and the expected tile_done and done pulses) and `wave-table` (the
 * clock-by-clock tables of docs/hardware/accelerators/simulation-guide.md).
 */

// ---------------------------------------------------------------------------------------------
// The demo case: tb/wave/demo.in and demo.expected.

/**
 * C (6 × 5) = A (6 × 3) · B (3 × 5): on the 4 × 4 array, four output tiles, three of them edge
 * tiles (4 × 1, 2 × 4 and 2 × 1 of their elements inside C).
 */
export const WAVE_DEMO_DIMS: MatmulDims = { m: 6, n: 5, k: 3 };

/**
 * The demo's operands, tagged so every value in the waveform names its own indices:
 * A[i, k] = 10·(i + 1) + (k + 1) (A[1, 2] = 23) and B[k, j] = ±(10·(k + 1) + (j + 1)), negative
 * for odd k (B[1, 3] = −24), so each accumulator steps up, down and up again over K = 3.
 */
export function waveDemoOperands(): { a: Int8Array; b: Int8Array } {
  const { m, n, k } = WAVE_DEMO_DIMS;
  const a = new Int8Array(m * k);
  const b = new Int8Array(k * n);
  for (let i = 0; i < m; i += 1) {
    for (let kk = 0; kk < k; kk += 1) a[i * k + kk] = 10 * (i + 1) + (kk + 1);
  }
  for (let kk = 0; kk < k; kk += 1) {
    for (let j = 0; j < n; j += 1)
      b[kk * n + j] = (kk % 2 === 1 ? -1 : 1) * (10 * (kk + 1) + (j + 1));
  }
  return { a, b };
}

/** The demo's `.in` and `.expected` texts, C from the reference model. */
export function renderWaveDemo(): { input: string; expected: string } {
  const { a, b } = waveDemoOperands();
  return {
    input: formatCaseInput({ ...WAVE_DEMO_DIMS, a, b }),
    expected: formatOutput(matmulInt8(a, b, WAVE_DEMO_DIMS)),
  };
}

// ---------------------------------------------------------------------------------------------
// A minimal VCD reader (the approach of packages/rtl-tools/src/wave/vcd.ts), for Verilator's VCD
// and GTKWave's fst2vcd output of the FST.

export interface VcdVariable {
  /** Scopes and name joined by dots, without the bit range: `TOP.matmul_sim_top.done`. */
  readonly path: string;
  readonly width: number;
  readonly id: string;
  /** The declared bit range, `[7:0]`, or '' when the declaration has none. */
  readonly range: string;
}

export interface VcdChange {
  readonly time: number;
  readonly value: string;
}

export interface Vcd {
  /** Every variable by path. A path declared twice (an alias) keeps its first declaration. */
  readonly variables: ReadonlyMap<string, VcdVariable>;
  /** Value changes by identifier code, in time order. */
  readonly changes: ReadonlyMap<string, readonly VcdChange[]>;
  /** The last timestamp in the file. */
  readonly endTime: number;
}

const DUMP_SECTIONS = new Set(['$dumpvars', '$dumpall', '$dumpon', '$dumpoff']);

export function parseVcd(text: string): Vcd {
  const variables = new Map<string, VcdVariable>();
  const changes = new Map<string, VcdChange[]>();
  const tokens = text.split(/\s+/).filter((token) => token !== '');
  const scopes: string[] = [];
  let time = 0;
  let i = 0;

  const record = (id: string, value: string): void => {
    let list = changes.get(id);
    if (list === undefined) {
      list = [];
      changes.set(id, list);
    }
    list.push({ time, value });
  };
  const skipToEnd = (): void => {
    while (i < tokens.length && tokens[i] !== '$end') i += 1;
    i += 1;
  };

  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (token === '$scope') {
      scopes.push(tokens[i + 2] ?? '');
      skipToEnd();
    } else if (token === '$upscope') {
      scopes.pop();
      skipToEnd();
    } else if (token === '$var') {
      const width = Number(tokens[i + 2]);
      const id = tokens[i + 3] ?? '';
      const declared = tokens[i + 4] ?? '';
      const name = declared.replace(/\[\d+:\d+\]$/, '');
      const next = tokens[i + 5] ?? '';
      const range = /^\[\d+:\d+\]$/.test(next) ? next : declared.slice(name.length);
      const path = [...scopes, name].filter((part) => part !== '').join('.');
      if (!variables.has(path)) variables.set(path, { path, width, id, range });
      skipToEnd();
    } else if (DUMP_SECTIONS.has(token) || token === '$end') {
      // $dumpvars and its kin hold ordinary value changes; their closing $end has nothing to do.
      i += 1;
    } else if (token.startsWith('$')) {
      skipToEnd();
    } else if (token.startsWith('#')) {
      time = Number(token.slice(1));
      i += 1;
    } else if (token.startsWith('b') || token.startsWith('B') || token.startsWith('r')) {
      record(tokens[i + 1] ?? '', token.slice(1).toLowerCase());
      i += 2;
    } else {
      record(token.slice(1), (token[0] ?? '').toLowerCase());
      i += 1;
    }
  }
  return { variables, changes, endTime: time };
}

/** The variable at `path`; throws naming the path when the waveform lacks it. */
export function variable(vcd: Vcd, path: string): VcdVariable {
  const found = vcd.variables.get(path);
  if (found === undefined) throw new Error(`the waveform has no signal ${path}`);
  return found;
}

/** The value changes of the variable at `path`. */
export function changesOf(vcd: Vcd, path: string): readonly VcdChange[] {
  return vcd.changes.get(variable(vcd, path).id) ?? [];
}

/** The value of `path` at `time`: its last change at or before then, unsigned (NaN for x/z). */
export function valueAt(vcd: Vcd, path: string, time: number): number {
  let value = 'x';
  for (const change of changesOf(vcd, path)) {
    if (change.time > time) break;
    value = change.value;
  }
  return /^[01]+$/.test(value) ? parseInt(value, 2) : Number.NaN;
}

/** The value of `path` at `time` as a two's-complement signed number of its width. */
export function signedAt(vcd: Vcd, path: string, time: number): number {
  const value = valueAt(vcd, path, time);
  const width = variable(vcd, path).width;
  return value >= 2 ** (width - 1) ? value - 2 ** width : value;
}

/** The times at which the 1-bit `path` rises from 0 to 1. */
export function risingEdges(vcd: Vcd, path: string): number[] {
  const edges: number[] = [];
  let previous = 'x';
  for (const change of changesOf(vcd, path)) {
    if (previous === '0' && change.value === '1') edges.push(change.time);
    previous = change.value;
  }
  return edges;
}

// ---------------------------------------------------------------------------------------------
// The signals.

export const SIM_TOP = 'TOP.matmul_sim_top';
const TOP = `${SIM_TOP}.u_top`;
const CTRL = `${TOP}.u_controller`;
const ARRAY = `${TOP}.u_array`;

/** The scope of PE(i, j) in the array. */
export function pePath(i: number, j: number): string {
  return `${ARRAY}.g_row[${String(i)}].g_col[${String(j)}].u_pe`;
}

/** The scope of row i's (`a`) or column j's (`b`) skew registers, for i, j ≥ 1. */
export function skewPath(side: 'a' | 'b', index: number): string {
  return `${ARRAY}.g_${side}_skew[${String(index)}].g_delay`;
}

const PE_PORTS = ['a_in', 'a_valid_in', 'b_in', 'b_valid_in', 'acc'] as const;

/** The signals the demo waveform must hold, by what the simulation guide calls them. */
export const REQUIRED_SIGNALS: readonly (readonly [string, string])[] = [
  ['clock', `${SIM_TOP}.clk`],
  ['reset', `${SIM_TOP}.rst`],
  ['start', `${SIM_TOP}.start`],
  ['busy', `${SIM_TOP}.busy`],
  ['done', `${SIM_TOP}.done`],
  ['error', `${SIM_TOP}.error`],
  ['error code', `${SIM_TOP}.error_code`],
  ['controller state tap', `${SIM_TOP}.dbg_state`],
  ['tile row tap', `${SIM_TOP}.dbg_tile_i`],
  ['tile column tap', `${SIM_TOP}.dbg_tile_j`],
  ['k tap', `${SIM_TOP}.dbg_k`],
  ['controller state', `${CTRL}.state`],
  ['tile rows inside C', `${CTRL}.rows_here`],
  ['tile columns inside C', `${CTRL}.cols_here`],
  ['tile start', `${ARRAY}.tile_start`],
  ['tile done', `${ARRAY}.tile_done`],
  ['A operands valid', `${ARRAY}.a_valid`],
  ['B operands valid', `${ARRAY}.b_valid`],
  ['C write enable', `${CTRL}.c_we`],
  ['C write address', `${CTRL}.c_addr`],
  ['C write data', `${CTRL}.c_wdata`],
  ...[
    [0, 0],
    [1, 1],
    [3, 3],
  ].flatMap(([i = 0, j = 0]) =>
    PE_PORTS.map((port): readonly [string, string] => [
      `PE(${String(i)}, ${String(j)}) ${port}`,
      `${pePath(i, j)}.${port}`,
    ]),
  ),
  ...(['a', 'b'] as const).flatMap((side) =>
    (['data_q', 'valid_q'] as const).map((reg): readonly [string, string] => [
      `${side === 'a' ? 'row' : 'column'} 1 skew ${reg}`,
      `${skewPath(side, 1)}.${reg}`,
    ]),
  ),
];

/**
 * The signals a GTKWave save file displays, as it names them: the path with the bit range of a
 * vector (`….acc[31:0]`), the bare path of a 1-bit signal, including one declared `[0:0]`
 * (GTKWave does not find `valid_q[0:0]`). A `+{alias}` before the name is dropped.
 */
export function gtkwSignals(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^[[@*\-^#]/.test(line))
    .map((line) => line.replace(/^\+\{[^}]*\}\s*/, ''));
}

/** The name a GTKWave save file uses for a waveform variable (see {@link gtkwSignals}). */
export function gtkwName(variable: VcdVariable): string {
  return variable.width === 1 ? variable.path : `${variable.path}${variable.range}`;
}

// ---------------------------------------------------------------------------------------------
// Clocks.

/**
 * The rising clock edges of a waveform, numbered from the edge that samples the first accepted
 * start (clock 0, the first clock busy is high): `clockOf(t)` is the number of the last edge at
 * or before `t`, so a register that changes at edge c holds its new value in clock c.
 */
interface Clocks {
  readonly edges: readonly number[];
  /** The index in `edges` of clock 0. */
  readonly origin: number;
}

function clocksOf(vcd: Vcd): Clocks {
  const edges = risingEdges(vcd, `${SIM_TOP}.clk`);
  const busy = risingEdges(vcd, `${SIM_TOP}.busy`)[0];
  if (busy === undefined) throw new Error('busy never rises: the waveform has no accepted start');
  const origin = edges.indexOf(busy);
  if (origin < 0) throw new Error(`busy rises at ${String(busy)} ns, not at a rising clock edge`);
  return { edges, origin };
}

function clockOf(clocks: Clocks, time: number): number {
  let index = -1;
  for (const [i, edge] of clocks.edges.entries()) {
    if (edge > time) break;
    index = i;
  }
  return index - clocks.origin;
}

function timeOf(clocks: Clocks, clock: number): number {
  const time = clocks.edges[clocks.origin + clock];
  if (time === undefined) throw new Error(`the waveform has no clock ${String(clock)}`);
  return time;
}

// ---------------------------------------------------------------------------------------------
// wave-check.

export interface TileBoundary {
  /** The output tile's row and column index (dbg_tile_i, dbg_tile_j). */
  readonly tileI: number;
  readonly tileJ: number;
  /** The rows and columns of the tile inside C (the rest are masked out of the store). */
  readonly rows: number;
  readonly cols: number;
  /** Clocks (see {@link clocksOf}) of tile_start, tile_done and the last STORE clock. */
  readonly start: number;
  readonly done: number;
  readonly storeEnd: number;
}

/** Each tile_start → tile_done → end of STORE of a waveform, in order. */
export function tileBoundaries(vcd: Vcd): TileBoundary[] {
  const clocks = clocksOf(vcd);
  const starts = risingEdges(vcd, `${ARRAY}.tile_start`);
  const dones = risingEdges(vcd, `${ARRAY}.tile_done`);
  const storeOf = filterValue('ctrl_state.txt', 'STORE');
  // The changes of state out of STORE (a VCD records only changes, so each is a new state).
  const stores = changesOf(vcd, `${CTRL}.state`).filter(
    (_, index, all) => index > 0 && parseInt(all[index - 1]?.value ?? '', 2) === storeOf,
  );
  return starts.map((time, index): TileBoundary => {
    const done = dones[index];
    const storeExit = stores[index]?.time;
    return {
      tileI: valueAt(vcd, `${SIM_TOP}.dbg_tile_i`, time),
      tileJ: valueAt(vcd, `${SIM_TOP}.dbg_tile_j`, time),
      rows: valueAt(vcd, `${CTRL}.rows_here`, time),
      cols: valueAt(vcd, `${CTRL}.cols_here`, time),
      start: clockOf(clocks, time),
      done: done === undefined ? Number.NaN : clockOf(clocks, done),
      storeEnd: storeExit === undefined ? Number.NaN : clockOf(clocks, storeExit) - 1,
    };
  });
}

/** The value of a named member of a filter file's enum. */
function filterValue(file: string, name: string): number {
  const text = renderWaveFilters().find((filter) => filter.file === file)?.text ?? '';
  const line = text.split('\n').find((row) => row.endsWith(` ${name}`));
  if (line === undefined) throw new Error(`${file} has no ${name}`);
  return parseInt(line, 16);
}

const num = (value: number): string => (Number.isNaN(value) ? '–' : String(value));

/** The Markdown table of {@link tileBoundaries}. */
export function formatTileBoundaries(tiles: readonly TileBoundary[]): string {
  const rows = [
    '| tile | (tile_i, tile_j) | inside C | tile_start | tile_done | last STORE | clocks |',
    '| ---: | ---------------- | -------- | ---------: | --------: | ---------: | -----: |',
  ];
  for (const [index, tile] of tiles.entries()) {
    rows.push(
      `| ${String(index)} | (${num(tile.tileI)}, ${num(tile.tileJ)}) | ${num(tile.rows)} × ${num(tile.cols)} | ${num(tile.start)} | ${num(tile.done)} | ${num(tile.storeEnd)} | ${num(tile.storeEnd - tile.start + 1)} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}

export interface WaveCheckOptions {
  /** The demo waveform as VCD (fst2vcd's output). */
  readonly vcd: string;
  /** tb/wave/matmul.gtkw. */
  readonly gtkw: string;
  /** The directory holding the committed translate filter files. */
  readonly filters: string;
  /** The tile_done pulses expected (one per output tile). */
  readonly expectTiles: number;
  /** The done pulses expected (one per run). */
  readonly expectDone: number;
}

/**
 * Checks a demo waveform: every required signal and every signal of the save file is in it, the
 * filter files match matmul_pkg, and tile_done and done pulse the expected number of times. Prints
 * the tile boundary table and returns the exit code.
 */
export function waveCheck(options: WaveCheckOptions, out: (text: string) => void): number {
  const vcd = parseVcd(readFileSync(options.vcd, 'utf8'));
  const problems: string[] = [];

  const missingRequired = REQUIRED_SIGNALS.filter(([, path]) => !vcd.variables.has(path));
  for (const [label, path] of missingRequired) problems.push(`missing ${label}: ${path}`);
  if (missingRequired.length === 0) {
    out(`all ${String(REQUIRED_SIGNALS.length)} required signals present\n`);
  }

  // The save file as the make targets name it, relative to hardware/accelerators/matmul.
  const fromHw = relative(HW_DIR, options.gtkw);
  const gtkw = fromHw.startsWith('..') || isAbsolute(fromHw) ? options.gtkw : fromHw;
  const shown = gtkwSignals(readFileSync(options.gtkw, 'utf8'));
  const names = new Set([...vcd.variables.values()].map(gtkwName));
  const missingShown = shown.filter((name) => !names.has(name));
  for (const name of missingShown) {
    problems.push(`${gtkw} shows ${name}, not in the waveform under that name`);
  }
  if (shown.length === 0) problems.push(`${gtkw} shows no signals`);
  if (missingShown.length === 0 && shown.length > 0) {
    out(`all ${String(shown.length)} signals of ${gtkw} present\n`);
  }

  for (const { file, text } of renderWaveFilters()) {
    let committed = '';
    try {
      committed = readFileSync(join(options.filters, file), 'utf8');
    } catch {
      // A missing file is reported as stale below.
    }
    if (committed !== text) {
      problems.push(`${file} does not match rtl/matmul_pkg.sv; run gen-wave-filters`);
    }
  }

  if (missingRequired.length === 0) {
    const tileDone = risingEdges(vcd, `${ARRAY}.tile_done`).length;
    const done = risingEdges(vcd, `${SIM_TOP}.done`).length;
    out(
      `${String(tileDone)} tile_done pulses, ${String(done)} done pulse${done === 1 ? '' : 's'}\n`,
    );
    if (tileDone !== options.expectTiles) {
      problems.push(
        `tile_done pulsed ${String(tileDone)} times, expected ${String(options.expectTiles)}`,
      );
    }
    if (done !== options.expectDone) {
      problems.push(`done pulsed ${String(done)} times, expected ${String(options.expectDone)}`);
    }
    if (done > 0) {
      const clocks = clocksOf(vcd);
      out(`\n${formatTileBoundaries(tileBoundaries(vcd))}`);
      const doneAt = risingEdges(vcd, `${SIM_TOP}.done`)[0] ?? 0;
      out(`\ndone at clock ${String(clockOf(clocks, doneAt))} (clock 0: the first busy clock)\n`);
    }
  }

  for (const problem of problems) out(`FAIL ${problem}\n`);
  if (problems.length > 0) return 1;
  out('wave-check: every signal is present and the tile and done pulses match\n');
  return 0;
}

// ---------------------------------------------------------------------------------------------
// wave-table.

const ROWS = 4;
const COLS = 4;

/**
 * A Markdown table of clocks `from` … `to` of a 4 × 4 waveform (clock 0: the first busy clock),
 * one row per clock with the values every signal holds during it: the controller state, the k
 * presented, the A operand entering each row of PE column 0 and the B operand entering each column
 * of PE row 0 (after the skew registers; `·` while its valid bit is low), how many PEs multiply in
 * the clock, a few accumulators and tile_done. The simulation guide's walkthrough comes from it.
 */
export function waveTable(vcd: Vcd, from: number, to: number): string {
  const clocks = clocksOf(vcd);
  const operand = (path: string, time: number): string =>
    valueAt(vcd, `${path}_valid_in`, time) === 1 ? String(signedAt(vcd, `${path}_in`, time)) : '·';
  const rows = [
    '| clock | state | k | A into PE(0..3, 0) | B into PE(0, 0..3) | PEs multiplying | acc PE(0,0) | acc PE(1,1) | acc PE(3,3) | tile_done |',
    '| ----: | ----- | -: | ------------------ | ------------------ | --------------: | ----------: | ----------: | ----------: | :-------: |',
  ];
  for (let clock = from; clock <= to; clock += 1) {
    const time = timeOf(clocks, clock);
    const state = filterName('ctrl_state.txt', valueAt(vcd, `${CTRL}.state`, time));
    const a = Array.from({ length: ROWS }, (_, i) => operand(`${pePath(i, 0)}.a`, time));
    const b = Array.from({ length: COLS }, (_, j) => operand(`${pePath(0, j)}.b`, time));
    let multiplying = 0;
    for (let i = 0; i < ROWS; i += 1) {
      for (let j = 0; j < COLS; j += 1) {
        if (
          valueAt(vcd, `${pePath(i, j)}.a_valid_in`, time) === 1 &&
          valueAt(vcd, `${pePath(i, j)}.b_valid_in`, time) === 1
        ) {
          multiplying += 1;
        }
      }
    }
    const acc = (i: number, j: number): string =>
      String(signedAt(vcd, `${pePath(i, j)}.acc`, time));
    const k = state === 'COMPUTE' ? String(valueAt(vcd, `${SIM_TOP}.dbg_k`, time)) : '';
    rows.push(
      `| ${String(clock)} | ${state} | ${k} | ${a.join(' ')} | ${b.join(' ')} | ${String(multiplying)} | ${acc(0, 0)} | ${acc(1, 1)} | ${acc(3, 3)} | ${valueAt(vcd, `${ARRAY}.tile_done`, time) === 1 ? '1' : ''} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}
