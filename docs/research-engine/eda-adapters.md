# EDA adapters

`@vcpu/eda-adapters` runs the EDA tools on a candidate and returns structured results, so the pipeline can reject a design with evidence and no AI involvement. This page covers the command runner and the Verilator adapter. The result types (`StageResult`, `CommandRecord`) and `classifyCommand` are in `packages/research-core/src/pipeline/`.

## Command runner

Adapters run commands through the `CommandRunner` interface in `packages/eda-adapters/src/runner/`, so the same adapter can later run inside the sandbox image.

`HostCommandRunner` runs each command as the leader of its own process group:

- **Timeout:** SIGTERM to the group, then SIGKILL after `killGraceMs` (default 2 s). The SIGKILL is sent even if the leader has already exited, so it reaches `make`, `pnpm`, `node` and the simulators. The record's `pid` is also the group id, and `processGroupAlive(pid)` checks that nothing is left.
- **Logs:** each stream is written to its own file and capped at `maxLogBytes`. The start of the stream is kept, a marker is appended, and the record holds the full size.
- **Failures:** a command that fails, overruns or cannot start returns a record. A rejection means the runner itself broke.

## Verilator adapter

`VerilatorAdapter` takes the `repoRoot`. Each method takes a `VerilatorRunContext` (`workspaceRoot`, `outDir`, `campaignSeed`, `experimentSeed`, `count`, `timeoutMs`) and returns a `StageResult`. Methods don't call each other: the pipeline orders the gates.

| Method                        | Stage          | Commands, after `make tools-check` if not yet run                        | Parsed from                       | Outcome                                                                  |
| ----------------------------- | -------------- | ------------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------ |
| `lint(context)`               | `lint`         | `make lint`                                                              | Verilator diagnostics             | `errors`, `warnings`                                                     |
| `unitTestPe(context)`         | `unit`         | `make test-pe PE_SEED=<seed>`, for the campaign and then experiment seed | Testbench PASS and MISMATCH lines | `checks`, `runs`, `firstFailure`                                         |
| `differentialVerify(context)` | `differential` | `make sim`, then `cli verify` from `@vcpu/accelerator-reference`         | `verify.json`, never console text | `totals`, `failedDirected`, `failedRandom`, `reportFile`, `firstFailure` |
| `wave(context, caseFile)`     | `wave`         | `make wave CASE=<file.in>` (optional: runs only when called)             | The file written                  | `waveFile`, `bytes`                                                      |

`timeoutMs` covers all of a stage's commands together. `toolVersion` comes from `build/tool-versions.json`, not from the `provenance` block of `verify.json`, which reads the repository's own `build/` rather than the run's.

### Running a candidate outside the repository

A workspace holds a full copy of `hardware/accelerators/matmul/`. Every `make` runs in that copy with these overrides on the command line, where they win over the Makefile's assignments:

| Variable                                    | Why                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `REPO_ROOT=<repo>`                          | Reaches `hardware/toolchain.env` and the harness and `node_modules`, which are not copied.                   |
| `BUILD_DIR=<outDir>/build`                  | Keeps every build output under the run's output directory.                                                   |
| `VERILATOR=$(TOOL_BIN)verilator -Wno-fatal` | Every recipe builds with `-Wall`, which makes a warning fatal. Make expands this after resolving `TOOL_BIN`. |
| `PE_VECTORS=<outDir>/unit/seed-<n>/pe.vec`  | Keeps one vector file per seed (`test-pe` only).                                                             |

`HW_DIR` needs no override: the Makefile derives it from its own path, so it builds the copy's RTL. Workspaces can therefore live anywhere. A sandbox runner needs the same layout: the workspace, the repository with its `node_modules`, and the output directory.

`make verify-size` is deliberately not used. It passes only `--reports` to `verify`, which then uses the repository's own `build/verify` and `build/failures`, and deletes them first, so parallel experiments would destroy each other's cases. The adapter calls the same `verify` command with `--work`, `--failures` and `--reports` under `<outDir>/build/`.

The adapter rejects (it does not return a result) if `workspaceRoot` is the repository or `outDir` is inside its `hardware/accelerators/matmul/`.

### Output directory

```text
<outDir>/
  logs/<stage>-<n>-<label>.{stdout,stderr}.log
  unit/seed-<n>/pe.vec
  build/
    tool-versions.json
    reports/verify-4x4/verify.{json,md}
    failures/<size>-<case>/            saved by verify for failing cases, at most 25
    waves/<case>.fst
```

### Failure classification

The first row that applies wins.

| Class                    | When                                                                                                                                                                                                            | Stages                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `infrastructure-failure` | A command could not start, the runner rejected, or `tool-versions.json` is missing or has no Verilator. The message holds the `pnpm hardware:setup` hint.                                                       | All                    |
| `timeout`                | The stage overran `timeoutMs`. The process tree is killed.                                                                                                                                                      | All                    |
| `incorrect-design`       | The testbench printed a `MISMATCH` or `N of M checks failed` before any `PASS`.                                                                                                                                 | `unit`                 |
| `incorrect-design`       | `verify.json` has `passed: false` and at least one case the runner finished.                                                                                                                                    | `differential`         |
| `unsupported-design`     | A Verilator `%Error` with a location or code, such as a syntax or elaboration error or `PINNOTFOUND`.                                                                                                           | All that use Verilator |
| `unsupported-design`     | A `PINMISSING` warning, or a `WIDTH*` warning on a port connection: the frozen PE interface changed, even though `-Wno-fatal` lets the build continue.                                                          | All that use Verilator |
| `tool-failure`           | Anything else: a Verilator internal error, a failed C++ build, no report from `verify`, every failing case being a runner crash, a failed `test-pe-corrupt` self-check, or a non-zero exit on a passing report. | All                    |

Other warnings are recorded in `warnings` and the stage stays ok. A candidate that passes `unit` and fails `differential` is `incorrect-design` with the differential `firstFailure`.

`firstFailure` in `differential` names the first saved failing case: its generator, seed and dimensions, the first differing elements, `savedDir`, its `files`, and `caseFile`, which `wave` takes. In `unit` it names the seed, the line of `vectorFile`, the segment and the comparison.

### Tests

`pnpm --filter @vcpu/eda-adapters test` runs the parser tests on `test/fixtures/` and the runner and adapter tests with no toolchain. `src/verilator/verilator.integration.test.ts` runs the real flows on scratch copies: clean RTL, every mutant in `scripts/mutants.txt`, renamed and narrowed ports, a warning, a waveform and a tiny timeout. It skips with a message when the pinned toolchain is not installed (`pnpm hardware:setup`).
