import type { Metric, MetricTier, TimingConstraints } from '@vcpu/research-core';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { Artifact } from './artifact.entity.js';
import { Experiment } from './experiment.entity.js';
import { newId } from './new-id.js';

@Entity({ name: 'timing_result' })
export class TimingResult {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'experiment_id', type: 'uuid' })
  experimentId!: string;

  @ManyToOne(() => Experiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment>;

  @Column({ type: 'text' })
  tier!: MetricTier;

  @Column({ name: 'tool_version', type: 'text' })
  toolVersion!: string;

  @Column({ name: 'target_clock_period', type: 'jsonb' })
  targetClockPeriod!: Metric;

  @Column({ name: 'critical_path_delay', type: 'jsonb' })
  criticalPathDelay!: Metric;

  @Column({ name: 'worst_negative_slack', type: 'jsonb' })
  worstNegativeSlack!: Metric;

  @Column({ name: 'total_negative_slack', type: 'jsonb' })
  totalNegativeSlack!: Metric;

  @Column({ name: 'timing_constraints', type: 'jsonb' })
  timingConstraints!: TimingConstraints;

  @Column({ name: 'report_artifact_id', type: 'uuid', nullable: true })
  reportArtifactId!: string | null;

  @ManyToOne(() => Artifact, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'report_artifact_id' })
  reportArtifact!: Relation<Artifact> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
