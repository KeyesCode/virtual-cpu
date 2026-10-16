import type { CpuMetrics } from '@vcpu/cpu-core';
import { MNEMONICS, type Mnemonic, OPCODE_IDS, opcodeById } from '@vcpu/shared';
import type { ReactNode } from 'react';
import { rate } from '../../lib/format';
import { type DashboardSnapshot, THROUGHPUT_WINDOW_MS } from '../../state/dashboardStore';
import { PanelHeader } from '../ui';

export interface OpcodeBar {
  readonly mnemonic: Mnemonic;
  readonly count: number;
}

/**
 * Retired instructions per mnemonic (LOAD and STORE variants added together), unused ones left
 * out, most frequent first; ties keep the ISA's mnemonic order.
 */
export function opcodeBars(metrics: CpuMetrics): readonly OpcodeBar[] {
  const counts = new Map<Mnemonic, number>();
  for (const id of OPCODE_IDS) {
    const count = metrics.opcodeCounts[id];
    if (count === 0) continue;
    const { mnemonic } = opcodeById[id];
    counts.set(mnemonic, (counts.get(mnemonic) ?? 0) + count);
  }
  return [...counts]
    .map(([mnemonic, count]) => ({ mnemonic, count }))
    .sort(
      (a, b) => b.count - a.count || MNEMONICS.indexOf(a.mnemonic) - MNEMONICS.indexOf(b.mnemonic),
    );
}

/** The bottom-right panel: execution metrics from the core, host throughput from the browser. */
export function PerformancePanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { metrics } = snapshot.cpu;
  const bars = opcodeBars(metrics);
  const top = bars[0]?.count ?? 0;
  const paced = snapshot.speed !== 'max';
  return (
    <section className="flex min-h-80 flex-col overflow-hidden rounded-[10px] border border-line bg-panel @desk:min-h-0">
      <PanelHeader>Performance</PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-2 gap-2 p-3">
          <Tile label="Instructions" testId="perf-instructions">
            {metrics.instructions}
          </Tile>
          <Tile
            label="Host throughput"
            testId="perf-throughput"
            unit={`instr/s${paced ? ' · paced' : ''}`}
            title={`Measured in this browser over a ${String(THROUGHPUT_WINDOW_MS / 1000)} s sliding window${paced ? '; the speed slider limits it' : ''}.`}
          >
            {snapshot.throughput === null ? '—' : rate(snapshot.throughput)}
          </Tile>
          <Tile label="Mem reads / writes" unit="data">
            {metrics.memoryReads} / {metrics.memoryWrites}
          </Tile>
          <Tile label="Branches" unit="taken / not">
            {metrics.branchesTaken} / {metrics.branchesNotTaken}
          </Tile>
        </div>
        {bars.length === 0 ? (
          <p className="px-3 pb-2.5 text-xs text-faint">No instructions executed yet</p>
        ) : (
          <ul className="px-3 pt-0.5 pb-2.5" aria-label="Opcode distribution">
            {bars.map(({ mnemonic, count }) => (
              <li
                key={mnemonic}
                className="flex h-[19px] items-center gap-2 font-mono text-[11.5px]"
              >
                <span className="w-11 text-muted">{mnemonic}</span>
                <span className="h-2 flex-1 overflow-hidden rounded bg-[#1b2130]">
                  <i
                    className="block h-full rounded bg-accent"
                    style={{ width: `${String((count / top) * 100)}%` }}
                  />
                </span>
                <span className="w-10 text-right text-dim">{count}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="px-3 pb-2.5 text-[10.5px] text-faint">
          Est. cycles: <b className="text-muted">{metrics.estimatedCycles}</b> (instructional timing
          model, see docs/benchmarks.md). Not measured hardware clock cycles.
        </p>
      </div>
    </section>
  );
}

function Tile({
  label,
  unit,
  title,
  testId,
  children,
}: {
  label: string;
  unit?: string;
  title?: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-[11px] py-[9px]" title={title}>
      <div className="text-[10.5px] tracking-[0.5px] text-dim uppercase">{label}</div>
      <div className="mt-0.5 font-mono text-[19px] font-semibold text-white" data-testid={testId}>
        {children}
        {unit !== undefined && (
          <small className="ml-1 text-[11px] font-normal text-dim">{unit}</small>
        )}
      </div>
    </div>
  );
}
