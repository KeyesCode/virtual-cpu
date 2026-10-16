import { Readable } from 'node:stream';
import { CPU_NAME } from '@vcpu/shared';
import { assembleCommand } from './commands/assemble.js';
import { benchmarkCommand } from './commands/benchmark.js';
import type { Command } from './commands/command.js';
import { debugCommand } from './commands/debug.js';
import { disassembleCommand } from './commands/disassemble.js';
import { runCommand } from './commands/run.js';
import { type CliIo, ExitCode, println, UsageError } from './io.js';
import { AssemblyFailed } from './program.js';

export { ExitCode, type CliIo } from './io.js';
export { createDebugRepl, type DebugRepl, type ReplResult } from './debug/repl.js';
export * from './schemas.js';

const COMMAND_LIST: readonly Command[] = [
  assembleCommand,
  runCommand,
  debugCommand,
  disassembleCommand,
  benchmarkCommand,
];

export const COMMANDS = ['assemble', 'run', 'debug', 'disassemble', 'benchmark'] as const;

function findCommand(name: string): Command | undefined {
  return COMMAND_LIST.find((command) => command.name === name);
}

export function usage(): string {
  const width = Math.max(...COMMAND_LIST.map((c) => c.synopsis.length)) + 3;
  return [
    `${CPU_NAME} command-line interface`,
    '',
    'Usage: pnpm cpu <command> <file> [options]',
    '',
    'Commands:',
    ...COMMAND_LIST.map((c) => `  ${c.synopsis.padEnd(width)}${c.summary}`),
    '',
    'Options:',
    `  ${'-h, --help'.padEnd(width)}Show this help, or a command's help after its name`,
    '',
    'Exit codes: 0 ok, 1 assembly errors, 2 CPU fault, 3 instruction limit, 64 usage error.',
  ].join('\n');
}

/**
 * Runs one command line (argv without the node and script paths), writing through `io`, and
 * returns the exit code.
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  // `pnpm cpu -- <args>` forwards a literal `--`; drop it.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const [name, ...rest] = args;

  if (name === undefined || name === '-h' || name === '--help') {
    println(io.stdout, usage());
    return ExitCode.OK;
  }
  if (name === 'help') {
    const topic = rest[0] === undefined ? undefined : findCommand(rest[0]);
    println(io.stdout, topic?.help ?? usage());
    return ExitCode.OK;
  }
  const command = findCommand(name);
  if (command === undefined) {
    println(io.stderr, `Unknown command: ${name}\n\n${usage()}`);
    return ExitCode.USAGE;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      println(io.stderr, `cpu ${name}: ${error.message}`);
      println(io.stderr, `Run "pnpm cpu ${name} --help" for usage.`);
      return ExitCode.USAGE;
    }
    if (error instanceof AssemblyFailed) {
      println(io.stderr, error.message);
      return ExitCode.ASSEMBLY_ERROR;
    }
    throw error;
  }
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  /** Directory relative paths resolve against (default `process.cwd()`). */
  readonly cwd?: string;
  /** Lines for `debug` (default: no input). */
  readonly stdin?: string;
}

/** Runs `main` with captured output, for tests and scripts. */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await main(argv, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    cwd: options.cwd ?? process.cwd(),
    stdin: Readable.from([options.stdin ?? '']),
  });
  return { exitCode, stdout, stderr };
}
