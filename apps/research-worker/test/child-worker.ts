// A research worker with the fixture handlers, run as its own process by the kill-and-resume test.
// Settings come from the environment, as `pnpm research:worker` reads them; the FIXTURE_* variables
// script the fixture.
import { STAGE_STATES, type StageState } from '@vcpu/research-core';
import { readWorkerConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createFixtureHandlers } from '../src/processors/fixture.js';
import { startWorker } from '../src/worker.js';

const env = process.env;
const slowStage = env['FIXTURE_SLOW_STAGE'] as StageState | undefined;
if (slowStage !== undefined && !(STAGE_STATES as readonly string[]).includes(slowStage)) {
  throw new Error(`FIXTURE_SLOW_STAGE: ${slowStage} is not a stage`);
}
const config = readWorkerConfig(env);
const { handlers } = createFixtureHandlers({
  delayMs: Number(env['FIXTURE_DELAY_MS'] ?? '50'),
  ...(env['FIXTURE_JOURNAL'] ? { journal: env['FIXTURE_JOURNAL'] } : {}),
  ...(slowStage
    ? { slowStage: { stage: slowStage, ms: Number(env['FIXTURE_SLOW_MS'] ?? '60000') } }
    : {}),
});
const worker = await startWorker(config, { handlers, logger: createLogger(config.logLevel) });
process.once('SIGTERM', () => {
  void worker.close().then(() => process.exit(0));
});
