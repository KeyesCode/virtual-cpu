// The research repositories without NestJS: the worker imports this entry point
// (`@vcpu/research-api/repositories`) and builds them on a plain TypeORM DataSource.
import type { CampaignRepository, ExperimentRepository } from '@vcpu/research-core';
import type { DataSource } from 'typeorm';
import { TypeOrmCampaignRepository } from './typeorm-campaign-repository.js';
import { TypeOrmExperimentRepository } from './typeorm-experiment-repository.js';

export { createDataSource, dataSourceOptions, readDatabaseUrl } from '../data-source.js';
export { TypeOrmCampaignRepository, TypeOrmExperimentRepository };

export interface ResearchRepositories {
  readonly experiments: ExperimentRepository;
  readonly campaigns: CampaignRepository;
}

export function createRepositories(dataSource: DataSource): ResearchRepositories {
  return {
    experiments: new TypeOrmExperimentRepository(dataSource),
    campaigns: new TypeOrmCampaignRepository(dataSource),
  };
}
