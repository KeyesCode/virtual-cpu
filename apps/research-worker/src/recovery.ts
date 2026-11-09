import {
  InvalidTransition,
  StaleExperimentState,
  decideFailure,
  isStageState,
  type ExperimentRecord,
  type StageState,
} from '@vcpu/research-core';
import { enqueueStage, isStagePending } from './queue.js';
import type { Orchestration } from './processors/stage.js';

/** How many stale experiments one recovery pass takes on. */
const RECOVERY_BATCH = 100;

export interface RecoveryReport {
  /** Experiments whose stage was put back on the queue. */
  readonly requeued: string[];
  /** Experiments failed because the dead attempt was the last the policy allows. */
  readonly failed: string[];
  /** Stale experiments left alone: their job is still queued or running, or another recoverer won. */
  readonly skipped: string[];
}

/**
 * One pass of stale-job recovery. A live experiment (`QUEUED` or a stage) whose heartbeat is older
 * than `staleAfterMs` and whose stage job is no longer in the queue has lost its worker or its job.
 * The pass takes it over with a conditional update (only one of several racing recoverers wins),
 * then re-queues the stage. A stage that had started counts the dead attempt as an
 * `infrastructure-failure`, so a stage that keeps killing its worker ends `FAILED` instead of
 * looping. Idempotent stages make the re-run safe.
 */
export async function recoverStale(orchestration: Orchestration): Promise<RecoveryReport> {
  const staleBefore = new Date(Date.now() - orchestration.staleAfterMs);
  const stale = await orchestration.experiments.findStale(
    ['QUEUED', ...orchestration.plan],
    staleBefore,
    RECOVERY_BATCH,
  );
  const report: RecoveryReport = { requeued: [], failed: [], skipped: [] };
  for (const experiment of stale) {
    const outcome = await recoverOne(orchestration, experiment, staleBefore);
    report[outcome].push(experiment.id);
  }
  if (stale.length > 0) orchestration.logger.info(report, 'stale recovery pass');
  return report;
}

async function recoverOne(
  orchestration: Orchestration,
  experiment: ExperimentRecord,
  staleBefore: Date,
): Promise<keyof RecoveryReport> {
  const firstStage = orchestration.plan[0];
  if (firstStage === undefined) throw new Error('the stage plan is empty');
  const stage: StageState | null =
    experiment.status === 'QUEUED'
      ? firstStage
      : isStageState(experiment.status)
        ? experiment.status
        : null;
  if (stage === null) return 'skipped';
  const logger = orchestration.logger.child({
    experimentId: experiment.id,
    stage,
    attempt: experiment.stageAttempt,
  });

  // The running attempt (BullMQ re-runs it itself if its worker died) or a scheduled retry.
  const candidates = new Set([Math.max(1, experiment.stageAttempt), experiment.stageAttempt + 1]);
  for (const attempt of candidates) {
    if (await isStagePending(orchestration.queue, experiment.id, stage, attempt)) {
      return 'skipped';
    }
  }

  const reclaimed = await orchestration.experiments.reclaimStale(
    experiment.id,
    { status: experiment.status, stageAttempt: experiment.stageAttempt },
    staleBefore,
  );
  if (!reclaimed) return 'skipped';

  if (experiment.status === 'QUEUED' || experiment.stageAttempt === 0) {
    logger.warn('recovered: stage was never started, re-queued');
    await enqueueStage(orchestration.queue, { experimentId: experiment.id, stage, attempt: 1 });
    return 'requeued';
  }

  const decision = decideFailure(
    'infrastructure-failure',
    experiment.stageAttempt,
    orchestration.retryPolicy,
  );
  if (decision.action === 'retry') {
    logger.warn({ nextAttempt: decision.nextAttempt }, 'recovered: worker stopped heartbeating');
    await enqueueStage(orchestration.queue, {
      experimentId: experiment.id,
      stage,
      attempt: decision.nextAttempt,
    });
    return 'requeued';
  }
  try {
    await orchestration.experiments.appendTransition(
      experiment.id,
      {
        type: 'fail',
        failureClass: 'infrastructure-failure',
        attemptsMade: experiment.stageAttempt,
        reason: `worker stopped heartbeating during ${stage}; retries exhausted`,
      },
      {
        expectedState: experiment.status,
        attempt: experiment.stageAttempt,
        retryPolicy: orchestration.retryPolicy,
      },
    );
    logger.error('recovered: retries exhausted, experiment failed');
    return 'failed';
  } catch (error) {
    if (error instanceof StaleExperimentState || error instanceof InvalidTransition) {
      return 'skipped';
    }
    throw error;
  }
}
