import type { TraceEntry } from '@vcpu/cpu-core';
import { Fragment, useEffect, useState } from 'react';
import { describeStages, STAGES } from '../../lib/stages';

export const CYCLE_CAPTION =
  "Conceptual view of the emulator's steps for one instruction, not a cycle-accurate model of a pipelined CPU.";

/**
 * FETCH → DECODE → EXECUTE → WRITEBACK for the last executed instruction. With `animate`, the
 * stages light up one after another over `stageMs` each; otherwise all are shown as done. The
 * animation is UI-only: the emulator executes each instruction in one call.
 */
export function CycleStrip({
  entry,
  animate,
  stageMs,
}: {
  entry: TraceEntry | null;
  animate: boolean;
  stageMs: number;
}) {
  const [progress, setProgress] = useState<{ entry: TraceEntry | null; index: number }>({
    entry,
    index: STAGES.length,
  });

  useEffect(() => {
    if (!animate || entry === null) return;
    const timers = STAGES.map((_, index) =>
      setTimeout(
        () => {
          setProgress({ entry, index: index + 1 });
        },
        stageMs * (index + 1),
      ),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [entry, animate, stageMs]);

  // A new entry starts at FETCH when animating; the effect then advances it.
  const active =
    progress.entry === entry ? progress.index : animate && entry !== null ? 0 : STAGES.length;
  const captions = entry === null ? null : describeStages(entry);

  return (
    <div className="px-3 pt-3 pb-3">
      <ol className="flex items-center gap-1.5" aria-label="Instruction cycle">
        {STAGES.map((stage, index) => {
          const state =
            entry === null
              ? 'idle'
              : index < active
                ? 'done'
                : index === active
                  ? 'active'
                  : 'idle';
          return (
            <Fragment key={stage}>
              {index > 0 && (
                <span aria-hidden className="font-mono text-sm text-fainter">
                  →
                </span>
              )}
              <li
                data-stage={stage}
                data-state={state}
                className={`min-w-0 flex-1 rounded-[7px] border px-1 py-2.5 text-center font-mono text-xs font-semibold transition-colors ${STAGE_TONE[state]}`}
              >
                {stage}
                <small
                  className={`mt-0.5 block truncate text-[10px] font-normal ${state === 'active' ? 'text-accent-deep' : 'text-fainter'}`}
                >
                  {captions?.[stage] ?? ' '}
                </small>
              </li>
            </Fragment>
          );
        })}
      </ol>
      <p className="mt-2 flex gap-1.5 text-[11px] text-dim">
        <span aria-hidden>ⓘ</span>
        {CYCLE_CAPTION}
      </p>
    </div>
  );
}

const STAGE_TONE = {
  idle: 'border-line bg-panel-2 text-dim',
  done: 'border-[#164e63] bg-panel-2 text-accent-soft',
  active: 'border-accent bg-accent text-bg shadow-[0_0_18px_rgba(56,189,248,0.45)]',
} as const;
