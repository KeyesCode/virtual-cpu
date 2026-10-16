import { FLAG_MASKS, FLAG_NAMES, type FlagName } from '@vcpu/shared';

const FLAG_LABEL: Record<FlagName, string> = {
  Z: 'ZERO',
  C: 'CARRY',
  N: 'NEGATIVE',
  V: 'OVERFLOW',
};

/** Z, C, N and V as lights, lit amber when set. */
export function FlagLights({ flags }: { flags: number }) {
  return (
    <div className="flex gap-1.5 px-3 pb-3">
      {FLAG_NAMES.map((flag) => {
        const on = (flags & FLAG_MASKS[flag]) !== 0;
        return (
          <div
            key={flag}
            data-testid={`flag-${flag}`}
            data-on={on ? 'true' : 'false'}
            aria-label={`${FLAG_LABEL[flag]} flag ${on ? 'set' : 'clear'}`}
            className={`flex-1 rounded-[7px] border py-1.5 text-center font-mono text-[15px] font-semibold ${
              on
                ? 'border-[#a16207] bg-[#1f1a0e] text-amber'
                : 'border-line bg-panel-2 text-fainter'
            }`}
          >
            {flag}
            <small
              className={`block font-sans text-[10px] font-normal tracking-[0.5px] ${on ? 'text-[#a16207]' : 'text-fainter'}`}
            >
              {FLAG_LABEL[flag]}
            </small>
          </div>
        );
      })}
    </div>
  );
}
