import type { TraceEntry } from '@vcpu/cpu-core';
import { hex, hexBytes } from '../../lib/format';
import { CHANGE_TONE, describeChanges, entryText } from './changes';
import { Empty, TD, TH } from './table';
import { useStickToBottom } from './useStickToBottom';

/** Rows the timeline shows; the full bounded trace is in the Trace log tab. */
export const TIMELINE_ROWS = 200;

/** The most recent executed instructions, oldest first, with the newest row highlighted. */
export function TimelineTable({ trace }: { trace: readonly TraceEntry[] }) {
  const rows = trace.slice(-TIMELINE_ROWS);
  const newest = rows.at(-1);
  const { ref, onScroll } = useStickToBottom<HTMLDivElement>(newest);
  if (newest === undefined) {
    return <Empty />;
  }
  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse font-mono text-xs" aria-label="Execution timeline">
        <thead>
          <tr>
            <th className={TH}>#</th>
            <th className={TH}>Addr</th>
            <th className={TH}>Bytes</th>
            <th className={TH}>Instruction</th>
            <th className={TH}>Changes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr
              key={entry.sequence}
              aria-current={entry === newest ? 'step' : undefined}
              className={`text-muted ${entry === newest ? 'bg-accent/6' : ''}`}
            >
              <td className={TD}>{entry.sequence}</td>
              <td className={TD}>{hex(entry.pc)}</td>
              <td className={`${TD} text-faint`}>{hexBytes(entry.bytes)}</td>
              <td className={`${TD} text-[#e2e8f0]`}>{entryText(entry)}</td>
              <td className={TD}>
                {describeChanges(entry).map((change, i) => (
                  <span key={i} className={`mr-3 ${CHANGE_TONE[change.kind]}`}>
                    {change.text}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
