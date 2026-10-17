# Simulation Guide

How to run a VCPU-8 program on the RTL, read what the runner writes, and watch the CPU work clock by clock in GTKWave. The last section follows three instructions of the demo program through the control FSM, with every value taken from the demo's waveform.

## Setup

Everything here uses the pinned OSS CAD Suite. Install it once with `pnpm install` and `pnpm hardware:setup`, as described in [Toolchain setup](README.md#toolchain-setup) (macOS and Ubuntu). The bundle provides Verilator, which builds the runner, and GTKWave with its `vcd2fst` and `fst2vcd` converters. You need nothing else. Check the install with:

```sh
make -C hardware/rtl/vcpu8 tools-check
```

Every command below runs from the repository root. `make -C hardware/rtl/vcpu8 help` lists all the targets.

## Running a program

```sh
make -C hardware/rtl/vcpu8 simulate PROGRAM=examples/14-fibonacci.asm
make -C hardware/rtl/vcpu8 simulate PROGRAM=fixtures/v1/op-add.mem.hex MAX_STEPS=100
pnpm hardware:simulate PROGRAM=examples/14-fibonacci.asm
```

`PROGRAM` is a `.asm` file, which `@vcpu/rtl-tools assemble` assembles with the Project 1 assembler, or a 256-line `$readmemh` image such as a fixture's `.mem.hex`. A relative path is looked up from the repository root first, then from `hardware/rtl/vcpu8/`. If the source does not assemble, the target fails with the assembler's error.

The runner (`build/sim/vcpu8_sim`, from `tb/sim/vcpu8_sim.cpp`) loads the image into the RAM while reset is held, releases reset, and clocks the CPU until it is HALTED or FAULTED, or until `MAX_STEPS` (default 1,000,000) or `MAX_CYCLES` (default: no limit) runs out. It prints a summary. For the demo program it prints:

```text
status        HALTED
fault         none
stop reason   halted
instructions  15
steps         15
cycles        78
registers     R0=0x10 R1=0x20 R2=0x10 R3=0x00 R4=0x10 R5=0x00 R6=0x00 R7=0x00
PC=0x17  SP=0xFF  SD=0  FLAGS=0x0C (Z=1 C=1 N=0 V=0)
memory
…
```

It also writes two files into `build/simulate/`:

- **`<name>.state.json`**, format `vcpu8-rtl-state/1`: the end state. Its fields are `status`, `fault` (`null`, or `{code, number, pc}`), `instructions` (retired, which is `instret`), `steps`, `cycles` (clock edges after reset), `registers` (R0–R7), `pc`, `sp`, `sd`, `flags` (the FLAGS byte, `{0000, Z, C, N, V}`), all 256 `memory` bytes, and `stopReason` (`halted`, `faulted`, `max_steps` or `max_cycles`).
- **`<name>.trace.jsonl`**: one line per step, with the fields of the fixture trace ([fixtures/README.md](../../fixtures/README.md)) plus `cycle`, the clock count when the step completed. A step is one `retire` pulse, or a precise fault, which does not retire. The demo's ADD, for example:

  ```text
  {"step":2,"pc":6,"ir":[32,1],"status":"READY","fault":null,"regs":[16,32,0,0,0,0,0,0],"flags":4,"sp":255,"sd":0,"nextPc":8,"memWrites":[],"cycle":17}
  ```

The fixture check, `make -C hardware/rtl/vcpu8 fixtures`, compares these files with the emulator's state and trace.

## Generating waveforms

```sh
make -C hardware/rtl/vcpu8 wave                                     # the demo → build/waves/wave-demo.fst
make -C hardware/rtl/vcpu8 wave PROGRAM=examples/19-subroutines.asm # any program, looked up as for simulate
make -C hardware/rtl/vcpu8 wave WAVE_FORMAT=vcd                     # VCD instead of FST
make -C hardware/rtl/vcpu8 wave MAX_CYCLES=500                      # stop earlier (default 10,000)
pnpm hardware:wave                                                  # the same as `make … wave`
```

`make wave` builds a second, tracing copy of the runner into `build/sim-trace/` (Verilator `--trace --trace-structs --trace-max-array 256`). It assembles `PROGRAM`, which defaults to `hardware/rtl/vcpu8/tb/programs/wave-demo.asm`, and runs it with `--wave`. Then it writes `build/waves/<name>.fst`, or `<name>.vcd` with `WAVE_FORMAT=vcd`, next to the run's `.state.json` and `.trace.jsonl`. At the end it prints the command that opens the result.

- **Every signal is traced**, from the first reset cycle to the stop, at every level of the hierarchy. That includes the decoder outputs, R0–R7 and all 256 RAM bytes (`u_top.u_mem.mem[0..255]`).
- **Time is in nanoseconds, and the clock period is 10 ns.** The two reset edges are at 10 and 20 ns, and reset is released at 25 ns. After that, clock edge _N_ is at 10 × (_N_ + 2) ns. You rarely need this formula: the `cycle` signal (in `tb/sim/vcpu8_sim_top.sv`) counts the edges since reset. It reads _N_ during the cycle that follows edge _N_, and it uses the same numbering as the runner's `cycles` and the trace's `cycle` field.
- **The waveform runs two cycles past the stop.** After HALTED or FAULTED it records two more cycles, in which nothing changes. That way the last `retire` pulse and the final state are visible. A program that never halts stops at `MAX_CYCLES`, and its waveform is still written.
- **Why FST is converted from VCD.** The pinned Verilator's own FST writer (`--trace-fst`) needs liblz4, which OSS CAD Suite does not ship. So the tracing runner writes VCD, and GTKWave's `vcd2fst` from the same bundle converts it. FST files are several times smaller than VCD and open faster.
- **Tracing is off everywhere else.** `make test`, `simulate` and `fixtures` use the untraced runner in `build/sim/`. The untraced runner rejects `--wave`, so these targets never build the tracing variant or write into `build/waves/`.
- **Waveforms are build outputs.** They live in the git-ignored `build/`. Never commit an `.fst` or `.vcd`.

### Opening them in GTKWave

```sh
cd hardware/rtl/vcpu8
gtkwave build/waves/wave-demo.fst tb/wave/vcpu8.gtkw
```

`gtkwave` is the bundle's: put `~/.cache/vcpu8/oss-cad-suite-2026-10-16/bin` on your `PATH` as in [Toolchain setup](README.md#toolchain-setup), or call it by that path.

- **macOS:** the bundle's GTKWave is a native GTK application. Run the command above from Terminal. It needs no XQuartz and no Homebrew GTKWave.
- **Ubuntu:** run the same command in a desktop session (X11 or Wayland). Without a display, for example over SSH or in CI, GTKWave cannot open. Use `make wave-check` instead, or convert the FST back to text with `fst2vcd -f build/waves/wave-demo.fst`.

The save file `tb/wave/vcpu8.gtkw` opens the signals in seven groups; the last one starts closed:

| Group                        | Signals (under `TOP.vcpu8_sim_top`)                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Clock and reset              | `clk`, `rst`, `cycle` (decimal)                                                                                                |
| Fetch and decode             | `u_top.u_core.u_control.state` (by name), `dbg_pc`, `dbg_ir_op`, `dbg_ir_rb`, `dbg_ir_tb`, `dbg_ir_len`                        |
| ALU                          | `u_top.u_core.u_alu.a`, `.b`, `.op` (by name), `.r`                                                                            |
| Register write               | `u_top.u_core.u_registers.we`, `.wa`, `.wd`                                                                                    |
| Memory bus                   | `mem_addr`, `mem_we`, `mem_wdata`, `mem_rdata`                                                                                 |
| Flags, retirement and status | `u_top.u_core.u_flags.flags` (binary ZCNV), `dbg_flags`, `retire`, `retire_pc`, `instret`, `status` and `fault_code` (by name) |
| Registers and stack (closed) | `u_top.u_core.u_registers.r[0]`–`r[7]`, `dbg_sp`, `dbg_sd`                                                                     |

Buses are shown in hex, apart from `cycle`, `instret`, `dbg_ir_len`, `wa` and `dbg_sd`, which are decimal. Use GTKWave's zoom-to-fit button to see the whole run.

**State names.** Four signals are shown by name through GTKWave translate filter files in `tb/wave/`. GTKWave finds the files beside the save file, wherever you start it from.

| Filter file      | Applied to        | Generated from                                      |
| ---------------- | ----------------- | --------------------------------------------------- |
| `fsm_state.txt`  | `u_control.state` | `fsm_state_t` in `core/vcpu8_types_pkg.sv`          |
| `alu_op.txt`     | `u_alu.op`        | `alu_op_t` in `core/vcpu8_types_pkg.sv`             |
| `status.txt`     | `status`          | the `STATUS_*` constants in `core/vcpu8_isa_pkg.sv` |
| `fault_code.txt` | `fault_code`      | the `FAULT_*` constants in `core/vcpu8_isa_pkg.sv`  |

The FSM state encoding is 0 FETCH, 1 DECODE, 2 OPERAND1, 3 OPERAND2, 4 EXECUTE, 5 WRITEBACK, 6 HALTED and 7 FAULTED. That is a microarchitecture choice, not part of the ISA ([control-unit.md](control-unit.md#control-fsm)). To name another signal, for example `dbg_state` or `u_core.state`, select it and choose _Data Format → Translate Filter File → Enable and Select_. After the packages change, regenerate the filter files with `pnpm --filter @vcpu/rtl-tools cli gen-wave-filters`. `make wave-check` fails while a filter file is stale.

### Checking a waveform: `make wave-check`

```sh
make -C hardware/rtl/vcpu8 wave-check
```

It regenerates the demo's FST, converts it back to VCD with `fst2vcd`, and then runs `@vcpu/rtl-tools wave-check` on it, which checks that:

- every signal the guide relies on is in the dump: clock, reset, `cycle`, PC, the IR bytes and length, the FSM state, ALU a/b/op/r, the register write enable, address and data, the memory address, write enable, write data and read data, FLAGS, `retire`, `instret` and `status`;
- every signal that `vcpu8.gtkw` shows is in the dump, so the save file cannot go stale;
- the filter files match the RTL packages;
- `retire` pulses exactly once per instruction that the TypeScript emulator retires on the same image, the final `instret` equals that count, and the final status matches the emulator's.

It needs only `fst2vcd`, never a display, so it also runs on a headless machine. If `fst2vcd` is missing, it fails rather than skipping. On the demo it reports:

```text
24 required signals checked
37 signals of …/tb/wave/vcpu8.gtkw checked
retire pulses 15, final instret 15, emulator 15
wave-check: every signal is present and retire matches the emulator
```

## The demo program

`hardware/rtl/vcpu8/tb/programs/wave-demo.asm` retires 15 instructions in 78 clock cycles and takes every path through the FSM:

- 1-byte instructions (RET, HLT): FETCH → DECODE → EXECUTE → WRITEBACK;
- 2-byte instructions (ADD, DEC, JNZ, CALL, PUSH, POP): with OPERAND1 added;
- 3-byte instructions (LDI, STORE, LOAD): with OPERAND1 and OPERAND2 added;
- a memory write and a memory read, one branch taken and the same branch not taken, a CALL and a RET through the stack, and the stop in HALTED.

Its header lists where each instruction sits on the `cycle` axis.

| `cycle` | Address | Instruction           | What to look at                                                             |
| ------: | ------- | --------------------- | --------------------------------------------------------------------------- |
|     0–5 | `0x00`  | `LDI R0, 0xF0`        | The 3-byte path; OPERAND2 (cycle 3) fetches the immediate `F0`              |
|   12–16 | `0x06`  | `ADD R0, R1`          | `F0 + 20 = 10` with carry; walked through below                             |
|   17–22 | `0x08`  | `STORE [0x80], R0`    | `mem_we` in WRITEBACK (22): `[80] ← 10`                                     |
|   23–28 | `0x0B`  | `LOAD R2, [0x80]`     | Address `80` in EXECUTE (27); the byte arrives in WRITEBACK (28), `R2 ← 10` |
|   40–44 | `0x13`  | `JNZ loop`, taken     | Walked through below                                                        |
|   50–54 | `0x13`  | `JNZ loop`, not taken | Z = 1 now (FLAGS `0C`), so PC goes on to `0x15` in cycle 55                 |
|   55–59 | `0x15`  | `CALL stash`          | Walked through below                                                        |
|   70–73 | `0x1C`  | `RET`                 | The 1-byte path; reads `17` back from `[FF]`, so PC is `0x17` in cycle 74   |
|   74–77 | `0x17`  | `HLT`                 | HALTED from cycle 78 on; `status` becomes HALTED                            |

## Walkthrough: fetch, decode, execute, writeback

The tables below were printed from the demo's waveform by:

```sh
make -C hardware/rtl/vcpu8 wave-check     # writes build/waves/wave-demo.check.vcd
pnpm --silent --filter @vcpu/rtl-tools cli wave-table \
  --vcd hardware/rtl/vcpu8/build/waves/wave-demo.check.vcd --cycles 12-17
```

Run the same command with any other range to tabulate other cycles, or any program's VCD.

### How to read a row

Each row is one clock cycle: the values that every signal holds between rising edge _N_ and edge _N_ + 1, while `cycle` = _N_. `t` is the time at which that cycle starts, so it is where to put the GTKWave cursor. Three timing rules explain most of what you see:

1. **The state, PC, SP, IR, FLAGS and registers change only at rising edges.** A row shows them as the previous edge left them. So a write that the row's WRITEBACK performs shows up in the **next** row.
2. **The RAM read is registered.** `mem_rdata` in a row is the byte at the `mem_addr` of the **previous** row ([memory-interface.md](memory-interface.md)). FETCH puts PC on the bus, and the opcode is on `mem_rdata` during DECODE.
3. **The decoder reads the bytes the moment they arrive.** In DECODE it decodes the opcode straight from `mem_rdata`, and in OPERAND1 the register byte. IR.op is latched at the end of DECODE and IR.rb and IR.tb at the end of OPERAND1, so the IR column catches up one cycle later ([control-unit.md](control-unit.md#states)). The ALU computes in every cycle, from whatever registers the current decode selects. Its output only matters when WRITEBACK enables a register or FLAGS write.

Columns: `PC`, `SP`, `IR` (`dbg_ir_op/rb/tb`, as many bytes as `dbg_ir_len`) and `FLAGS` (`dbg_flags`: `08` Z, `04` C, `02` N, `01` V) come from the debug taps. `mem write` is `[mem_addr] ← mem_wdata` when `mem_we` is 1. `ALU` is `u_alu.a`, `.op`, `.b` and `.r`. `register write` is `R[wa] ← wd` when the register file's `we` is 1. `retire` and `instret` are the retirement outputs.

### ADD R0, R1: a 2-byte ALU instruction (cycles 12–17)

`ADD R0, R1` is at `0x06`, encoded `20 01`: opcode `0x20` and register byte `0x01` (a = R0, b = R1). R0 = `F0` and R1 = `20` from the two LDIs.

| cycle | t (ns) | state     | PC  | SP  | IR       | mem_addr | mem_rdata | mem write | ALU a, op, b → r | register write | FLAGS | retire | instret |
| ----: | -----: | --------- | --- | --- | -------- | -------- | --------- | --------- | ---------------- | -------------- | ----- | ------ | ------: |
|    12 |    140 | FETCH     | 06  | FF  | 11 10 20 | 06       | 11        | –         | 20 ADD F0 → 10   | –              | 00    | 1      |       2 |
|    13 |    150 | DECODE    | 06  | FF  | 11 10 20 | 07       | 20        | –         | 20 ADD F0 → 10   | –              | 00    | 0      |       2 |
|    14 |    160 | OPERAND1  | 06  | FF  | 20 10    | 06       | 01        | –         | F0 ADD 20 → 10   | –              | 00    | 0      |       2 |
|    15 |    170 | EXECUTE   | 06  | FF  | 20 01    | 06       | 20        | –         | F0 ADD 20 → 10   | –              | 00    | 0      |       2 |
|    16 |    180 | WRITEBACK | 06  | FF  | 20 01    | 06       | 20        | –         | F0 ADD 20 → 10   | R0 ← 10        | 00    | 0      |       2 |
|    17 |    190 | FETCH     | 08  | FF  | 20 01    | 08       | 20        | –         | 10 ADD 20 → 30   | –              | 04    | 1      |       3 |

- **Cycle 12, FETCH.** `mem_addr` = PC = `06`. `retire` is 1 here, but that pulse belongs to the previous instruction, `LDI R1, 0x20`, which committed at the edge that started this cycle (`instret` 1 → 2, and `retire_pc` = `03`). The IR and the ALU still show that LDI.
- **Cycle 13, DECODE.** The opcode `20` has arrived on `mem_rdata`, and the decoder works from it directly: valid, 2 bytes long, ALU op ADD. So the FSM asks for byte 1 (`mem_addr` = PC + 1 = `07`) and goes to OPERAND1. The edge that ends this cycle latches IR.op = `20` and the length 2.
- **Cycle 14, OPERAND1.** The register byte `01` is on `mem_rdata`, and the decoder takes it from there. The register file reads R0 and R1, and the ALU already has `F0 ADD 20 → 10`. The register byte is well formed, so no `MALFORMED_OPERAND`. The instruction is 2 bytes, so the next state is EXECUTE (no OPERAND2), and `mem_addr` goes back to PC.
- **Cycle 15, EXECUTE.** IR now holds `20 01`, and the decoder reads it from IR from here on. EXECUTE is where the FSM checks the faults that need the operands (DIV by zero, stack overflow or underflow, CALL at `0xFE`). ADD has none of them. Nothing is written yet.
- **Cycle 16, WRITEBACK.** The commit cycle. The register file's `we` is 1 with `wa` = 0 and `wd` = `10`, `flags_mask` lets the ALU's flags through, and the next PC is PC + 2 = `08`. All of it happens at the edge that ends this cycle.
- **Cycle 17.** After that edge, R0 = `10`, FLAGS = `04` (C = 1: `F0 + 20` = `0x110` does not fit in 8 bits; Z, N and V are 0) and PC = `08`. `retire` pulses with `instret` = 3, and the FSM is already fetching the STORE at `08`. That matches the trace line for step 2 shown above, which completes at `"cycle":17`.

A 3-byte instruction adds OPERAND2 between OPERAND1 and EXECUTE. In the first LDI (cycles 0–5), OPERAND1 (cycle 2) asks for PC + 2, and OPERAND2 (cycle 3) has the immediate `F0` on `mem_rdata` and latches it into IR.tb.

### JNZ loop, taken (cycles 40–45)

`JNZ loop` is at `0x13`, encoded `42 11`, with target `0x11`. The `DEC R3` before it took R3 from 2 to 1, so Z = 0 (FLAGS = `04`, C left over from the ADD) and the branch is taken.

| cycle | t (ns) | state     | PC  | SP  | IR    | mem_addr | mem_rdata | mem write | ALU a, op, b → r | register write | FLAGS | retire | instret |
| ----: | -----: | --------- | --- | --- | ----- | -------- | --------- | --------- | ---------------- | -------------- | ----- | ------ | ------: |
|    40 |    420 | FETCH     | 13  | FF  | 25 30 | 13       | 25        | –         | 01 DEC 10 → 00   | –              | 04    | 1      |       7 |
|    41 |    430 | DECODE    | 13  | FF  | 25 30 | 14       | 42        | –         | 01 ADD 10 → 11   | –              | 04    | 0      |       7 |
|    42 |    440 | OPERAND1  | 13  | FF  | 42 30 | 13       | 11        | –         | 20 ADD 20 → 40   | –              | 04    | 0      |       7 |
|    43 |    450 | EXECUTE   | 13  | FF  | 42 11 | 13       | 42        | –         | 20 ADD 20 → 40   | –              | 04    | 0      |       7 |
|    44 |    460 | WRITEBACK | 13  | FF  | 42 11 | 13       | 42        | –         | 20 ADD 20 → 40   | –              | 04    | 0      |       7 |
|    45 |    470 | FETCH     | 11  | FF  | 42 11 | 11       | 42        | –         | 20 ADD 20 → 40   | –              | 04    | 1      |       8 |

- **DECODE (41)** sees the opcode `42` and asks for byte 1 at `14`. **OPERAND1 (42)** receives the target `11` and latches it into IR.tb. For a jump, byte 1 is an address, not a register byte, so it is never checked as one.
- The ALU column shows `20 ADD 20 → 40` from EXECUTE on. That is the ALU decoding `11` as if it were a register byte (R1 + R1). It means nothing, because a JNZ enables neither a register write nor a flag write: `register write` stays `–` and FLAGS stays `04`.
- **WRITEBACK (44)** writes only PC. The condition reads FLAGS: Z = 0, so the branch is taken, and the next PC is IR.tb = `11` instead of PC + 2 = `15`. A taken branch costs the same 5 cycles as one not taken, because nothing is fetched ahead.
- **Cycle 45:** PC = `11`, and the FSM fetches `DEC R3` again (`mem_addr` = `11`). Ten cycles later the second JNZ (cycles 50–54) sees FLAGS = `0C` (Z = 1) and falls through to `0x15`.

### CALL stash: a write to the stack (cycles 55–60)

`CALL stash` is at `0x15`, encoded `45 18`, with target `0x18`. It pushes its return address, `0x15` + 2 = `0x17`, at SP, and jumps.

| cycle | t (ns) | state     | PC  | SP  | IR    | mem_addr | mem_rdata | mem write | ALU a, op, b → r | register write | FLAGS | retire | instret |
| ----: | -----: | --------- | --- | --- | ----- | -------- | --------- | --------- | ---------------- | -------------- | ----- | ------ | ------: |
|    55 |    570 | FETCH     | 15  | FF  | 42 11 | 15       | 42        | –         | 20 ADD 20 → 40   | –              | 0C    | 1      |      10 |
|    56 |    580 | DECODE    | 15  | FF  | 42 11 | 16       | 45        | –         | 20 ADD 20 → 40   | –              | 0C    | 0      |      10 |
|    57 |    590 | OPERAND1  | 15  | FF  | 45 11 | 15       | 18        | –         | 20 ADD 10 → 30   | –              | 0C    | 0      |      10 |
|    58 |    600 | EXECUTE   | 15  | FF  | 45 18 | FF       | 45        | –         | 20 ADD 10 → 30   | –              | 0C    | 0      |      10 |
|    59 |    610 | WRITEBACK | 15  | FF  | 45 18 | FF       | 00        | [FF] ← 17 | 20 ADD 10 → 30   | –              | 0C    | 0      |      10 |
|    60 |    620 | FETCH     | 18  | FE  | 45 18 | 18       | 00        | –         | 20 ADD 10 → 30   | –              | 0C    | 1      |      11 |

- **EXECUTE (58)** puts the stack address on the bus: `mem_addr` = SP = `FF`. It also checks the two CALL faults: a CALL at `0xFE` (`PC_OVERFLOW`) and a full stack (`STACK_OVERFLOW`, SD = 64). Neither applies.
- **WRITEBACK (59)** holds the address and raises `mem_we` with `mem_wdata` = PC + 2 = `17`, so the RAM writes `[FF] ← 17` at the edge that ends the cycle. `mem_rdata` = `00` in this cycle is the old byte at `FF`, read in EXECUTE; the RAM reads before it writes. The same edge sets PC to IR.tb = `18`, SP to `FE` and SD to 1.
- **Cycle 60:** PC = `18`, SP = `FE`, and the FSM is fetching `PUSH R2` at `stash`. The trace line for step 10 records the same write, `"memWrites":[{"address":255,"value":23}]`, at `"cycle":60`.

The matching `RET` (cycles 70–73) is a 1-byte instruction, so it goes straight from DECODE to EXECUTE. Its EXECUTE puts SP + 1 = `FF` on the bus, the `17` arrives on `mem_rdata` in WRITEBACK (cycle 73), and that byte becomes the next PC: in cycle 74, PC = `17`, the HLT.
