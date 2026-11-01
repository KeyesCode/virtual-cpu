import type { CampaignEventType } from '@vcpu/research-core';
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

/** The campaign's audit trail: budget stops, duplicate candidates, pauses and resumes. */
@Entity({ name: 'campaign_event' })
export class CampaignEvent {
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

  @Column({ type: 'text' })
  type!: CampaignEventType;

  @Column({ type: 'text' })
  actor!: string;

  @Column({ type: 'jsonb', default: {} })
  details!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  at!: Date;
}
