import { ANIMATED_SPEED_LIMIT, type DashboardSnapshot } from '../../state/dashboardStore';
import { PanelHeader } from '../ui';
import { CycleStrip } from './CycleStrip';
import { FlagLights } from './FlagLights';
import { RegisterGrid } from './RegisterGrid';
import { SpecialRegisters } from './SpecialRegisters';

/** Stage length when a single Step is animated. */
const STEP_STAGE_MS = 140;

export function CpuPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const { cpu, running, speed, lastStop } = snapshot;
  const entry = cpu.lastEntry;
  const changed = new Set(
    entry?.registerChanges.map((change) => change.register).filter((r) => r.startsWith('R')) ?? [],
  );
  const slow = speed !== 'max' && speed <= ANIMATED_SPEED_LIMIT;
  const animate = running ? slow : lastStop?.stopReason === 'step';
  const stageMs =
    running && speed !== 'max' ? Math.min(250, 1000 / speed / (4 + 1)) : STEP_STAGE_MS;

  return (
    <section className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-panel @desk:min-h-0">
      <PanelHeader
        aside={
          <span className="font-normal tracking-normal normal-case">
            hex · <span className="text-faint">unsigned · signed</span>
          </span>
        }
      >
        CPU State
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        <RegisterGrid registers={cpu.state.registers} changed={changed} />
        <SpecialRegisters state={cpu.state} />
        <FlagLights flags={cpu.state.flags} />
        <PanelHeader className="border-t">Instruction cycle</PanelHeader>
        <CycleStrip entry={entry} animate={animate} stageMs={stageMs} />
      </div>
    </section>
  );
}
