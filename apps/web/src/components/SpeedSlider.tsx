import type { CSSProperties } from 'react';
import { SPEEDS, type Speed } from '../state/dashboardStore';

export function speedLabel(speed: Speed): string {
  return speed === 'max' ? 'max' : `${String(speed)} instr/s`;
}

/** Instructions per second, from 1 to `max` (unthrottled batches every animation frame). */
export function SpeedSlider({
  speed,
  onChange,
}: {
  speed: Speed;
  onChange: (speed: Speed) => void;
}) {
  const index = SPEEDS.indexOf(speed);
  return (
    <label className="flex items-center gap-2 font-mono text-[11px] text-dim">
      SPEED
      <input
        type="range"
        min={0}
        max={SPEEDS.length - 1}
        step={1}
        value={index}
        aria-label="Speed"
        aria-valuetext={speedLabel(speed)}
        onChange={(event) => {
          const next = SPEEDS[Number(event.target.value)];
          if (next !== undefined) onChange(next);
        }}
        className="speed-slider w-[120px]"
        style={{ '--fill': `${String((index / (SPEEDS.length - 1)) * 100)}%` } as CSSProperties}
      />
      <span className="w-[72px] text-right">{speedLabel(speed)}</span>
    </label>
  );
}
