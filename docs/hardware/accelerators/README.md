# INT8 matmul accelerator (Project 3)

Project 3 adds dedicated AI hardware to the monorepo: a synthesizable, parameterized INT8 × INT8 → INT32 matrix multiplication accelerator, built as an output-stationary systolic array of 4 × 4, 8 × 8 or 16 × 16 processing elements from one RTL, with tiling for any M × K · K × N up to 64. It is verified element by element against a TypeScript reference model, and every performance number in its reports comes from the RTL or from synthesis, never from the reference.

**Status: workspace and reference model.** The make workspace, the reference model, the vector format and the architecture contract exist. The processing element, the array, the buffers, the controller, the differential verification, synthesis and benchmarks are being built by the other Project 3 tickets; each adds its documents here.

Start with the [architecture contract](architecture.md): the numerics, the dataflow and its cycle-by-cycle timing, tiling, the buffers and host port, and the handshake that every RTL module implements.

## Documents

| Document                           | Contents                                                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md) | The contract: numerics and overflow, parameters and names, block diagram, ports, dataflow and a 4 × 4 cycle table, tiling, memory, handshake, what is measured |

Research results live outside `docs/`, in [research/accelerators/matmul/](../../../research/accelerators/matmul/README.md).

## Layout

```text
hardware/accelerators/matmul/
├── Makefile                 includes mk/*.mk; `make help` lists the targets; ROWS=4|8|16 picks the array size
├── REVISION                 the architecture revision (matmul-os-r1) every report records
├── mk/                      one make fragment per topic, added by later tickets
├── rtl/                     synthesizable RTL only; *_pkg.sv packages first
│   └── matmul_pkg.sv        DATA_W, ACC_W, MAX_DIM, error_code_t and ctrl_state_t
└── build/                   all outputs, per size (build/sim-8x8/, …), git-ignored
packages/accelerator-reference/
├── src/model/               the pure reference: matmul.ts (wrapping INT32 matmul, exact matmul, fitsInt32, validation),
│                            prng.ts (the seeded PRNG and the named matrix generators)
├── src/harness/             vectors.ts: the .in/.expected/.out text format, the JSON sidecar, output comparison
└── src/cli.ts               gen-vectors
research/accelerators/matmul/  committed small reports (see its README)
```

Later tickets add `tb/unit/` (unit testbenches), `tb/sim/` (the Verilator runner), `tb/wave/` (the GTKWave view), `synth/` (Yosys scripts and the reviewed warning allowlist) and `scripts/`.

## Building

The accelerator uses the same pinned OSS CAD Suite as Project 2 (`hardware/toolchain.env`), installed once with `pnpm hardware:setup`; Project 3 needs no other tools. It builds and tests on its own, independent of the Project 2 CPU.

```sh
pnpm install
pnpm hardware:setup                                   # once: OSS CAD Suite into ~/.cache/vcpu8
make -C hardware/accelerators/matmul help             # the targets
make -C hardware/accelerators/matmul tools-check      # tool versions -> build/tool-versions.json
make -C hardware/accelerators/matmul lint             # Verilator --lint-only -Wall over rtl/*.sv
make -C hardware/accelerators/matmul lint ROWS=16     # the same at 16 x 16
pnpm --filter @vcpu/accelerator-reference test        # the reference model's tests
pnpm accel:gen-vectors --seed 1 --m 13 --n 11 --k 19 --out hardware/accelerators/matmul/build/vectors
```

The root `package.json` has `accel:lint`, `accel:test`, `accel:simulate`, `accel:verify`, `accel:synth`, `accel:benchmark` and `accel:wave`, each `make -C hardware/accelerators/matmul <target>`, and `accel:gen-vectors`. A target a later ticket has not added yet fails with make's "No rule to make target".
