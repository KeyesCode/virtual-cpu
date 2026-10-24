# INT8 matmul accelerator (Project 3)

Project 3 adds dedicated AI hardware to the monorepo: a synthesizable, parameterized INT8 × INT8 → INT32 matrix multiplication accelerator, built as an output-stationary systolic array of 4 × 4, 8 × 8 or 16 × 16 processing elements from one RTL, with tiling for any M × K · K × N up to 64. It is verified element by element against a TypeScript reference model, and every performance number in its reports comes from the RTL or from synthesis, never from the reference.

**Status: the complete tiled accelerator RTL, differentially verified and synthesized.** The make workspace, the reference model, the vector format, the architecture contract, the verified processing element, the verified 4 × 4 / 8 × 8 / 16 × 16 systolic array, and the buffers, controller and `matmul_top`, verified on tiled matmuls of any M × K · K × N up to 64 at every size, exist, with the Verilator runner and the differential verification (`make verify`: the directed corpus and 120 seeded random products across 4 × 4, 8 × 8 and 16 × 16, compared element by element, and six RTL mutants it must catch), and all three sizes synthesize ([synthesis guide](synthesis-guide.md)); `make wave` records any run as a GTKWave waveform ([simulation guide](simulation-guide.md)). Benchmarks are being built by the other Project 3 tickets; each adds its documents here.

Start with the [architecture contract](architecture.md): the numerics, the dataflow and its cycle-by-cycle timing, tiling, the buffers and host port, and the handshake that every RTL module implements.

New to hardware? Read [concepts.md](concepts.md) first, then [from-rtl-to-silicon.md](from-rtl-to-silicon.md): together they explain the fifteen topics below in plain language, with worked examples in this design's numbers.

## Topics

| #   | Topic                                     | Document and section                                                                               |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Matrix multiplication fundamentals        | [concepts.md § 1](concepts.md#1-matrix-multiplication-fundamentals)                                |
| 2   | Why AI models use matrix operations       | [concepts.md § 2](concepts.md#2-why-ai-models-use-matrix-operations)                               |
| 3   | What a multiply-accumulate unit is        | [concepts.md § 3](concepts.md#3-what-a-multiply-accumulate-unit-is)                                |
| 4   | How a systolic array works                | [concepts.md § 4](concepts.md#4-how-a-systolic-array-works)                                        |
| 5   | How operands move between PEs             | [concepts.md § 5](concepts.md#5-how-operands-move-between-processing-elements)                     |
| 6   | Output-stationary dataflow                | [concepts.md § 6](concepts.md#6-output-stationary-dataflow)                                        |
| 7   | Tiling                                    | [concepts.md § 7](concepts.md#7-tiling)                                                            |
| 8   | Why memory bandwidth matters              | [concepts.md § 8](concepts.md#8-why-memory-bandwidth-matters)                                      |
| 9   | Why utilisation matters                   | [concepts.md § 9](concepts.md#9-why-utilisation-matters)                                           |
| 10  | How arithmetic precision affects hardware | [concepts.md § 10](concepts.md#10-how-arithmetic-precision-affects-hardware)                       |
| 11  | How RTL becomes digital logic             | [from-rtl-to-silicon.md § 11](from-rtl-to-silicon.md#11-how-rtl-becomes-digital-logic)             |
| 12  | How to interpret synthesis reports        | [from-rtl-to-silicon.md § 12](from-rtl-to-silicon.md#12-how-to-interpret-synthesis-reports)        |
| 13  | How to compare accelerator designs fairly | [from-rtl-to-silicon.md § 13](from-rtl-to-silicon.md#13-how-to-compare-accelerator-designs-fairly) |
| 14  | What FPGA implementation requires         | [from-rtl-to-silicon.md § 14](from-rtl-to-silicon.md#14-what-fpga-implementation-requires)         |
| 15  | What ASIC fabrication requires            | [from-rtl-to-silicon.md § 15](from-rtl-to-silicon.md#15-what-asic-fabrication-requires)            |

## Documents

| Document                                                             | Contents                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [concepts.md](concepts.md)                                           | Topics 1–10 for a programmer new to hardware: matmul, why AI uses it, the MAC, the systolic array, operand movement, output-stationary dataflow, tiling, bandwidth, utilisation, precision |
| [from-rtl-to-silicon.md](from-rtl-to-silicon.md)                     | Topics 11–15: how RTL becomes logic (the PE as the example), reading synthesis reports, fair comparison rules, what an FPGA build and an ASIC would require                                |
| [architecture.md](architecture.md)                                   | The contract: numerics and overflow, parameters and names, block diagram, ports, dataflow and a 4 × 4 cycle table, tiling, memory, handshake, what is measured                             |
| [processing-element.md](processing-element.md)                       | The MAC cell: ports, one-clock timing, the overflow rule, why there is no stall port, the synthesis preview and its unit-test evidence                                                     |
| [systolic-array.md](systolic-array.md)                               | The PE grid: dataflow, internal skew registers, the `tile_start` / `busy` / `tile_done` protocol, a traced 4 × 4 K = 3 tile, utilisation, unit-test evidence                               |
| [controller.md](controller.md)                                       | The FSM and `matmul_top`: states, tile order, how K is handled, edge masks, read latency, handshake timing, cycle formulas and their measured values, `test-top` evidence                  |
| [memory.md](memory.md)                                               | The buffers and the host port: sizes, layout, banking, bandwidth, read/write timing, maximum dimensions, transfer overhead, the RAM inference check                                        |
| [synthesis-guide.md](synthesis-guide.md)                             | Yosys and nextpnr for 4 × 4, 8 × 8 and 16 × 16: the flows, the FPGA wrapper, cells, multipliers, memories, logic depth, fit and Fmax estimates, warnings, baseline                         |
| [verification-strategy.md](verification-strategy.md)                 | The layers of checks, the Verilator runner and its clock breakdown, the directed and random corpora, reports, failure replay, the mutants and what is not covered                          |
| [simulation-guide.md](simulation-guide.md)                           | Running a case, `make wave` / `wave-check`, the GTKWave view, and the demo product clock by clock: skew, accumulators, drain, store, the 4 tile boundaries and the done pulse              |
| [images/systolic-4x4-dataflow.svg](images/systolic-4x4-dataflow.svg) | Diagram: operand flow through the 4 × 4 array, its skew registers, and four clocks of a K = 2 tile                                                                                         |
| [images/systolic-4x4.html](images/systolic-4x4.html)                 | Animated page (open from disk): the 4 × 4 K = 3 tile clock by clock, operands, skew registers and accumulators                                                                             |

Research results live outside `docs/`, in [research/accelerators/matmul/](../../../research/accelerators/matmul/README.md).

## Layout

```text
hardware/accelerators/matmul/
├── Makefile                 includes mk/*.mk; `make help` lists the targets; ROWS=4|8|16 picks the array size
├── REVISION                 the architecture revision (matmul-os-r1) every report records
├── mk/                      one make fragment per topic (unit-pe.mk: gen-pe-vectors, test-pe, test-pe-corrupt;
│                            unit-array.mk: test-array, test-array-4|8|16|4x8, test-array-corrupt, trace-array;
│                            unit-top.mk: test-top, test-top-4|8|16|4x8, test-top-corrupt;
│                            synth.mk: synth, synth-size-4|8|16, synth-baseline, synth-compare, synth-latch-check;
│                            sim.mk: sim, sim-all, simulate; verify.mk: verify, verify-size, replay, verify-mutant;
│                            wave.mk: sim-trace, wave, wave-check)
├── scripts/tool-versions.sh `make tools-check`: tool versions to build/tool-versions.json
├── scripts/mutants.txt      the RTL mutants `make verify-mutant` requires verify to catch
├── rtl/                     synthesizable RTL only; *_pkg.sv packages first
│   ├── matmul_pkg.sv        DATA_W, ACC_W, MAX_DIM, ADDR_W, error_code_t and ctrl_state_t
│   ├── processing_element.sv the INT8 × INT8 → INT32 MAC cell with operand forwarding
│   ├── systolic_array.sv    ROWS × COLS PEs, the input skew registers and tile_done
│   ├── input_buffer.sv      a banked A or B buffer (RAM per bank) with the host write port
│   ├── output_buffer.sv     the C buffer (one RAM) with the host read port
│   ├── matmul_controller.sv the FSM: dimension checks, tile schedule, buffer reads, edge masks, stores
│   └── matmul_top.sv        the accelerator: controller, buffers and array, with the host port
├── tb/unit/                 unit testbenches (tb_processing_element.sv, tb_systolic_array.sv, tb_matmul_top.sv)
├── tb/sim/                  the Verilator runner: matmul_sim_top.sv (matmul_top + its size) and matmul_sim.cpp
├── tb/wave/                 the GTKWave view: matmul.gtkw, the generated filters ctrl_state.txt and error_code.txt,
│                            and the waveform demo case demo.in / demo.expected
├── synth/                   Yosys scripts (generic.ys, ice40.ys, ecp5.ys) and the reviewed warnings.allow
└── build/                   all outputs, per size (build/sim-8x8/, …), git-ignored
packages/accelerator-reference/
├── src/model/               the pure reference: matmul.ts (wrapping INT32 matmul, exact matmul, fitsInt32, validation),
│                            prng.ts (the seeded PRNG and the named matrix generators), pe.ts (the clock-level PE)
├── src/harness/             vectors.ts: the .in/.expected/.out text format, the JSON sidecar, output comparison;
│                            pe-vectors.ts: the PE unit-test vectors; tile-vectors.ts: the array tile suites;
│                            top-vectors.ts: the matmul_top suites; synth-summary.ts: the synthesis summary and compare;
│                            verify.ts: the verify corpora, runner pool, comparison, failures and replay;
│                            report.ts: report schemas and provenance; mutants.ts: verify-mutant;
│                            wave.ts: the demo case, the VCD reader, wave-check and wave-table;
│                            wave-filters.ts: the GTKWave filters from matmul_pkg
├── src/viz/                 schedule.ts: the documented tile timing rule for the visualizations; svg.ts, page.ts: gen-viz
└── src/cli.ts               gen-vectors, gen-pe-vectors, gen-tile-vectors, gen-tile-suite, gen-top-suite, gen-viz,
                             synth-summary, synth-compare, verify, mutants, gen-wave-filters, gen-wave-demo,
                             wave-check, wave-table
hardware/fpga/matmul_fpga_wrapper.sv, matmul_up5k_sg48.pcf   the pin-legal top and iCE40 pins of the FPGA flows
research/accelerators/matmul/  committed small reports (see its README)
```

## Building

The accelerator uses the same pinned OSS CAD Suite as Project 2 (`hardware/toolchain.env`), installed once with `pnpm hardware:setup`; Project 3 needs no other tools. `tools-check` requires Verilator, Yosys, nextpnr-ice40 and nextpnr-ecp5 (GTKWave optional). `ROWS` and `COLS` must be powers of two from 2 to 64; any other value stops make with an error. It builds and tests on its own, independent of the Project 2 CPU.

```sh
pnpm install
pnpm hardware:setup                                   # once: OSS CAD Suite into ~/.cache/vcpu8
make -C hardware/accelerators/matmul help             # the targets
make -C hardware/accelerators/matmul tools-check      # tool versions -> build/tool-versions.json
make -C hardware/accelerators/matmul lint             # Verilator --lint-only -Wall over rtl/*.sv
make -C hardware/accelerators/matmul lint ROWS=16     # from matmul_top at 16 x 16
make -C hardware/accelerators/matmul test-pe          # the processing element against the reference, cycle by cycle
make -C hardware/accelerators/matmul test-top         # whole tiled matmuls through matmul_top at 4x4, 8x8, 16x16 and 4x8
make -C hardware/accelerators/matmul sim-all          # the Verilator runner at 4x4, 8x8 and 16x16 (build/sim-<R>x<C>/matmul_sim)
make -C hardware/accelerators/matmul simulate ROWS=8 CASE=<file.in>  # one case: clock breakdown, C checked against <name>.expected
make -C hardware/accelerators/matmul verify           # differential verification (SEED=1 COUNT=40 per size)
make -C hardware/accelerators/matmul verify-mutant    # every RTL mutant in scripts/mutants.txt must be caught
make -C hardware/accelerators/matmul test             # every registered unit test
make -C hardware/accelerators/matmul synth            # Yosys + nextpnr for 4x4, 8x8 and 16x16 -> build/synth/summary.{json,md}
make -C hardware/accelerators/matmul wave             # the demo's waveform -> build/waves/demo.fst (see simulation-guide.md)
make -C hardware/accelerators/matmul wave-check       # the demo's waveform has every signal, 4 tile_done pulses and 1 done
pnpm --filter @vcpu/accelerator-reference test        # the reference model's tests
pnpm accel:gen-vectors --seed 1 --m 13 --n 11 --k 19 --out hardware/accelerators/matmul/build/vectors
```

The root `package.json` has `accel:lint`, `accel:test`, `accel:simulate`, `accel:verify`, `accel:synth`, `accel:benchmark` and `accel:wave`, each `make -C hardware/accelerators/matmul <target>`, and `accel:gen-vectors`. A target a later ticket has not added yet fails with make's "No rule to make target".
