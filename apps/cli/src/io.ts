import { isAbsolute, resolve } from 'node:path';

/** Process exit codes. Scripts can rely on them; they are documented in apps/cli/README.md. */
export const ExitCode = {
  /** The command succeeded; for `run`, the program halted. */
  OK: 0,
  /** The source did not assemble. */
  ASSEMBLY_ERROR: 1,
  /** The CPU faulted. */
  CPU_FAULT: 2,
  /** `run` hit `--max-instructions` before the program halted. */
  INSTRUCTION_LIMIT: 3,
  /** Bad arguments, a missing or unreadable file, or an input that is not a program. */
  USAGE: 64,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** Where a command reads and writes. `bin.ts` wires it to the process; tests capture it. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Relative file arguments resolve against this directory. */
  readonly cwd: string;
  /** Input for `debug`. */
  readonly stdin?: NodeJS.ReadableStream;
  /** Output stream for `debug`'s line editor when stdin is a terminal. */
  readonly terminal?: NodeJS.WritableStream;
}

/** A bad command line or input file: printed to stderr with exit code 64. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export function resolvePath(io: CliIo, path: string): string {
  return isAbsolute(path) ? path : resolve(io.cwd, path);
}

/** Writes `text` followed by a newline. */
export function println(write: (text: string) => void, text = ''): void {
  write(`${text}\n`);
}
