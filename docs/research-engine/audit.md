# Project 4 repository audit

This audit records whether the repository is ready for automated hardware experiments. Every number below was produced by running the command on this machine on 2026-11-01. Nothing is copied from an earlier audit.

**Verdict: ready.** Projects 1, 2 and 3 pass their gates on the audited revision. The first research target is the Project 3 processing element, `hardware/accelerators/matmul/rtl/processing_element.sv`. OpenROAD, OpenSTA and a liberty file are [missing](#tools); VIRT-Q6RNBH adds them in the EDA sandbox image.

## Environment

| Item     | Value                                                                        |
| -------- | ---------------------------------------------------------------------------- |
| Revision | `bb289865317fafe265ffd2f28a5d89a6eaa3cd97` (master, clean tree)              |
| Machine  | Apple M2 Pro, 12 cores, 32 GiB RAM, 95 GiB free disk                         |
| Host     | macOS (Darwin 25.6.0), Node 24.15.0, pnpm 10.34.7, GNU Make 3.81             |
| Master   | GitHub Actions `ci`, `hardware` and `accelerator` all succeeded on `bb28986` |

## Evidence

| Command                                                            | Exit | Time  | Result                                                                     |
| ------------------------------------------------------------------ | ---- | ----- | -------------------------------------------------------------------------- |
| `pnpm test`                                                        | 0    | 6 s   | 71 test files, 1,157 tests passed                                          |
| `make -C hardware/accelerators/matmul tools-check`                 | 0    | 1 s   | Verilator 5.053, Yosys 0.70+145, nextpnr 0.11.1, GTKWave found             |
| `make -C hardware/accelerators/matmul test-pe`                     | 0    | 6 s   | 284,355 checks, 20,000 random clocks, seed 1; corrupt vector fails         |
| `make -C hardware/accelerators/matmul verify-size ROWS=4 COUNT=20` | 0    | 4 s   | 42/42 cases (22 directed, 20 random), `verify.json` git commit matches     |
| `make -C hardware/accelerators/matmul synth-compare`               | 0    | 253 s | 0 deltas against the committed baseline; 4×4 PE 1,008 cells, 50 flip-flops |
| `make -C hardware/rtl/vcpu8 test`                                  | 0    | 50 s  | 6 unit tests passed; 98/98 fixtures, 1,526 instructions, 7,824 cycles      |
| `command -v verilator` (toolchain on `PATH`)                       | 0    | -     | Present in `~/.cache/vcpu8/oss-cad-suite-2026-10-16/bin`                   |
| `command -v yosys` (toolchain on `PATH`)                           | 0    | -     | Present in the same directory                                              |
| `command -v openroad`                                              | 1    | -     | Missing                                                                    |
| `command -v sta`                                                   | 1    | -     | Missing                                                                    |
| `command -v docker`                                                | 0    | -     | Docker 20.10.23, daemon running, Compose v2.15.1                           |
| `command -v claude`                                                | 0    | -     | Claude Code 2.1.316                                                        |
| `command -v codex`                                                 | 0    | -     | Codex CLI 0.165.0                                                          |
| `claude --help`                                                    | 0    | -     | 9 of the 10 flags the decisions file names; see [agent CLIs](#agent-clis)  |
| `codex exec --help`                                                | 0    | -     | All 10 flags the decisions file names                                      |

`synth-compare` and the Project 2 `test` target go beyond the commands the plan listed. They are here so the Project 2 verdict and the claim that synthesis works rest on runs, not on committed reports.

## Project readiness

| Project                    | Verdict  | Basis                                                                                                               |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| 1: TypeScript VCPU-8       | Complete | 1,157 tests pass. `@vcpu/cpu-core`, `shared`, `assembler`, `debugger`, `benchmarks`, plus `apps/cli` and `apps/web` |
| 2: SystemVerilog VCPU-8    | Complete | 6 unit tests and 98 fixtures pass; report in [project-2-report.md](../hardware/project-2-report.md)                 |
| 3: INT8 matmul accelerator | Ready    | Unit, differential and synthesis gates pass; final report missing (see below)                                       |

Project 3 detail:

- **Verification.** `test-pe` compares the PE against the TypeScript model and fails on a corrupted vector, so the check can detect a mismatch. `verify-size` compares `matmul_top` against `@vcpu/accelerator-reference` element by element and records provenance in `build/reports/verify-4x4/verify.json`.
- **Synthesis.** A fresh `make synth` reproduces `research/accelerators/matmul/synth/baseline.json` exactly, apart from the recorded git commit. All synthesis gates passed, with 1,038 warnings, all in the reviewed allowlist. The baseline holds generic Yosys cells, flip-flops, `$mul` cells, logic depth and nextpnr results for iCE40 and ECP5.
- **Experiments.** `make experiment NAME=<dir>` already builds, verifies, benchmarks and synthesises parameter variants, and its results are committed under `research/accelerators/matmul/experiments/`.
- **Open item.** Fredrin shows VIRT-E3FW9I (Project 3 acceptance audit and final report) as completed, but no pull request is attached and `docs/hardware/accelerators/project-3-report.md` does not exist on master. Project 4 does not depend on that report. The master CI regression that blocked the ticket was fixed by #42.

## Repository inventory

| Area                 | What exists                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| Workspace            | pnpm workspace over `apps/*` and `packages/*`; packages are consumed from TypeScript source through `exports` |
| CPU reference        | `packages/cpu-core`, with the ISA in `packages/shared`                                                        |
| RTL                  | `hardware/rtl/vcpu8/` (Project 2), `hardware/accelerators/matmul/` (Project 3, revision `matmul-os-r1`)       |
| Golden model         | `packages/accelerator-reference/src/model/`, with the harness in `src/harness/`                               |
| Hardware benchmarks  | `make benchmark` for both designs, `pnpm bench` for the emulator                                              |
| Synthesis scripts    | `hardware/accelerators/matmul/synth/{generic,ice40,ecp5}.ys`, plus Project 2's equivalents                    |
| Research reports     | `research/cpu/`, `research/accelerators/matmul/{synth,comparisons,experiments,reports}/`                      |
| CI                   | `ci.yml` (TypeScript), `hardware.yml` (Project 2), `accelerator.yml` (Project 3), all on `ubuntu-24.04`       |
| Docker               | None before this ticket; this ticket adds `infrastructure/docker/compose.yml`                                 |
| Backend and database | None before this ticket                                                                                       |

The brief's suggested tree differs from this repository in a few names: the repository is `virtual-cpu`, the simulator lives in `apps/web` and `apps/cli`, and the ISA lives in `@vcpu/shared`. Metrics live in `@vcpu/research-core` rather than a separate package, as §5 of `project-4-decisions.md` fixes.

## Tools

| Tool                     | State   | Notes                                                                              |
| ------------------------ | ------- | ---------------------------------------------------------------------------------- |
| Verilator 5.053          | Present | Pinned OSS CAD Suite 2026-10-16 (`hardware/toolchain.env`)                         |
| Yosys 0.70+145           | Present | Same suite                                                                         |
| nextpnr 0.11.1, GTKWave  | Present | Same suite                                                                         |
| OpenROAD                 | Missing | Not on `PATH` and not in the suite; VIRT-Q6RNBH adds it to the sandbox image       |
| OpenSTA (`sta`)          | Missing | Not on `PATH` and not in the suite; VIRT-Q6RNBH adds it to the sandbox image       |
| sky130hd liberty         | Missing | No sky130 `.lib` within four levels of the home directory; no `hardware/asic/` yet |
| Docker 20.10.23          | Present | `postgres:16-alpine` and `redis:7-alpine` images already pulled                    |
| `psql` 17.4, Redis 8.6.1 | Present | Host clients; the research engine uses the Compose services                        |
| `gh` 2.95.0              | Present |                                                                                    |

Tier 1 metrics, and so the campaign's ADP, need OpenSTA and the liberty file. Tier 0 metrics work today.

## Agent CLIs

Flags were read from `--help` of the installed versions. No agent was invoked, so authentication was not exercised here.

| CLI          | Flags listed in `--help`                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code  | `-p/--print`, `--output-format`, `--json-schema`, `--allowedTools`, `--disallowedTools`, `--permission-mode`, `--add-dir`, `--model`, `--append-system-prompt`, `--max-budget-usd` |
| Codex `exec` | `--json`, `--output-schema`, `-o/--output-last-message`, `-C/--cd`, `-s/--sandbox`, `--add-dir`, `--ephemeral`, `--skip-git-repo-check`, `-m/--model`, `-c/--config`               |

## Differences from the decisions file

`project-4-decisions.md` is the orchestrator's decisions file, attached to every Project 4 ticket. Its decisions still stand. These facts differ from its §1 audit, which ran on the earlier revision `80022bc`:

| Decisions file says                                | This audit found                                                                                                     | Who it affects                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `claude --max-turns` is a documented headless flag | `claude --help` 2.1.316 does not list it. `--max-budget-usd` is listed, and only applies to API calls with `--print` | VIRT-DCBULO must bound runs another way, or confirm the flag first            |
| Python 3.14                                        | `python3` resolves to 3.11.2 here; `/opt/homebrew/bin/python3` is 3.14.3 and `/usr/bin/python3` is 3.9.6             | Host Python varies, so hardware steps must rely on the sandbox image's Python |
| Master has a CI regression                         | Fixed: `accelerator` failed on `80022bc` and succeeded on `bb28986`                                                  | Campaign 001's baseline commit may use a green master at or after `bb28986`   |
| Agent CLIs logged in                               | Not checked: running them would spend subscription usage                                                             | VIRT-DCBULO verifies this when it first invokes each CLI                      |

Other findings that affect later tickets:

- **Port 6379 is taken.** An unrelated container, `agentops-redis`, holds it on this machine, so Compose must run with `REDIS_PORT=6380` here. `.env.example` documents the override.
- **NestJS version.** npm's current major is 12 (12.3.2). The API pins `^11.0.0` because the decisions file names NestJS 11.
- **`msgpackr-extract`.** BullMQ's optional native decoder has an install script that pnpm blocks. It stays off the allow-list, because the package falls back to JavaScript.

## Research target

The target is `processing_element.sv`, revision `matmul-os-r1`. It is the smallest verified unit with all of these: a golden model, a seeded unit test with a mutation self-check, and system-level differential verification through the array and `matmul_top`. Its interface is frozen in [processing-element.md](../hardware/accelerators/processing-element.md).

The whole accelerator is the alternative, and the brief prefers it when its flows work. They do, but the PE is the better first target. Sixteen identical PEs account for 16,128 of the 18,130 generic cells in the 4×4 design, so the PE is where an improvement matters most. It also allows a one-file allowlist with a frozen interface, which keeps generated changes easy to bound. The 4×4 `matmul_top` stays in the loop as a secondary Tier 0 measurement and as the differential gate.

## Scaffold verification

These ran on the scaffolded tree, on top of `bb28986`.

| Command                                                                                    | Exit | Result                                                                                                             |
| ------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                           | 0    | Lockfile matches all 18 workspace projects                                                                         |
| `pnpm check`                                                                               | 0    | Typecheck, lint and format clean; 79 test files, 1,165 tests passed (the 8 new workspaces add 8 files and 8 tests) |
| `pnpm -r typecheck` (within `pnpm check`)                                                  | 0    | Lists all 8 new workspaces, 17 in total                                                                            |
| `pnpm research:test`                                                                       | 0    | 8 test files, 8 tests passed                                                                                       |
| `pnpm --filter @vcpu/research-dashboard build`                                             | 0    | Placeholder dashboard builds                                                                                       |
| `pnpm research:verify`                                                                     | 1    | Prints `research:verify: not implemented yet (lands with VIRT-ZIH4RS; ...)`, as a stub should                      |
| `docker compose -f infrastructure/docker/compose.yml config`                               | 0    | Valid; `postgres:16-alpine` and `redis:7-alpine`, both ports bound to 127.0.0.1                                    |
| `docker compose --env-file .env.example -f infrastructure/docker/compose.yml config`       | 0    | Valid with the documented env file                                                                                 |
| `REDIS_PORT=6380 docker compose -f infrastructure/docker/compose.yml up -d postgres redis` | 0    | Both containers started                                                                                            |
| `REDIS_PORT=6380 docker compose -f infrastructure/docker/compose.yml ps`                   | 0    | `postgres` and `redis` both `Up (healthy)`; PostgreSQL 16.14, Redis 7.4.10 with `noeviction`                       |

`REDIS_PORT=6380` was needed because `agentops-redis` holds port 6379 on this machine. The default port was not exercised on this machine. The services were removed afterwards with `docker compose down -v`, and the `agentops` containers were left alone.
