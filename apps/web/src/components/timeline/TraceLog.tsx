import type { TraceEntry } from '@vcpu/cpu-core';
import { DEFAULT_TRACE_CAPACITY } from '@vcpu/cpu-core';
import { useState } from 'react';
import { Button } from '../ui';
import { traceLine } from './changes';
import { Empty } from './table';
import { useStickToBottom } from './useStickToBottom';

/** How long the copy result stays next to the button. */
const COPIED_MS = 1500;

/** The whole trace as plain text, one step per line. */
export function traceText(trace: readonly TraceEntry[]): string {
  return trace.map(traceLine).join('\n');
}

/** The full bounded trace, with copy-as-text. */
export function TraceLog({ trace }: { trace: readonly TraceEntry[] }) {
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const { ref, onScroll } = useStickToBottom<HTMLPreElement>(trace.at(-1));
  if (trace.length === 0) {
    return <Empty />;
  }
  const text = traceText(trace);
  const copy = (): void => {
    const show = (result: 'copied' | 'failed') => () => {
      setCopied(result);
      setTimeout(() => {
        setCopied(null);
      }, COPIED_MS);
    };
    navigator.clipboard.writeText(`${text}\n`).then(show('copied'), show('failed'));
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs text-dim">
        <span>
          {trace.length} {trace.length === 1 ? 'entry' : 'entries'} · keeps the last{' '}
          {DEFAULT_TRACE_CAPACITY}
        </span>
        <div className="flex-1" />
        {copied !== null && (
          <span className={copied === 'copied' ? 'text-ok' : 'text-danger'}>
            {copied === 'copied' ? 'Copied' : 'Copy failed'}
          </span>
        )}
        <Button onClick={copy} className="py-1">
          Copy as text
        </Button>
      </div>
      <pre
        ref={ref}
        onScroll={onScroll}
        aria-label="Trace log"
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-muted"
      >
        {text}
      </pre>
    </div>
  );
}
