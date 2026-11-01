import { resolve } from 'node:path';
import { config } from 'dotenv';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { researchEntities } from './entities/index.js';
import { InitialResearchSchema1793491200000 } from './migrations/1793491200000-initial-research-schema.js';

const repositoryEnvFile = resolve(import.meta.dirname, '../../../.env');

/** `DATABASE_URL` from the environment, or else from the `.env` at the repository root. */
export function readDatabaseUrl(): string {
  config({ path: repositoryEnvFile, quiet: true });
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set: export it or add it to .env');
  return url;
}

/**
 * `synchronize` stays off everywhere: the schema is exactly what the hand-written migrations say,
 * including the indexes, unique constraints and checks, which the entities do not repeat.
 */
export function dataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: researchEntities,
    migrations: [InitialResearchSchema1793491200000],
    migrationsTransactionMode: 'each',
    synchronize: false,
  };
}

export function createDataSource(url = readDatabaseUrl()): DataSource {
  return new DataSource(dataSourceOptions(url));
}
