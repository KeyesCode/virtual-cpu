# Silicon Lab Research Engine (Project 4)

Project 4 builds a platform that proposes hardware design changes, verifies them, measures them and keeps the evidence. Its first campaign tries to improve the area-delay product of the Project 3 processing element.

**Status: documented and scaffolded.** Compose runs PostgreSQL and Redis, and the database schema exists. No experiment logic exists yet.

| Document                                     | What it covers                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| [audit.md](audit.md)                         | Readiness of Projects 1 to 3, tools present and missing, target choice, evidence  |
| [architecture.md](architecture.md)           | Components, data model, state machine, metric tiers, sandbox and agent boundaries |
| [research-workflow.md](research-workflow.md) | The 15-step loop, correctness gates, failure classes, rollout, budgets            |
| [data-model.md](data-model.md)               | Tables, columns and units, constraints, what the migrations guarantee             |
| [eda-adapters.md](eda-adapters.md)           | The command runner and Verilator adapter: commands, outputs, failure classes      |
| [sandbox.md](sandbox.md)                     | The EDA sandbox image and runner: threat model, flags, mounts, macOS and Ubuntu   |

## Getting started

Commands run from the repository root.

```sh
pnpm install
cp .env.example .env
docker compose --env-file .env -f infrastructure/docker/compose.yml up -d postgres redis
docker compose --env-file .env -f infrastructure/docker/compose.yml ps
```

If a port is taken, change `POSTGRES_PORT` or `REDIS_PORT` in `.env`, and update `DATABASE_URL` or `REDIS_URL` to match.

## Root scripts

| Script                         | State                                                  |
| ------------------------------ | ------------------------------------------------------ |
| `pnpm research:test`           | Works: runs the tests of the eight research workspaces |
| `pnpm research:dashboard`      | Works: serves the placeholder page                     |
| `pnpm research:migrate`        | Works: applies pending migrations to `DATABASE_URL`    |
| `pnpm research:migrate:revert` | Works: reverts the last migration                      |
| `pnpm research:sandbox:build`  | Works: builds the EDA sandbox image                    |
| `pnpm research:worker`         | Stub until VIRT-JAA90W                                 |
| `pnpm research:api`            | Stub until VIRT-1CIURP                                 |
| `pnpm research:verify`         | Stub until VIRT-ZIH4RS                                 |
| `pnpm research:campaign`       | Stub until VIRT-W3M5PV                                 |
| `pnpm research:dev`            | Stub until VIRT-5LP8M4                                 |

A stub prints `not implemented yet` and exits 1.

## Build order

Each step depends on the ones before it.

1. Audit, docs, workspace scaffold and Compose (VIRT-YV1PCJ).
2. In parallel: domain model (VIRT-W2OETF), Verilator adapter (VIRT-WYLTFY), Yosys adapter (VIRT-B2P2JZ), EDA sandbox (VIRT-Q6RNBH), artifact storage (VIRT-UDSAEZ), metrics (VIRT-FJGLVO).
3. State machine and BullMQ (VIRT-JAA90W), OpenSTA and OpenROAD adapter (VIRT-JVBNK4), baselines and candidates (VIRT-PWZZNZ).
4. Deterministic pipeline (VIRT-ZIH4RS), research API (VIRT-1CIURP), agent adapters (VIRT-DCBULO).
5. Campaign engine (VIRT-W3M5PV), dashboard core (VIRT-C741GM), reports (VIRT-EJRBT7).
6. Dashboard analytics (VIRT-UR82L0), CI and local development (VIRT-5LP8M4).
7. Pilot campaign (VIRT-NL0DZA).
8. Campaign 001 and the final report (VIRT-2C0ELG).
