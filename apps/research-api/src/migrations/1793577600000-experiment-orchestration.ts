import type { MigrationInterface, QueryRunner } from 'typeorm';

// The columns the orchestration worker needs to survive crashes: who holds the current stage, when
// it last showed it was alive, and which attempt of the stage is running. A transition row records
// the attempt that caused it, so a retry history can be read back from the table.
const up = [
  `ALTER TABLE experiment
     ADD COLUMN stage_attempt integer NOT NULL DEFAULT 0,
     ADD COLUMN lease_owner text,
     ADD COLUMN heartbeat_at timestamptz,
     ADD CONSTRAINT ck_experiment_stage_attempt CHECK (stage_attempt >= 0)`,
  // Stale recovery searches live states by heartbeat age.
  `CREATE INDEX idx_experiment_status_heartbeat ON experiment (status, heartbeat_at)`,
  `ALTER TABLE experiment_transition
     ADD COLUMN attempt integer,
     ADD CONSTRAINT ck_transition_attempt CHECK (attempt > 0)`,
];

const down = [
  `ALTER TABLE experiment_transition
     DROP CONSTRAINT ck_transition_attempt,
     DROP COLUMN attempt`,
  `DROP INDEX idx_experiment_status_heartbeat`,
  `ALTER TABLE experiment
     DROP CONSTRAINT ck_experiment_stage_attempt,
     DROP COLUMN heartbeat_at,
     DROP COLUMN lease_owner,
     DROP COLUMN stage_attempt`,
];

export class ExperimentOrchestration1793577600000 implements MigrationInterface {
  name = 'ExperimentOrchestration1793577600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of up) await queryRunner.query(statement);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const statement of down) await queryRunner.query(statement);
  }
}
