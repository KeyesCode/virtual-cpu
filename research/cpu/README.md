# VCPU-8 CPU research data

This folder holds small, committed summaries of measurements on the VCPU-8 RTL, so that a change to the design shows up as a reviewable diff. Raw tool output does not belong here: full logs, netlists, waveforms, runner traces and per-variant builds stay in `hardware/rtl/vcpu8/build/`, which is git-ignored and rebuilt by the make targets.

Every file here is written by a make target, never by hand, and records the git commit and tool versions it came from. Every number in it comes from a command that was actually run.

| Path                                                     | Written by                                          | Contents                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [synth/baseline.json](synth/baseline.json)               | `make -C hardware/rtl/vcpu8 synth-baseline`         | The synthesis summary: generic Yosys cell, flip-flop and gate counts, logic depth, memory inference, iCE40 and ECP5 utilisation, nextpnr Fmax estimates and the reviewed warnings                              |
| [synth/baseline.md](synth/baseline.md)                   | `make -C hardware/rtl/vcpu8 synth-baseline`         | The same summary as tables                                                                                                                                                                                     |
| `reports/<date>-<shortsha>-<variant>.json`               | `make -C hardware/rtl/vcpu8 benchmark-baseline`     | An RTL benchmark report (schema below): cycles, retired instructions, CPI, cycles per class and opcode, branches, calls, returns and data accesses of every benchmark program, gated on the differential check |
| `reports/<date>-<shortsha>-<variant>.md`                 | `make -C hardware/rtl/vcpu8 benchmark-baseline`     | The same report as tables                                                                                                                                                                                      |
| `experiments/<name>/experiment.json`                     | by hand: the variants an experiment compares        | Design variants (Verilog defines and parameters) to verify, benchmark and synthesise; [experiments/README.md](experiments/README.md) documents the format                                                      |
| `experiments/<name>/results/<date>-<shortsha>.{json,md}` | `make -C hardware/rtl/vcpu8 experiment NAME=<name>` | The comparison of an experiment's variants: verify result, total cycles, CPI, the DIV-heavy program's cycles, cells, flip-flops, LUTs and Fmax                                                                 |

`make -C hardware/rtl/vcpu8 synth-compare` reruns synthesis and prints every difference from the committed baseline. Rewrite the baseline only on purpose, with `make synth-baseline`, and commit it together with the change that moved the numbers. [docs/hardware/synthesis-guide.md](../../docs/hardware/synthesis-guide.md) explains what each figure means and what it does not.

`make -C hardware/rtl/vcpu8 benchmark-compare` reruns the benchmark and fails unless its modelled numbers equal the newest committed `reports/*-default.json` byte for byte. [docs/hardware/performance-analysis.md](../../docs/hardware/performance-analysis.md) explains the benchmark numbers.

## What gets committed

Only small JSON and Markdown reports: the synthesis baseline, benchmark reports and experiment results. Never commit raw logs, netlists, waveforms (`.vcd`, `.fst`), runner traces or build directories; they are all under `hardware/rtl/vcpu8/build/`, which `.gitignore` excludes. Commit a report from a clean working tree, so its `git.dirty` (or `gitDirty`) is `false` and its commit identifies exactly the design it measured. A report from a dirty tree is still written, with `dirty: true`, but should not be committed.

## The architecture revision

`hardware/rtl/vcpu8/REVISION` names the microarchitecture, for example `vcpu8-mc-r1` (VCPU-8, multicycle, revision 1). Every benchmark report and experiment result records it, so numbers from different designs are never mistaken for each other.

Bump the number (`vcpu8-mc-r2`, …) in the same commit as any change that is visible in cycles: a state added to or removed from the FSM, an instruction that takes a different number of clocks, a different memory interface. A change that leaves every cycle count unchanged (a refactor, a lint fix, a timing improvement) keeps the revision; the git commit tells those apart. A different microarchitecture family (for example a pipelined design) gets a new prefix, such as `vcpu8-pl-r1`. Variants chosen by an experiment's defines or parameters do not change the revision: the report records the variant separately. The ISA version never changes with the revision; it stays 1.0.0.

## The benchmark report

`make -C hardware/rtl/vcpu8 benchmark` writes `build/reports/benchmark.{json,md}`. The JSON follows `RtlBenchmarkReportSchema` in [packages/rtl-tools/src/bench/report.ts](../../packages/rtl-tools/src/bench/report.ts), `schemaVersion` 1, `kind` `vcpu8-rtl-benchmark`. Fields are only ever added; removing or redefining one bumps `schemaVersion`.

| Field          | Contents                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revision`     | `hardware/rtl/vcpu8/REVISION`                                                                                                                                                   |
| `isaVersion`   | `ISA_VERSION` from `@vcpu/shared` (1.0.0)                                                                                                                                       |
| `variant`      | Name, description, Verilog defines and parameters, and their 12-digit hash; `default` is the committed design                                                                   |
| `labels`       | What the RTL cycles, the instructional-model cycles and the time estimates are, written into every report                                                                       |
| `config`       | The program set (`examples/`, the `@vcpu/benchmarks` suite), each program's step limit and the correctness gate                                                                 |
| `verification` | Whether the correctness gate passed, and which programs failed it                                                                                                               |
| `synthesis`    | From a synthesis summary: its commit, generic Yosys cells and flip-flops, and per FPGA flow the device, timing model, LUTs, flip-flops, block RAM and Fmax; or why it is absent |
| `totals`       | Suite totals: cycles, instructions, CPI, cycles per class and opcode, branch, call, return and data counts; `null` unless every program passed                                  |
| `programs`     | Per program: the RTL metrics, the emulator's instructional-model estimate and cycles / Fmax per FPGA flow; or, for a program that failed the gate, the reason and no numbers    |
| `provenance`   | When, the git commit and dirty flag, the runner, the toolchain and tool versions (from `build/tool-versions.json`)                                                              |
| `host`         | Simulator wall-clock time per program, on this machine: it measures the simulator, not the processor                                                                            |

Everything except `provenance` and `host` is modelled processor behaviour and is deterministic: two runs of the same design give byte-identical JSON once those two sections are removed, which `rtl-tools benchmark-compare` checks.
