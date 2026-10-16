import type { DashboardSnapshot, DashboardStore } from '../state/dashboardStore';
import { CpuStatus } from '@vcpu/shared';
import { Button } from './ui';

/** Run, Pause, Step, Step back and Reset, enabled according to the CPU's state. */
export function ControlBar({
  snapshot,
  store,
}: {
  snapshot: DashboardSnapshot;
  store: DashboardStore;
}) {
  const { running, cpu } = snapshot;
  const terminal = cpu.status === CpuStatus.HALTED || cpu.status === CpuStatus.FAULTED;
  return (
    <div className="flex items-center gap-2" role="toolbar" aria-label="CPU controls">
      <Button
        primary
        disabled={running || terminal}
        onClick={() => {
          store.run();
        }}
      >
        <span aria-hidden>▶</span> Run
      </Button>
      <Button
        disabled={!running}
        onClick={() => {
          store.pause();
        }}
      >
        <span aria-hidden>❚❚</span> Pause
      </Button>
      <Button
        disabled={running || terminal}
        onClick={() => {
          store.step();
        }}
      >
        <span aria-hidden>↷</span> Step
      </Button>
      <Button
        disabled={running || cpu.history.entries === 0}
        onClick={() => {
          store.stepBack();
        }}
      >
        <span aria-hidden>↶</span> Step back
      </Button>
      <Button
        onClick={() => {
          store.reset();
        }}
      >
        <span aria-hidden>⟲</span> Reset
      </Button>
    </div>
  );
}
