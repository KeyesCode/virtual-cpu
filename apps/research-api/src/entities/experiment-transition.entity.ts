import type { ExperimentState, FailureClass } from '@vcpu/research-core';
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

/** One row per state change. `fromState` is null on an experiment's first row. */
@Entity({ name: 'experiment_transition' })
export class ExperimentTransition {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ name: 'experiment_id', type: 'uuid' })
  experimentId!: string;

  @ManyToOne(() => Experiment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'experiment_id' })
  experiment!: Relation<Experiment>;

  @Column({ name: 'from_state', type: 'text', nullable: true })
  fromState!: ExperimentState | null;

  @Column({ name: 'to_state', type: 'text' })
  toState!: ExperimentState;

  @Column({ name: 'failure_class', type: 'text', nullable: true })
  failureClass!: FailureClass | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  at!: Date;
}
