// `pnpm research:worker`: the orchestration worker, on the host. It reads its settings from the
// environment or the repository's .env (REDIS_URL, DATABASE_URL, WORKER_CONCURRENCY,
// STAGE_TIMEOUTS_JSON, HEARTBEAT_MS, STALE_AFTER_MS and the rest in config.ts).
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Redis } from 'ioredis';
import { readWorkerConfig } from './config.js';
import { createLogger } from './logger.js';
import { createNoopHandlers } from './processors/handlers.js';
import { startWorker } from './worker.js';
import { stagesFor } from '@vcpu/research-core';

loadEnv({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const logger = createLogger(process.env['LOG_LEVEL'] ?? 'info');

/** Fail fast with a clear message rather than retrying forever against a Redis that is not there. */
async function checkRedis(url: string): Promise<void> {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await probe.connect();
    await probe.ping();
  } finally {
    probe.disconnect();
  }
}

/**
 * Exit non-zero when Redis stays unreachable after start, so a supervisor restarts the worker.
 * BullMQ itself would wait for it forever.
 */
function watchRedis(url: string, giveUpAfterMs: number): Redis {
  const watcher = new Redis(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => (times * 500 > giveUpAfterMs ? null : 500),
  });
  watcher.on('error', () => undefined);
  watcher.on('end', () => {
    logger.fatal({ redisUrl: url }, 'Redis is unreachable: exiting so the worker can be restarted');
    process.exit(1);
  });
  return watcher;
}

let config;
try {
  config = readWorkerConfig(process.env);
} catch (error) {
  logger.fatal({ err: error }, 'invalid worker configuration');
  process.exit(2);
}

try {
  await checkRedis(config.redisUrl);
} catch (error) {
  logger.fatal({ err: error, redisUrl: config.redisUrl }, 'cannot reach Redis');
  process.exit(1);
}

// The real EDA stage handlers arrive with the pipeline (VIRT-ZIH4RS). Until then every stage is a
// no-op, which exercises the orchestration but measures nothing.
logger.warn('no EDA stage handlers are installed yet: every stage is a no-op');
let worker;
try {
  worker = await startWorker(config, {
    handlers: createNoopHandlers(stagesFor(config.stagePlan)),
    logger,
  });
} catch (error) {
  logger.fatal({ err: error }, 'the research worker could not start');
  process.exit(1);
}
const watcher = watchRedis(config.redisUrl, 30_000);

const stop = (signal: string) => {
  logger.info({ signal }, 'shutdown requested');
  watcher.removeAllListeners('end');
  watcher.disconnect();
  worker.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    },
  );
};
process.once('SIGTERM', () => {
  stop('SIGTERM');
});
process.once('SIGINT', () => {
  stop('SIGINT');
});
