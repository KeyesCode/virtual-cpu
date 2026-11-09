import { hostname } from 'node:os';
import {
  DEFAULT_RETRY_POLICY,
  OPTIONAL_STAGES,
  STAGE_STATES,
  type RetryPolicy,
  type StagePlanConfig,
  type StageState,
} from '@vcpu/research-core';
import { v7 } from 'uuid';
import { z } from 'zod';

export interface WorkerConfig {
  readonly redisUrl: string;
  readonly databaseUrl: string;
  /** Stages one worker process runs at once. */
  readonly concurrency: number;
  /** Per-stage wall-clock limits; a stage without one gets `defaultStageTimeoutMs`. */
  readonly stageTimeoutsMs: Readonly<Partial<Record<StageState, number>>>;
  readonly defaultStageTimeoutMs: number;
  /** How often a running stage refreshes its heartbeat. */
  readonly heartbeatMs: number;
  /** A live experiment whose heartbeat is older than this is stale and gets recovered. */
  readonly staleAfterMs: number;
  /** How often the `stale-recovery` job runs. */
  readonly recoveryIntervalMs: number;
  /** How long shutdown waits for running stages before interrupting them. */
  readonly shutdownTimeoutMs: number;
  /** The namespace of every Redis key: queues, cancellation flags and the cancel channel. */
  readonly queuePrefix: string;
  readonly stagePlan: StagePlanConfig;
  readonly retryPolicy: RetryPolicy;
  /** Names this process in leases and logs. */
  readonly workerId: string;
  readonly logLevel: string;
}

const integer = (min: number) => z.coerce.number().int().min(min);

const EnvSchema = z.object({
  REDIS_URL: z.string().min(1, 'REDIS_URL is not set: export it or add it to .env'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is not set: export it or add it to .env'),
  WORKER_CONCURRENCY: integer(1).default(2),
  STAGE_TIMEOUTS_JSON: z.string().default('{}'),
  STAGE_TIMEOUT_MS: integer(1).default(30 * 60_000),
  HEARTBEAT_MS: integer(100).default(5_000),
  STALE_AFTER_MS: integer(200).default(60_000),
  RECOVERY_INTERVAL_MS: integer(100).default(30_000),
  SHUTDOWN_TIMEOUT_MS: integer(0).default(30_000),
  RESEARCH_QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'RESEARCH_QUEUE_PREFIX must be lowercase letters, digits and dashes')
    .default('research'),
  WORKER_SKIP_STAGES: z.string().default(''),
  WORKER_ID: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

const StageTimeoutsSchema = z.partialRecord(z.enum(STAGE_STATES), z.number().int().positive());

/** Read and check the worker's configuration from environment variables. */
export function readWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = EnvSchema.parse(env);
  let timeouts: unknown;
  try {
    timeouts = JSON.parse(parsed.STAGE_TIMEOUTS_JSON);
  } catch {
    throw new Error('STAGE_TIMEOUTS_JSON is not valid JSON');
  }
  const skipped = parsed.WORKER_SKIP_STAGES.split(',')
    .map((stage) => stage.trim())
    .filter((stage) => stage !== '');
  for (const stage of skipped) {
    if (!(OPTIONAL_STAGES as readonly string[]).includes(stage)) {
      throw new Error(`WORKER_SKIP_STAGES: ${stage} is not an optional stage`);
    }
  }
  return checkWorkerConfig({
    redisUrl: parsed.REDIS_URL,
    databaseUrl: parsed.DATABASE_URL,
    concurrency: parsed.WORKER_CONCURRENCY,
    stageTimeoutsMs: StageTimeoutsSchema.parse(timeouts),
    defaultStageTimeoutMs: parsed.STAGE_TIMEOUT_MS,
    heartbeatMs: parsed.HEARTBEAT_MS,
    staleAfterMs: parsed.STALE_AFTER_MS,
    recoveryIntervalMs: parsed.RECOVERY_INTERVAL_MS,
    shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
    queuePrefix: parsed.RESEARCH_QUEUE_PREFIX,
    stagePlan: {
      generation: !skipped.includes('GENERATING'),
      physicalAnalysis: !skipped.includes('PHYSICAL_ANALYSIS'),
    },
    retryPolicy: DEFAULT_RETRY_POLICY,
    workerId: parsed.WORKER_ID ?? newWorkerId(),
    logLevel: parsed.LOG_LEVEL,
  });
}

export function newWorkerId(): string {
  return `${hostname()}:${String(process.pid)}:${v7().slice(-12)}`;
}

/** Refuse settings under which a healthy stage would look stale. */
export function checkWorkerConfig(config: WorkerConfig): WorkerConfig {
  if (config.staleAfterMs < 2 * config.heartbeatMs) {
    throw new Error(
      `STALE_AFTER_MS (${String(config.staleAfterMs)}) must be at least twice HEARTBEAT_MS (${String(config.heartbeatMs)})`,
    );
  }
  return config;
}
