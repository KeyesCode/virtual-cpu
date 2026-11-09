import { stageJobId, type StageState } from '@vcpu/research-core';
import { Queue, type ConnectionOptions } from 'bullmq';

/** The queue every stage job goes to: one job per attempt of one stage of one experiment. */
export const EXPERIMENTS_QUEUE = 'experiments';
/** The queue of the `stale-recovery` job scheduler, apart so stage jobs never delay it. */
export const RECOVERY_QUEUE = 'experiments-recovery';
export const STALE_RECOVERY_JOB = 'stale-recovery';

export interface StageJobData {
  readonly experimentId: string;
  readonly stage: StageState;
  readonly attempt: number;
}

/** Redis connection options BullMQ needs for blocking commands. */
export function bullConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

export function createExperimentsQueue(redisUrl: string, prefix: string): Queue<StageJobData> {
  return new Queue<StageJobData>(EXPERIMENTS_QUEUE, {
    connection: bullConnection(redisUrl),
    prefix,
  });
}

/**
 * The BullMQ-level retry is only a safety net for the orchestration itself (Postgres unreachable
 * while a result is persisted): the processor is idempotent, so running it again is safe. Stage
 * failures are retried by `decideFailure`, which enqueues a new attempt with its own job id.
 */
const ORCHESTRATION_ATTEMPTS = 3;
const ORCHESTRATION_BACKOFF_MS = 1_000;

/**
 * Add one stage attempt. The job id is `<experimentId>:<stage>:<attempt>`, so adding the same
 * attempt twice is a no-op while the first is still queued.
 */
export async function enqueueStage(
  queue: Queue<StageJobData>,
  data: StageJobData,
  delayMs = 0,
): Promise<void> {
  await queue.add(data.stage, data, {
    jobId: stageJobId(data.experimentId, data.stage, data.attempt),
    delay: delayMs,
    attempts: ORCHESTRATION_ATTEMPTS,
    backoff: { type: 'exponential', delay: ORCHESTRATION_BACKOFF_MS },
    // A finished job is gone, so a later attempt or a recovery can reuse nothing by accident; the
    // history lives in experiment_transition and the logs.
    removeOnComplete: true,
    removeOnFail: true,
  });
}

const PENDING_STATES = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

/** Whether the queue still holds this stage attempt, waiting, delayed or running. */
export async function isStagePending(
  queue: Queue<StageJobData>,
  experimentId: string,
  stage: StageState,
  attempt: number,
): Promise<boolean> {
  const job = await queue.getJob(stageJobId(experimentId, stage, attempt));
  if (!job) return false;
  return PENDING_STATES.has(await job.getState());
}
