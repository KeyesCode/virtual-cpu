import { AsmEditor } from './components/editor/AsmEditor';
import { CpuPanel } from './components/cpu/CpuPanel';
import { MemoryGrid } from './components/memory/MemoryGrid';
import { TopBar } from './components/TopBar';
import { Panel } from './components/ui';
import type { DashboardStore } from './state/dashboardStore';
import { useDebugSession } from './state/useDebugSession';

/**
 * The VCPU-8 dashboard. At 1280px and wider it uses the mockup's three columns; narrower, the
 * panels stack. Breakpoints are container queries on the page width.
 */
export function App({ createStore }: { createStore?: () => DashboardStore }) {
  const [snapshot, store] = useDebugSession(createStore);
  return (
    <div className="@container">
      <div className="flex min-h-screen flex-col bg-bg text-ink @desk:h-screen @desk:min-h-[880px]">
        <TopBar snapshot={snapshot} store={store} />
        <main className="grid flex-1 grid-cols-1 gap-3 p-3 @desk:min-h-0 @desk:grid-cols-[330px_minmax(0,1fr)_500px] @wide:grid-cols-[430px_minmax(0,1fr)_500px] @desk:grid-rows-[500px_minmax(0,1fr)]">
          <AsmEditor snapshot={snapshot} store={store} />
          <CpuPanel snapshot={snapshot} />
          <MemoryGrid snapshot={snapshot} />
          {/* Filled by the follow-up ticket: timeline, stack, watchpoints, trace and performance. */}
          <Panel title="Execution timeline" className="min-h-40">
            <PendingPanel />
          </Panel>
          <Panel title="Performance" className="min-h-40">
            <PendingPanel />
          </Panel>
        </main>
      </div>
    </div>
  );
}

function PendingPanel() {
  return <p className="p-3 text-xs text-faint">Not part of this build yet.</p>;
}
