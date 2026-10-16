import type { TraceEntry } from '@vcpu/cpu-core';
import type { DebugSession, DebugStop, WatchpointKind } from '@vcpu/debugger';
import { MEMORY_SIZE } from '@vcpu/shared';
import { formatHexdump, formatRegisters } from '../format/state.js';
import { byteValue, hex, parseNumber } from '../format/hex.js';
import { formatSource, formatTraceEntry } from '../format/trace.js';

export const REPL_HELP = `Commands:
  step [n]                    Execute n instructions (default 1), even one under a breakpoint
  back [n]                    Step back n instructions (default 1)
  run                         Run until a breakpoint, watchpoint, HLT, fault or the instruction limit
  break [addr|line]           Stop before the instruction at an address (0x1A) or source line (21);
                              with no argument, list breakpoints
  watch [addr] [r|w|rw]       Stop after an instruction reads (r), writes (w) or accesses (rw,
                              the default) the byte at addr; with no argument, list watchpoints
  regs                        Registers, PC, SP, SD, IR and flags
  mem [addr] [len]            Hexdump len bytes from addr (default: all 256 bytes; len 16)
  stack                       SP, stack depth and the live stack bytes, top first
  trace [n]                   The last n executed instructions (default 10)
  reset                       Back to the loaded program; breakpoints and watchpoints stay
  help                        This list
  quit                        Leave the debugger
Numbers are decimal, 0x hex or 0b binary. A bare decimal in "break" is a source line when the
program came from a .asm file, and an address for a .bin.`;

export interface ReplOptions {
  /** True when the program came from source, so `break 21` means line 21. */
  readonly hasSource: boolean;
  /** Instruction limit for each `run`. */
  readonly maxInstructions: number;
}

export interface ReplResult {
  /** Text to print; may be empty. */
  readonly output: string;
  readonly quit: boolean;
}

export interface DebugRepl {
  /** Where execution is: status, PC, the instruction there and its source line. */
  location(): string;
  /** Handles one command line. Never throws: errors come back as `error: …` output. */
  execute(line: string): ReplResult;
}

const WATCH_KINDS: Readonly<Record<string, WatchpointKind>> = {
  r: 'read',
  read: 'read',
  w: 'write',
  write: 'write',
  rw: 'access',
  access: 'access',
};

/** `record[key]` for own keys only, so input such as `constructor` finds nothing. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The `pnpm cpu debug` command language as a pure function of the session and one line, so it
 * can be tested without a terminal. All CPU behaviour comes from the session.
 */
export function createDebugRepl(session: DebugSession, options: ReplOptions): DebugRepl {
  /** Trace entries of the instructions the current command executed. */
  let stepped: TraceEntry[] = [];
  session.onStep((entry) => {
    stepped.push(entry);
  });

  const location = (): string => {
    const current = session.getCurrentInstruction();
    const status = session.getStatus();
    const source = formatSource(current.source);
    return `[${status}] PC ${hex(current.address)}  ${current.text.padEnd(20)}${source === '' ? '' : `; ${source}`}`.trimEnd();
  };

  const count = (text: string | undefined, fallback: number, what: string): number => {
    if (text === undefined) return fallback;
    const value = parseNumber(text);
    if (value === null || value < 1)
      throw new Error(`${what} must be a positive integer, got "${text}"`);
    return value;
  };

  const address = (text: string, what: string): number => {
    const value = parseNumber(text);
    if (value === null || value >= MEMORY_SIZE) {
      throw new Error(`${what} must be an address from 0x00 to 0xFF, got "${text}"`);
    }
    return value;
  };

  const describeStop = (stop: DebugStop): string[] => {
    switch (stop.stopReason) {
      case 'breakpoint': {
        const line = stop.breakpoint.line === null ? '' : ` (line ${String(stop.breakpoint.line)})`;
        return [`Breakpoint ${String(stop.breakpoint.id)} at ${hex(stop.address)}${line}`];
      }
      case 'watchpoint':
        return stop.hits.map((hit) => {
          const access =
            hit.access === 'read'
              ? `read [${hex(hit.address)}] = ${hex(hit.newValue)}`
              : `wrote [${hex(hit.address)}] ${hex(hit.oldValue)} → ${hex(hit.newValue)}`;
          return `Watchpoint ${String(hit.watchpoint.id)} (${hit.watchpoint.kind}): ${hit.text} at ${hex(hit.pc)} ${access}`;
        });
      case 'halted':
        return [`HALTED after ${String(session.getInstructionCount())} instructions`];
      case 'faulted':
        return [
          `FAULTED at ${hex(stop.fault?.pc ?? stop.pc)}: ${stop.fault?.code ?? 'unknown fault'}: ${stop.fault?.detail ?? ''}`,
        ];
      case 'limit':
        return [`Stopped after ${String(stop.executed)} instructions: the instruction limit`];
      case 'paused':
        return ['Paused'];
      case 'step':
        return [];
    }
  };

  const commands: Readonly<Record<string, (args: readonly string[]) => string[] | 'quit'>> = {
    help: () => [REPL_HELP],
    step: ([n]) => {
      const total = count(n, 1, 'step count');
      const lines: string[] = [];
      for (let i = 0; i < total; i += 1) {
        const stop = session.step();
        lines.push(...stepped.map((entry) => formatTraceEntry(entry)));
        stepped = [];
        if (stop.stopReason !== 'step') {
          lines.push(...describeStop(stop));
          break;
        }
      }
      return [...lines, location()];
    },
    back: ([n]) => {
      const total = count(n, 1, 'step-back count');
      const lines: string[] = [];
      for (let i = 0; i < total; i += 1) {
        const result = session.stepBack();
        if (!result.ok) {
          lines.push(result.message);
          break;
        }
        lines.push(`Undid ${formatTraceEntry(result.undone)}`);
      }
      return [...lines, location()];
    },
    run: () => {
      const stop = session.run({ maxInstructions: options.maxInstructions });
      return [
        `Ran ${String(stop.executed)} instruction${stop.executed === 1 ? '' : 's'}`,
        ...describeStop(stop),
        location(),
      ];
    },
    break: ([target]) => {
      if (target === undefined) {
        const list = session.listBreakpoints();
        if (list.length === 0) return ['No breakpoints'];
        return list.map(
          (bp) =>
            `Breakpoint ${String(bp.id)} at ${hex(bp.address)}${bp.line === null ? '' : ` (line ${String(bp.line)})`}${bp.enabled ? '' : ' [disabled]'}`,
        );
      }
      const isLine = options.hasSource && /^[0-9]+$/.test(target);
      const breakpoint = session.addBreakpoint(
        isLine ? { line: count(target, 1, 'line') } : { address: address(target, 'breakpoint') },
      );
      const line = breakpoint.line === null ? '' : ` (line ${String(breakpoint.line)})`;
      return [
        `Breakpoint ${String(breakpoint.id)} at ${hex(breakpoint.address)}${line}`,
        ...(breakpoint.warning === null ? [] : [`warning: ${breakpoint.warning}`]),
      ];
    },
    watch: ([target, kindText]) => {
      if (target === undefined) {
        const list = session.listWatchpoints();
        if (list.length === 0) return ['No watchpoints'];
        return list.map((wp) => {
          const range =
            wp.range.start === wp.range.end
              ? hex(wp.range.start)
              : `${hex(wp.range.start)}–${hex(wp.range.end)}`;
          return `Watchpoint ${String(wp.id)} on ${range} (${wp.kind})${wp.enabled ? '' : ' [disabled]'}`;
        });
      }
      const kind = own(WATCH_KINDS, kindText ?? 'rw');
      if (kind === undefined)
        throw new Error(`watch kind must be r, w or rw, got "${kindText ?? ''}"`);
      const watchpoint = session.addWatchpoint({ address: address(target, 'watchpoint'), kind });
      return [`Watchpoint ${String(watchpoint.id)} on ${hex(watchpoint.range.start)} (${kind})`];
    },
    regs: () => [formatRegisters(session.getState())],
    mem: ([start, length]) => {
      const from = start === undefined ? 0 : address(start, 'address');
      const len = start === undefined ? MEMORY_SIZE : count(length, 16, 'length');
      const to = Math.min(MEMORY_SIZE, from + len) - 1;
      return [formatHexdump(session.getState().memory, { start: from, end: to })];
    },
    stack: () => {
      const view = session.getStackView();
      const header = `SP = ${hex(view.sp)}  depth = ${String(view.depth)}`;
      if (view.slots.length === 0) return [header, '  (empty)'];
      return [
        header,
        ...view.slots.map(
          (slot, i) =>
            `  ${hex(slot.address)}  ${hex(slot.value)} (${byteValue(slot.value)})${i === 0 ? '  ← top' : ''}`,
        ),
      ];
    },
    trace: ([n]) => {
      const entries = session.getTimeline(count(n, 10, 'trace length'));
      return entries.length === 0
        ? ['No instructions executed yet']
        : entries.map((entry) => formatTraceEntry(entry));
    },
    reset: () => {
      session.reset();
      return ['Reset', location()];
    },
    quit: () => 'quit',
  };
  const aliases: Readonly<Record<string, string>> = { '?': 'help', exit: 'quit', q: 'quit' };

  return {
    location,
    execute(line) {
      const [word, ...args] = line.trim().split(/\s+/);
      if (word === undefined || word === '') return { output: '', quit: false };
      const name = own(aliases, word.toLowerCase()) ?? word.toLowerCase();
      const handler = own(commands, name);
      if (handler === undefined) {
        return { output: `Unknown command "${word}". Type "help" for the commands.`, quit: false };
      }
      stepped = [];
      try {
        const result = handler(args);
        return result === 'quit'
          ? { output: '', quit: true }
          : { output: result.join('\n'), quit: false };
      } catch (error) {
        return {
          output: `error: ${error instanceof Error ? error.message : String(error)}`,
          quit: false,
        };
      } finally {
        stepped = [];
      }
    },
  };
}
