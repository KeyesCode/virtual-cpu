import type { MigrationInterface, QueryRunner } from 'typeorm';

// The value lists are literals on purpose: a migration records the schema as it was on the day it
// ran, so it must not change when the enums in @vcpu/research-core do.
const EXPERIMENT_STATES = `'CREATED', 'QUEUED', 'PREPARING', 'GENERATING', 'STATIC_VALIDATION',
  'COMPILING', 'VERIFYING', 'SYNTHESIZING', 'PHYSICAL_ANALYSIS', 'SCORING', 'COMPLETED',
  'REJECTED', 'FAILED', 'CANCELLED'`;
const FAILURE_CLASSES = `'incorrect-design', 'unsupported-design', 'tool-failure', 'timeout',
  'infrastructure-failure', 'budget-exceeded', 'policy-violation'`;
const AGENT_PROVIDERS = `'claude-code', 'codex'`;
const METRIC_TIERS = `'technology-independent', 'technology-mapped', 'physical'`;
const SHA256 = `'^[0-9a-f]{64}$'`;

const up = [
  // A metric is a number with a unit and a provenance, or it is unavailable with a reason and has
  // no number at all. COALESCE matters: a CHECK passes on NULL, and a missing key yields NULL.
  `CREATE FUNCTION research_metric_valid(m jsonb) RETURNS boolean
     LANGUAGE sql IMMUTABLE AS $$
       SELECT COALESCE(
         jsonb_typeof(m) = 'object' AND CASE
           WHEN m->>'provenance' = 'unavailable' THEN
             NOT m ? 'value' AND NOT m ? 'unit'
             AND jsonb_typeof(m->'reason') = 'string' AND length(m->>'reason') > 0
           WHEN m->>'provenance' IN ('measured', 'estimated', 'theoretical') THEN
             jsonb_typeof(m->'value') = 'number'
             AND jsonb_typeof(m->'unit') = 'string' AND length(m->>'unit') > 0
           ELSE false
         END,
         false)
     $$`,

  `CREATE FUNCTION research_metric_map_valid(metrics jsonb) RETURNS boolean
     LANGUAGE sql IMMUTABLE AS $$
       SELECT jsonb_typeof(metrics) = 'object'
         AND COALESCE(
           (SELECT bool_and(research_metric_valid(entry.value))
              FROM jsonb_each(metrics) AS entry),
           true)
     $$`,

  // Only `metrics` may change, and only until `metrics_frozen_at` is set. Comparing whole rows
  // means a column added later is immutable without touching this function.
  `CREATE FUNCTION baseline_immutable() RETURNS trigger
     LANGUAGE plpgsql AS $$
       BEGIN
         IF OLD.metrics_frozen_at IS NOT NULL THEN
           RAISE EXCEPTION 'baseline % is frozen and cannot be updated', OLD.id
             USING ERRCODE = 'integrity_constraint_violation';
         END IF;
         IF (to_jsonb(NEW) - 'metrics' - 'metrics_frozen_at')
            IS DISTINCT FROM (to_jsonb(OLD) - 'metrics' - 'metrics_frozen_at') THEN
           RAISE EXCEPTION 'baseline % is immutable: only metrics can be set, once', OLD.id
             USING ERRCODE = 'integrity_constraint_violation';
         END IF;
         RETURN NEW;
       END
     $$`,

  `CREATE TABLE research_project (
     id uuid PRIMARY KEY,
     name text NOT NULL,
     description text NOT NULL,
     architecture_type text NOT NULL,
     source_repository text NOT NULL,
     baseline_commit text NOT NULL,
     interface_spec_version text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT uq_research_project_name UNIQUE (name)
   )`,

  `CREATE TABLE baseline (
     id uuid PRIMARY KEY,
     project_id uuid NOT NULL
       CONSTRAINT fk_baseline_project REFERENCES research_project (id) ON DELETE RESTRICT,
     name text NOT NULL,
     source_commit text NOT NULL,
     source_content_hash text NOT NULL,
     parameters jsonb NOT NULL,
     verification_suite_version text NOT NULL,
     synthesis_config jsonb NOT NULL,
     timing_constraints jsonb NOT NULL,
     target_technology text NOT NULL,
     tool_versions jsonb NOT NULL,
     metrics jsonb NOT NULL DEFAULT '{}',
     metrics_frozen_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT uq_baseline_project_name UNIQUE (project_id, name),
     CONSTRAINT ck_baseline_source_content_hash CHECK (source_content_hash ~ ${SHA256}),
     CONSTRAINT ck_baseline_metrics CHECK (research_metric_map_valid(metrics)),
     CONSTRAINT ck_baseline_frozen_has_metrics
       CHECK (metrics_frozen_at IS NULL OR metrics <> '{}'::jsonb)
   )`,

  `CREATE TRIGGER baseline_immutable BEFORE UPDATE ON baseline
     FOR EACH ROW EXECUTE FUNCTION baseline_immutable()`,

  `CREATE TABLE research_campaign (
     id uuid PRIMARY KEY,
     project_id uuid NOT NULL
       CONSTRAINT fk_campaign_project REFERENCES research_project (id) ON DELETE RESTRICT,
     baseline_id uuid NOT NULL
       CONSTRAINT fk_campaign_baseline REFERENCES baseline (id) ON DELETE RESTRICT,
     name text NOT NULL,
     objective text NOT NULL,
     optimization_metric text NOT NULL,
     constraints jsonb NOT NULL DEFAULT '{}',
     config jsonb NOT NULL,
     max_experiments integer NOT NULL,
     max_concurrent_experiments integer NOT NULL,
     max_runtime numeric NOT NULL,
     max_runtime_unit text NOT NULL,
     max_compute_budget numeric,
     max_compute_budget_unit text,
     max_agent_budget numeric,
     max_agent_budget_unit text,
     status text NOT NULL DEFAULT 'CREATED',
     created_at timestamptz NOT NULL DEFAULT now(),
     completed_at timestamptz,
     CONSTRAINT uq_campaign_project_name UNIQUE (project_id, name),
     CONSTRAINT ck_campaign_objective CHECK (objective IN ('minimize-area-delay-product')),
     CONSTRAINT ck_campaign_status
       CHECK (status IN ('CREATED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED')),
     CONSTRAINT ck_campaign_config CHECK (jsonb_typeof(config) = 'object'),
     CONSTRAINT ck_campaign_max_experiments CHECK (max_experiments > 0),
     CONSTRAINT ck_campaign_max_concurrent CHECK (
       max_concurrent_experiments > 0 AND max_concurrent_experiments <= max_experiments
     ),
     CONSTRAINT ck_campaign_max_runtime CHECK (max_runtime > 0),
     CONSTRAINT ck_campaign_compute_budget CHECK (
       (max_compute_budget IS NULL) = (max_compute_budget_unit IS NULL)
       AND max_compute_budget > 0
     ),
     CONSTRAINT ck_campaign_agent_budget CHECK (
       (max_agent_budget IS NULL) = (max_agent_budget_unit IS NULL)
       AND max_agent_budget > 0
     )
   )`,
  `CREATE INDEX idx_campaign_project ON research_campaign (project_id)`,
  `CREATE INDEX idx_campaign_baseline ON research_campaign (baseline_id)`,

  // Its foreign keys are added at the end: artifact, experiment and candidate form a cycle.
  `CREATE TABLE artifact (
     id uuid PRIMARY KEY,
     experiment_id uuid,
     agent_run_id uuid,
     kind text NOT NULL,
     name text NOT NULL,
     content_hash text NOT NULL,
     size_bytes bigint NOT NULL,
     media_type text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_artifact_kind CHECK (kind IN (
       'candidate-source', 'patch', 'test-vectors', 'verification-report', 'synthesis-report',
       'timing-report', 'power-report', 'agent-output', 'tool-log', 'waveform',
       'experiment-config', 'reproducibility-manifest'
     )),
     CONSTRAINT ck_artifact_content_hash CHECK (content_hash ~ ${SHA256}),
     CONSTRAINT ck_artifact_size_bytes CHECK (size_bytes >= 0)
   )`,
  `CREATE INDEX idx_artifact_experiment ON artifact (experiment_id)`,
  `CREATE INDEX idx_artifact_agent_run ON artifact (agent_run_id)`,
  `CREATE INDEX idx_artifact_content_hash ON artifact (content_hash)`,

  `CREATE TABLE design_candidate (
     id uuid PRIMARY KEY,
     candidate_hash text NOT NULL,
     source_commit text,
     parent_candidate_id uuid
       CONSTRAINT fk_candidate_parent REFERENCES design_candidate (id) ON DELETE RESTRICT,
     changed_files jsonb NOT NULL,
     patch_artifact_id uuid
       CONSTRAINT fk_candidate_patch_artifact REFERENCES artifact (id) ON DELETE RESTRICT,
     architecture_parameters jsonb NOT NULL DEFAULT '{}',
     generated_at timestamptz NOT NULL DEFAULT now(),
     validation_status text NOT NULL DEFAULT 'pending',
     CONSTRAINT uq_candidate_hash UNIQUE (candidate_hash),
     CONSTRAINT ck_candidate_hash CHECK (candidate_hash ~ ${SHA256}),
     CONSTRAINT ck_candidate_changed_files CHECK (jsonb_typeof(changed_files) = 'array'),
     CONSTRAINT ck_candidate_validation_status
       CHECK (validation_status IN ('pending', 'valid', 'invalid'))
   )`,
  `CREATE INDEX idx_candidate_parent ON design_candidate (parent_candidate_id)`,

  `CREATE TABLE experiment (
     id uuid PRIMARY KEY,
     campaign_id uuid NOT NULL
       CONSTRAINT fk_experiment_campaign REFERENCES research_campaign (id) ON DELETE RESTRICT,
     parent_experiment_id uuid
       CONSTRAINT fk_experiment_parent REFERENCES experiment (id) ON DELETE SET NULL,
     candidate_id uuid
       CONSTRAINT fk_experiment_candidate REFERENCES design_candidate (id) ON DELETE RESTRICT,
     evaluation_config_hash text NOT NULL,
     hypothesis text,
     agent_provider text,
     agent_model text,
     agent_config jsonb NOT NULL DEFAULT '{}',
     seed bigint NOT NULL,
     status text NOT NULL DEFAULT 'CREATED',
     failure_class text,
     failure_reason text,
     created_at timestamptz NOT NULL DEFAULT now(),
     started_at timestamptz,
     completed_at timestamptz,
     CONSTRAINT uq_experiment_candidate_evaluation UNIQUE (candidate_id, evaluation_config_hash),
     CONSTRAINT ck_experiment_evaluation_config_hash
       CHECK (evaluation_config_hash ~ ${SHA256}),
     CONSTRAINT ck_experiment_agent_provider CHECK (agent_provider IN (${AGENT_PROVIDERS})),
     CONSTRAINT ck_experiment_seed CHECK (seed >= 0),
     CONSTRAINT ck_experiment_status CHECK (status IN (${EXPERIMENT_STATES})),
     CONSTRAINT ck_experiment_failure_class CHECK (failure_class IN (${FAILURE_CLASSES})),
     CONSTRAINT ck_experiment_failed_has_class
       CHECK (status NOT IN ('REJECTED', 'FAILED') OR failure_class IS NOT NULL)
   )`,
  `CREATE INDEX idx_experiment_campaign_status ON experiment (campaign_id, status)`,
  `CREATE INDEX idx_experiment_parent ON experiment (parent_experiment_id)`,

  `CREATE TABLE experiment_transition (
     id uuid PRIMARY KEY,
     experiment_id uuid NOT NULL
       CONSTRAINT fk_transition_experiment REFERENCES experiment (id) ON DELETE CASCADE,
     from_state text,
     to_state text NOT NULL,
     failure_class text,
     reason text,
     at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_transition_from_state CHECK (from_state IN (${EXPERIMENT_STATES})),
     CONSTRAINT ck_transition_to_state CHECK (to_state IN (${EXPERIMENT_STATES})),
     CONSTRAINT ck_transition_failure_class CHECK (failure_class IN (${FAILURE_CLASSES}))
   )`,
  `CREATE INDEX idx_transition_experiment_at ON experiment_transition (experiment_id, at)`,

  `CREATE TABLE verification_result (
     id uuid PRIMARY KEY,
     experiment_id uuid NOT NULL
       CONSTRAINT fk_verification_experiment REFERENCES experiment (id) ON DELETE CASCADE,
     test_suite text NOT NULL,
     passed boolean NOT NULL,
     failed_test_count integer NOT NULL,
     first_failure text,
     random_seed bigint,
     tool_version text NOT NULL,
     report_artifact_id uuid
       CONSTRAINT fk_verification_report REFERENCES artifact (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_verification_test_suite CHECK (test_suite IN (
       'lint', 'unit', 'differential', 'randomized', 'structural'
     )),
     CONSTRAINT ck_verification_failed_test_count CHECK (failed_test_count >= 0),
     CONSTRAINT ck_verification_passed_has_no_failures
       CHECK (NOT passed OR failed_test_count = 0),
     CONSTRAINT ck_verification_random_seed CHECK (random_seed >= 0)
   )`,
  `CREATE INDEX idx_verification_experiment ON verification_result (experiment_id)`,

  `CREATE TABLE synthesis_result (
     id uuid PRIMARY KEY,
     experiment_id uuid NOT NULL
       CONSTRAINT fk_synthesis_experiment REFERENCES experiment (id) ON DELETE CASCADE,
     tier text NOT NULL,
     top_module text NOT NULL,
     tool_version text NOT NULL,
     target_library text NOT NULL,
     cell_count integer NOT NULL,
     flip_flop_count integer NOT NULL,
     multiplier_cell_count integer,
     abstract_gate_count integer,
     logic_depth integer,
     estimated_area jsonb NOT NULL,
     warnings jsonb NOT NULL DEFAULT '[]',
     report_artifact_id uuid
       CONSTRAINT fk_synthesis_report REFERENCES artifact (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_synthesis_tier CHECK (tier IN (${METRIC_TIERS})),
     CONSTRAINT ck_synthesis_cell_count CHECK (cell_count >= 0),
     CONSTRAINT ck_synthesis_flip_flop_count CHECK (flip_flop_count >= 0),
     CONSTRAINT ck_synthesis_multiplier_cell_count CHECK (multiplier_cell_count >= 0),
     CONSTRAINT ck_synthesis_abstract_gate_count CHECK (abstract_gate_count >= 0),
     CONSTRAINT ck_synthesis_logic_depth CHECK (logic_depth >= 0),
     CONSTRAINT ck_synthesis_estimated_area CHECK (research_metric_valid(estimated_area)),
     CONSTRAINT ck_synthesis_warnings CHECK (jsonb_typeof(warnings) = 'array')
   )`,
  `CREATE INDEX idx_synthesis_experiment ON synthesis_result (experiment_id)`,

  `CREATE TABLE timing_result (
     id uuid PRIMARY KEY,
     experiment_id uuid NOT NULL
       CONSTRAINT fk_timing_experiment REFERENCES experiment (id) ON DELETE CASCADE,
     tier text NOT NULL,
     tool_version text NOT NULL,
     target_clock_period jsonb NOT NULL,
     critical_path_delay jsonb NOT NULL,
     worst_negative_slack jsonb NOT NULL,
     total_negative_slack jsonb NOT NULL,
     timing_constraints jsonb NOT NULL,
     report_artifact_id uuid
       CONSTRAINT fk_timing_report REFERENCES artifact (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_timing_tier CHECK (tier IN (${METRIC_TIERS})),
     CONSTRAINT ck_timing_target_clock_period CHECK (research_metric_valid(target_clock_period)),
     CONSTRAINT ck_timing_critical_path_delay CHECK (research_metric_valid(critical_path_delay)),
     CONSTRAINT ck_timing_worst_negative_slack
       CHECK (research_metric_valid(worst_negative_slack)),
     CONSTRAINT ck_timing_total_negative_slack
       CHECK (research_metric_valid(total_negative_slack))
   )`,
  `CREATE INDEX idx_timing_experiment ON timing_result (experiment_id)`,

  `CREATE TABLE power_result (
     id uuid PRIMARY KEY,
     experiment_id uuid NOT NULL
       CONSTRAINT fk_power_experiment REFERENCES experiment (id) ON DELETE CASCADE,
     estimation_method text NOT NULL,
     switching_activity_source text NOT NULL,
     dynamic_power jsonb NOT NULL,
     leakage_power jsonb NOT NULL,
     total_power jsonb NOT NULL,
     limitation_notes text,
     report_artifact_id uuid
       CONSTRAINT fk_power_report REFERENCES artifact (id) ON DELETE RESTRICT,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_power_dynamic_power CHECK (research_metric_valid(dynamic_power)),
     CONSTRAINT ck_power_leakage_power CHECK (research_metric_valid(leakage_power)),
     CONSTRAINT ck_power_total_power CHECK (research_metric_valid(total_power))
   )`,
  `CREATE INDEX idx_power_experiment ON power_result (experiment_id)`,

  `CREATE TABLE agent_run (
     id uuid PRIMARY KEY,
     experiment_id uuid NOT NULL
       CONSTRAINT fk_agent_run_experiment REFERENCES experiment (id) ON DELETE CASCADE,
     provider text NOT NULL,
     model text NOT NULL,
     prompt_version text NOT NULL,
     input_tokens bigint,
     output_tokens bigint,
     estimated_cost jsonb NOT NULL,
     duration jsonb NOT NULL,
     exit_code integer,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_agent_run_provider CHECK (provider IN (${AGENT_PROVIDERS})),
     CONSTRAINT ck_agent_run_input_tokens CHECK (input_tokens >= 0),
     CONSTRAINT ck_agent_run_output_tokens CHECK (output_tokens >= 0),
     CONSTRAINT ck_agent_run_estimated_cost CHECK (research_metric_valid(estimated_cost)),
     CONSTRAINT ck_agent_run_duration CHECK (research_metric_valid(duration))
   )`,
  `CREATE INDEX idx_agent_run_experiment ON agent_run (experiment_id)`,

  `CREATE TABLE research_finding (
     id uuid PRIMARY KEY,
     campaign_id uuid NOT NULL
       CONSTRAINT fk_finding_campaign REFERENCES research_campaign (id) ON DELETE CASCADE,
     experiment_id uuid
       CONSTRAINT fk_finding_experiment REFERENCES experiment (id) ON DELETE SET NULL,
     finding_type text NOT NULL,
     summary text NOT NULL,
     supporting_metrics jsonb NOT NULL DEFAULT '{}',
     confidence_level text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_finding_type
       CHECK (finding_type IN ('verified', 'estimated', 'ai-interpreted', 'unresolved')),
     CONSTRAINT ck_finding_confidence_level
       CHECK (confidence_level IN ('low', 'medium', 'high'))
   )`,
  `CREATE INDEX idx_finding_campaign ON research_finding (campaign_id)`,
  `CREATE INDEX idx_finding_experiment ON research_finding (experiment_id)`,

  `CREATE TABLE campaign_event (
     id uuid PRIMARY KEY,
     campaign_id uuid NOT NULL
       CONSTRAINT fk_event_campaign REFERENCES research_campaign (id) ON DELETE CASCADE,
     experiment_id uuid
       CONSTRAINT fk_event_experiment REFERENCES experiment (id) ON DELETE SET NULL,
     type text NOT NULL,
     actor text NOT NULL,
     details jsonb NOT NULL DEFAULT '{}',
     at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ck_event_type CHECK (type IN (
       'started', 'paused', 'resumed', 'cancelled', 'completed', 'budget-exceeded',
       'budget-raised', 'duplicate-candidate'
     ))
   )`,
  `CREATE INDEX idx_event_campaign_at ON campaign_event (campaign_id, at)`,
  `CREATE INDEX idx_event_experiment ON campaign_event (experiment_id)`,

  `ALTER TABLE artifact
     ADD CONSTRAINT fk_artifact_experiment
       FOREIGN KEY (experiment_id) REFERENCES experiment (id) ON DELETE SET NULL,
     ADD CONSTRAINT fk_artifact_agent_run
       FOREIGN KEY (agent_run_id) REFERENCES agent_run (id) ON DELETE SET NULL`,
];

const down = [
  `ALTER TABLE artifact
     DROP CONSTRAINT fk_artifact_experiment,
     DROP CONSTRAINT fk_artifact_agent_run`,
  `DROP TABLE campaign_event`,
  `DROP TABLE research_finding`,
  `DROP TABLE agent_run`,
  `DROP TABLE power_result`,
  `DROP TABLE timing_result`,
  `DROP TABLE synthesis_result`,
  `DROP TABLE verification_result`,
  `DROP TABLE experiment_transition`,
  `DROP TABLE experiment`,
  `DROP TABLE design_candidate`,
  `DROP TABLE artifact`,
  `DROP TABLE research_campaign`,
  `DROP TABLE baseline`,
  `DROP TABLE research_project`,
  `DROP FUNCTION baseline_immutable()`,
  `DROP FUNCTION research_metric_map_valid(jsonb)`,
  `DROP FUNCTION research_metric_valid(jsonb)`,
];

export class InitialResearchSchema1793491200000 implements MigrationInterface {
  name = 'InitialResearchSchema1793491200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of up) await queryRunner.query(statement);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const statement of down) await queryRunner.query(statement);
  }
}
