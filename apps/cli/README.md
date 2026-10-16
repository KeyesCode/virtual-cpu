# @vcpu/cli

`pnpm cpu`, the VCPU-8 command line. It assembles, runs, debugs and disassembles programs. All CPU behaviour comes from `@vcpu/assembler`, `@vcpu/cpu-core` and `@vcpu/debugger`; the CLI only reads files, formats output and sets the exit code.

```sh
pnpm cpu --help                 # the command list
pnpm cpu <command> --help       # one command's options (or: pnpm cpu help <command>)
```

Run it from the repository root. File arguments resolve against the directory you ran `pnpm` in. pnpm prints a `> vcpu-8 cpu …` header line before the output; `pnpm -s cpu …` leaves it out, which you need when you pipe `--json` into another tool.

Numbers in arguments (addresses, counts) are decimal `26`, hex `0x1A` or binary `0b11010`, as in the assembler.

## Commands

### `assemble`

```sh
pnpm cpu assemble <file.asm> [-o out.bin] [--symbols] [--listing]
```

Assembles source into raw machine code. The output file holds the bytes from address 0x00 through the last emitted byte, because a `.bin` always loads at 0x00. Without `-o` it is written next to the source, with a `.bin` extension.

| Option                | Effect                                                |
| --------------------- | ----------------------------------------------------- |
| `-o, --output <file>` | Where to write the bytes                              |
| `--symbols`           | Print the symbol table: labels and `.equ` constants   |
| `--listing`           | Print each statement with its address, bytes and line |

Diagnostics go to stderr in `file:line:col` form, with the source line and a caret under the problem. Assembly reports every error it finds, not just the first:

```
$ pnpm -s cpu assemble bad.asm
bad.asm:2:13: error: unknown register "R9" (valid: R0–R7)
          LDI R9, 1
              ^^
bad.asm: 1 error
```

### `run`

```sh
pnpm cpu run <file.asm|file.bin> [--max-instructions N] [--trace] [--json] [--memory nonzero|all]
```

Runs a program until it halts, faults or reaches the instruction limit. A `.asm` file is assembled first, and a `.bin` file is loaded as raw bytes at 0x00 (at most 256 bytes). The output has four parts: the final status, the registers and flags, a hexdump of memory, and an execution summary.

```
$ pnpm -s cpu run examples/01-addition.asm
Status: HALTED at PC 0x08 after 4 instructions

Registers
  R0 = 0x1E (30)          R1 = 0x14 (20)          R2 = 0x00 (0)           R3 = 0x00 (0)
  R4 = 0x00 (0)           R5 = 0x00 (0)           R6 = 0x00 (0)           R7 = 0x00 (0)
  PC = 0x08               SP = 0xFF               SD = 0                  IR = HLT
Flags
  Z=0 C=0 N=0 V=0         FLAGS = 0x00

Memory (rows with a non-zero byte; --memory all shows every row)
        +0 +1 +2 +3 +4 +5 +6 +7 +8 +9 +A +B +C +D +E +F
  0x00  11 00 0A 11 10 14 20 01 01 00 00 00 00 00 00 00

Execution summary
  Instructions   4
  Est. cycles    13 (timing-model estimate, not measured)
  Memory reads   0
  Memory writes  0
  Fetched bytes  9
  Branches       0 taken, 0 not taken
```

Each register shows its hex value and its unsigned value. A byte of 0x80 or more also shows its two's-complement reading, for example `0x81 (129, -127)`. SD is the stack depth in bytes. IR is the last retired instruction. Memory reads and writes count data accesses only (LOAD, STORE, PUSH, POP, CALL, RET), not instruction fetches. Estimated cycles come from the timing model in [docs/instruction-set.md](../../docs/instruction-set.md), so they are not measured clock cycles.

| Option                   | Effect                                                                          |
| ------------------------ | ------------------------------------------------------------------------------- |
| `--max-instructions <N>` | Stop after N instructions (default 1,000,000)                                   |
| `--trace`                | Before the result, print one line per executed instruction with what it changed |
| `--json`                 | Print one JSON document instead of text (see below)                             |
| `--memory <rows>`        | `nonzero` (default) shows only rows holding a non-zero byte; `all` every row    |

A trace line has the step number, address, bytes, instruction and its effects: register changes, flag changes, data reads and writes, and branch outcome.

```
  #2     0x06  20 01     ADD R0, R1          R0 0x0A→0x1E
```

### `debug`

```sh
pnpm cpu debug <file.asm|file.bin> [--max-instructions N] [--history N]
```

Opens an interactive debugger built on `@vcpu/debugger`. After each command that moves execution, it prints where the CPU is: the status, PC, the instruction there and its source line.

| Command                   | Effect                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `step [n]`                | Execute n instructions (default 1), even one under a breakpoint, printing each one               |
| `back [n]`                | Step back n instructions (default 1), up to `--history` steps (default 1024)                     |
| `run`                     | Run until a breakpoint, watchpoint, HLT, fault or `--max-instructions`                           |
| `break [addr\|line]`      | Stop **before** the instruction at an address or source line; with no argument, list breakpoints |
| `watch [addr] [r\|w\|rw]` | Stop **after** an instruction reads, writes or accesses (default) a byte; no argument lists them |
| `regs`                    | Registers, PC, SP, SD, IR and flags, in the same layout as `run`                                 |
| `mem [addr] [len]`        | Hexdump `len` bytes (default 16) from `addr`; with no argument, all 256 bytes                    |
| `stack`                   | SP, the stack depth and each live stack byte, top first                                          |
| `trace [n]`               | The last n executed instructions (default 10)                                                    |
| `reset`                   | Back to the loaded program. Breakpoints and watchpoints stay                                     |
| `help`, `quit`            | The command list; leave (`q`, `exit` and end of input also leave)                                |

In `break`, an `0x` or `0b` number is an address. A bare decimal is a source line when the program came from a `.asm` file, and an address for a `.bin`. Watchpoints count data accesses only, never instruction fetches.

The debugger reads commands one per line from stdin. On a terminal you get line editing. When the input is piped, each command is echoed after the prompt, so the output reads as a transcript:

```
$ printf 'break 0x1A\nrun\nquit\n' | pnpm -s cpu debug examples/14-fibonacci.asm
VCPU-8 debugger: examples/14-fibonacci.asm. Type "help" for commands.
[READY] PC 0x00  LDI R0, 0           ; line 15: LDI R0, 0
(vcpu) break 0x1A
Breakpoint 1 at 0x1A (line 26)
(vcpu) run
Ran 11 instructions
Breakpoint 1 at 0x1A (line 26)
[PAUSED] PC 0x1A  JNZ 0x0C            ; line 26: JNZ loop
(vcpu) quit
```

### `disassemble`

```sh
pnpm cpu disassemble <file.bin> [--start ADDR] [--end ADDR]
```

Decodes raw machine code back into assembly, with one line per instruction: address, bytes, then the instruction. A byte that does not start a valid instruction is shown as `.byte` with the reason (invalid opcode, malformed register byte, or cut off by the end of the range), and decoding carries on at the next byte. `--start` and `--end` (inclusive) limit the range. `--end` defaults to the last byte of the file.

```
$ pnpm -s cpu disassemble fib.bin --start 0x18
0x18  25 30     DEC R3
0x1A  42 0C     JNZ 0x0C
0x1C  01        HLT
```

### `benchmark`

Reserved for the benchmark suite, which adds it. For now it exits with code 64.

## Exit codes

| Code | Meaning                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------- |
| 0    | Success. For `run`, the program halted                                                                           |
| 1    | The source did not assemble                                                                                      |
| 2    | `run`: the CPU faulted                                                                                           |
| 3    | `run`: `--max-instructions` was reached before the program halted                                                |
| 64   | Usage error: a bad argument or flag, a missing or unreadable file, a wrong extension, or a `.bin` over 256 bytes |

## `run --json`

`--json` prints one JSON document on stdout. Its shape is a stable interface, defined by the Zod schema `RunJsonSchema` that `@vcpu/cli` exports, and every document is validated against it before it is printed. New fields may be added. A change that removes or redefines a field bumps `version`.

| Field             | Type                                    | Meaning                                                                                                                                                     |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`         | `1`                                     | Format version                                                                                                                                              |
| `isaVersion`      | string                                  | The ISA the CPU implements, e.g. `"1.0.0"`                                                                                                                  |
| `file`            | string                                  | The input path as given                                                                                                                                     |
| `input`           | `"asm"` \| `"bin"`                      | How the program was loaded                                                                                                                                  |
| `maxInstructions` | integer                                 | The instruction limit used                                                                                                                                  |
| `stopReason`      | `"halted"` \| `"faulted"` \| `"limit"`  | Why execution stopped                                                                                                                                       |
| `exitCode`        | `0` \| `2` \| `3`                       | The process exit code                                                                                                                                       |
| `status`          | `"HALTED"` \| `"FAULTED"` \| `"PAUSED"` | CPU status (PAUSED after the limit)                                                                                                                         |
| `registers`       | `{ "R0": byte, …, "R7": byte }`         | Register values, 0–255                                                                                                                                      |
| `pc`, `sp`        | byte                                    | Program counter and stack pointer                                                                                                                           |
| `sd`              | integer                                 | Stack depth in bytes                                                                                                                                        |
| `flags`           | `{ value, Z, C, N, V }`                 | The FLAGS byte and each flag as a boolean                                                                                                                   |
| `ir`              | string \| null                          | The last retired instruction as assembly                                                                                                                    |
| `fault`           | `{ code, pc, detail }` \| null          | The fault, e.g. `"DIVIDE_BY_ZERO"`, and the faulting instruction's address                                                                                  |
| `memory`          | 256 bytes                               | All of memory, address 0x00 first                                                                                                                           |
| `metrics`         | object                                  | `instructions`, `estimatedCycles`, `memoryReads`, `memoryWrites`, `fetchedBytes`, `branchesTaken`, `branchesNotTaken`, and `opcodeCounts` (every opcode id) |
| `trace`           | array, only with `--trace`              | One entry per executed step, oldest first (below)                                                                                                           |

A trace entry has `sequence`, `pc`, `nextPc`, `bytes`, `text` (the instruction as assembly), `registerChanges` (`{ register, before, after }`, SP and SD included), `flagChanges` (`{ flag, before, after }`), `memoryReads` (`{ address, value }`), `memoryWrites` (`{ address, before, after }`), `branchTaken` (`null` except for conditional branches), `cycles`, `status` (after the step) and `fault`. With `--trace`, the document keeps every step, so set `--max-instructions` for long runs.

## Tests

```sh
pnpm --filter @vcpu/cli test
```

The tests call the commands with captured output on every `examples/` program: run (text and `--json`, checked against the schema), assemble, then disassemble. They also cover each exit code, the debugger command language (a pure function of the session and one line), the register-dump layout, and one spawned process.
