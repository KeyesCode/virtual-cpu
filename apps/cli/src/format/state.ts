import type { CpuMetrics, CpuState, StopReason } from '@vcpu/cpu-core';
import { instructionText } from '@vcpu/debugger';
import { FLAG_MASKS, FLAG_NAMES, MEMORY_SIZE, REGISTER_NAMES } from '@vcpu/shared';
import { byteHex, byteValue, hex } from './hex.js';

/** Fits the widest cell, `R0 = 0x80 (128, -128)`, plus a gap. */
const COLUMN = 24;
const ROW = 16;

/**
 * The register file, PC, SP, SD, IR and FLAGS:
 *
 *     Registers
 *       R0 = 0x1E (30)          R1 = 0x14 (20)          R2 = 0x81 (129, -127)   R3 = 0x00 (0)
 *       …
 *       PC = 0x08               SP = 0xFF               SD = 0                  IR = HLT
 *     Flags
 *       Z=0 C=0 N=0 V=0         FLAGS = 0x00
 */
export function formatRegisters(state: CpuState): string {
  const cells = REGISTER_NAMES.map(
    (name, i) =>
      `${name} = ${hex(state.registers[i] ?? 0)} (${byteValue(state.registers[i] ?? 0)})`,
  );
  const ir = state.ir === null ? '—' : instructionText(state.ir.bytes);
  const special = [`PC = ${hex(state.pc)}`, `SP = ${hex(state.sp)}`, `SD = ${String(state.sd)}`];
  const flags = FLAG_NAMES.map((f) => `${f}=${(state.flags & FLAG_MASKS[f]) === 0 ? '0' : '1'}`);
  return [
    'Registers',
    row(cells.slice(0, 4)),
    row(cells.slice(4, 8)),
    row([...special, `IR = ${ir}`]),
    'Flags',
    row([flags.join(' '), `FLAGS = ${hex(state.flags)}`]),
  ].join('\n');
}

function row(cells: readonly string[]): string {
  return `  ${cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(COLUMN))).join('')}`;
}

export interface HexdumpOptions {
  /** First address shown (default 0x00). */
  readonly start?: number;
  /** Last address shown, inclusive (default 0xFF). */
  readonly end?: number;
  /** Leave out 16-byte rows that are all zero (default false). */
  readonly skipZeroRows?: boolean;
}

/**
 * 16 bytes a row, each row labelled with its first address. Bytes outside `start..end` in the
 * first and last row are left blank.
 */
export function formatHexdump(memory: readonly number[], options: HexdumpOptions = {}): string {
  const { start = 0, end = MEMORY_SIZE - 1, skipZeroRows = false } = options;
  const header = `        ${Array.from({ length: ROW }, (_, i) => `+${i.toString(16).toUpperCase()}`).join(' ')}`;
  const lines = [header];
  for (let base = start - (start % ROW); base <= end; base += ROW) {
    const cells: string[] = [];
    let nonZero = false;
    for (let address = base; address < base + ROW; address += 1) {
      if (address < start || address > end) {
        cells.push('  ');
        continue;
      }
      const value = memory[address] ?? 0;
      nonZero ||= value !== 0;
      cells.push(byteHex(value));
    }
    if (skipZeroRows && !nonZero) continue;
    lines.push(`  ${hex(base)}  ${cells.join(' ').trimEnd()}`);
  }
  if (lines.length === 1) lines.push('  (every byte is 0x00)');
  return lines.join('\n');
}

/** Instructions, estimated cycles, data reads and writes, fetched bytes and branches. */
export function formatSummary(metrics: CpuMetrics): string {
  const rows: [string, string][] = [
    ['Instructions', String(metrics.instructions)],
    ['Est. cycles', `${String(metrics.estimatedCycles)} (timing-model estimate, not measured)`],
    ['Memory reads', String(metrics.memoryReads)],
    ['Memory writes', String(metrics.memoryWrites)],
    ['Fetched bytes', String(metrics.fetchedBytes)],
    [
      'Branches',
      `${String(metrics.branchesTaken)} taken, ${String(metrics.branchesNotTaken)} not taken`,
    ],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return [
    'Execution summary',
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}${value}`),
  ].join('\n');
}

/** One line on how the program ended, e.g. `Status: HALTED at PC 0x08 after 4 instructions`. */
export function formatStatus(
  state: CpuState,
  stopReason: StopReason,
  executed: number,
  maxInstructions: number,
): string {
  const count = `${String(executed)} instruction${executed === 1 ? '' : 's'}`;
  switch (stopReason) {
    case 'halted':
      return `Status: HALTED at PC ${hex(state.pc)} after ${count}`;
    case 'faulted':
      return `Status: FAULTED at PC ${hex(state.fault?.pc ?? state.pc)} after ${count}: ${state.fault?.code ?? 'unknown fault'}: ${state.fault?.detail ?? ''}`;
    case 'limit':
      return `Status: ${state.status} at PC ${hex(state.pc)}: stopped at the instruction limit (${String(maxInstructions)}) before the program halted`;
    default:
      return `Status: ${state.status} at PC ${hex(state.pc)} after ${count} (${stopReason})`;
  }
}
