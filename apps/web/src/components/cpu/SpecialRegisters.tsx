import type { CpuState } from '@vcpu/cpu-core';
import { instructionText } from '@vcpu/debugger';
import { hex, hexBytes } from '../../lib/format';

const CARD = 'rounded-lg border bg-panel-2 px-2.5 py-2';
const NAME =
  'flex justify-between gap-2 whitespace-nowrap font-mono text-[11px] font-semibold text-dim';

/** PC, SP with stack depth, FLAGS as bits, and IR (the last retired instruction). */
export function SpecialRegisters({ state }: { state: CpuState }) {
  const ir = state.ir;
  return (
    <div className="grid grid-cols-2 gap-2 px-3 pb-3 @min-[640px]:grid-cols-[1fr_1fr_1fr_1.6fr]">
      <div className={`${CARD} border-[#0369a1]`} data-testid="pc">
        <div className={NAME}>PC</div>
        <div className="my-0.5 font-mono text-xl font-semibold text-accent-soft">
          {hex(state.pc)}
        </div>
      </div>
      <div className={`${CARD} border-[#5b21b6]`} data-testid="sp">
        <div className={NAME}>
          SP<span>depth {state.sd}</span>
        </div>
        <div className="my-0.5 font-mono text-xl font-semibold text-[#c4b5fd]">{hex(state.sp)}</div>
      </div>
      <div className={`${CARD} border-line`} data-testid="flags">
        <div className={NAME}>
          FLAGS<span className="font-normal">ZCNV</span>
        </div>
        <div className="my-0.5 font-mono text-xl font-semibold text-white">
          0b{state.flags.toString(2).padStart(4, '0')}
        </div>
      </div>
      <div className={`${CARD} border-line`} data-testid="ir">
        <div className={NAME}>
          IR
          {ir !== null && (
            <span>
              {ir.length} byte{ir.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <div className="my-0.5 truncate py-[3px] font-mono text-[15px] font-semibold text-white">
          {ir === null ? (
            <span className="text-faint">—</span>
          ) : (
            <>
              {hexBytes(ir.bytes)}{' '}
              <span className="text-xs text-dim">{instructionText(ir.bytes)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
