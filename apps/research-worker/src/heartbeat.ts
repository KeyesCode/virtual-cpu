import type { ExperimentRepository } from '@vcpu/research-core';
import type { Logger } from 'pino';

export interface HeartbeatOptions {
  readonly experiments: ExperimentRepository;
  readonly experimentId: string;
  readonly owner: string;
  readonly intervalMs: number;
  readonly logger: Logger;
  /** Called once if another worker has taken the lease over. */
  readonly onLost: () => void;
}

/**
 * Refresh the experiment's heartbeat every `intervalMs` while its stage runs. A failed refresh
 * (Postgres briefly down) is logged and tried again on the next beat; a refresh that finds the
 * lease taken over stops the beat and calls `onLost`. Returns the function that stops it.
 */
export function startHeartbeat(options: HeartbeatOptions): () => void {
  let stopped = false;
  const beat = async () => {
    try {
      const held = await options.experiments.heartbeat(options.experimentId, options.owner);
      if (!held && !stopped) {
        stopped = true;
        clearInterval(timer);
        options.logger.warn('lease lost: another worker took the stage over');
        options.onLost();
      }
    } catch (error) {
      options.logger.warn({ err: error }, 'heartbeat failed');
    }
  };
  const timer = setInterval(() => void beat(), options.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
