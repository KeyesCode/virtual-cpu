# CPU microarchitecture experiments

An experiment compares variants of the VCPU-8 RTL: the same ISA 1.0.0, built with different Verilog defines or parameters. Each variant must first pass the full differential verification against the TypeScript CPU. Only then is it benchmarked and synthesised, and the experiment writes one comparison of all of them. A variant that fails a stage is reported as failed, with no metrics.

```sh
make -C hardware/rtl/vcpu8 experiment NAME=smoke
```

[smoke/](smoke/experiment.json) is the smallest experiment: the committed design as its only variant. It proves that the plumbing works and that its numbers equal the committed baseline's.

[div-impl/](div-impl/README.md) is the first real one: the combinational divider against the iterative `vcpu8_divider` (parameter `DIV_ITER`), with the results and a recommendation.

## Adding an experiment

1. Make the alternative selectable in the RTL. Either use a define (`` `ifdef VCPU8_SOMETHING ``), or use an integer parameter, as `DIV_ITER` does. The default must be today's design, so nothing changes for a build without the flag. A parameter is set on each top-level module the flows build, so it must be declared on all three and passed down: `vcpu8_sim_top` (the runner), `vcpu8_top` (generic synthesis) and `vcpu8_fpga_wrapper` (the FPGA flows). A define needs no plumbing.
2. Create `research/cpu/experiments/<name>/experiment.json` (below).
3. Run `make -C hardware/rtl/vcpu8 experiment NAME=<name>` from a clean working tree.
4. Commit `experiment.json` and the `results/<date>-<shortsha>.{json,md}` it wrote. Nothing else from the run belongs in git.

Never change the ISA in an experiment. Every variant runs the same programs and must match `@vcpu/cpu-core` at every instruction boundary. If an idea needs a different ISA, it is a new project, not an experiment.

## experiment.json

```json
{
  "schemaVersion": 1,
  "description": "Combinational versus 8-iteration DIV: the cycle cost against the area and Fmax gain.",
  "verify": { "seed": 1, "count": 1000 },
  "baseline": "div-comb",
  "variants": [
    { "name": "div-comb", "description": "Combinational divider (the default)." },
    {
      "name": "div-iter",
      "description": "One quotient bit per clock.",
      "defines": {},
      "parameters": { "DIV_ITER": 1 }
    }
  ]
}
```

This is, apart from the descriptions, [div-impl/experiment.json](div-impl/experiment.json).

| Field                    | Meaning                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`          | `1`                                                                                                                                                             |
| `description`            | What the experiment asks, in one or two sentences                                                                                                               |
| `verify.seed`, `.count`  | The random programs every variant's `verify` runs, besides the fixtures, examples, directed programs and regressions (default seeds 1 … 1000, as `make verify`) |
| `baseline`               | The variant the comparison's deltas are against (default: the first)                                                                                            |
| `variants[].name`        | Lower-case letters, digits and dashes; unique                                                                                                                   |
| `variants[].description` | What is different                                                                                                                                               |
| `variants[].defines`     | `NAME: true` passes `-DNAME`; `NAME: <integer or identifier>` passes `-DNAME=value`. Verilator and Yosys get the same flags                                     |
| `variants[].parameters`  | `NAME: <integer>`: Verilator `-GNAME=value` on `vcpu8_sim_top`, and Yosys `chparam -set NAME value` on `vcpu8_top` and `vcpu8_fpga_wrapper`                     |

`ExperimentSpecSchema` in [packages/rtl-tools/src/bench/experiment.ts](../../../packages/rtl-tools/src/bench/experiment.ts) is the exact format; an experiment that does not match it stops before anything runs.

## What a run does

For each variant, in order:

1. **Build.** It builds the variant's RTL runner with Verilator into `hardware/rtl/vcpu8/build/variants/<hash>/sim/`. The hash is that of the defines and parameters. The build is reused when the core sources, the runner, Verilator and the flags are unchanged.
2. **Verify.** It runs `verify` on every corpus (fixtures, examples, `tb/programs`, `tb/regressions` and the random programs) with that runner, with full opcode and fault coverage required. A failure stops the variant here.
3. **Benchmark.** It runs the benchmark suite with the correctness gate, exactly as `make benchmark` does.
4. **Synth.** It runs `make synth` with `SYNTH_DIR=build/variants/<hash>/synth`, `SYNTH_DEFINES` and `SYNTH_PARAMS`, and with every gate of the normal synthesis. This is the slow step (about 15 s on an Apple M2 Pro), so it is reused when nothing it reads has changed: the core sources, the FPGA wrapper and pins, the Yosys scripts, the warning allowlist, the demo program, `mk/synth.mk`, the toolchain and the variant.

The full per-variant reports and logs go to `hardware/rtl/vcpu8/build/experiments/<name>/<variant>/` (`verify.log`, `benchmark.{json,md}` with the variant's own synthesis, `benchmark.log`) and `build/variants/<hash>/` (`synth.log`, `synth/summary.{json,md}`).

The comparison goes to `results/<date>-<shortsha>.json` and `.md` beside `experiment.json`. The JSON follows `ExperimentResultSchema` (`schemaVersion` 1, `kind` `vcpu8-experiment`). It records the experiment, the architecture revision, the git commit and dirty flag, the ISA version, the toolchain and tool versions, the verify and benchmark configuration and, per variant, its defines and parameters and hash, the stage it failed at (if any), the verify result, the suite's cycles, instructions and CPI, the DIV-heavy program (the one retiring the most DIV instructions) and its cycles, cycles per program, generic cells and flip-flops, and the generic logic depth (gates on the longest path, `ltp -noff`), and per FPGA flow the LUTs, flip-flops, Fmax and the suite's cycles / Fmax. The Markdown has the same comparison as tables, with deltas against the baseline variant.

`make experiment` exits 0 only when every variant passed every stage.
