/**
 * A minimal VCD reader for the waveforms `make wave` writes (Verilator's VCD, or GTKWave's
 * fst2vcd output of the FST). It keeps every variable's full hierarchical path and its value
 * changes; scalar values are `0`, `1`, `x` or `z`, vector values the bit string without the `b`.
 */

export interface VcdVariable {
  /** Scopes and name joined by dots, without the bit range: `TOP.vcpu8_sim_top.dbg_pc`. */
  readonly path: string;
  readonly width: number;
  readonly id: string;
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
      const name = (tokens[i + 4] ?? '').replace(/\[\d+:\d+\]$/, '');
      const path = [...scopes, name].filter((part) => part !== '').join('.');
      if (!variables.has(path)) variables.set(path, { path, width, id });
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

/** The value of `path` at `time`: its last change at or before then, as a number (NaN for x/z). */
export function valueAt(vcd: Vcd, path: string, time: number): number {
  let value = 'x';
  for (const change of changesOf(vcd, path)) {
    if (change.time > time) break;
    value = change.value;
  }
  return /^[01]+$/.test(value) ? parseInt(value, 2) : Number.NaN;
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
