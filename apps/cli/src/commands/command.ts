import type { CliIo } from '../io.js';

/** One `pnpm cpu <name>` subcommand. */
export interface Command {
  readonly name: string;
  /** One line for the top-level `--help`. */
  readonly summary: string;
  /** The usage line shown in the top-level `--help`, e.g. `run <file.asm|file.bin>`. */
  readonly synopsis: string;
  /** The full `pnpm cpu <name> --help` text. */
  readonly help: string;
  /** Runs the command and returns its exit code. */
  readonly run: (args: readonly string[], io: CliIo) => number | Promise<number>;
}
