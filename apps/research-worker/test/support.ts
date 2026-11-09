import 'reflect-metadata';
import { DEFAULT_RETRY_POLICY, type RetryPolicy, type StagePlanConfig } from '@vcpu/research-core';
import { createDataSource } from '@vcpu/research-api/repositories';
import { Redis } from 'ioredis';
import { v7 } from 'uuid';
import type { WorkerConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { DataSource } from '../src/worker.js';

export const databaseUrl = process.env['DATABASE_URL'];
export const redisUrl = process.env['REDIS_URL'];
export const integration = Boolean(databaseUrl && redisUrl);
if (!integration) {
  process.stderr.write(
    'Skipping the research worker integration tests: DATABASE_URL and REDIS_URL must both be set.\n',
  );
}

/** Quiet unless a test run asks for the worker's logs. */
export const testLogger = createLogger(process.env['WORKER_TEST_LOG_LEVEL'] ?? 'silent');

/** The six-stage plan of the kill-and-resume check: no generation, no Tier 2. */
export const SIX_STAGES: StagePlanConfig = { generation: false, physicalAnalysis: false };

/** Small backoffs, the default caps. */
export const FAST_RETRY_POLICY: RetryPolicy = {
  ...DEFAULT_RETRY_POLICY,
  'tool-failure': { retryable: true, maxAttempts: 3, backoff: { delayMs: 50, maxDelayMs: 200 } },
  timeout: { retryable: true, maxAttempts: 2, backoff: { delayMs: 50, maxDelayMs: 200 } },
  'infrastructure-failure': {
    retryable: true,
    maxAttempts: 5,
    backoff: { delayMs: 50, maxDelayMs: 200 },
  },
};

/** A database schema of its own for one test file, migrated, and dropped afterwards. */
export interface TestDatabase {
  /** `DATABASE_URL` with the schema on the search path, for child processes. */
  readonly url: string;
  readonly dataSource: DataSource;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `worker_test_${v7().replaceAll('-', '')}`;
  const url = new URL(databaseUrl ?? '');
  url.searchParams.set('options', `-c search_path=${schema}`);
  const dataSource = createDataSource(url.href);
  await dataSource.initialize();
  await dataSource.query(`CREATE SCHEMA ${schema}`);
  await dataSource.runMigrations();
  return {
    url: url.href,
    dataSource,
    drop: async () => {
      await dataSource.query(`DROP SCHEMA ${schema} CASCADE`);
      await dataSource.destroy();
    },
  };
}

/** A queue prefix of its own, so tests never see each other's jobs. */
export function newQueuePrefix(): string {
  return `test-${v7().slice(-12)}`;
}

/** Delete every Redis key under the prefix. */
export async function dropQueuePrefix(prefix: string): Promise<void> {
  const redis = new Redis(redisUrl ?? '');
  try {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  } finally {
    await redis.quit();
  }
}

export function testConfig(
  databaseUrlForWorker: string,
  overrides: Partial<WorkerConfig> = {},
): WorkerConfig {
  return {
    redisUrl: redisUrl ?? '',
    databaseUrl: databaseUrlForWorker,
    concurrency: 2,
    stageTimeoutsMs: {},
    defaultStageTimeoutMs: 20_000,
    heartbeatMs: 200,
    staleAfterMs: 2_000,
    recoveryIntervalMs: 60_000,
    shutdownTimeoutMs: 2_000,
    queuePrefix: newQueuePrefix(),
    stagePlan: SIX_STAGES,
    retryPolicy: FAST_RETRY_POLICY,
    workerId: `test-worker-${v7().slice(-12)}`,
    logLevel: 'silent',
    ...overrides,
  };
}

/** A project, a baseline and a campaign to hang experiments on. Returns the campaign id. */
export async function seedCampaign(dataSource: DataSource): Promise<string> {
  const projectId = v7();
  const baselineId = v7();
  const campaignId = v7();
  await dataSource.query(
    `INSERT INTO research_project (id, name, description, architecture_type, source_repository,
       baseline_commit, interface_spec_version)
     VALUES ($1, $2, 'test', 'mac-processing-element', 'github.com/KeyesCode/virtual-cpu', $3,
       'matmul-os-r1')`,
    [projectId, `project-${projectId}`, '1'.repeat(40)],
  );
  await dataSource.query(
    `INSERT INTO baseline (id, project_id, name, source_commit, source_content_hash, parameters,
       verification_suite_version, synthesis_config, timing_constraints, target_technology,
       tool_versions)
     VALUES ($1, $2, 'verified-baseline-v1', $3, $4, '{}', 'matmul-os-r1', '{}', '{}',
       'sky130_fd_sc_hd__tt_025C_1v80', '{}')`,
    [baselineId, projectId, '1'.repeat(40), 'a'.repeat(64)],
  );
  await dataSource.query(
    `INSERT INTO research_campaign (id, project_id, baseline_id, name, objective,
       optimization_metric, config, max_experiments, max_concurrent_experiments, max_runtime,
       max_runtime_unit)
     VALUES ($1, $2, $3, 'Campaign test', 'minimize-area-delay-product', 'area-delay-product',
       '{}', 100, 2, 24, 'h')`,
    [campaignId, projectId, baselineId],
  );
  return campaignId;
}

/** A `CREATED` experiment with its first transition row (none → `CREATED`). */
export async function seedExperiment(dataSource: DataSource, campaignId: string): Promise<string> {
  const id = v7();
  await dataSource.query(
    `INSERT INTO experiment (id, campaign_id, evaluation_config_hash, seed)
     VALUES ($1, $2, $3, 1)`,
    [id, campaignId, 'e'.repeat(64)],
  );
  await dataSource.query(
    `INSERT INTO experiment_transition (id, experiment_id, from_state, to_state)
     VALUES ($1, $2, NULL, 'CREATED')`,
    [v7(), id],
  );
  return id;
}

/** Poll until `check` returns a value other than undefined, or fail after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 20_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
