import type { Metric } from '@vcpu/research-core';
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

/** Always an estimate: this project has no physical power measurements. */
@Entity({ name: 'power_result' })
export class PowerResult {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'experiment_id', type: 'uuid' })
  experimentId!: string;

  @ManyToOne(() => Experiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment>;

  @Column({ name: 'estimation_method', type: 'text' })
  estimationMethod!: string;

  @Column({ name: 'switching_activity_source', type: 'text' })
  switchingActivitySource!: string;

  @Column({ name: 'dynamic_power', type: 'jsonb' })
  dynamicPower!: Metric;

  @Column({ name: 'leakage_power', type: 'jsonb' })
  leakagePower!: Metric;

  @Column({ name: 'total_power', type: 'jsonb' })
  totalPower!: Metric;

  @Column({ name: 'limitation_notes', type: 'text', nullable: true })
  limitationNotes!: string | null;

  @Column({ name: 'report_artifact_id', type: 'uuid', nullable: true })
  reportArtifactId!: string | null;

  @ManyToOne(() => Artifact, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'report_artifact_id' })
  reportArtifact!: Relation<Artifact> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
