import type { Watchpoint, WatchpointKind } from '@vcpu/debugger';
import { type SyntheticEvent, useState } from 'react';
import { hex, hexByte, parseHexRange } from '../../lib/format';
import { HIT_LOG_CAPACITY, type WatchHitRecord } from '../../state/dashboardStore';
import { Button } from '../ui';
import { Empty, TD, TH } from './table';

const KINDS: readonly WatchpointKind[] = ['write', 'read', 'access'];

/** `0x85`, or `0x80–0x8F` for a range. */
export function rangeText({ start, end }: { start: number; end: number }): string {
  return start === end ? hex(start) : `${hex(start)}–${hex(end)}`;
}

/**
 * Checks the add form's address text. Returns the range to watch, or the message to show.
 * Addresses are hex, as in the memory panel's Go to box.
 */
export function validateWatchInput(
  text: string,
): { ok: true; range: { start: number; end: number } } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: false, message: 'Enter an address, e.g. 0x85 or 0x80-0x8F' };
  const range = parseHexRange(text);
  if (range === null) {
    return { ok: false, message: 'Use a hex address 00–FF, or a range like 80-8F (start ≤ end)' };
  }
  return { ok: true, range };
}

export function WatchpointsTab({
  watchpoints,
  hits,
  onAdd,
  onRemove,
}: {
  watchpoints: readonly Watchpoint[];
  hits: readonly WatchHitRecord[];
  onAdd: (range: { start: number; end: number }, kind: WatchpointKind) => void;
  onRemove: (id: number) => void;
}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<WatchpointKind>('write');
  const [error, setError] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const result = validateWatchInput(text);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onAdd(result.range, kind);
    setText('');
    setError(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <form
        onSubmit={submit}
        className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2"
        aria-label="Add watchpoint"
      >
        <input
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          placeholder="0x85 or 0x80-0x8F"
          aria-label="Watch address or range"
          aria-invalid={error !== null}
          spellCheck={false}
          className={`w-44 rounded-[5px] border bg-panel-2 px-2 py-[5px] font-mono text-xs text-ink outline-none placeholder:text-faint focus:border-accent ${error === null ? 'border-line' : 'border-danger'}`}
        />
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as WatchpointKind);
          }}
          aria-label="Watch kind"
          className="rounded-[5px] border border-line bg-panel-2 px-2 py-[5px] font-mono text-xs text-ink outline-none focus:border-accent"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <Button type="submit">Add watchpoint</Button>
        {error !== null && (
          <span role="alert" className="w-full text-xs text-danger">
            {error}
          </span>
        )}
      </form>

      {watchpoints.length === 0 ? (
        <Empty>No watchpoints. A hit pauses the run after the instruction that made it.</Empty>
      ) : (
        <ul className="border-b border-line px-3 py-1.5 font-mono text-xs" aria-label="Watchpoints">
          {watchpoints.map((watchpoint) => (
            <li key={watchpoint.id} className="flex items-center gap-3 py-0.5 text-muted">
              <span className="text-faint">#{watchpoint.id}</span>
              <span className="w-12 text-violet">{watchpoint.kind}</span>
              <span className="text-[#e2e8f0]">{rangeText(watchpoint.range)}</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => {
                  onRemove(watchpoint.id);
                }}
                aria-label={`Remove watchpoint ${String(watchpoint.id)}`}
                className="rounded px-1.5 text-dim hover:bg-panel-2 hover:text-danger"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.8px] text-dim uppercase">
        Hits{' '}
        <span className="font-normal tracking-normal normal-case">
          {hits.length}
          {hits.length >= HIT_LOG_CAPACITY && ` (newest ${String(HIT_LOG_CAPACITY)} kept)`}
        </span>
      </div>
      {hits.length === 0 ? (
        <Empty>No hits yet</Empty>
      ) : (
        <table className="w-full border-collapse font-mono text-xs" aria-label="Watchpoint hits">
          <thead>
            <tr>
              <th className={TH}>#</th>
              <th className={TH}>Addr</th>
              <th className={TH}>Instruction</th>
              <th className={TH}>Access</th>
              <th className={TH}>Value</th>
            </tr>
          </thead>
          <tbody>
            {[...hits].reverse().map(({ step, hit }, i) => (
              <tr
                key={`${String(step)}-${String(hit.watchpoint.id)}-${hit.access}-${String(hit.address)}`}
                className={`text-muted ${i === 0 ? 'bg-accent/6' : ''}`}
              >
                <td className={TD}>{step}</td>
                <td className={TD}>{hex(hit.pc)}</td>
                <td className={`${TD} text-[#e2e8f0]`}>{hit.text}</td>
                <td
                  className={`${TD} ${hit.access === 'write' ? 'text-orange' : 'text-accent-soft'}`}
                >
                  {hit.access} {hex(hit.address)}
                </td>
                <td className={TD}>
                  {hit.access === 'write'
                    ? `${hexByte(hit.oldValue)}→${hexByte(hit.newValue)}`
                    : hexByte(hit.newValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
