# VCPU-8

[![ci](https://github.com/KeyesCode/virtual-cpu/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/KeyesCode/virtual-cpu/actions/workflows/ci.yml) [![hardware](https://github.com/KeyesCode/virtual-cpu/actions/workflows/hardware.yml/badge.svg?branch=master)](https://github.com/KeyesCode/virtual-cpu/actions/workflows/hardware.yml)

VCPU-8 is an educational 8-bit CPU, built from scratch in TypeScript. You write assembly, assemble it into real machine code, and watch the emulator fetch, decode and execute it one instruction at a time. You can do this from a web dashboard, a debugger or the command line.

It is Project 1 of a semiconductor learning path. The architecture is specified precisely enough to rebuild in SystemVerilog, and it ships the test vectors that a hardware version must pass. Project 2 is that rebuild: a synthesizable multicycle CPU that runs the same machine code and matches the emulator at every instruction boundary ([Project 2](#project-2-the-systemverilog-cpu)).

![The VCPU-8 dashboard running 14-fibonacci.asm](docs/images/dashboard-1600x1000.png)

## What's in it

- **The CPU (`@vcpu/cpu-core`).** Eight 8-bit registers, Z/C/N/V flags, 256 bytes of memory, a bounded stack and 30 opcodes in 1–3 bytes. It is deterministic, its faults are precise, and it has no React, Node or browser dependency.
- **One ISA definition (`@vcpu/shared`).** The emulator, assembler, debugger and fixtures all read the same frozen opcode table, so they cannot disagree.
- **An assembler and disassembler.** Two passes, with labels, `.org`, `.byte`, `.equ`, and errors that give line and column.
- **A debugger.** Breakpoints, memory watchpoints, and step back through a bounded history.
- **A web dashboard.** An editor, CPU state, a memory map, a conceptual instruction-cycle view, an execution timeline, and performance figures.
- **A CLI.** `pnpm cpu assemble | run | debug | disassemble | benchmark`.
- **A benchmark suite.** Host time and simulated metrics, kept separate, compared against a committed baseline.
- **Twenty example programs**, each checked by a test.
- **98 hardware fixtures** for RTL verification.

The [Project 1 report](docs/project-1-report.md) has the test counts, coverage, benchmark baseline, known limitations, and the readiness assessment for the SystemVerilog CPU.

## Quick start

You need Node.js 22.12 or newer (see `.nvmrc`) and pnpm 10. pnpm's version is pinned by `packageManager`, so `corepack enable` is enough.

```sh
pnpm install
pnpm check                                  # typecheck + lint + format check + all tests
pnpm cpu run examples/01-addition.asm       # LDI R0, 10 / LDI R1, 20 / ADD R0, R1 / HLT → R0 = 30
pnpm --filter @vcpu/web dev                 # open the dashboard
```

Everything runs locally. There is no backend, database or network service.

## Command line

`pnpm cpu` assembles, runs, debugs and disassembles VCPU-8 programs. [apps/cli/README.md](apps/cli/README.md) is the full reference: every option, the debugger commands and the `--json` format.

```sh
pnpm cpu run examples/14-fibonacci.asm                    # final status, registers, memory, summary
pnpm cpu run examples/14-fibonacci.asm --trace            # plus one line per executed instruction
pnpm -s cpu run examples/14-fibonacci.asm --json          # one JSON document (-s drops pnpm's header)
pnpm cpu assemble examples/14-fibonacci.asm -o fib.bin --listing --symbols
pnpm cpu disassemble fib.bin
pnpm cpu debug examples/14-fibonacci.asm                  # step, back, run, break, watch, regs, mem, …
pnpm cpu benchmark examples/14-fibonacci.asm              # host timing + simulated metrics
```

| Command                                    | What it does                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `assemble <file.asm> [-o out.bin]`         | Writes raw machine code; `--symbols` and `--listing` print the symbol table and a listing     |
| `run <file.asm\|file.bin>`                 | Runs to HLT, a fault or `--max-instructions N`; `--trace`, `--json`, `--memory all`           |
| `debug <file.asm\|file.bin>`               | Interactive debugger: breakpoints, watchpoints, step back, registers, memory, stack and trace |
| `disassemble <file.bin> [--start] [--end]` | Prints address, bytes and assembly for each instruction                                       |
| `benchmark <file.asm\|file.bin>`           | Host timing (median, percentiles, IPS, trace overhead) and simulated metrics; `--json`        |

Exit codes: 0 ok (for `run`, halted), 1 assembly errors, 2 CPU fault, 3 instruction limit, 64 usage error.

## Project 2: the SystemVerilog CPU

`hardware/rtl/vcpu8/` is VCPU-8 rebuilt as synthesizable SystemVerilog. It is a multicycle CPU with one clock and a synchronous reset that takes 4–6 clocks per instruction, and it runs ISA 1.0.0 machine code unmodified.

- **Verified against the emulator.** `make verify` runs the 98 fixtures, the 20 examples, directed programs and 1,000 seeded random programs on `@vcpu/cpu-core` and on the Verilated RTL, and compares the architectural state after every instruction. Twelve injected RTL bugs must each make it fail.
- **Exhaustive unit tests and formal proofs.** The ALU is checked over every operand pair and the decoder over every opcode and register byte. SymbiYosys proves the reset, FSM, write-enable, halt and retirement properties.
- **Synthesized and measured.** Yosys and nextpnr build it for an iCE40UP5K and an ECP5. The benchmark suite measures real RTL cycles and CPI, and `make experiment` compares design variants.

The [Project 2 report](docs/hardware/project-2-report.md) has the audit results, the Definition-of-Done evidence and the known limitations, and [fpga-readiness.md](docs/hardware/fpga-readiness.md) the plan for running it on a board.

The hardware tools come from one pinned OSS CAD Suite release, installed into `~/.cache/vcpu8` (macOS and Ubuntu; [setup](docs/hardware/README.md#toolchain-setup)):

```sh
pnpm hardware:setup                                       # Verilator, Yosys, SymbiYosys, nextpnr, GTKWave
make -C hardware/rtl/vcpu8 help                           # every target
make -C hardware/rtl/vcpu8 test                           # unit tests, then the 98 fixtures on the RTL
make -C hardware/rtl/vcpu8 verify                         # differential verification against the emulator
make -C hardware/rtl/vcpu8 simulate PROGRAM=examples/14-fibonacci.asm
make -C hardware/rtl/vcpu8 wave                           # build/waves/wave-demo.fst for GTKWave
make -C hardware/rtl/vcpu8 synth                          # resource and timing reports
make -C hardware/rtl/vcpu8 formal                         # SymbiYosys proofs
make -C hardware/rtl/vcpu8 benchmark                      # RTL cycles and CPI of the 20 examples
```

CI runs these gates, except `benchmark`, on every pull request (`.github/workflows/hardware.yml`). `pnpm check` needs none of the hardware tools.

## Scripts

| Script                          | What it does                                                |
| ------------------------------- | ----------------------------------------------------------- |
| `pnpm check`                    | typecheck, lint, format check and tests, in that order      |
| `pnpm typecheck`                | `tsc` for the root config files and every workspace         |
| `pnpm lint`                     | ESLint (typescript-eslint strict, type-checked)             |
| `pnpm format` / `format:check`  | Prettier, write or check only                               |
| `pnpm test`                     | Vitest across all workspaces                                |
| `pnpm test:coverage`            | Vitest with V8 coverage (`coverage/`)                       |
| `pnpm cpu <command>`            | The `@vcpu/cli` command-line interface                      |
| `pnpm bench`                    | Benchmarks every example into `benchmarks/results/`         |
| `pnpm bench:compare`            | Compares the newest result with `benchmarks/baseline.json`  |
| `pnpm fixtures:export`          | Regenerates the hardware fixtures in `fixtures/v1/`         |
| `pnpm --filter @vcpu/web dev`   | Dashboard dev server                                        |
| `pnpm --filter @vcpu/web build` | Static dashboard build to `apps/web/dist`                   |
| `pnpm hardware:setup`           | Installs the pinned hardware toolchain (Project 2)          |
| `pnpm hardware:<gate>`          | `lint`, `test`, `verify`, `formal`, `synth`, `benchmark`, … |

## Layout

```
apps/
  web/          @vcpu/web        Vite + React + Tailwind dashboard (static, deployed to Vercel)
  cli/          @vcpu/cli        `pnpm cpu` command-line interface
packages/
  shared/       @vcpu/shared     the single authoritative ISA definition and fixture schema
  cpu-core/     @vcpu/cpu-core   CPU emulator; no React, Node or browser APIs
  assembler/    @vcpu/assembler  two-pass assembler and disassembler
  debugger/     @vcpu/debugger   breakpoints, watchpoints, step-back history
  benchmarks/   @vcpu/benchmarks benchmark suite
  rtl-tools/    @vcpu/rtl-tools  Project 2 tooling: ISA package generator, differential verification, benchmarks
hardware/       Project 2 RTL (rtl/vcpu8/), the FPGA wrapper (fpga/) and the pinned OSS CAD Suite toolchain
research/cpu/   Project 2 research results: synthesis baseline, RTL benchmark reports, experiments
examples/       20 example programs, each with a .expect.json checked by the tests
fixtures/v1/    hardware test fixtures (vcpu8-fixture/1)
benchmarks/     committed baseline.json; results/ holds local runs (git-ignored)
scripts/        fixture exporter
docs/           architecture, ISA, hardware porting, concepts, the Project 1 report; hardware/ for Project 2
```

Workspace packages are consumed straight from their TypeScript source through `exports`. Tests and the dev tools need no build step.

`packages/cpu-core` and `packages/shared` may not import Node built-ins or React. ESLint enforces this rule, and their `tsconfig` leaves out DOM and Node types.

## Documentation

New to hardware? Start with the concepts guide. Porting to RTL? Start with hardware porting.

| Document                                                                 | What it covers                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [docs/concepts.md](docs/concepts.md)                                     | A short course from transistors and logic gates to fetch-decode-execute, tied to VCPU-8     |
| [docs/architecture.md](docs/architecture.md)                             | Programmer's model, block diagram, design principles, versioning, v1.0 limitations          |
| [docs/instruction-set.md](docs/instruction-set.md)                       | ISA 1.0.0: formats, encodings, opcode map, per-instruction semantics and flags, timing      |
| [docs/memory-model.md](docs/memory-model.md)                             | Memory map, address rules, the stack and its depth counter, program images                  |
| [docs/cpu-execution.md](docs/cpu-execution.md)                           | The execution cycle, faults and their priority, reset, statuses, metrics                    |
| [docs/benchmarks.md](docs/benchmarks.md)                                 | How host time is measured, how simulated cycles are estimated, comparing against a baseline |
| [docs/hardware-porting.md](docs/hardware-porting.md)                     | Mapping VCPU-8 to SystemVerilog modules, and using the fixtures in a testbench              |
| [docs/hardware/README.md](docs/hardware/README.md)                       | Project 2 RTL: toolchain setup (macOS, Ubuntu), make targets, CI, the hardware docs index   |
| [docs/hardware/isa-compatibility.md](docs/hardware/isa-compatibility.md) | ISA compatibility audit: the ISA the RTL implements, cross-checks, brief discrepancies      |
| [docs/hardware/project-2-report.md](docs/hardware/project-2-report.md)   | Project 2 completion report: audit results, DoD evidence, limitations, next revision        |
| [docs/hardware/fpga-readiness.md](docs/hardware/fpga-readiness.md)       | FPGA fit, timing, clocking and reset, block RAM, and the Project 5 debug-bridge plan        |
| [docs/project-1-report.md](docs/project-1-report.md)                     | Project 1 completion report: evidence, results, limitations, Project 2 readiness            |
| [examples/README.md](examples/README.md)                                 | The 20 example programs, their expected results and overflow notes                          |
| [fixtures/README.md](fixtures/README.md)                                 | The `vcpu8-fixture/1` format and what `fixtures/v1/` contains                               |
| [apps/cli/README.md](apps/cli/README.md)                                 | Full CLI reference                                                                          |

## Deployment

`vercel.json` builds `@vcpu/web` and serves `apps/web/dist` as a static site.
