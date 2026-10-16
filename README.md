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

## Scripts

| Script               | What it does                                           |
| -------------------- | ------------------------------------------------------ |
| `pnpm typecheck`     | `tsc` for the root config files and every workspace    |
| `pnpm lint`          | ESLint (typescript-eslint strict, type-checked)        |
| `pnpm format`        | Prettier, write                                        |
| `pnpm format:check`  | Prettier, check only                                   |
| `pnpm test`          | Vitest across all workspaces                           |
| `pnpm test:coverage` | Vitest with V8 coverage (`coverage/`)                  |
| `pnpm check`         | typecheck, lint, format check and tests, in that order |
| `pnpm cpu <command>` | Runs the `@vcpu/cli` command-line interface            |

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
docs/           architecture and hardware-porting documentation
```

Workspace packages are consumed straight from their TypeScript source through `exports`. Tests and the dev tools need no build step.

`packages/cpu-core` and `packages/shared` may not import Node built-ins or React. ESLint enforces this rule, and their `tsconfig` leaves out DOM and Node types.

## Deployment

`vercel.json` builds `@vcpu/web` and serves `apps/web/dist` as a static site.
