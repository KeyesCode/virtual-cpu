import type { CandidateDescriptor, CandidateValidationStatus } from '@vcpu/research-core';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  CreateDateColumn,
  type Relation,
} from 'typeorm';
import { Artifact } from './artifact.entity.js';
import { newId } from './new-id.js';

/** An immutable RTL candidate. `candidateHash` is unique: the same content is one candidate. */
@Entity({ name: 'design_candidate' })
export class DesignCandidate {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'candidate_hash', type: 'text' })
  candidateHash!: string;

  @Column({ name: 'source_commit', type: 'text', nullable: true })
  sourceCommit!: string | null;

  @Column({ name: 'parent_candidate_id', type: 'uuid', nullable: true })
  parentCandidateId!: string | null;

  @ManyToOne(() => DesignCandidate, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'parent_candidate_id' })
  parentCandidate!: Relation<DesignCandidate> | null;

  @Column({ name: 'changed_files', type: 'jsonb' })
  changedFiles!: CandidateDescriptor['changedFiles'];

  @Column({ name: 'patch_artifact_id', type: 'uuid', nullable: true })
  patchArtifactId!: string | null;

  @ManyToOne(() => Artifact, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'patch_artifact_id' })
  patchArtifact!: Relation<Artifact> | null;

  @Column({ name: 'architecture_parameters', type: 'jsonb', default: {} })
  architectureParameters!: CandidateDescriptor['architectureParameters'];

  @CreateDateColumn({ name: 'generated_at', type: 'timestamptz' })
  generatedAt!: Date;

  @Column({ name: 'validation_status', type: 'text', default: 'pending' })
  validationStatus!: CandidateValidationStatus;
}
