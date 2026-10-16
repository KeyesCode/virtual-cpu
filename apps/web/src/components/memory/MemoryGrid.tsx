import { MEMORY_MAP, MEMORY_SIZE } from '@vcpu/shared';
import { type CSSProperties, useState } from 'react';
import { hex, hexByte, parseHexAddress } from '../../lib/format';
import type { DashboardSnapshot } from '../../state/dashboardStore';
import { PanelHeader } from '../ui';

export type MemoryHighlight = 'pc' | 'write' | 'stack' | 'sp' | 'breakpoint' | 'goto';

export interface MemoryLayers {
  /** Bytes of the instruction at PC. */
  readonly pc: ReadonlySet<number>;
  /** Bytes written by the last executed instruction. */
  readonly write: ReadonlySet<number>;
  /** Where SP points (the next free stack slot). */
  readonly sp: number;
  /** Enabled breakpoint addresses. */
  readonly breakpoints: ReadonlySet<number>;
  /** The address picked with Go to. */
  readonly goto: number | null;
}

/** The highlight layers on one memory cell, in drawing order. */
export function cellHighlights(address: number, layers: MemoryLayers): MemoryHighlight[] {
  const result: MemoryHighlight[] = [];
  if (address >= MEMORY_MAP.stack.start && address <= MEMORY_MAP.stack.end) result.push('stack');
  if (layers.pc.has(address)) result.push('pc');
  if (layers.write.has(address)) result.push('write');
  if (address === layers.sp) result.push('sp');
  if (layers.breakpoints.has(address)) result.push('breakpoint');
  if (address === layers.goto) result.push('goto');
  return result;
}

/** Cell colours; later layers win, so the current instruction and last write stay readable. */
function cellTone(value: number, highlights: readonly MemoryHighlight[]): string {
  const has = (h: MemoryHighlight): boolean => highlights.includes(h);
  if (has('write')) return 'bg-[#3b2a07] text-[#fde68a]';
  if (has('pc')) return 'bg-accent-deep text-[#e0f2fe]';
  const background = has('stack') ? 'bg-[#1a1530]' : '';
  if (has('breakpoint')) return `${background} text-[#fecaca]`;
  if (has('sp')) return `${background} text-[#ddd6fe]`;
  if (has('stack')) return `${background} text-[#6d5fa8]`;
  return value === 0 ? 'text-ghost' : 'text-[#8592a3]';
}

const COLUMNS = Array.from({ length: 16 }, (_, i) => i);
const ROWS = Array.from({ length: MEMORY_SIZE / 16 }, (_, i) => i * 16);

/** All 256 bytes as a 16×16 hex grid with highlight layers, a legend and Go to address. */
export function MemoryGrid({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { cpu } = snapshot;
  const [gotoText, setGotoText] = useState('');
  const gotoAddress = parseHexAddress(gotoText);
  const memory = cpu.state.memory;
  const current = cpu.current;
  const layers: MemoryLayers = {
    pc: new Set(current.bytes.map((_, i) => current.address + i).filter((a) => a < MEMORY_SIZE)),
    write: new Set(cpu.lastEntry?.memoryWrites.map((w) => w.address) ?? []),
    sp: cpu.state.sp,
    breakpoints: new Set(cpu.breakpointAddresses),
    goto: gotoAddress,
  };

  return (
    <section className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel @desk:min-h-0">
      <PanelHeader
        aside={
          <label className="flex items-center rounded-[5px] border border-line bg-panel-2 px-2 py-[3px] font-mono text-xs tracking-normal text-ink normal-case">
            Go to 0x
            <input
              aria-label="Go to address"
              value={gotoText}
              maxLength={4}
              placeholder="__"
              onChange={(event) => {
                setGotoText(event.target.value);
              }}
              className={`w-6 bg-transparent outline-none placeholder:text-faint ${gotoText !== '' && gotoAddress === null ? 'text-danger' : ''}`}
            />
          </label>
        }
      >
        Memory · {MEMORY_SIZE} B
      </PanelHeader>
      <div className="overflow-auto px-2 pt-2 pb-1.5 font-mono text-[11.5px]">
        <table className="border-separate border-spacing-x-px" aria-label="Memory">
          <thead>
            <tr className="h-[21px]">
              <th className="w-8" />
              {COLUMNS.map((column) => (
                <th key={column} className="w-[27px] font-normal text-faint">
                  +{column.toString(16).toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row} className="h-[21px]">
                <th className="text-left font-normal text-faint">{hexByte(row)}</th>
                {COLUMNS.map((column) => {
                  const address = row + column;
                  const value = memory[address] ?? 0;
                  const highlights = cellHighlights(address, layers);
                  return (
                    <td
                      key={column}
                      data-address={address}
                      data-highlights={highlights.join(' ')}
                      title={`${hex(address)} = ${hex(value)} (${String(value)})`}
                      className={`h-[19px] w-[27px] rounded-[3px] text-center leading-[19px] ${cellTone(value, highlights)}`}
                      style={ringStyle(highlights)}
                    >
                      {hexByte(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {gotoAddress !== null && (
        <div className="px-3 font-mono text-xs text-dim">
          {hex(gotoAddress)} = <span className="text-ink">{hex(memory[gotoAddress] ?? 0)}</span> (
          {memory[gotoAddress] ?? 0})
        </div>
      )}
      <Legend />
    </section>
  );
}

function ringStyle(highlights: readonly MemoryHighlight[]): CSSProperties | undefined {
  const rings: string[] = [];
  if (highlights.includes('sp')) rings.push('inset 0 0 0 1px var(--color-violet)');
  if (highlights.includes('breakpoint')) rings.push('inset 0 0 0 1px var(--color-danger)');
  if (highlights.includes('pc')) rings.push('inset 0 0 0 1px var(--color-accent)');
  if (highlights.includes('write')) rings.push('inset 0 0 0 1px var(--color-amber)');
  if (highlights.includes('goto')) rings.push('0 0 0 2px var(--color-ink)');
  return rings.length === 0 ? undefined : { boxShadow: rings.join(', ') };
}

function Legend() {
  const item = (label: string, swatch: string) => (
    <span className="flex items-center gap-[5px]">
      <i className={`inline-block size-2.5 rounded-[2px] ${swatch}`} />
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-3 px-3 pt-1.5 pb-2.5 text-[11px] text-dim">
      {item('Current instr', 'bg-accent-deep shadow-[inset_0_0_0_1px_var(--color-accent)]')}
      {item('Last write', 'bg-[#3b2a07] shadow-[inset_0_0_0_1px_var(--color-amber)]')}
      {item('Stack region', 'bg-[#1a1530]')}
      {item('SP', 'shadow-[inset_0_0_0_1px_var(--color-violet)]')}
      {item('Breakpoint', 'shadow-[inset_0_0_0_1px_var(--color-danger)]')}
    </div>
  );
}
