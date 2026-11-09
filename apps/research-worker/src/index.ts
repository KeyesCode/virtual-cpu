// BullMQ orchestration of the experiment state machine. The worker runs on the host, never in
// Compose: docs/research-engine/architecture.md explains why, and state-machine.md how it works.
export const packageName = '@vcpu/research-worker';

export { Cancellation } from './cancellation.js';
export { checkWorkerConfig, newWorkerId, readWorkerConfig, type WorkerConfig } from './config.js';
export { createLogger } from './logger.js';
export {
  createFixtureHandlers,
  type FixtureJournalEntry,
  type FixtureOptions,
  type FixtureStats,
} from './processors/fixture.js';
export {
  StageFailure,
  createNoopHandlers,
  type StageContext,
  type StageHandler,
  type StageHandlers,
  type StageOutcome,
} from './processors/handlers.js';
export { EXPERIMENTS_QUEUE, RECOVERY_QUEUE, enqueueStage, type StageJobData } from './queue.js';
export { recoverStale, type RecoveryReport } from './recovery.js';
export {
  cancelExperiment,
  enqueueExperiment,
  startWorker,
  type WorkerDependencies,
  type WorkerHandle,
} from './worker.js';
