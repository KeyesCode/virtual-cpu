import type { CommandRecord } from '@vcpu/research-core';

export interface RunOptions {
  readonly cwd: string;
  /** Added to the runner's own environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** The most of each output stream kept on disk. */
  readonly maxLogBytes: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

/**
 * Runs one command and records how it ended. A command that fails, overruns or cannot start is a
 * record, not a rejection; a rejection means the runner itself broke. The sandbox ticket adds an
 * implementation that runs the same commands inside the Docker image.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandRecord>;
}
