import { instructionText } from '@vcpu/debugger';
import { CPU_NAME, CpuStatus, ISA_VERSION } from '@vcpu/shared';
import { hex } from '../lib/format';
import type { DashboardSnapshot, DashboardStore } from '../state/dashboardStore';
import { ControlBar } from './ControlBar';
import { SpeedSlider } from './SpeedSlider';

const PILL_TONE: Record<CpuStatus, string> = {
  READY: 'border-[#164e63] bg-[#0b2230] text-accent [--dot:var(--color-accent)]',
  RUNNING: 'border-[#1d4d38] bg-[#0f2a1f] text-ok [--dot:var(--color-ok)]',
  PAUSED: 'border-[#a16207] bg-[#1f1a0e] text-amber [--dot:var(--color-amber)]',
  HALTED: 'border-[#4c3d80] bg-[#1a1530] text-violet [--dot:var(--color-violet)]',
  FAULTED: 'border-[#7f1d1d] bg-[#2a1215] text-danger [--dot:var(--color-danger)]',
};

/** The pill text: the status, plus the fault code and address when FAULTED. */
export function statusText(snapshot: DashboardSnapshot): string {
  const { status, state } = snapshot.cpu;
  if (status === CpuStatus.FAULTED && state.fault !== null) {
    return `FAULTED · ${state.fault.code} @ ${hex(state.fault.pc)}`;
  }
  return status;
}

export function TopBar({
  snapshot,
  store,
}: {
  snapshot: DashboardSnapshot;
  store: DashboardStore;
}) {
  const { cpu } = snapshot;
  const [major = '1', minor = '0'] = ISA_VERSION.split('.');
  const [name, suffix] = CPU_NAME.split('-');
  const ir = cpu.state.ir;
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-[18px] gap-y-2 border-b border-line bg-topbar px-[18px] py-2">
      <div className="font-mono text-base font-bold tracking-[0.5px] text-white" title={CPU_NAME}>
        {name}
        {suffix !== undefined && <span className="text-accent">-{suffix}</span>}
      </div>
      <div className="rounded border border-line px-[7px] py-0.5 font-mono text-[11px] text-dim">
        ISA v{major}.{minor}
      </div>
      <div
        role="status"
        aria-label="CPU status"
        title={cpu.state.fault?.detail}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold ${PILL_TONE[cpu.status]}`}
      >
        <i className="size-[7px] rounded-full bg-[var(--dot)] shadow-[0_0_8px_var(--dot)]" />
        {statusText(snapshot)}
      </div>
      <Kv label="PC" value={hex(cpu.state.pc)} />
      <Kv label="SP" value={hex(cpu.state.sp)} />
      <Kv label="INSTR" value={String(cpu.instructionCount)} />
      <Kv label="IR" value={ir === null ? '—' : instructionText(ir.bytes)} />
      <div className="flex-1" />
      <ControlBar snapshot={snapshot} store={store} />
      <SpeedSlider
        speed={snapshot.speed}
        onChange={(speed) => {
          store.setSpeed(speed);
        }}
      />
    </div>
  );
}

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <div className="font-mono text-xs text-dim" data-testid={`kv-${label}`}>
      {label}
      <b className="ml-1.5 font-semibold text-white">{value}</b>
    </div>
  );
}
