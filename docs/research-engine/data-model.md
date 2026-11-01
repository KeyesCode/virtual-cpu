# Research data model

The research schema lives in PostgreSQL 16. The entities are in `apps/research-api/src/entities/`, the migrations in `apps/research-api/src/migrations/`, and the shared enums and Zod schemas in `packages/research-core/src/domain/`. The API, worker and dashboard use that one vocabulary.

The migrations define the schema. `synchronize` is off everywhere, so the entities describe columns and relations but do not repeat the indexes, unique constraints or checks.

## Migrating

```sh
docker compose --env-file .env -f infrastructure/docker/compose.yml up -d postgres
pnpm research:migrate          # applies pending migrations, each in its own transaction
pnpm research:migrate:revert   # reverts the last migration
```

Both read `DATABASE_URL` from the environment, then from the `.env` at the repository root. Reverting leaves only TypeORM's own empty `migrations` table.

The tests in `apps/research-api/test/db/` run when `DATABASE_URL` is set and skip with a message otherwise. Each run migrates into its own temporary PostgreSQL schema and drops it afterwards, so running them never touches the tables in that database.

```sh
DATABASE_URL=postgres://research:research@127.0.0.1:5432/research pnpm --filter @vcpu/research-api test
```

## Relationships

```mermaid
erDiagram
  research_project ||--o{ baseline : has
  research_project ||--o{ research_campaign : has
  baseline ||--o{ research_campaign : "is fixed for"
  research_campaign ||--o{ experiment : runs
  research_campaign ||--o{ research_finding : records
  research_campaign ||--o{ campaign_event : audits
  experiment |o--o{ experiment : "is parent of"
  design_candidate |o--o{ design_candidate : "is parent of"
  design_candidate |o--o{ experiment : "is evaluated by"
  experiment ||--o{ experiment_transition : "moves through"
  experiment ||--o{ verification_result : has
  experiment ||--o{ synthesis_result : has
  experiment ||--o{ timing_result : has
  experiment ||--o{ power_result : has
  experiment ||--o{ agent_run : has
  experiment |o--o{ artifact : owns
  experiment |o--o{ research_finding : supports
  experiment |o--o{ campaign_event : concerns
  agent_run |o--o{ artifact : outputs
  artifact |o--o{ design_candidate : "is patch of"
  artifact |o--o{ verification_result : reports
  artifact |o--o{ synthesis_result : reports
  artifact |o--o{ timing_result : reports
  artifact |o--o{ power_result : reports
```

## Tables

Every table has a `uuid` primary key, generated in the app as a UUIDv7, and every timestamp is a `timestamptz`.

| Table                   | Purpose                                                       | Key columns and units                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research_project`      | A hardware target                                             | `name` (unique), `architecture_type`, `source_repository`, `baseline_commit`, `interface_spec_version`                                                                                                                          |
| `baseline`              | A frozen baseline (see [below](#immutable-baselines))         | `name` (unique per project), `source_commit`, `source_content_hash`, `parameters`, `verification_suite_version`, `synthesis_config`, `timing_constraints`, `target_technology`, `tool_versions`, `metrics`, `metrics_frozen_at` |
| `research_campaign`     | A group of experiments against one baseline                   | `objective`, `optimization_metric`, `constraints`, `config`, `status`, `max_experiments`, `max_concurrent_experiments`, `max_runtime` + `_unit`, `max_compute_budget` + `_unit`, `max_agent_budget` + `_unit`                   |
| `experiment`            | One candidate's evaluation                                    | `candidate_id`, `evaluation_config_hash`, `parent_experiment_id`, `hypothesis`, `agent_provider`, `agent_model`, `agent_config`, `seed`, `status`, `failure_class`, `failure_reason`                                            |
| `experiment_transition` | One row per state change                                      | `from_state` (null on the first row), `to_state`, `failure_class`, `reason`, `at`                                                                                                                                               |
| `design_candidate`      | An RTL candidate, identified by its content                   | `candidate_hash` (unique), `source_commit`, `parent_candidate_id`, `changed_files`, `patch_artifact_id`, `architecture_parameters`, `validation_status`                                                                         |
| `verification_result`   | One correctness gate                                          | `test_suite`, `passed`, `failed_test_count`, `first_failure`, `random_seed`, `tool_version`                                                                                                                                     |
| `synthesis_result`      | One synthesis run                                             | `tier`, `top_module`, `target_library`, `cell_count`, `flip_flop_count`, `multiplier_cell_count`, `abstract_gate_count`, `logic_depth` (all counts), `estimated_area` (metric, µm²), `warnings`                                 |
| `timing_result`         | One static timing run                                         | `tier`, `target_clock_period`, `critical_path_delay`, `worst_negative_slack`, `total_negative_slack` (metrics, ns), `timing_constraints`                                                                                        |
| `power_result`          | One power estimate                                            | `estimation_method`, `switching_activity_source`, `dynamic_power`, `leakage_power`, `total_power` (metrics, W), `limitation_notes`                                                                                              |
| `agent_run`             | One agent invocation                                          | `provider`, `model`, `prompt_version`, `input_tokens`, `output_tokens` (null when unknown), `estimated_cost` (metric, USD), `duration` (metric, s), `exit_code` (null when killed)                                              |
| `artifact`              | Metadata only: the bytes live in the artifact store           | `kind`, `name`, `content_hash`, `size_bytes`, `media_type`, `experiment_id`, `agent_run_id`                                                                                                                                     |
| `research_finding`      | A conclusion drawn from a campaign                            | `finding_type`, `summary`, `supporting_metrics`, `confidence_level`, `experiment_id`                                                                                                                                            |
| `campaign_event`        | The audit trail: budget stops, duplicates, pauses and resumes | `type`, `actor`, `details`, `at`, `experiment_id`                                                                                                                                                                               |

`bigint` and `numeric` columns read back as strings, because they can exceed what a JavaScript number holds exactly. That covers seeds, token counts, `size_bytes` and the campaign limits.

## Metrics and units

A physical quantity is never a bare number. It takes one of two forms:

- A JSONB metric object, `{ value, unit, provenance, method?, tool?, toolVersion? }`, in every result column marked "metric" above. `provenance` is `measured`, `estimated` or `theoretical`. The unit above is the expected one, but it is stored with each value and a future report could use another.
- A `numeric` column with a sibling `_unit` text column, for the campaign limits.

An unavailable metric is `{ provenance: "unavailable", reason }`. It has no `value` key, so nothing can read it as 0. Metric columns are `NOT NULL`, so an adapter must say why a number is missing instead of leaving it empty.

The Zod `MetricSchema` validates at the boundary. The database enforces the same shape through the `research_metric_valid` check: a metric with no unit, an unavailable metric that carries a value, or an unknown provenance is refused. It cannot check that a unit suits its column.

Counts such as cells and flip-flops are plain integers with `>= 0` checks, because they are not physical quantities. `tier` records which of the three metric tiers a result belongs to, so that tiers are not mixed in one comparison.

## Immutable baselines

The `baseline_immutable` trigger refuses any update to a baseline except filling `metrics` and setting `metrics_frozen_at`, and it refuses every update once `metrics_frozen_at` is set. A baseline cannot be frozen with empty metrics.

Everything except the metrics must therefore be known before the insert. That includes the target clock period: measure it first, then create the baseline with it.

## Constraints

| Rule                                           | Enforced by                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One candidate per content                      | Unique `design_candidate.candidate_hash`                                                                                                                              |
| No evaluation runs twice                       | Unique `experiment (candidate_id, evaluation_config_hash)`. The same candidate under another config is allowed, and experiments with no candidate yet do not conflict |
| A rejected or failed experiment says why       | `failure_class` is required for `REJECTED` and `FAILED`                                                                                                               |
| A passing result has no failures               | `failed_test_count = 0` when `passed`                                                                                                                                 |
| States and classes match `@vcpu/research-core` | `CHECK` lists on every enum column                                                                                                                                    |
| Hashes are SHA-256                             | `CHECK` against 64 lowercase hex digits                                                                                                                               |

Adding an enum value in `@vcpu/research-core` needs a new migration too.

## Deletion

| Deleting      | Effect                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| A project     | Refused while it has baselines or campaigns                                                                                     |
| A baseline    | Refused while a campaign uses it                                                                                                |
| A campaign    | Refused while it has experiments. Its findings and events cascade                                                               |
| An experiment | Its transitions, results and agent runs cascade. Child experiments, artifacts, findings and events stay, with the link set null |
| A candidate   | Refused while an experiment or a child candidate uses it                                                                        |
| An artifact   | Refused while a result or candidate cites it                                                                                    |
| An agent run  | Its artifacts stay, with the link set null                                                                                      |

## Indexes

Beyond the primary keys and unique constraints: `experiment (campaign_id, status)`, `experiment (parent_experiment_id)`, `experiment_transition (experiment_id, at)`, `research_finding (campaign_id)`, `campaign_event (campaign_id, at)`, `artifact (content_hash)`, and an index on every other foreign key that a delete or a listing has to search.
