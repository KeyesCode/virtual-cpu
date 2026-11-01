import type { VerificationSuite } from '@vcpu/research-core';
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

@Entity({ name: 'verification_result' })
export class VerificationResult {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'experiment_id', type: 'uuid' })
  experimentId!: string;

  @ManyToOne(() => Experiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment>;

  @Column({ name: 'test_suite', type: 'text' })
  testSuite!: VerificationSuite;

  @Column({ type: 'boolean' })
  passed!: boolean;

  @Column({ name: 'failed_test_count', type: 'integer' })
  failedTestCount!: number;

  @Column({ name: 'first_failure', type: 'text', nullable: true })
  firstFailure!: string | null;

  /** Read back as a string, because `bigint` can exceed a JavaScript number. */
  @Column({ name: 'random_seed', type: 'bigint', nullable: true })
  randomSeed!: string | null;

  @Column({ name: 'tool_version', type: 'text' })
  toolVersion!: string;

  @Column({ name: 'report_artifact_id', type: 'uuid', nullable: true })
  reportArtifactId!: string | null;

  @ManyToOne(() => Artifact, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'report_artifact_id' })
  reportArtifact!: Relation<Artifact> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
