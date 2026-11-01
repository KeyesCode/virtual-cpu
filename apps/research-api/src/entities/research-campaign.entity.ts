import type { CampaignConfig, CampaignObjective, CampaignStatus } from '@vcpu/research-core';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { Baseline } from './baseline.entity.js';
import { newId } from './new-id.js';
import { ResearchProject } from './research-project.entity.js';

/** A group of experiments against one fixed baseline. `numeric` columns read back as strings. */
@Entity({ name: 'research_campaign' })
export class ResearchCampaign {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @ManyToOne(() => ResearchProject, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'project_id' })
  project!: Relation<ResearchProject>;

  @Column({ name: 'baseline_id', type: 'uuid' })
  baselineId!: string;

  @ManyToOne(() => Baseline, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'baseline_id' })
  baseline!: Relation<Baseline>;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  objective!: CampaignObjective;

  @Column({ name: 'optimization_metric', type: 'text' })
  optimizationMetric!: string;

  @Column({ type: 'jsonb', default: {} })
  constraints!: Record<string, unknown>;

  /** The validated campaign file, including the budgets that have no column of their own. */
  @Column({ type: 'jsonb' })
  config!: CampaignConfig;

  @Column({ name: 'max_experiments', type: 'integer' })
  maxExperiments!: number;

  @Column({ name: 'max_concurrent_experiments', type: 'integer' })
  maxConcurrentExperiments!: number;

  @Column({ name: 'max_runtime', type: 'numeric' })
  maxRuntime!: string;

  @Column({ name: 'max_runtime_unit', type: 'text' })
  maxRuntimeUnit!: string;

  @Column({ name: 'max_compute_budget', type: 'numeric', nullable: true })
  maxComputeBudget!: string | null;

  @Column({ name: 'max_compute_budget_unit', type: 'text', nullable: true })
  maxComputeBudgetUnit!: string | null;

  @Column({ name: 'max_agent_budget', type: 'numeric', nullable: true })
  maxAgentBudget!: string | null;

  @Column({ name: 'max_agent_budget_unit', type: 'text', nullable: true })
  maxAgentBudgetUnit!: string | null;

  @Column({ type: 'text', default: 'CREATED' })
  status!: CampaignStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
