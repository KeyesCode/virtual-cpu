import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCpu } from '@vcpu/cpu-core';
import { CPU_STATUS_NUMBERS, parseMemoryHex } from '@vcpu/shared';
import { filterName, renderWaveFilters } from '../wave/filters.js';
import { changesOf, parseVcd, risingEdges, type Vcd, valueAt } from '../wave/vcd.js';

const SIM_TOP = 'TOP.vcpu8_sim_top';
const CORE = `${SIM_TOP}.u_top.u_core`;

/** The signals the waveform must hold, by what the simulation guide calls them. */
export const REQUIRED_SIGNALS: readonly (readonly [string, string])[] = [
  ['clock', `${SIM_TOP}.clk`],
  ['reset', `${SIM_TOP}.rst`],
  ['cycle count', `${SIM_TOP}.cycle`],
  ['PC', `${SIM_TOP}.dbg_pc`],
  ['IR opcode', `${SIM_TOP}.dbg_ir_op`],
  ['IR register byte', `${SIM_TOP}.dbg_ir_rb`],
  ['IR trailing byte', `${SIM_TOP}.dbg_ir_tb`],
  ['IR length', `${SIM_TOP}.dbg_ir_len`],
  ['FSM state', `${CORE}.u_control.state`],
  ['ALU operand a', `${CORE}.u_alu.a`],
  ['ALU operand b', `${CORE}.u_alu.b`],
  ['ALU op', `${CORE}.u_alu.op`],
  ['ALU result', `${CORE}.u_alu.r`],
  ['register write enable', `${CORE}.u_registers.we`],
  ['register write address', `${CORE}.u_registers.wa`],
  ['register write data', `${CORE}.u_registers.wd`],
  ['memory address', `${SIM_TOP}.mem_addr`],
  ['memory write enable', `${SIM_TOP}.mem_we`],
  ['memory write data', `${SIM_TOP}.mem_wdata`],
  ['memory read data', `${SIM_TOP}.mem_rdata`],
  ['FLAGS', `${SIM_TOP}.dbg_flags`],
  ['retire', `${SIM_TOP}.retire`],
  ['instret', `${SIM_TOP}.instret`],
  ['status', `${SIM_TOP}.status`],
];

/** The signal paths a GTKWave save file displays, without their bit ranges. */
export function gtkwSignals(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^[[@*\-^#]/.test(line))
    .map((line) => line.replace(/\[\d+:\d+\]$/, ''));
}

export interface WaveCheckOptions {
  /** The demo waveform as VCD (fst2vcd's output). */
  readonly vcd: string;
  /** The image the waveform ran, for the emulator. */
  readonly image: string;
  /** tb/wave/vcpu8.gtkw. */
  readonly gtkw: string;
  /** The directory holding the committed translate filter files. */
  readonly filters: string;
}

/**
 * Checks a demo waveform: every required signal and every signal of the save file is in it, the
 * filter files match the RTL packages, and `retire` pulses once per instruction the TypeScript
 * emulator retires on the same image, which is also the final `instret`. Returns the exit code.
 */
export function waveCheck(options: WaveCheckOptions, out: (text: string) => void): number {
  const vcd = parseVcd(readFileSync(options.vcd, 'utf8'));
  const problems: string[] = [];

  for (const [label, path] of REQUIRED_SIGNALS) {
    if (!vcd.variables.has(path)) problems.push(`missing ${label}: ${path}`);
  }
  out(`${String(REQUIRED_SIGNALS.length)} required signals checked\n`);

  const shown = gtkwSignals(readFileSync(options.gtkw, 'utf8'));
  for (const path of shown) {
    if (!vcd.variables.has(path))
      problems.push(`${options.gtkw} shows ${path}, not in the waveform`);
  }
  out(`${String(shown.length)} signals of ${options.gtkw} checked\n`);

  for (const { file, text } of renderWaveFilters()) {
    let committed = '';
    try {
      committed = readFileSync(join(options.filters, file), 'utf8');
    } catch {
      // A missing file is reported as stale below.
    }
    if (committed !== text) {
      problems.push(`${file} does not match the RTL packages; run gen-wave-filters`);
    }
  }

  const cpu = createCpu({ traceCapacity: 0 });
  cpu.loadProgram(parseMemoryHex(readFileSync(options.image, 'utf8')));
  cpu.run();
  const expected = cpu.getMetrics().instructions;
  const expectedStatus = CPU_STATUS_NUMBERS[cpu.getState().status];
  if (problems.length === 0) {
    const pulses = risingEdges(vcd, `${SIM_TOP}.retire`).length;
    const instret = valueAt(vcd, `${SIM_TOP}.instret`, vcd.endTime);
    const status = valueAt(vcd, `${SIM_TOP}.status`, vcd.endTime);
    out(
      `retire pulses ${String(pulses)}, final instret ${String(instret)}, emulator ${String(expected)}\n`,
    );
    if (pulses !== expected)
      problems.push(`retire pulsed ${String(pulses)} times, expected ${String(expected)}`);
    if (instret !== expected)
      problems.push(`final instret is ${String(instret)}, expected ${String(expected)}`);
    if (status !== expectedStatus) {
      problems.push(
        `final status is ${String(status)}, the emulator's is ${String(expectedStatus)}`,
      );
    }
  }

  for (const problem of problems) out(`FAIL ${problem}\n`);
  if (problems.length > 0) return 1;
  out('wave-check: every signal is present and retire matches the emulator\n');
  return 0;
}

const hex2 = (value: number): string =>
  Number.isNaN(value) ? 'xx' : value.toString(16).toUpperCase().padStart(2, '0');

/**
 * The time each clock cycle is sampled at: the moment `cycle` takes its value (just after that
 * rising edge, when everything has settled), and for cycle 0 the release of reset.
 */
function cycleTimes(vcd: Vcd): Map<number, number> {
  const resetRelease =
    changesOf(vcd, `${SIM_TOP}.rst`).find((change) => change.value === '0')?.time ?? 0;
  const times = new Map<number, number>();
  for (const change of changesOf(vcd, `${SIM_TOP}.cycle`)) {
    const cycle = parseInt(change.value, 2);
    if (!times.has(cycle)) times.set(cycle, Math.max(change.time, resetRelease));
  }
  return times;
}

/**
 * A Markdown table of cycles `from`..`to` of a waveform, one row per clock cycle, with the values
 * every signal holds during that cycle. The simulation guide's walkthrough tables come from it.
 */
export function waveTable(vcdPath: string, from: number, to: number): string {
  const vcd = parseVcd(readFileSync(vcdPath, 'utf8'));
  const times = cycleTimes(vcd);
  const rows = [
    '| cycle | t (ns) | state | PC | SP | IR | mem_addr | mem_rdata | mem write | ALU a, op, b → r | register write | FLAGS | retire | instret |',
    '| ----: | -----: | ----- | -- | -- | -- | -------- | --------- | --------- | ---------------- | -------------- | ----- | ------ | ------: |',
  ];
  for (let cycle = from; cycle <= to; cycle += 1) {
    const time = times.get(cycle);
    if (time === undefined) throw new Error(`the waveform has no cycle ${String(cycle)}`);
    const at = (path: string): number => valueAt(vcd, path, time);
    const len = at(`${SIM_TOP}.dbg_ir_len`);
    const ir = [at(`${SIM_TOP}.dbg_ir_op`), at(`${SIM_TOP}.dbg_ir_rb`), at(`${SIM_TOP}.dbg_ir_tb`)]
      .slice(0, Math.max(len, 1))
      .map(hex2)
      .join(' ');
    const memWrite =
      at(`${SIM_TOP}.mem_we`) === 1
        ? `[${hex2(at(`${SIM_TOP}.mem_addr`))}] ← ${hex2(at(`${SIM_TOP}.mem_wdata`))}`
        : '–';
    const alu = `${hex2(at(`${CORE}.u_alu.a`))} ${filterName('alu_op.txt', at(`${CORE}.u_alu.op`))} ${hex2(at(`${CORE}.u_alu.b`))} → ${hex2(at(`${CORE}.u_alu.r`))}`;
    const regWrite =
      at(`${CORE}.u_registers.we`) === 1
        ? `R${String(at(`${CORE}.u_registers.wa`))} ← ${hex2(at(`${CORE}.u_registers.wd`))}`
        : '–';
    rows.push(
      `| ${String(cycle)} | ${String(time)} | ${filterName('fsm_state.txt', at(`${CORE}.u_control.state`))} | ${hex2(at(`${SIM_TOP}.dbg_pc`))} | ${hex2(at(`${SIM_TOP}.dbg_sp`))} | ${ir} | ${hex2(at(`${SIM_TOP}.mem_addr`))} | ${hex2(at(`${SIM_TOP}.mem_rdata`))} | ${memWrite} | ${alu} | ${regWrite} | ${hex2(at(`${SIM_TOP}.dbg_flags`))} | ${String(at(`${SIM_TOP}.retire`))} | ${String(at(`${SIM_TOP}.instret`))} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}
