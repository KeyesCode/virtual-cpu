import {
  InvalidTransition,
  LeaseLost,
  StaleExperimentState,
  decideFailure,
  isTerminal,
  nextState,
  stageIdempotencyKey,
  type CampaignRepository,
  type ExperimentEvent,
  type ExperimentRecord,
  type ExperimentRepository,
  type ExperimentState,
  type FailureClass,
  type RetryPolicy,
  type StageState,
} from '@vcpu/research-core';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Cancellation } from '../cancellation.js';
import { startHeartbeat } from '../heartbeat.js';
import { enqueueStage, type StageJobData } from '../queue.js';
import { StageFailure, type StageHandlers, type StageOutcome } from './handlers.js';

/** Everything the stage processor and the recovery job share. */
export interface Orchestration {
  readonly experiments: ExperimentRepository;
  readonly campaigns: CampaignRepository;
  readonly queue: Queue<StageJobData>;
  readonly cancellation: Cancellation;
  readonly handlers: StageHandlers;
  readonly plan: readonly StageState[];
  readonly workerId: string;
  readonly heartbeatMs: number;
  readonly staleAfterMs: number;
  readonly stageTimeoutsMs: Readonly<Partial<Record<StageState, number>>>;
  readonly defaultStageTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  readonly logger: Logger;
  /** The abort controller of each stage this process is running, by experiment id. */
  readonly running: Map<string, AbortController>;
}

/** Why a running stage was aborted. */
export class StageAbort extends Error {
  constructor(
    readonly kind: 'timeout' | 'cancel' | 'interrupt' | 'lease-lost',
    message: string,
  ) {
    super(message);
    this.name = 'StageAbort';
  }
}

type StageRun =
  | { readonly kind: 'ok' }
  | { readonly kind: 'failed'; readonly failureClass: FailureClass; readonly message: string }
  | { readonly kind: 'cancelled'; readonly reason: string }
  | { readonly kind: 'interrupted'; readonly reason: string }
  | { readonly kind: 'lease-lost' };

/**
 * Apply a transition, treating "the experiment moved on" (cancelled meanwhile, taken over, already
 * applied by an earlier run of this job) as a no-op rather than an error. Returns the experiment
 * after the move, or null when it did not happen.
 */
async function applyIfCurrent(
  orchestration: Orchestration,
  experimentId: string,
  event: ExperimentEvent,
  options: { expectedState: ExperimentState; attempt?: number; leaseOwner?: string },
  logger: Logger,
): Promise<ExperimentRecord | null> {
  try {
    const { experiment, row } = await orchestration.experiments.appendTransition(
      experimentId,
      event,
      {
        expectedState: options.expectedState,
        retryPolicy: orchestration.retryPolicy,
        ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
        ...(options.leaseOwner === undefined ? {} : { expectedLeaseOwner: options.leaseOwner }),
      },
    );
    logger.info(
      {
        from: row.fromState,
        to: row.toState,
        failureClass: row.failureClass,
        reason: row.reason,
        transitionId: row.id,
      },
      'transition',
    );
    return experiment;
  } catch (error) {
    if (
      error instanceof StaleExperimentState ||
      error instanceof LeaseLost ||
      error instanceof InvalidTransition
    ) {
      logger.warn({ event: event.type, err: error.message }, 'transition skipped: state moved on');
      return null;
    }
    throw error;
  }
}

/** Run one stage attempt under its timeout, heartbeat and cancellation. */
async function runStage(
  orchestration: Orchestration,
  experiment: ExperimentRecord,
  stage: StageState,
  attempt: number,
  logger: Logger,
): Promise<StageRun> {
  const handler = orchestration.handlers[stage];
  if (!handler) {
    return {
      kind: 'failed',
      failureClass: 'infrastructure-failure',
      message: `no ${stage} handler`,
    };
  }
  const timeoutMs = orchestration.stageTimeoutsMs[stage] ?? orchestration.defaultStageTimeoutMs;
  const controller = new AbortController();
  orchestration.running.set(experiment.id, controller);
  const timer = setTimeout(() => {
    controller.abort(new StageAbort('timeout', `${stage} ran past ${String(timeoutMs)} ms`));
  }, timeoutMs);
  const stopHeartbeat = startHeartbeat({
    experiments: orchestration.experiments,
    experimentId: experiment.id,
    owner: orchestration.workerId,
    intervalMs: orchestration.heartbeatMs,
    logger,
    onLost: () => {
      controller.abort(new StageAbort('lease-lost', 'another worker took the stage over'));
    },
  });
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(controller.signal.reason as Error);
      },
      { once: true },
    );
  });
  aborted.catch(() => undefined);

  try {
    // A cancel that arrived between the check before the claim and the subscription is still seen.
    const reason = await orchestration.cancellation.check(experiment.id);
    if (reason !== null) return { kind: 'cancelled', reason };

    const work = handler({
      experimentId: experiment.id,
      campaignId: experiment.campaignId,
      stage,
      attempt,
      idempotencyKey: stageIdempotencyKey(experiment.id, stage),
      signal: controller.signal,
      logger,
    });
    work.catch(() => undefined);
    const outcome: StageOutcome = await Promise.race([work, aborted]);
    if (controller.signal.aborted) return fromAbort(controller.signal.reason);
    return outcome.ok
      ? { kind: 'ok' }
      : { kind: 'failed', failureClass: outcome.failureClass, message: outcome.message };
  } catch (error) {
    if (controller.signal.aborted) return fromAbort(controller.signal.reason);
    if (error instanceof StageFailure) {
      return { kind: 'failed', failureClass: error.failureClass, message: error.message };
    }
    return {
      kind: 'failed',
      failureClass: 'infrastructure-failure',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    stopHeartbeat();
    orchestration.running.delete(experiment.id);
  }
}

function fromAbort(reason: unknown): StageRun {
  if (!(reason instanceof StageAbort)) {
    return { kind: 'interrupted', reason: 'aborted' };
  }
  switch (reason.kind) {
    case 'timeout':
      return { kind: 'failed', failureClass: 'timeout', message: reason.message };
    case 'cancel':
      return { kind: 'cancelled', reason: reason.message };
    case 'interrupt':
      return { kind: 'interrupted', reason: reason.message };
    case 'lease-lost':
      return { kind: 'lease-lost' };
  }
}

/**
 * Process one stage job. Safe to run more than once for the same job, and for stale duplicates:
 * it does nothing unless the experiment is still in the job's stage and this worker wins the lease.
 */
export async function processStageJob(
  orchestration: Orchestration,
  data: StageJobData,
): Promise<void> {
  const { experimentId, stage, attempt } = data;
  const logger = orchestration.logger.child({ experimentId, stage, attempt });
  let experiment = await orchestration.experiments.load(experimentId);
  if (!experiment) {
    logger.warn('job ignored: experiment does not exist');
    return;
  }
  if (isTerminal(experiment.status)) {
    logger.info({ status: experiment.status }, 'job ignored: experiment already finished');
    return;
  }

  // Between stages: a cancel flag or a cancelled campaign stops the experiment here.
  const cancelReason =
    (await orchestration.cancellation.check(experimentId)) ??
    (await campaignStopReason(orchestration.campaigns, experiment.campaignId));
  if (cancelReason !== null) {
    await applyIfCurrent(
      orchestration,
      experimentId,
      { type: 'cancel', reason: cancelReason },
      { expectedState: experiment.status },
      logger,
    );
    return;
  }

  if (experiment.status === 'QUEUED' && stage === orchestration.plan[0]) {
    experiment =
      (await applyIfCurrent(
        orchestration,
        experimentId,
        { type: 'start' },
        { expectedState: 'QUEUED' },
        logger,
      )) ?? (await orchestration.experiments.load(experimentId));
    if (!experiment) return;
  }
  if (experiment.status !== stage) {
    logger.info({ status: experiment.status }, 'job ignored: experiment is not in this stage');
    return;
  }

  const claimed = await orchestration.experiments.claim(experimentId, {
    stage,
    owner: orchestration.workerId,
    attempt,
    staleBefore: new Date(Date.now() - orchestration.staleAfterMs),
  });
  if (!claimed) {
    logger.info('job ignored: another worker holds the stage or a later attempt exists');
    return;
  }

  logger.info('stage started');
  const started = Date.now();
  const run = await runStage(orchestration, claimed, stage, attempt, logger);
  const wallTimeMs = Date.now() - started;
  const owner = orchestration.workerId;

  switch (run.kind) {
    case 'ok': {
      const next = nextState(orchestration.plan, stage);
      logger.info({ wallTimeMs, next }, 'stage succeeded');
      const advanced = await applyIfCurrent(
        orchestration,
        experimentId,
        { type: 'advance', to: next },
        { expectedState: stage, attempt, leaseOwner: owner },
        logger,
      );
      if (advanced && next !== 'COMPLETED') {
        await enqueueStage(orchestration.queue, { experimentId, stage: next, attempt: 1 });
      }
      return;
    }
    case 'cancelled':
      logger.info({ wallTimeMs, reason: run.reason }, 'stage cancelled');
      await applyIfCurrent(
        orchestration,
        experimentId,
        { type: 'cancel', reason: run.reason },
        { expectedState: stage, attempt },
        logger,
      );
      return;
    case 'lease-lost':
      logger.warn({ wallTimeMs }, 'stage result discarded: lease lost');
      return;
    case 'interrupted':
      logger.warn({ wallTimeMs, reason: run.reason }, 'stage interrupted');
      await settleFailure(orchestration, data, 'infrastructure-failure', run.reason, logger);
      return;
    case 'failed':
      logger.warn(
        { wallTimeMs, failureClass: run.failureClass, message: run.message },
        'stage failed',
      );
      await settleFailure(orchestration, data, run.failureClass, run.message, logger);
      return;
  }
}

/** Retry the stage, or end the experiment, as the retry policy decides for this class. */
async function settleFailure(
  orchestration: Orchestration,
  data: StageJobData,
  failureClass: FailureClass,
  message: string,
  logger: Logger,
): Promise<void> {
  const { experimentId, stage, attempt } = data;
  const owner = orchestration.workerId;
  const decision = decideFailure(failureClass, attempt, orchestration.retryPolicy);
  const options = { expectedState: stage, attempt, leaseOwner: owner };
  switch (decision.action) {
    case 'retry': {
      const released = await orchestration.experiments.releaseForRetry(
        experimentId,
        owner,
        attempt,
      );
      if (!released) {
        logger.warn('retry skipped: lease lost');
        return;
      }
      logger.info(
        { failureClass, nextAttempt: decision.nextAttempt, delayMs: decision.delayMs },
        'stage retry scheduled',
      );
      await enqueueStage(
        orchestration.queue,
        { experimentId, stage, attempt: decision.nextAttempt },
        decision.delayMs,
      );
      return;
    }
    case 'reject':
      await applyIfCurrent(
        orchestration,
        experimentId,
        { type: 'reject', failureClass: decision.failureClass, reason: message },
        options,
        logger,
      );
      return;
    case 'fail':
      await applyIfCurrent(
        orchestration,
        experimentId,
        {
          type: 'fail',
          failureClass: decision.failureClass,
          attemptsMade: attempt,
          reason: message,
        },
        options,
        logger,
      );
      return;
    case 'cancel':
      await applyIfCurrent(
        orchestration,
        experimentId,
        { type: 'budget-exceeded', reason: message },
        options,
        logger,
      );
      return;
  }
}

async function campaignStopReason(
  campaigns: CampaignRepository,
  campaignId: string,
): Promise<string | null> {
  const campaign = await campaigns.load(campaignId);
  return campaign?.status === 'CANCELLED' ? `campaign ${campaign.name} was cancelled` : null;
}
