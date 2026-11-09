import 'reflect-metadata';
import {
  InvalidTransition,
  StaleExperimentState,
  isTerminal,
  stagesFor,
  type ExperimentRecord,
  type ExperimentRepository,
  type StageState,
} from '@vcpu/research-core';
import { createDataSource, createRepositories } from '@vcpu/research-api/repositories';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { Cancellation } from './cancellation.js';
import type { WorkerConfig } from './config.js';
import { createLogger } from './logger.js';
import type { StageHandlers } from './processors/handlers.js';
import { StageAbort, processStageJob, type Orchestration } from './processors/stage.js';
import {
  EXPERIMENTS_QUEUE,
  RECOVERY_QUEUE,
  STALE_RECOVERY_JOB,
  bullConnection,
  createExperimentsQueue,
  enqueueStage,
  type StageJobData,
} from './queue.js';
import { recoverStale, type RecoveryReport } from './recovery.js';

/** The research-api TypeORM data source (typed through it, so the worker shares its TypeORM). */
export type DataSource = ReturnType<typeof createDataSource>;

export interface WorkerDependencies {
  readonly handlers: StageHandlers;
  readonly logger?: Logger;
  /** An initialised data source to use instead of opening one from `config.databaseUrl`. */
  readonly dataSource?: DataSource;
}

export interface WorkerHandle {
  readonly workerId: string;
  readonly plan: readonly StageState[];
  readonly experiments: ExperimentRepository;
  /** Move a `CREATED` experiment to `QUEUED` and queue its first stage. */
  enqueueExperiment(experimentId: string): Promise<ExperimentRecord>;
  /** Cancel an experiment: see `cancelExperiment`. */
  cancelExperiment(experimentId: string, reason: string): Promise<ExperimentRecord>;
  /** Run one stale-recovery pass now (the scheduler runs it every `recoveryIntervalMs`). */
  recoverStale(): Promise<RecoveryReport>;
  /** Stop taking jobs, let running stages finish (or interrupt them after the shutdown timeout). */
  close(): Promise<void>;
}

/**
 * Start the orchestration worker: one BullMQ worker on the `experiments` queue running up to
 * `concurrency` stages at once, a `stale-recovery` job scheduler on its own queue, and the cancel
 * channel subscription.
 */
export async function startWorker(
  config: WorkerConfig,
  dependencies: WorkerDependencies,
): Promise<WorkerHandle> {
  const logger = (dependencies.logger ?? createLogger(config.logLevel)).child({
    workerId: config.workerId,
  });
  const plan = stagesFor(config.stagePlan);
  const missing = plan.filter((stage) => !dependencies.handlers[stage]);
  if (missing.length > 0) throw new Error(`no handler for stage(s): ${missing.join(', ')}`);

  const ownsDataSource = !dependencies.dataSource;
  const dataSource = dependencies.dataSource ?? createDataSource(config.databaseUrl);
  if (!dataSource.isInitialized) await dataSource.initialize();
  const { experiments, campaigns } = createRepositories(dataSource);

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const subscriber = redis.duplicate();
  const cancellation = new Cancellation(redis, config.queuePrefix);
  const queue = createExperimentsQueue(config.redisUrl, config.queuePrefix);

  const orchestration: Orchestration = {
    experiments,
    campaigns,
    queue,
    cancellation,
    handlers: dependencies.handlers,
    plan,
    workerId: config.workerId,
    heartbeatMs: config.heartbeatMs,
    staleAfterMs: config.staleAfterMs,
    stageTimeoutsMs: config.stageTimeoutsMs,
    defaultStageTimeoutMs: config.defaultStageTimeoutMs,
    retryPolicy: config.retryPolicy,
    logger,
    running: new Map(),
  };

  const stopListening = await cancellation.listen(subscriber, (experimentId, reason) => {
    const controller = orchestration.running.get(experimentId);
    if (!controller) return;
    logger.info({ experimentId, reason }, 'cancel message: aborting the running stage');
    controller.abort(new StageAbort('cancel', reason));
  });

  const worker = new Worker<StageJobData>(
    EXPERIMENTS_QUEUE,
    async (job) => {
      await processStageJob(orchestration, job.data);
    },
    {
      connection: bullConnection(config.redisUrl),
      prefix: config.queuePrefix,
      concurrency: config.concurrency,
      // The queue lock and the heartbeat agree on when a worker is dead.
      lockDuration: config.staleAfterMs,
      stalledInterval: Math.max(1_000, Math.floor(config.staleAfterMs / 2)),
      maxStalledCount: 2,
    },
  );
  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, ...job?.data, attemptsMade: job?.attemptsMade, err: error },
      'stage job failed in the orchestrator',
    );
  });
  worker.on('error', (error) => {
    logger.error({ err: error }, 'worker error');
  });

  const recoveryQueue = new Queue(RECOVERY_QUEUE, {
    connection: bullConnection(config.redisUrl),
    prefix: config.queuePrefix,
  });
  await recoveryQueue.upsertJobScheduler(
    STALE_RECOVERY_JOB,
    { every: config.recoveryIntervalMs },
    { name: STALE_RECOVERY_JOB, opts: { removeOnComplete: true, removeOnFail: 100 } },
  );
  const recoveryWorker = new Worker(
    RECOVERY_QUEUE,
    async () => {
      await recoverStale(orchestration);
    },
    { connection: bullConnection(config.redisUrl), prefix: config.queuePrefix, concurrency: 1 },
  );
  recoveryWorker.on('failed', (_job, error) => {
    logger.error({ err: error }, 'stale recovery failed');
  });

  await Promise.all([worker.waitUntilReady(), recoveryWorker.waitUntilReady()]);
  logger.info(
    {
      concurrency: config.concurrency,
      plan,
      heartbeatMs: config.heartbeatMs,
      staleAfterMs: config.staleAfterMs,
      recoveryIntervalMs: config.recoveryIntervalMs,
      queuePrefix: config.queuePrefix,
    },
    'research worker started',
  );

  let closing: Promise<void> | null = null;
  const close = async () => {
    logger.info({ running: orchestration.running.size }, 'research worker stopping');
    await recoveryWorker.close();
    const interrupt = setTimeout(() => {
      for (const controller of orchestration.running.values()) {
        controller.abort(new StageAbort('interrupt', 'the worker is shutting down'));
      }
    }, config.shutdownTimeoutMs);
    await worker.close();
    clearTimeout(interrupt);
    await stopListening();
    await Promise.all([queue.close(), recoveryQueue.close()]);
    subscriber.disconnect();
    await redis.quit();
    if (ownsDataSource) await dataSource.destroy();
    logger.info('research worker stopped');
  };

  return {
    workerId: config.workerId,
    plan,
    experiments,
    enqueueExperiment: (experimentId) =>
      enqueueExperiment({ experiments, queue, logger, plan }, experimentId),
    cancelExperiment: (experimentId, reason) =>
      cancelExperiment({ experiments, cancellation, logger }, experimentId, reason, {
        staleAfterMs: config.staleAfterMs,
      }),
    recoverStale: () => recoverStale(orchestration),
    close: () => (closing ??= close()),
  };
}

/** Move a `CREATED` experiment to `QUEUED` and add its first stage job. Safe to repeat. */
export async function enqueueExperiment(
  context: {
    experiments: ExperimentRepository;
    queue: Queue<StageJobData>;
    logger: Logger;
    plan: readonly StageState[];
  },
  experimentId: string,
): Promise<ExperimentRecord> {
  const first = context.plan[0];
  if (first === undefined) throw new Error('the stage plan is empty');
  let experiment = await context.experiments.load(experimentId);
  if (!experiment) throw new Error(`experiment ${experimentId} does not exist`);
  if (experiment.status === 'CREATED') {
    try {
      experiment = (
        await context.experiments.appendTransition(
          experimentId,
          { type: 'enqueue' },
          { expectedState: 'CREATED' },
        )
      ).experiment;
    } catch (error) {
      if (!(error instanceof StaleExperimentState)) throw error;
      experiment = (await context.experiments.load(experimentId)) ?? experiment;
    }
  }
  if (experiment.status !== 'QUEUED') {
    throw new Error(`experiment ${experimentId} is ${experiment.status}, not CREATED or QUEUED`);
  }
  await enqueueStage(context.queue, { experimentId, stage: first, attempt: 1 });
  context.logger.info({ experimentId }, 'experiment queued');
  return experiment;
}

/**
 * Cancel an experiment. The flag and the cancel message go out first: a worker running a stage of
 * it aborts that stage (killing its command) and records the cancellation, and one about to start
 * a stage sees the flag. If no live worker holds it (not started, between stages, or its worker
 * died), the cancellation is recorded here directly. A cancel after a terminal state is ignored and
 * logged.
 */
export async function cancelExperiment(
  context: { experiments: ExperimentRepository; cancellation: Cancellation; logger: Logger },
  experimentId: string,
  reason: string,
  options: { staleAfterMs: number },
): Promise<ExperimentRecord> {
  const logger = context.logger.child({ experimentId });
  const experiment = await context.experiments.load(experimentId);
  if (!experiment) throw new Error(`experiment ${experimentId} does not exist`);
  if (isTerminal(experiment.status)) {
    logger.info(
      { status: experiment.status, reason },
      'cancel ignored: experiment already finished',
    );
    return experiment;
  }
  await context.cancellation.request(experimentId, reason);
  const heldLive =
    experiment.leaseOwner !== null &&
    experiment.heartbeatAt !== null &&
    Date.now() - experiment.heartbeatAt.getTime() < options.staleAfterMs;
  if (heldLive) {
    logger.info(
      { reason, holder: experiment.leaseOwner },
      'cancel requested from the running worker',
    );
    return experiment;
  }
  try {
    const { experiment: cancelled } = await context.experiments.appendTransition(
      experimentId,
      { type: 'cancel', reason },
      { expectedState: experiment.status },
    );
    logger.info({ reason, from: experiment.status }, 'experiment cancelled');
    return cancelled;
  } catch (error) {
    if (error instanceof StaleExperimentState || error instanceof InvalidTransition) {
      // It moved on meanwhile; the flag still stops it before its next stage.
      return (await context.experiments.load(experimentId)) ?? experiment;
    }
    throw error;
  }
}
