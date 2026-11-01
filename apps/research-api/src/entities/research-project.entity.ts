import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { newId } from './new-id.js';

/** A hardware research target. */
@Entity({ name: 'research_project' })
export class ResearchProject {
  @PrimaryColumn({ type: 'uuid' })
  id = newId();

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ name: 'architecture_type', type: 'text' })
  architectureType!: string;

  @Column({ name: 'source_repository', type: 'text' })
  sourceRepository!: string;

  @Column({ name: 'baseline_commit', type: 'text' })
  baselineCommit!: string;

  @Column({ name: 'interface_spec_version', type: 'text' })
  interfaceSpecVersion!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
