import type { BaselineManifest, MetricMap } from '@vcpu/research-core';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { newId } from './new-id.js';
import { ResearchProject } from './research-project.entity.js';

/**
 * A frozen hardware baseline. The `baseline_immutable` trigger refuses every update except filling
 * `metrics` before `metricsFrozenAt` is set, so everything else is decided before the insert.
 */
@Entity({ name: 'baseline' })
export class Baseline {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @ManyToOne(() => ResearchProject, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'project_id' })
  project!: Relation<ResearchProject>;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'source_commit', type: 'text' })
  sourceCommit!: string;

  @Column({ name: 'source_content_hash', type: 'text' })
  sourceContentHash!: string;

  @Column({ type: 'jsonb' })
  parameters!: BaselineManifest['parameters'];

  @Column({ name: 'verification_suite_version', type: 'text' })
  verificationSuiteVersion!: string;

  @Column({ name: 'synthesis_config', type: 'jsonb' })
  synthesisConfig!: BaselineManifest['synthesisConfig'];

  @Column({ name: 'timing_constraints', type: 'jsonb' })
  timingConstraints!: BaselineManifest['timingConstraints'];

  @Column({ name: 'target_technology', type: 'text' })
  targetTechnology!: string;

  @Column({ name: 'tool_versions', type: 'jsonb' })
  toolVersions!: BaselineManifest['toolVersions'];

  @Column({ type: 'jsonb', default: {} })
  metrics!: MetricMap;

  @Column({ name: 'metrics_frozen_at', type: 'timestamptz', nullable: true })
  metricsFrozenAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
