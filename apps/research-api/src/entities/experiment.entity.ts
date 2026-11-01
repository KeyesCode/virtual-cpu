import type { AgentProvider, ExperimentState, FailureClass } from '@vcpu/research-core';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { DesignCandidate } from './design-candidate.entity.js';
import { newId } from './new-id.js';
import { ResearchCampaign } from './research-campaign.entity.js';

/**
 * One candidate's evaluation. `candidateId` stays null until generation produces the candidate;
 * `(candidateId, evaluationConfigHash)` is unique, so no evaluation runs twice.
 */
@Entity({ name: 'experiment' })
export class Experiment {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  @ManyToOne(() => ResearchCampaign, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'campaign_id' })
  campaign!: Relation<ResearchCampaign>;

  @Column({ name: 'parent_experiment_id', type: 'uuid', nullable: true })
  parentExperimentId!: string | null;

  @ManyToOne(() => Experiment, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'parent_experiment_id' })
  parentExperiment!: Relation<Experiment> | null;

  @Column({ name: 'candidate_id', type: 'uuid', nullable: true })
  candidateId!: string | null;

  @ManyToOne(() => DesignCandidate, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'candidate_id' })
  candidate!: Relation<DesignCandidate> | null;

  @Column({ name: 'evaluation_config_hash', type: 'text' })
  evaluationConfigHash!: string;

  @Column({ type: 'text', nullable: true })
  hypothesis!: string | null;

  /** Null for an experiment no agent generated, such as a deterministic fixture. */
  @Column({ name: 'agent_provider', type: 'text', nullable: true })
  agentProvider!: AgentProvider | null;

  @Column({ name: 'agent_model', type: 'text', nullable: true })
  agentModel!: string | null;

  @Column({ name: 'agent_config', type: 'jsonb', default: {} })
  agentConfig!: Record<string, unknown>;

  /** Read back as a string, because `bigint` can exceed a JavaScript number. */
  @Column({ type: 'bigint' })
  seed!: string;

  @Column({ type: 'text', default: 'CREATED' })
  status!: ExperimentState;

  @Column({ name: 'failure_class', type: 'text', nullable: true })
  failureClass!: FailureClass | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
