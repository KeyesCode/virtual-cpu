import type { Metric, MetricTier } from '@vcpu/research-core';
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

/**
 * One synthesis run. Counts are plain integers because they are not physical quantities; the
 * Tier 0 counts are null on a technology-mapped run, which does not report them.
 */
@Entity({ name: 'synthesis_result' })
export class SynthesisResult {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'experiment_id', type: 'uuid' })
  experimentId!: string;

  @ManyToOne(() => Experiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment>;

  @Column({ type: 'text' })
  tier!: MetricTier;

  @Column({ name: 'top_module', type: 'text' })
  topModule!: string;

  @Column({ name: 'tool_version', type: 'text' })
  toolVersion!: string;

  /** `generic` on a technology-independent run. */
  @Column({ name: 'target_library', type: 'text' })
  targetLibrary!: string;

  @Column({ name: 'cell_count', type: 'integer' })
  cellCount!: number;

  @Column({ name: 'flip_flop_count', type: 'integer' })
  flipFlopCount!: number;

  @Column({ name: 'multiplier_cell_count', type: 'integer', nullable: true })
  multiplierCellCount!: number | null;

  @Column({ name: 'abstract_gate_count', type: 'integer', nullable: true })
  abstractGateCount!: number | null;

  @Column({ name: 'logic_depth', type: 'integer', nullable: true })
  logicDepth!: number | null;

  @Column({ name: 'estimated_area', type: 'jsonb' })
  estimatedArea!: Metric;

  @Column({ type: 'jsonb', default: [] })
  warnings!: string[];

  @Column({ name: 'report_artifact_id', type: 'uuid', nullable: true })
  reportArtifactId!: string | null;

  @ManyToOne(() => Artifact, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'report_artifact_id' })
  reportArtifact!: Relation<Artifact> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
