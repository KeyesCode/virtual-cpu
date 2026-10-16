import {
  createCpu,
  type CpuMetrics,
  type CpuState,
  DEFAULT_MAX_INSTRUCTIONS,
  type TraceEntry,
} from '@vcpu/cpu-core';
import { createDebugSession } from '@vcpu/debugger';
import { HELP_OPTION, parseCommandLine, parseCount, singleFile } from '../args.js';
import { formatHexdump, formatRegisters, formatStatus, formatSummary } from '../format/state.js';
import { formatTraceEntry } from '../format/trace.js';
import { type CliIo, ExitCode, println, UsageError } from '../io.js';
import { type LoadedProgram, loadProgram } from '../program.js';
import { runJson, type RunJson } from '../schemas.js';
import type { Command } from './command.js';

const help = `Usage: pnpm cpu run <file.asm|file.bin> [--max-instructions N] [--trace] [--json] [--memory nonzero|all]

Runs a program until it halts, faults or reaches the instruction limit, then prints the
final status, the registers and flags, a memory hexdump and an execution summary.
A .asm file is assembled first; a .bin file is loaded as raw bytes at 0x00.

Options:
      --max-instructions <N>  Stop after N instructions (default ${String(DEFAULT_MAX_INSTRUCTIONS)})
      --trace                 Print every executed instruction and what it changed
      --json                  Print one JSON document instead (see apps/cli/README.md)
      --memory <rows>         nonzero (default): only rows holding a non-zero byte; all: every row
  -h, --help                  Show this help

Exit codes: 0 halted, 1 assembly errors, 2 CPU fault, 3 instruction limit, 64 usage error.`;

type FinalStop = RunJson['stopReason'];

interface Outcome {
  readonly stopReason: FinalStop;
  readonly executed: number;
  readonly state: CpuState;
  readonly metrics: CpuMetrics;
}

const EXIT_CODES = {
  halted: ExitCode.OK,
  faulted: ExitCode.CPU_FAULT,
  limit: ExitCode.INSTRUCTION_LIMIT,
} as const satisfies Record<FinalStop, RunJson['exitCode']>;

function finalStop(reason: string): FinalStop {
  if (reason === 'halted' || reason === 'faulted' || reason === 'limit') return reason;
  // Nothing here sets breakpoints, watchpoints or pauses, so no other stop can happen.
  throw new Error(`Unexpected stop reason: ${reason}`);
}

/** Runs on the bare core: no per-step work beyond the CPU's own. */
function execute(program: LoadedProgram, maxInstructions: number): Outcome {
  const cpu = createCpu({ traceCapacity: 0 });
  cpu.loadProgram(program.bytes);
  const { executed, stopReason } = cpu.run({ maxInstructions });
  return {
    stopReason: finalStop(stopReason),
    executed,
    state: cpu.getState(),
    metrics: cpu.getMetrics(),
  };
}

/** Runs through a debug session so each step's trace entry reaches `onStep` as it happens. */
function executeTraced(
  program: LoadedProgram,
  maxInstructions: number,
  onStep: (entry: TraceEntry) => void,
): Outcome {
  const session = createDebugSession({
    program: program.bytes,
    sourceMap: program.sourceMap,
    historyCapacity: 0,
    traceCapacity: 0,
  });
  session.onStep(onStep);
  const stop = session.run({ maxInstructions });
  return {
    stopReason: finalStop(stop.stopReason),
    executed: stop.executed,
    state: session.getState(),
    metrics: session.getMetrics(),
  };
}

function run(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseCommandLine(args, {
    ...HELP_OPTION,
    'max-instructions': { type: 'string' },
    trace: { type: 'boolean' },
    json: { type: 'boolean' },
    memory: { type: 'string' },
  });
  if (values.help === true) {
    println(io.stdout, help);
    return ExitCode.OK;
  }
  const file = singleFile(positionals, 'the <file.asm|file.bin> to run');
  const maxInstructions =
    values['max-instructions'] === undefined
      ? DEFAULT_MAX_INSTRUCTIONS
      : parseCount(values['max-instructions'], '--max-instructions');
  const memoryRows = values.memory ?? 'nonzero';
  if (memoryRows !== 'nonzero' && memoryRows !== 'all') {
    throw new UsageError(`--memory must be "nonzero" or "all", got "${memoryRows}"`);
  }
  const json = values.json === true;

  const program = loadProgram(io, file);
  const trace: TraceEntry[] = [];
  let outcome: Outcome;
  if (values.trace === true) {
    if (!json) println(io.stdout, 'Trace');
    outcome = executeTraced(program, maxInstructions, (entry) => {
      if (json) trace.push(entry);
      else println(io.stdout, `  ${formatTraceEntry(entry)}`);
    });
    if (!json) println(io.stdout);
  } else {
    outcome = execute(program, maxInstructions);
  }
  const exitCode = EXIT_CODES[outcome.stopReason];

  if (json) {
    const document = runJson({
      file,
      input: program.kind,
      maxInstructions,
      stopReason: outcome.stopReason,
      exitCode,
      state: outcome.state,
      metrics: outcome.metrics,
      trace: values.trace === true ? trace : null,
    });
    println(io.stdout, JSON.stringify(document, null, 2));
    return exitCode;
  }

  const memoryTitle =
    memoryRows === 'all'
      ? 'Memory'
      : 'Memory (rows with a non-zero byte; --memory all shows every row)';
  println(
    io.stdout,
    [
      formatStatus(outcome.state, outcome.stopReason, outcome.executed, maxInstructions),
      '',
      formatRegisters(outcome.state),
      '',
      memoryTitle,
      formatHexdump(outcome.state.memory, { skipZeroRows: memoryRows === 'nonzero' }),
      '',
      formatSummary(outcome.metrics),
    ].join('\n'),
  );
  return exitCode;
}

export const runCommand: Command = {
  name: 'run',
  synopsis: 'run <file.asm|file.bin>',
  summary: 'Run a program and print the final CPU state',
  help,
  run,
};
