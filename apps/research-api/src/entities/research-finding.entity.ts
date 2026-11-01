import type { ConfidenceLevel, FindingType } from '@vcpu/research-core';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { Experiment } from './experiment.entity.js';
import { newId } from './new-id.js';
import { ResearchCampaign } from './research-campaign.entity.js';

@Entity({ name: 'research_finding' })
export class ResearchFinding {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId!: string;

  @ManyToOne(() => ResearchCampaign, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign!: Relation<ResearchCampaign>;

  @Column({ name: 'experiment_id', type: 'uuid', nullable: true })
  experimentId!: string | null;

  @ManyToOne(() => Experiment, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment> | null;

  @Column({ name: 'finding_type', type: 'text' })
  findingType!: FindingType;

  @Column({ type: 'text' })
  summary!: string;

  @Column({ name: 'supporting_metrics', type: 'jsonb', default: {} })
  supportingMetrics!: Record<string, unknown>;

  @Column({ name: 'confidence_level', type: 'text' })
  confidenceLevel!: ConfidenceLevel;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
