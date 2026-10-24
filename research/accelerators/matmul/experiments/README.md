# Matmul accelerator experiments

An experiment compares variants of the INT8 matmul accelerator RTL. Every variant is the same `matmul-os-r1` design built with different top-level parameters (and, once the RTL has any, Verilog defines). Each variant must first pass differential verification against `@vcpu/accelerator-reference`. Only then is it benchmarked and synthesised. The experiment then writes one comparison of all the variants, which names the Pareto-optimal ones on total cycles and generic cells. A variant that fails a stage is reported as failed, with no metrics.

```sh
make -C hardware/accelerators/matmul experiment NAME=array-size
```

| Experiment                                   | Question                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [array-size](array-size/README.md)           | 4 × 4 versus 8 × 8 versus 16 × 16 PEs: the cycles a larger array saves against the logic it costs          |
| [buffer-capacity](buffer-capacity/README.md) | MAX_DIM 32 versus 64 versus 128 on the 8 × 8 array: cells and memory bits against the largest workload run |

## Adding an experiment

1. Make sure the knob you want to vary exists (see [the knobs](#the-knobs)). A new knob is RTL work first: a parameter must be declared on all three tops the flows build and passed down. Those tops are `matmul_sim_top` (the Verilator runner), `matmul_top` (generic synthesis) and `matmul_fpga_wrapper` (the FPGA flows). A define needs no plumbing. Its default must be today's design, so a build without it is unchanged.
2. Create `research/accelerators/matmul/experiments/<name>/experiment.json` (below) and a `README.md` that states the question.
3. Commit, then run `make -C hardware/accelerators/matmul experiment NAME=<name>` from the clean working tree. The run is refused from a dirty tree, because its commit must identify exactly the design it measured. `ALLOW_DIRTY=1` overrides the refusal for a run that is not to be committed.
4. Commit the `results/<date>-<shortsha>.{json,md}` it wrote and the answer in the README, in two or three sentences with numbers from the result. Nothing else from the run belongs in git.

An experiment never changes the numerics, the dataflow contract or the host interface. If an idea changes what the accelerator computes or how a host talks to it, it needs a new architecture revision ([../README.md](../README.md#the-architecture-revision)). It is not an experiment.

## experiment.json

```json
{
  "schemaVersion": 1,
  "id": "array-size",
  "description": "4 × 4 versus 8 × 8 versus 16 × 16 processing elements …",
  "verify": { "seed": 1, "count": 40 },
  "benchmark": { "seed": 1 },
  "baseline": "8x8",
  "variants": [
    { "name": "4x4", "description": "16 PEs.", "parameters": { "ROWS": 4, "COLS": 4 } },
    { "name": "8x8", "description": "64 PEs.", "parameters": { "ROWS": 8, "COLS": 8 } },
    { "name": "16x16", "description": "256 PEs.", "parameters": { "ROWS": 16, "COLS": 16 } }
  ]
}
```

This is, apart from the description, [array-size/experiment.json](array-size/experiment.json).

| Field                    | Meaning                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`          | `1`                                                                                                                                                                                                                 |
| `id`                     | The experiment's name, lower-case letters, digits and dashes; it must equal the directory name. The result's experiment ID is `<id>/<date>-<shortsha>`                                                              |
| `description`            | What the experiment asks, in a sentence or two                                                                                                                                                                      |
| `verify.seed`, `.count`  | The random cases each variant's verify runs besides the directed corpus (default seed 1, 40 cases, as `make verify`)                                                                                                |
| `benchmark.seed`         | The operand seed of the benchmark workloads (default 1, as `make benchmark`)                                                                                                                                        |
| `workloads`              | Optional: the workloads, `{ "m", "k", "n", "what" }` (A is M × K, B is K × N), in place of the benchmark's own nine. A workload with a dimension above a variant's MAX_DIM is not supported by that variant (below) |
| `baseline`               | The variant the comparison's deltas are against (default: the first)                                                                                                                                                |
| `variants[].name`        | Lower-case letters, digits and dashes; unique                                                                                                                                                                       |
| `variants[].description` | What is different                                                                                                                                                                                                   |
| `variants[].parameters`  | `NAME: <integer>`: Verilator `-GNAME=value` on `matmul_sim_top` and Yosys `chparam -set NAME value` on `matmul_top` and `matmul_fpga_wrapper`. `ROWS` is required; `COLS` defaults to `ROWS`, `MAX_DIM` to 64       |
| `variants[].defines`     | `NAME: true` passes `-DNAME`; `NAME: <integer or identifier>` passes `-DNAME=value`. Verilator and Yosys get the same flags                                                                                         |

`ExperimentSpecSchema` in [packages/accelerator-reference/src/harness/experiment.ts](../../../../packages/accelerator-reference/src/harness/experiment.ts) is the exact format. A spec that does not match it stops the run before anything is built.

## The knobs

| Knob                  | Status          | What it changes                                                                                                                                                                                                                                                                                                                     |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROWS`, `COLS`        | implemented     | The PE array. Powers of two from 2 to MAX_DIM, and `COLS` must equal `ROWS`, because the synthesis flow builds square arrays                                                                                                                                                                                                        |
| `MAX_DIM`             | implemented     | The largest M, N or K, and with it every buffer: A, B and C each hold MAX_DIM × MAX_DIM elements. It must be 32, 64 or 128. The FPGA wrapper writes the address a byte at a time (the bits above 8 in a second byte) and each dimension as one byte, which bounds it at both ends                                                   |
| K-chunk size          | **future work** | Split K into chunks and accumulate partial sums in the output buffer (read-modify-write), so the accumulators are freed between chunks. r1 streams the whole K through the array for each output tile and never writes partial sums ([architecture.md](../../../../docs/hardware/accelerators/architecture.md)). Not in the RTL yet |
| Weight-stationary     | **future work** | A different dataflow: B held in the PEs, A and the partial sums moving. A new architecture revision with its own prefix, not a parameter of r1. Not in the RTL yet                                                                                                                                                                  |
| Store/compute overlap | **future work** | Store a finished tile while the next one computes (double-buffered accumulators). r1 starts a tile only after the previous one is stored. Not in the RTL yet                                                                                                                                                                        |

A variant whose parameters break these rules is reported as failed at the `config` stage, and the other variants still run. Any other parameter passes straight through to Verilator and Yosys, so it fails at `build` or `synth` unless all three tops declare it.

## What a run does

For each variant, in order:

1. **Config.** It checks the parameters against the rules above.
2. **Build.** It builds the variant's runner with `make sim-variant` ([mk/sim.mk](../../../../hardware/accelerators/matmul/mk/sim.mk)) into `hardware/accelerators/matmul/build/variants/<hash>/sim/`. The hash is that of the parameters (with the defaults filled in) and the defines, so the name and description do not change it. Make reuses the build while the RTL and the runner are unchanged.
3. **Verify.** It runs differential verification on that runner, exactly as `make verify` does: the directed corpus (at the variant's MAX_DIM, so the capacity cases use the variant's own capacity) and `verify.count` random cases from `verify.seed`. Every element of C must equal the reference. A failure stops the variant here.
4. **Benchmark.** It runs the workloads with the benchmark's correctness gate, as `make benchmark` does. A workload with M, K or N above the variant's MAX_DIM is not run. It is recorded as "not supported by this variant", which is a property of the design, not a failure.
5. **Synth.** It runs `make synth` for the variant's size, with `SYNTH_ROOT=build/variants/<hash>`, `SYNTH_PARAMS` (every parameter but ROWS and COLS) and `SYNTH_DEFINES` ([mk/synth.mk](../../../../hardware/accelerators/matmul/mk/synth.mk)). That is the generic Yosys flow on `matmul_top`, then iCE40 and ECP5 synthesis and place and route of the FPGA wrapper, with every gate of the normal synthesis and the same settings, frequency target and nextpnr seed. A design that does not fit an FPGA is a result (`fits: false`), not a failure. If Yosys or nextpnr-ice40 is missing, the stage is skipped with the reason and the variant is reported as incomplete.

The full reports and logs stay in the git-ignored `build/`. Each variant's `verify/verify.{json,md}` and `benchmark/benchmark.{json,csv,md}` go to `build/experiments/<id>/<variant>/`, beside `verify.log` and `benchmark.log`. The build and synthesis logs go to `build/variants/<hash>/` (`sim-build.log`, `sim/build.log`, `synth.log`), along with `synth/summary.{json,md}`. Synthesis is the slow stage, and the 16 × 16 array takes the longest: a full `array-size` run took about five minutes on an Apple M-series laptop, with 16 × 16 synthesis more than three of them. The results record the seconds per stage.

`make experiment` exits 0 when no variant failed a stage, and 1 when one did. The comparison is still written and names the variant and the stage.

## The results

`results/<date>-<shortsha>.json` (the UTC date and the commit) follows `ExperimentResultSchema`, `schemaVersion` 1, `kind` `matmul-experiment`. It records:

- the experiment ID, the architecture revision and the labels that say what MACs, cycles, utilisation and synthesis counts are;
- the verify and benchmark configuration, with every workload, and the baseline;
- per variant: its parameters, defines and hash, the status of every stage, and the stage it failed at, if any;
- per variant that passed:
  - the verify result;
  - every workload's benchmark metrics, or why it is not supported;
  - the generic synthesis counts: cells, flip-flops, `$mul` cells, memory banks and bits, abstract gates and logic depth;
  - per FPGA flow, whether it fits, the mapped LUTs, flip-flops, block RAM and DSP, and nextpnr's Fmax estimate where it fits;
  - the allowlisted synthesis warnings;
- the Pareto section;
- the provenance: the creation time, the git commit and dirty flag, the toolchain and tool versions, and the host's wall-clock seconds per stage.

`results/<date>-<shortsha>.md` has the same comparison:

- a summary table;
- one table per benchmark metric, with workloads down and variants across: total cycles, compute cycles, PE utilisation and MACs per cycle;
- the generic synthesis and FPGA tables;
- the Pareto-optimal variants.

Every number of a variant other than the baseline carries its delta against the baseline, wherever the baseline has that number too (a workload above the baseline's MAX_DIM has none).

Everything except `provenance` is deterministic for a given commit: the seeds are fixed, nextpnr runs with a fixed seed, and the toolchain is pinned. A rerun of the same commit gives the same file apart from the run ID, the experiment ID and the provenance.

## The Pareto rule

The comparison names the Pareto-optimal variants on two axes, both lower is better:

1. total cycles, summed over the common workloads (those every passed variant ran);
2. generic Yosys cells.

A variant is Pareto-optimal when no other variant has at most its cycles and at most its cells and fewer of one. Failed and incomplete variants are left out. Two variants with identical numbers are both optimal.

The two axes deliberately leave things out. The rule says nothing about capacity, so in `buffer-capacity` the smallest buffer is optimal although it runs fewer workloads (its README says what that means). It says nothing about Fmax either, so a faster array that fits no FPGA can still be optimal. Read the frontier together with the tables.

**Power is never a ranking axis.** There is no compatible power estimation flow, so every report says power is "not measured". No variant is ranked, filtered or recommended on power.
