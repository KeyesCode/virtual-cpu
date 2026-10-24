# INT8 matmul accelerator research data

This folder holds small, committed summaries of measurements on the INT8 matmul accelerator RTL (Project 3), so that a change to the design shows up as a reviewable diff. Raw tool output does not belong here: full logs, netlists, waveforms, runner outputs and per-size builds stay in `hardware/accelerators/matmul/build/`, which is git-ignored and rebuilt by the make targets.

Every file here is written by a make target, never by hand, and records the git commit, the architecture revision, the array size and the tool versions it came from. Every number in it comes from a command that was actually run: cycle counts from the Verilator runner, resources from Yosys, Fmax estimates from nextpnr for a named FPGA. Simulator wall-clock time is never reported as hardware speed, and power is "not measured".

The Project 3 tickets add reports here, and each documents its files in the table below:

| Path                  | Written by                                  | Contents                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `synth/baseline.*`    | `make synth-baseline` (`make synth`)        | Generic, iCE40 and ECP5 resource and timing summaries of the 4 × 4, 8 × 8 and 16 × 16 arrays; `make synth-compare` fails on any difference from it ([synthesis guide](../../../docs/hardware/accelerators/synthesis-guide.md)) |
| `reports/`            | the benchmark ticket (`make benchmark`)     | Compute, transfer and total cycles, MACs, PE utilisation and MACs per clock of the benchmark workloads                                                                                                                         |
| `experiments/<name>/` | the design-space ticket (`make experiment`) | The configurations an experiment compares, and its results with the Pareto-optimal designs                                                                                                                                     |
| `cpu-comparison/`     | the CPU comparison ticket                   | VCPU-8 against the accelerator on the same tiny INT8 matmul workloads                                                                                                                                                          |

## What gets committed

Only small JSON, Markdown and CSV reports. Never commit raw logs, netlists, waveforms (`.vcd`, `.fst`), test vectors, runner outputs or build directories. Commit a report from a clean working tree, so its dirty flag is `false` and its commit identifies exactly the design it measured.

Every report is JSON with a zod schema and `schemaVersion: 1` (fields are only ever added; removing or redefining one bumps it), plus a Markdown rendering, and records `revision`, the git commit and dirty flag, the array size (`ROWS` × `COLS`) and the `build/tool-versions.json` provenance. A MAC is one multiply plus one accumulate, and reports count MACs.

## The architecture revision

`hardware/accelerators/matmul/REVISION` names the microarchitecture: `matmul-os-r1` (matmul, output-stationary, revision 1). Bump the number in the same commit as any change that is visible in cycles (a controller state added or removed, a different skew, a different buffer interface). A change that leaves every cycle count unchanged keeps the revision; the git commit tells those apart. A different dataflow (for example weight-stationary) gets a new prefix. The array size is a parameter, not a revision: reports record it separately. [docs/hardware/accelerators/architecture.md](../../../docs/hardware/accelerators/architecture.md) is the contract for `matmul-os-r1`.
