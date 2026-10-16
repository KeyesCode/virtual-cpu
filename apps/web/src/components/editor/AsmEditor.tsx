import type { Diagnostic } from '@vcpu/assembler';
import { useMemo, useState } from 'react';
import { EXAMPLES } from '../../lib/examples';
import { hexByte } from '../../lib/format';
import { highlightLine, type TokenClass } from '../../lib/highlight';
import {
  type DashboardSnapshot,
  type DashboardStore,
  lineHasInstruction,
} from '../../state/dashboardStore';
import { Button, PanelHeader } from '../ui';

const TOKEN_TONE: Record<TokenClass, string> = {
  plain: '',
  comment: 'text-faint italic',
  label: 'text-ok',
  directive: 'text-pink',
  mnemonic: 'text-purple',
  register: 'text-accent-soft',
  number: 'text-amber',
  string: 'text-amber',
};

/** 20px rows, shared by the gutter, the highlighted layer and the textarea. */
const ROW = 'h-5 leading-5';

/**
 * A lightweight assembly editor: a transparent textarea over a syntax-highlighted copy of the
 * same text, so typing, selection and undo stay native. The gutter holds breakpoints, line numbers
 * and each line's address from the live assembly.
 */
export function AsmEditor({
  snapshot,
  store,
}: {
  snapshot: DashboardSnapshot;
  store: DashboardStore;
}) {
  const { source, assembly, loadedSource, breakpointLines, cpu } = snapshot;
  const [cursorLine, setCursorLine] = useState(1);
  const lines = useMemo(() => source.split('\n'), [source]);
  const errors = assembly.diagnostics.filter((d) => d.severity === 'error');

  const addressByLine = useMemo(() => {
    const map = new Map<number, number>();
    for (const entry of assembly.sourceMap.values()) {
      const known = map.get(entry.line);
      if (known === undefined || entry.address < known) map.set(entry.line, entry.address);
    }
    return map;
  }, [assembly]);

  const diagnosticsByLine = useMemo(() => {
    const map = new Map<number, Diagnostic[]>();
    for (const d of assembly.diagnostics) {
      map.set(d.line, [...(map.get(d.line) ?? []), d]);
    }
    return map;
  }, [assembly]);

  const isLoaded = source === loadedSource;
  const currentLine = isLoaded ? cpu.current.source?.line : undefined;
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);

  const updateCursor = (target: HTMLTextAreaElement): void => {
    setCursorLine(target.value.slice(0, target.selectionStart).split('\n').length);
  };

  return (
    <section className="flex min-h-[420px] flex-col overflow-hidden rounded-[10px] border border-line bg-panel @desk:row-span-2 @desk:min-h-0">
      <PanelHeader
        aside={
          <select
            aria-label="Example program"
            className="rounded-[5px] border border-line bg-panel-2 px-2 py-[3px] font-mono text-xs tracking-normal text-ink normal-case"
            value={snapshot.exampleName ?? ''}
            onChange={(event) => {
              store.selectExample(event.target.value);
            }}
          >
            {snapshot.exampleName === null && <option value="">custom</option>}
            {EXAMPLES.map((example) => (
              <option key={example.name} value={example.name}>
                {example.name}.asm
              </option>
            ))}
          </select>
        }
      >
        Assembly
      </PanelHeader>

      <div className="relative min-h-0 flex-1 overflow-auto font-mono text-[12.5px]">
        <div className="flex w-max min-w-full py-2">
          {/* Gutter: breakpoint, line number, address. */}
          <div className="sticky left-0 z-10 shrink-0 bg-panel select-none" aria-label="Gutter">
            {lines.map((_, index) => {
              const line = index + 1;
              const address = addressByLine.get(line);
              const diagnostics = diagnosticsByLine.get(line);
              const hasError = diagnostics?.some((d) => d.severity === 'error') ?? false;
              const breakable = lineHasInstruction(assembly, line);
              const hasBreakpoint = breakpointLines.has(line);
              return (
                <div
                  key={line}
                  className={`flex items-center ${ROW} ${rowTone(line, currentLine)}`}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${hasBreakpoint ? 'Remove' : 'Add'} breakpoint on line ${String(line)}`}
                    aria-pressed={hasBreakpoint}
                    disabled={!breakable && !hasBreakpoint}
                    onClick={() => {
                      store.toggleBreakpoint(line);
                    }}
                    className="group flex h-5 w-[22px] items-center justify-center enabled:cursor-pointer"
                  >
                    {hasBreakpoint ? (
                      <i className="size-[9px] rounded-full bg-danger shadow-[0_0_6px_var(--color-danger)]" />
                    ) : (
                      breakable && (
                        <i className="size-[9px] rounded-full bg-danger/0 group-hover:bg-danger/40" />
                      )
                    )}
                  </button>
                  <span
                    className={`w-7 pr-2.5 text-right ${hasError ? 'text-danger' : 'text-fainter'}`}
                    title={diagnostics
                      ?.map((d) => `col ${String(d.column)}: ${d.message}`)
                      .join('\n')}
                  >
                    {line}
                  </span>
                  <span className="w-[38px] text-faint">
                    {address === undefined ? '' : hexByte(address)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Highlighted text with the editable textarea on top. */}
          <div className="relative flex-1">
            <div aria-hidden className="pointer-events-none whitespace-pre text-ink">
              {lines.map((text, index) => {
                const line = index + 1;
                const spans = (diagnosticsByLine.get(line) ?? [])
                  .filter((d) => d.severity === 'error')
                  .map((d) => [d.column - 1, d.column - 1 + (d.span.end - d.span.start)] as const);
                return (
                  <div
                    key={line}
                    className={`${ROW} pr-4 ${rowTone(line, currentLine)}`}
                    data-line={line}
                  >
                    {highlightLine(text, spans).map((segment, i) => (
                      <span
                        key={i}
                        className={`${TOKEN_TONE[segment.cls]} ${segment.error ? 'squiggle' : ''}`}
                        data-error={segment.error ? 'true' : undefined}
                      >
                        {segment.text}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
            <textarea
              aria-label="Assembly source"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              wrap="off"
              value={source}
              onChange={(event) => {
                store.setSource(event.target.value);
                updateCursor(event.target);
              }}
              onSelect={(event) => {
                updateCursor(event.currentTarget);
              }}
              style={{ width: `max(100%, ${String(longest + 2)}ch)` }}
              className="absolute inset-y-0 left-0 resize-none overflow-hidden border-0 bg-transparent p-0 font-mono text-[12.5px] leading-5 whitespace-pre text-transparent caret-white outline-none selection:bg-accent/30"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
        <Button
          primary
          onClick={() => {
            store.assembleNow();
          }}
        >
          Assemble
        </Button>
        <Button
          disabled={!assembly.ok}
          title={assembly.ok ? undefined : 'Fix the errors before loading'}
          onClick={() => {
            store.load();
          }}
        >
          Load into CPU
        </Button>
        <div className="flex-1" />
        <Button
          disabled={!assembly.ok}
          title="Raw machine code from 0x00 to the last assembled byte"
          onClick={() => {
            downloadBinary(store, snapshot.exampleName ?? 'program');
          }}
        >
          .bin ↓
        </Button>
      </div>
      <StatusLine snapshot={snapshot} errors={errors} cursorLine={cursorLine} />
    </section>
  );
}

function rowTone(line: number, currentLine: number | undefined): string {
  return line === currentLine ? 'bg-accent/[0.12] current-line' : '';
}

function StatusLine({
  snapshot,
  errors,
  cursorLine,
}: {
  snapshot: DashboardSnapshot;
  errors: readonly Diagnostic[];
  cursorLine: number;
}) {
  const { assembly } = snapshot;
  const size = assembly.bytes.ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
  const warnings = assembly.diagnostics.length - errors.length;
  const first = errors[0];
  const loaded = snapshot.source === snapshot.loadedSource;
  return (
    <div
      className="flex items-center gap-2.5 border-t border-line px-3 py-2 font-mono text-xs"
      aria-live="polite"
    >
      {first === undefined ? (
        <span className="truncate text-ok" data-testid="assembly-status">
          ✓ {size} bytes · {assembly.symbols.size} symbols · 0 errors
          {warnings > 0 && <span className="text-amber"> · {warnings} warnings</span>}
          {!loaded && <span className="text-amber"> · not loaded</span>}
          {snapshot.notice !== null && <span className="text-dim"> · {snapshot.notice}</span>}
        </span>
      ) : (
        <span className="truncate text-danger" data-testid="assembly-status" title={first.message}>
          ✗ {errors.length} error{errors.length === 1 ? '' : 's'} · line {first.line}, col{' '}
          {first.column}: {first.message}
        </span>
      )}
      <div className="flex-1" />
      <span className="shrink-0 text-dim">Ln {cursorLine}</span>
    </div>
  );
}

function downloadBinary(store: DashboardStore, name: string): void {
  const bytes = store.programBinary();
  if (bytes === null) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.bin`;
  link.click();
  URL.revokeObjectURL(url);
}
