# EDA adapters

`@vcpu/eda-adapters` runs the EDA tools on a candidate and returns structured results, so the pipeline can reject a design with evidence and no AI involvement. This page covers the command runner, the Verilator adapter and the Yosys adapter. The result types (`StageResult`, `CommandRecord`) and `classifyCommand` are in `packages/research-core/src/pipeline/`.

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

## Yosys adapter

`YosysAdapter` takes the `repoRoot`. Each method takes a context with the `design` (`top`, `params`, `sources`), `outDir` and `timeoutMs`, and returns a `StageResult<SynthesisReport>`. `peDesign(workspaceRoot)` and `matmulTopDesign(workspaceRoot, rows)` build the design for a workspace: the RTL in the Makefile's order, at the frozen parameters.

| Method                       | Stage           | Tier | What it establishes                                                                                                            |
| ---------------------------- | --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| `synthesizeGeneric(context)` | `synth-generic` | 0    | Cells by type, flip-flops, `$mul`, abstract gates, `ltp` logic depth, memories and their bits. Counts only.                    |
| `synthesizeMapped(context)`  | `synth-mapped`  | 1    | With `liberty`: library cells by type, cells, flip-flops, area in µm² and `mapped.v` for static timing. Without: nothing runs. |

Each runs `yosys -V`, then `yosys -q -l yosys.log -s script.ys` in `<outDir>/<flow>/`, which is emptied first. The binary is the pinned OSS CAD Suite's; a sandbox runner passes its own with the `yosys` option. There is no fallback to `PATH`.

Every metric carries its `unit`, `provenance`, `method`, `tool` and `toolVersion`. A metric a flow does not produce is `unavailable` with a reason, never 0: the generic flow has no area, and the mapped flow reports no `$mul`, abstract gates, logic depth or memories.

### Flows

The generic flow is `hardware/accelerators/matmul/synth/generic.ys` with the top parameterised, written out by `buildGenericScript`. A unit test compares the two line by line, so they cannot drift.

The mapped flow is the same structural gates, then:

```text
synth -top <top>
tee -q -o mapped.ff.stat.json stat -json
dfflibmap -dont_use <glob>… -liberty <file>
abc -dont_use <glob>… -liberty <file>
opt_clean
tee -q -o mapped.stat.json stat -liberty <file> -json
write_verilog -noattr mapped.v
write_json mapped.json
```

Flip-flops are counted before `dfflibmap`, while they are still generic cells, because a library cell's name doesn't say what it is. `dontUse` defaults to `SKY130HD_DONT_USE`, the `DONT_USE_CELLS` of ORFS's sky130hd platform: its liberty file doesn't mark them, so ABC would otherwise use `lpflow` power-isolation cells as ordinary gates. The patterns match nothing in another library. The report records the liberty path, its SHA-256 and `dontUse`.

### Script form

**The steps must stay in their own file, run by the `script` command.** `script.ys` reads the design, sets the parameters and calls `script generic.ys` (or `mapped.ys`). This is how Project 3 runs them, and it matters: the same passes pasted into one script give a different netlist.

| Form, Yosys 0.70+145 on macOS arm64                  | PE generic cells | 4 × 4 generic cells | PE sky130hd area |
| ---------------------------------------------------- | ---------------- | ------------------- | ---------------- |
| Steps in their own file, run by `script` (used here) | 1,008            | 18,130              | 7,020.48 µm²     |
| The same steps inline in the `-s` file               | 894              | 18,125              | 6,287.28 µm²     |

The designs are identical until `techmap`, which expands the PE's `$macc_v2` differently. The cause inside Yosys isn't established. It is stable for a given form: changing the paths, the log name or the working directory, or adding unrelated attributes, doesn't move the result.

So comparisons are only valid under one script form. The form is frozen with the evaluation, and the scripts are artifacts with hashes. An 11.7 % swing from script form alone is also a warning about reading small area differences as design improvements: mapped area comes from one fixed heuristic flow, not an optimum.

### Gates

`gates` lists each gate as `passed`, `failed`, or `unknown` when the run stopped before establishing it. Any failed gate is `unsupported-design`.

| Gate             | Fails on                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `elaboration`    | An `ERROR` with a source location, such as a syntax error.                                                                           |
| `hierarchy`      | `hierarchy -check`: an unknown module or port.                                                                                       |
| `latch`          | `select -assert-none` on the latch cells (`always @*`), or Yosys's own `always_comb` error.                                          |
| `loop`           | `check -assert`: a combinational loop.                                                                                               |
| `multi-driver`   | `check -assert`: conflicting drivers.                                                                                                |
| `undriven`       | `check -assert`: a used net with no driver.                                                                                          |
| `check`          | `check -assert`: any other problem.                                                                                                  |
| `warnings`       | A `Warning:` line matching no reviewed entry. The numbers are kept, but the stage fails.                                             |
| `unmapped-cells` | Mapped flow: a generic cell survived mapping. Area is `unavailable`, because `stat -liberty` would leave that cell out and read low. |

Warnings are checked against `synth/warnings.allow`, read from the repository rather than the candidate's copy. The mapped flow accepts one more, reviewed in `MAPPED_WARNING_ALLOW`: ABC's note that it leaves multi-output cells out of mapping. That file belongs to Project 3 and isn't edited here.

### Failure classification

The first row that applies wins.

| Class                    | When                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `infrastructure-failure` | Yosys could not start (the message holds the `pnpm hardware:setup` hint), a named liberty file or a source file is missing, or `warnings.allow` is unreadable.   |
| `timeout`                | The stage overran `timeoutMs`. The process tree is killed.                                                                                                       |
| `unsupported-design`     | A failed gate.                                                                                                                                                   |
| `tool-failure`           | Anything else: a crash, an ABC failure, a non-zero exit with no `ERROR` line, or JSON that fails its schema or lacks the top module. The raw files stay on disk. |

Counts come from `stat -json`, validated with Zod, and never from console text. The log only decides why a run failed. `yosys -l` writes the log directly, so `maxLogBytes` caps `logs/` but not `yosys.log`.

An adapter given a bad module name, parameter or path, or an `outDir` inside `hardware/accelerators/matmul/`, rejects: that is misuse, not a result. Paths may not contain whitespace, quotes, `#`, `;` or `\`, because they are written into a Yosys script.

### Output directory

```text
<outDir>/
  logs/synth-<flow>-<n>-<label>.{stdout,stderr}.log
  generic/
    script.ys  generic.ys  yosys.log
    generic.stat.json  generic.mul.stat.json  generic.gates.stat.json  generic.stat.txt
    generic.ltp.txt  generic.memories.json  generic.json
  mapped/
    script.ys  mapped.ys  yosys.log
    mapped.ff.stat.json  mapped.stat.json  mapped.v  mapped.json
```

`artifacts` lists every file of the flow's directory with its size and SHA-256.

### Assumptions

- **Generic cells are counts, not area.** They are Yosys internal cells, with no physical size. `areaUm2` is `unavailable` in the generic flow.
- **Liberty area is an estimate.** `areaUm2` is the sum of the mapped standard cells' `area` attributes, `estimated`, method `yosys-stat-liberty`. It excludes wiring, routing, clock tree, buffers added later, and core utilisation.
- **Yosys reports no timing.** `logicDepthGates` is a gate count on the longest path, not a delay, and the flow sets no clock or drive constraints. Delay comes from static timing on `mapped.v`.
- **Mapped `matmul_top` builds its memories from flip-flops.** `synth` maps them, as there is no SRAM macro in the library. At 4 × 4 that is about 7.66 mm², 382k cells, a 52 MB netlist and 2 minutes. It describes a register file nobody would build, so read it only as a system-level comparison. The generic flow keeps memories as `$mem_v2` and counts their bits.
- **A PE is measured as its own top.** The generic count of a PE as top equals its in-context row in the 4 × 4 baseline: 1,008 cells, 50 flip-flops.
- **Results are per platform.** Yosys and ABC builds for another OS or CPU map some logic differently (see `mk/platform.mk`). The numbers above are from macOS arm64, and a run compares only with a baseline from the same platform. The integration test picks the baseline file as `mk/platform.mk` does. The Linux x64 PE-as-top count hasn't been measured.

### Tests

`src/yosys/yosys.test.ts` runs with no toolchain, on real outputs in `test/fixtures/`. `src/yosys/yosys.integration.test.ts` runs the real flows and skips without the pinned toolchain: it asserts the PE and 4 × 4 numbers against the baseline, a design failing each structural gate, and a mapped PE. The mapped test downloads the sky130hd typical-corner liberty from ORFS `v3.0` into the temporary directory, checks its SHA-256, and skips when offline. That file is not committed; vendoring it belongs to the sandbox image.
