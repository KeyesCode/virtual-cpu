import { spawn } from 'node:child_process';
import type { CommandRecord } from '@vcpu/research-core';
import { CappedLog } from './capped-log.js';
import type { CommandRunner, RunOptions } from './command-runner.js';

const DEFAULT_KILL_GRACE_MS = 2000;

/** Whether any process of the group led by `pid` is still alive. */
export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

/**
 * Runs a command on this machine as the leader of its own process group, so that a timeout reaches
 * everything it started (make, pnpm, node and the simulators): SIGTERM to the group, then SIGKILL
 * after `killGraceMs`, sent whether or not the leader has exited by then.
 */
export class HostCommandRunner implements CommandRunner {
  private readonly killGraceMs: number;

  constructor(options: { readonly killGraceMs?: number } = {}) {
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandRecord> {
    const stdout = new CappedLog(options.stdoutPath, options.maxLogBytes);
    const stderr = new CappedLog(options.stderrPath, options.maxLogBytes);
    const startedAt = new Date();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve) => {
      let spawnError: string | null = null;
      let timedOut = false;
      let finished = false;
      const timers = new Set<NodeJS.Timeout>();

      const finish = (exitCode: number | null, signal: string | null) => {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        if (timedOut) signalGroup(child.pid, 'SIGKILL');
        const finishedAt = new Date();
        resolve({
          command,
          args: [...args],
          cwd: options.cwd,
          pid: child.pid ?? null,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
          exitCode,
          signal,
          timedOut,
          spawnError,
          stdout: stdout.close(),
          stderr: stderr.close(),
        });
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.write(chunk);
      });
      child.on('error', (error) => {
        if (child.pid === undefined) {
          spawnError = error.message;
          finish(null, null);
        }
      });
      child.on('close', (code, signal) => {
        finish(code, signal);
      });

      timers.add(
        setTimeout(() => {
          timedOut = true;
          signalGroup(child.pid, 'SIGTERM');
          timers.add(
            setTimeout(() => {
              signalGroup(child.pid, 'SIGKILL');
              // A process that left the group can hold the pipes open forever: stop waiting.
              timers.add(
                setTimeout(() => {
                  finish(null, 'SIGKILL');
                }, this.killGraceMs),
              );
            }, this.killGraceMs),
          );
        }, options.timeoutMs),
      );
    });
  }
}
