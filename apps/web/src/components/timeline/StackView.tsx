import type { TraceEntry } from '@vcpu/cpu-core';
import type { StackView as Stack } from '@vcpu/debugger';
import { STACK_CAPACITY } from '@vcpu/shared';
import { hex, hexByte } from '../../lib/format';
import { Empty, TD, TH } from './table';

/**
 * Stack addresses whose current byte was written by CALL, i.e. return addresses. Found from the
 * newest kept trace entry that wrote each address, so a slot written before the trace's window
 * is not marked.
 */
export function returnAddressSlots(trace: readonly TraceEntry[]): ReadonlySet<number> {
  const seen = new Set<number>();
  const fromCall = new Set<number>();
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const entry = trace[i];
    if (entry === undefined) continue;
    for (const write of entry.memoryWrites) {
      if (seen.has(write.address)) continue;
      seen.add(write.address);
      if (entry.instruction?.mnemonic === 'CALL') fromCall.add(write.address);
    }
  }
  return fromCall;
}

/** The live stack, SP+1 through 0xFF, top of stack first. */
export function StackView({ stack, trace }: { stack: Stack; trace: readonly TraceEntry[] }) {
  const returns = returnAddressSlots(trace);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-4 border-b border-line px-3 py-[7px] font-mono text-xs text-dim">
        <span>
          SP <b className="font-semibold text-violet">{hex(stack.sp)}</b>
        </span>
        <span>
          depth <b className="font-semibold text-ink">{stack.depth}</b> / {STACK_CAPACITY}
        </span>
        {stack.depth >= STACK_CAPACITY && <span className="text-amber">stack full</span>}
      </div>
      {stack.slots.length === 0 ? (
        <Empty>Stack is empty</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse font-mono text-xs" aria-label="Stack">
            <thead>
              <tr>
                <th className={TH}>Slot</th>
                <th className={TH}>Addr</th>
                <th className={TH}>Value</th>
                <th className={TH}>Note</th>
              </tr>
            </thead>
            <tbody>
              {stack.slots.map((slot, i) => (
                <tr key={slot.address} className={`text-muted ${i === 0 ? 'bg-violet/6' : ''}`}>
                  <td className={TD}>{i === 0 ? 'top' : `+${String(i)}`}</td>
                  <td className={TD}>{hex(slot.address)}</td>
                  <td className={`${TD} text-[#e2e8f0]`}>{hexByte(slot.value)}</td>
                  <td className={TD}>
                    {returns.has(slot.address) && (
                      <span className="text-ok">return address → {hex(slot.value)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
