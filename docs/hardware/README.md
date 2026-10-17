# VCPU-8 Hardware (Project 2)

Project 2 rebuilds VCPU-8 (ISA 1.0.0, frozen) as a synthesizable multicycle SystemVerilog CPU that matches the TypeScript emulator at every instruction boundary. These documents describe the RTL, how it is verified and how to build it.

Start with the Project 1 hand-off, [hardware-porting.md](../hardware-porting.md), and with the [ISA compatibility audit](isa-compatibility.md), which fixes exactly which ISA the RTL implements.

## Documents

| Document                                                 | Status  | Contents                                                                                                        |
| -------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| [isa-compatibility.md](isa-compatibility.md)             | written | ISA version, opcode table, state, faults, doc-vs-code checks, brief discrepancies                               |
| [vcpu8-microarchitecture.md](vcpu8-microarchitecture.md) | written | Module hierarchy, how the RTL maps to logic, clock and reset, measured clocks per instruction, running programs |
| [datapath.md](datapath.md)                               | written | Registers, multiplexers and how an instruction moves through them                                               |
| [control-unit.md](control-unit.md)                       | written | The decoder; the multicycle FSM, fault detection and priority, retirement                                       |
| [alu.md](alu.md)                                         | written | ALU equations, flags, MUL and DIV implementation, exhaustive verification                                       |
| [register-file.md](register-file.md)                     | written | Register file and FLAGS: flip-flops, ports, read-during-write, reset                                            |
| [memory-interface.md](memory-interface.md)               | written | The 256 × 8 synchronous RAM: timing, port sharing, read-first, loading, debug and FPGA memory                   |
| `verification-strategy.md`                               | planned | Unit tests, fixtures, differential and random testing, formal properties                                        |
| `simulation-guide.md`                                    | planned | Running simulations, waveforms and GTKWave                                                                      |
| `synthesis-guide.md`                                     | planned | Yosys and nextpnr flows and their reports                                                                       |
| `performance-analysis.md`                                | planned | RTL cycle counts and CPI, compared with the instructional timing model                                          |
| `fpga-readiness.md`                                      | planned | What remains before the design runs on an FPGA                                                                  |

Each planned document is written by the ticket that builds the part it describes.

## Layout

```text
hardware/
├── toolchain.env              pinned OSS CAD Suite release and per-platform sha256
├── scripts/setup-toolchain.sh the installer behind `pnpm hardware:setup`
└── rtl/vcpu8/
    ├── Makefile               includes mk/*.mk; `make help` lists the targets
    ├── mk/                    one make fragment per topic (isa.mk, …)
    ├── core/                  synthesizable RTL; *_pkg.sv packages first
    │   ├── vcpu8_isa_pkg.sv   GENERATED from @vcpu/shared, committed, drift-checked
    │   ├── vcpu8_types_pkg.sv microarchitecture types (alu_op_t, decoder selects, FSM states), hand-written
    │   ├── vcpu8_decoder.sv   combinational decoder: opcode and register byte → control signals
    │   ├── vcpu8_control.sv   the multicycle FSM: PC, SP, SD, IR, faults, retirement
    │   ├── vcpu8_core.sv      control, decoder, registers, FLAGS and ALU, and the datapath muxes
    │   └── vcpu8_top.sv       the core plus vcpu8_memory: the whole CPU
    ├── tb/                    testbenches and probes (simulation only)
    │   ├── unit/              self-checking unit testbenches (tb_vcpu8_*.sv)
    │   └── sim/               the RTL program runner: vcpu8_sim.cpp and its wrapper vcpu8_sim_top.sv
    ├── scripts/               helper scripts for the make targets
    └── build/                 all outputs (git-ignored)
packages/rtl-tools/            @vcpu/rtl-tools: the ISA generator, test-vector generators, assemble and the fixture check
```

## Toolchain setup

The hardware flow uses one pinned, dated release of the [YosysHQ OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build). It bundles Verilator 5, Yosys, SymbiYosys (`sby`) with the yices, boolector, z3 and bitwuzla SMT solvers, nextpnr-ice40 and GTKWave. The release and the sha256 of each platform's tarball are recorded in `hardware/toolchain.env`. Hardware tools are never installed globally with Homebrew or apt.

`pnpm hardware:setup`:

- downloads the tarball for the host (darwin-arm64, darwin-x64, linux-x64 or linux-arm64) with curl;
- checks its sha256 against `toolchain.env`;
- extracts it into `${VCPU8_TOOLS_DIR:-$HOME/.cache/vcpu8}/oss-cad-suite-<version>/`.

The tools live outside the repository, so every worktree shares one install. The script needs no sudo and writes nothing outside that directory. It is idempotent: running it again reports the installed version and exits. A checksum mismatch or failed download exits non-zero and leaves no partial install.

The Makefile finds the pinned install by itself. If the install is missing, it falls back to the tools on `PATH`, and a target whose tool is missing points you to `pnpm hardware:setup`. To use the tools in a shell:

```sh
export PATH="$HOME/.cache/vcpu8/oss-cad-suite-2026-10-16/bin:$PATH"
```

### macOS (Apple Silicon or Intel)

```sh
xcode-select --install         # once: make, curl, tar and a C++ compiler for Verilator builds
pnpm install
pnpm hardware:setup            # about 500 MB download, extracted into ~/.cache/vcpu8
make -C hardware/rtl/vcpu8 tools-check
```

The macOS bundle includes a working Verilator, so no Homebrew fallback is needed. Files downloaded by curl are not quarantined by Gatekeeper. If you fetched the tarball with a browser instead and macOS blocks the tools, remove the quarantine attribute:

```sh
xattr -dr com.apple.quarantine "$HOME/.cache/vcpu8/oss-cad-suite-2026-10-16"
```

macOS ships GNU Make 3.81. The Makefile is written for it, and it names tools by absolute path because Make 3.81 ignores a `PATH` changed inside the Makefile when it runs a simple command.

### Ubuntu 22.04 / 24.04 (x86-64 or arm64)

```sh
sudo apt-get install -y build-essential curl ca-certificates   # make, a C++ compiler for Verilator builds
# Node.js 22.12+ and pnpm 10 as for Project 1, then:
pnpm install
pnpm hardware:setup            # about 750 MB download, extracted into ~/.cache/vcpu8
make -C hardware/rtl/vcpu8 tools-check
```

The `apt-get` line installs only build prerequisites. The hardware tools themselves come from the pinned bundle.

### Cache location and offline reuse

- `VCPU8_TOOLS_DIR` moves the cache, for example to a shared disk or a CI cache directory. Set it for both `pnpm hardware:setup` and `make`.
- The verified tarball stays in `$VCPU8_TOOLS_DIR/downloads/`. If the install directory is deleted, `pnpm hardware:setup` re-extracts from that tarball without network access.
- To move to a newer release, update the tag, tarball names and sha256 values in `hardware/toolchain.env`, then run `pnpm hardware:setup`. Older installs are left in place, and you can delete them by hand.

## Make targets

Run them from the repository root with `make -C hardware/rtl/vcpu8 <target>`. `make -C hardware/rtl/vcpu8 help` prints the current list, including the targets that later fragments add.

| Target            | Does                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `help`            | Lists the targets and shows which toolchain is in use                                                                                                                                                                     |
| `tools-check`     | Prints the version of every tool, writes `build/tool-versions.json`, and fails if a required tool is missing or Verilator is older than 5                                                                                 |
| `lint`            | `verilator --lint-only -Wall --top-module vcpu8_top` over every `core/*.sv`, packages first                                                                                                                               |
| `gen-isa`         | Regenerates `core/vcpu8_isa_pkg.sv` from `@vcpu/shared` (the same as `pnpm hardware:gen`)                                                                                                                                 |
| `check-isa`       | Regenerates the package into `build/`, fails if it differs from the committed file, lints both packages, and synthesizes `tb/isa_pkg_probe.sv` with Yosys                                                                 |
| `test`            | Runs every registered unit test (`UNIT_TESTS`), then every system test (`SYSTEM_TESTS`, so far `fixtures`)                                                                                                                |
| `sim`             | Builds the RTL program runner `build/sim/vcpu8_sim` with Verilator                                                                                                                                                        |
| `simulate`        | `PROGRAM=<file.asm\|file.mem.hex>`: assembles if needed, runs the program on the RTL and prints the end state ([vcpu8-microarchitecture.md](vcpu8-microarchitecture.md#running-programs-on-the-rtl))                      |
| `fixtures`        | Runs every `fixtures/v1` fixture on the RTL and compares the end state and the trace in lock-step; `FILTER=<glob>` picks a subset                                                                                         |
| `fixtures-tamper` | Proves the fixture check fails with a precise report: a copy of `op-add` with expected R0 changed and a copy of `op-push-full-stack` with one trace `memWrites` value changed must both fail, naming the field (and step) |
| `clean`           | Removes `build/`                                                                                                                                                                                                          |

Root scripts: `pnpm hardware:setup`, `pnpm hardware:gen`, `pnpm hardware:lint`, `pnpm hardware:test` and `pnpm hardware:simulate PROGRAM=…`.

### Adding targets and unit tests

Each topic gets its own fragment, `hardware/rtl/vcpu8/mk/<topic>.mk`, which the Makefile includes automatically. Several tickets can therefore add targets in parallel without editing the same lines. A fragment registers a unit test by appending its name and defining a `test-<name>` target:

```make
UNIT_TESTS += alu
test-alu: ## Exhaustive ALU test against the TypeScript ALU
	…
```

A check of the whole CPU, run after the unit tests, appends its target name to `SYSTEM_TESTS` instead (`SYSTEM_TESTS += fixtures`).

Write a `## description` comment after a target so `make help` lists it. New `core/*.sv` files are picked up by `lint` with no list edits.

### Hardware tests stay out of `pnpm test`

`pnpm check` (Project 1) must keep passing on a machine without the hardware toolchain. Tests that need Verilator or Yosys therefore run only from `make` targets. The vitest tests in `@vcpu/rtl-tools` are pure TypeScript. One of them checks byte for byte that the committed `vcpu8_isa_pkg.sv` matches the generator.

## Using the ISA package in RTL

Opcode, fault, status and reset numbers come only from `vcpu8_isa_pkg.sv`, so RTL never contains a hand-typed opcode byte. Yosys 0.70 imposes a few rules that the [audit](isa-compatibility.md#tool-constraints-found-during-setup) records:

```systemverilog
import vcpu8_isa_pkg::*;      // file scope: localparams and types are fine this way

module vcpu8_decoder (input logic [7:0] op, output logic [1:0] len /* … */);
  assign len = vcpu8_isa_pkg::isa_len(op);   // call package functions with an explicit scope
endmodule
```

Do not put `import` inside a module, and do not use `return` in functions. Yosys rejects both.
