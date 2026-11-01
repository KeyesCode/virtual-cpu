import type { AgentProvider, Metric } from '@vcpu/research-core';
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

/**
 * One agent invocation. Null token counts and an unavailable cost mean unknown, never zero. The
 * run's outputs are the `Artifact` rows that point at it.
 */
@Entity({ name: 'agent_run' })
export class AgentRun {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'experiment_id', type: 'uuid' })
  experimentId!: string;

  @ManyToOne(() => Experiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment>;

  @Column({ type: 'text' })
  provider!: AgentProvider;

  @Column({ type: 'text' })
  model!: string;

  @Column({ name: 'prompt_version', type: 'text' })
  promptVersion!: string;

  /** Read back as a string, because `bigint` can exceed a JavaScript number. */
  @Column({ name: 'input_tokens', type: 'bigint', nullable: true })
  inputTokens!: string | null;

  /** Read back as a string, because `bigint` can exceed a JavaScript number. */
  @Column({ name: 'output_tokens', type: 'bigint', nullable: true })
  outputTokens!: string | null;

  @Column({ name: 'estimated_cost', type: 'jsonb' })
  estimatedCost!: Metric;

  @Column({ type: 'jsonb' })
  duration!: Metric;

  /** Null when the process was killed and left no exit code. */
  @Column({ name: 'exit_code', type: 'integer', nullable: true })
  exitCode!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
