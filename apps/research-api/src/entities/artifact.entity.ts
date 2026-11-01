import type { ArtifactKind } from '@vcpu/research-core';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  type Relation,
} from 'typeorm';
import { AgentRun } from './agent-run.entity.js';
import { Experiment } from './experiment.entity.js';
import { newId } from './new-id.js';

/** Metadata only: the bytes live in the artifact store, addressed by `contentHash`. */
@Entity({ name: 'artifact' })
export class Artifact {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  /** Null for what no single experiment owns, such as a baseline evaluation's reports. */
  @Column({ name: 'experiment_id', type: 'uuid', nullable: true })
  experimentId!: string | null;

  @ManyToOne(() => Experiment, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment> | null;

  /** Set on an agent's outputs: this is how an agent run references them. */
  @Column({ name: 'agent_run_id', type: 'uuid', nullable: true })
  agentRunId!: string | null;

  @ManyToOne(() => AgentRun, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'agent_run_id' })
  agentRun!: Relation<AgentRun> | null;

  @Column({ type: 'text' })
  kind!: ArtifactKind;

  @Column({ type: 'text' })
  name!: string;

  @Column({ name: 'content_hash', type: 'text' })
  contentHash!: string;

  /** Read back as a string, because `bigint` can exceed a JavaScript number. */
  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes!: string;

  @Column({ name: 'media_type', type: 'text' })
  mediaType!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
