import { useState } from 'react';
import type { DashboardSnapshot, DashboardStore } from '../../state/dashboardStore';
import { StackView } from './StackView';
import { TimelineTable } from './TimelineTable';
import { TraceLog } from './TraceLog';
import { WatchpointsTab } from './WatchpointsTab';

const TABS = ['Execution timeline', 'Stack', 'Watchpoints', 'Trace log'] as const;
type Tab = (typeof TABS)[number];

/** The bottom-centre panel: timeline, stack, watchpoints and trace log tabs. */
export function TimelinePanel({
  snapshot,
  store,
}: {
  snapshot: DashboardSnapshot;
  store: DashboardStore;
}) {
  const [tab, setTab] = useState<Tab>('Execution timeline');
  const { cpu } = snapshot;
  const { entries, capacity } = cpu.history;
  return (
    <section className="flex min-h-80 flex-col overflow-hidden rounded-[10px] border border-line bg-panel @desk:min-h-0">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-3 py-[7px]">
        <div role="tablist" aria-label="Execution views" className="flex gap-0.5">
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              onClick={() => {
                setTab(name);
              }}
              className={`rounded-[5px] border px-2.5 py-[3px] text-xs font-semibold ${tab === name ? 'border-line bg-panel-2 text-white' : 'border-transparent text-dim hover:text-ink'}`}
            >
              {name}
              {name === 'Watchpoints' && cpu.watchpoints.length > 0 && (
                <span className="ml-1 text-violet">{cpu.watchpoints.length}</span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-[11px] text-dim">
          history {entries} / {capacity} snapshots
          {capacity > 0 && entries >= capacity && (
            <span className="text-amber"> · capacity reached</span>
          )}
        </span>
      </header>
      <div role="tabpanel" aria-label={tab} className="flex min-h-0 flex-1 flex-col">
        {tab === 'Execution timeline' && <TimelineTable trace={cpu.trace} />}
        {tab === 'Stack' && <StackView stack={cpu.stack} trace={cpu.trace} />}
        {tab === 'Watchpoints' && (
          <WatchpointsTab
            watchpoints={cpu.watchpoints}
            hits={snapshot.watchHits}
            onAdd={(range, kind) => {
              store.addWatchpoint({ range, kind });
            }}
            onRemove={(id) => {
              store.removeWatchpoint(id);
            }}
          />
        )}
        {tab === 'Trace log' && <TraceLog trace={cpu.trace} />}
      </div>
    </section>
  );
}
