# virtual-cpu

VCPU-8 is an educational 8-bit virtual CPU. It includes an emulator core, an assembler and disassembler, a debugger, a React dashboard, a CLI and benchmarks. Its architecture is documented precisely enough to rebuild the CPU in SystemVerilog.

> Status: scaffold only. The CPU, ISA, assembler and UI arrive in later tickets.

## Requirements

- Node.js 22.12 or newer (see `.nvmrc`)
- pnpm 10, pinned by the `packageManager` field (enable it with `corepack enable`, or let pnpm manage its own version)

## Getting started

```sh
pnpm install
pnpm check          # typecheck + lint + format check + tests, across every workspace
pnpm cpu --help     # CLI
pnpm --filter @vcpu/web dev     # web dashboard dev server
pnpm --filter @vcpu/web build   # static build to apps/web/dist
```

## Command line

`pnpm cpu` assembles, runs, debugs and disassembles VCPU-8 programs. [apps/cli/README.md](apps/cli/README.md) is the full reference: every option, the debugger commands and the `--json` format.

```sh
pnpm cpu run examples/14-fibonacci.asm                    # final status, registers, memory, summary
pnpm cpu run examples/14-fibonacci.asm --trace            # plus one line per executed instruction
pnpm -s cpu run examples/14-fibonacci.asm --json          # one JSON document (-s drops pnpm's header)
pnpm cpu assemble examples/14-fibonacci.asm -o fib.bin --listing --symbols
pnpm cpu disassemble fib.bin
pnpm cpu debug examples/14-fibonacci.asm                  # step, back, run, break, watch, regs, mem, …
```

| Command                                    | What it does                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `assemble <file.asm> [-o out.bin]`         | Writes raw machine code; `--symbols` and `--listing` print the symbol table and a listing     |
| `run <file.asm\|file.bin>`                 | Runs to HLT, a fault or `--max-instructions N`; `--trace`, `--json`, `--memory all`           |
| `debug <file.asm\|file.bin>`               | Interactive debugger: breakpoints, watchpoints, step back, registers, memory, stack and trace |
| `disassemble <file.bin> [--start] [--end]` | Prints address, bytes and assembly for each instruction                                       |
| `benchmark <file.asm\|file.bin>`           | Host timing (median, percentiles, IPS, trace overhead) and simulated metrics; `--json`        |

Exit codes: 0 ok (for `run`, halted), 1 assembly errors, 2 CPU fault, 3 instruction limit, 64 usage error.

## Scripts

| Script               | What it does                                               |
| -------------------- | ---------------------------------------------------------- |
| `pnpm typecheck`     | `tsc` for the root config files and every workspace        |
| `pnpm lint`          | ESLint (typescript-eslint strict, type-checked)            |
| `pnpm format`        | Prettier, write                                            |
| `pnpm format:check`  | Prettier, check only                                       |
| `pnpm test`          | Vitest across all workspaces                               |
| `pnpm test:coverage` | Vitest with V8 coverage (`coverage/`)                      |
| `pnpm check`         | typecheck, lint, format check and tests, in that order     |
| `pnpm cpu <command>` | Runs the `@vcpu/cli` command-line interface                |
| `pnpm bench`         | Benchmarks every example into `benchmarks/results/`        |
| `pnpm bench:compare` | Compares the newest result with `benchmarks/baseline.json` |

## Layout

```
apps/
  web/          @vcpu/web        Vite + React + Tailwind dashboard (static, deployed to Vercel)
  cli/          @vcpu/cli        `pnpm cpu` command-line interface
packages/
  cpu-core/     @vcpu/cpu-core   CPU emulator; no React, Node or browser APIs
  assembler/    @vcpu/assembler  two-pass assembler and disassembler
  debugger/     @vcpu/debugger   breakpoints, watchpoints, step-back history
  benchmarks/   @vcpu/benchmarks benchmark suite
  shared/       @vcpu/shared     the single authoritative ISA definition
examples/       example assembly programs
benchmarks/     committed baseline.json; results/ holds local runs (git-ignored)
docs/           architecture and hardware-porting documentation
```

Workspace packages are consumed straight from their TypeScript source through `exports`. Tests and the dev tools need no build step.

`packages/cpu-core` and `packages/shared` may not import Node built-ins or React. ESLint enforces this rule, and their `tsconfig` leaves out DOM and Node types.

## Documentation

- [docs/concepts.md](docs/concepts.md): a short course from transistors to fetch-decode-execute, tied to VCPU-8. Start here if you are new to hardware.
- [docs/architecture.md](docs/architecture.md): the VCPU-8 programmer's model and block diagram, with links to the instruction set, memory model and execution documents.
- [docs/benchmarks.md](docs/benchmarks.md): how the benchmark suite measures host time, how simulated cycles are estimated, and how to compare runs against the committed baseline.

## Deployment

`vercel.json` builds `@vcpu/web` and serves `apps/web/dist` as a static site.
