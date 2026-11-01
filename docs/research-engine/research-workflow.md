# Research workflow

This document describes how one experiment runs, how a design gets rejected, and how a campaign stops. The engine is not built yet; this is the contract the following tickets implement. [architecture.md](architecture.md) describes the components.

## The loop

Each step of the research loop maps to a stage of the experiment state machine.

| #   | Step                                | State                            | Done by                                        |
| --- | ----------------------------------- | -------------------------------- | ---------------------------------------------- |
| 1   | Select a design and baseline        | `CREATED`                        | The campaign config; the baseline is frozen    |
| 2   | Analyse the design and past results | `GENERATING`                     | Research Planner, from summarised findings     |
| 3   | Generate a hypothesis               | `GENERATING`                     | Research Planner, or the Coordinator choosing  |
| 4   | Propose a constrained RTL change    | `GENERATING`                     | RTL Engineer in a generation workspace         |
| 5   | Create an isolated candidate        | `PREPARING`                      | The harness, from the baseline tree            |
| 6   | Compile and lint                    | `STATIC_VALIDATION`, `COMPILING` | Pipeline: allowlist, hashes, Verilator         |
| 7   | Verify correctness                  | `VERIFYING`                      | Pipeline: the gates below                      |
| 8   | Reject incorrect designs            | `REJECTED`                       | Pipeline; never retried                        |
| 9   | Synthesize                          | `SYNTHESIZING`                   | Pipeline: Yosys, generic and sky130hd          |
| 10  | Run timing and physical analysis    | `PHYSICAL_ANALYSIS`              | Pipeline: OpenSTA, and OpenROAD when available |
| 11  | Collect PPA metrics                 | `SCORING`                        | Pipeline: report parsers                       |
| 12  | Compare against the baseline        | `SCORING`                        | `research-core`, only if comparable            |
| 13  | Store the experiment and artifacts  | `COMPLETED`                      | Pipeline, by content hash at every stage       |
| 14  | Generate a report                   | After completion                 | Report generator                               |
| 15  | Propose the next experiment         | Next experiment                  | Performance Analyst, then Coordinator          |

Steps 2 to 4 are the only ones where an agent can affect the design. Steps 5 to 13 are deterministic pipeline work. Step 5 happens before generation so the agent has a workspace to change, which is why the states run out of step order there. Step 15 feeds the next experiment.

## Correctness gates

The pipeline runs all of these for a PE candidate. The agent runs none of them.

| Gate         | What runs                                                                             | On failure |
| ------------ | ------------------------------------------------------------------------------------- | ---------- |
| Lint         | Verilator `--lint-only -Wall`                                                         | `REJECTED` |
| Unit         | `make test-pe` with the campaign's fixed seed, then again with the experiment seed    | `REJECTED` |
| Differential | `make verify-size ROWS=4` directed corpus, with the candidate PE in the array         | `REJECTED` |
| Randomized   | The random corpus of the same run, with the experiment seed (default count 40)        | `REJECTED` |
| Structural   | The Yosys gates of `synth/generic.ys`: hierarchy, latch, loop, multi-driver, undriven | `REJECTED` |

A rejected candidate never reaches PPA scoring, so a design cannot score well by losing functionality. Failing traces are kept as artifacts.

## Failure classes

| Class                    | Meaning                                                             | Retried                    |
| ------------------------ | ------------------------------------------------------------------- | -------------------------- |
| `incorrect-design`       | It elaborates, but gives wrong results                              | No                         |
| `unsupported-design`     | Interface or elaboration failure, or a change outside the allowlist | No                         |
| `tool-failure`           | A tool crashed or wrote an unreadable report                        | Yes, up to a per-class cap |
| `timeout`                | A stage ran past its wall-clock limit                               | Yes, up to a per-class cap |
| `infrastructure-failure` | Docker, the database, Redis or the disk failed                      | Yes, up to a per-class cap |
| `budget-exceeded`        | A campaign limit was reached                                        | No                         |
| `policy-violation`       | A policy boundary was crossed                                       | No                         |

A deterministic correctness failure is a result, not an outage, so retrying it would only waste budget and hide the finding.

## Rollout

The engine proves itself without agents first, because a bug in the pipeline must not be mistaken for a research result.

1. **Deterministic.** `pnpm research:verify` runs a fixture candidate end to end on the real tools, evaluates and freezes the PE baseline, and shows that a known-bad candidate is rejected (VIRT-ZIH4RS).
2. **Agents enabled.** The Claude Code and Codex adapters are added after the loop is proven (VIRT-DCBULO), and the campaign engine connects them (VIRT-W3M5PV).
3. **Pilot.** 8 real experiments, with a limit of 30 agent invocations, check generation, sandboxing, gates, metric extraction and reproducibility (VIRT-NL0DZA).
4. **Campaign 001.** 100 experiments, 350 invocations and 24 hours at most (VIRT-2C0ELG).

Evaluating a frozen candidate is reproducible within documented tool limits. Generation is not: an agent can give a different answer to the same prompt. Reproducibility manifests keep those two claims separate.

## Budgets and stop conditions

Each campaign counts experiments, agent invocations, tokens when reported, cost, EDA wall-clock time and artifact bytes.

- **Cost.** Claude's `--output-format json` reports `total_cost_usd`. Codex reports tokens but no price, so its cost is `unknown`, never 0.
- **Limits.** Reaching any limit pauses the campaign with `budget-exceeded`. Resuming past it takes an explicit human raise through the API, which is logged. Workers never raise a limit.
- **Target.** A campaign may stop when it reaches `targetImprovementPercent`. For Campaign 001 that is 15 %, a stretch goal rather than a requirement.
- **Controls.** Campaigns support start, pause, resume and cancel. Duplicate candidates are not re-run; the campaign records a `duplicate-candidate` event and asks the agent again, a bounded number of times.

A negative result is a valid result. Baselines, constraints and failed experiments are never adjusted or dropped to manufacture an improvement.
