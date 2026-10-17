# Formal Verification

`make -C hardware/rtl/vcpu8 formal` (or `pnpm hardware:formal`) runs SymbiYosys over a set of properties of the VCPU-8 core and its ALU. A simulation test checks the programs it runs. A formal proof checks a property for **every** input sequence: here, every program and every value the RAM can return.

**This is not a proof that the CPU is correct.** The properties cover specific invariants: reset, the FSM, when state may be written, halting and faulting, retirement, memory-access rules and the ALU's arithmetic. They do not say that an instruction does what the ISA says it does. That evidence comes from the unit tests, the 98 Project 1 fixtures and the differential tests against the TypeScript emulator, and **differential simulation remains mandatory**. Formal adds guarantees for the invariants that simulation can only sample.

## Running it

```sh
make -C hardware/rtl/vcpu8 formal            # alu_prove, core_prove, core_bmc: every task must PASS
make -C hardware/rtl/vcpu8 formal-selftest   # a deliberately false property must FAIL with a trace
make -C hardware/rtl/vcpu8 formal-mutant     # broken rf_we in a copy of the RTL must fail we_rf
```

`make formal` prints one line per task, with its proof kind, depth and engine, and exits non-zero if any task ends in FAIL, ERROR or UNKNOWN. These are the lines from the run on this commit:

```text
PASS    alu_prove                  k-induction, depth 1, smtbmc boolector; induction closed at k = 1 (1s)
PASS    core_prove                 k-induction, depth 20, smtbmc boolector; induction closed at k = 3 (7s)
PASS    core_bmc                   BMC, depth 40, smtbmc boolector (36s)
```

The tools come from the pinned OSS CAD Suite (SBY v0.70-9, Yosys 0.70+145, Boolector 3.2.4). If `sby`, `yosys` or `boolector` is missing, the target stops before running anything and points to `pnpm hardware:setup`. Every task uses the `smtbmc boolector` engine. With Yices 2.7.0 from the same suite, `core_bmc` took 281 s, against 30 s with Boolector, both measured on the same machine.

## Summary

| Group                                                       | Assertions | Assumptions                  | Engine             | Proof kind  | Depth        | Result |
| ----------------------------------------------------------- | ---------- | ---------------------------- | ------------------ | ----------- | ------------ | ------ |
| [ALU](#alu-properties-alu_prove)                            | 25         | none                         | `smtbmc boolector` | k-induction | 1 (complete) | PASS   |
| [Deterministic reset](#1-deterministic-reset)               | 7          | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |
| [Legal FSM](#2-legal-fsm)                                   | 10         | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |
| [Register-write constraints](#3-register-write-constraints) | 7          | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |
| [Halt and fault](#4-halt-and-fault)                         | 7          | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |
| [Retirement](#5-retirement)                                 | 5          | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |
| [Memory-access validity](#6-memory-access-validity)         | 8          | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |
| [Helper invariants](#helper-invariants)                     | 5          | reset in cycle 0, anyseq RAM | `smtbmc boolector` | k-induction | 20 (k = 3)   | PASS   |

The core groups are also checked by BMC from reset to depth 40 (`core_bmc`, PASS). Every core property is proven for unbounded time: none holds only to a bound. "Assertions" counts the labelled `assert` statements, all 74 of which appear in the SMT models (`yosys-smt2-assert` lines in `build/formal/*/model/design_smt2.smt2`).

### Files

| File                                | Contents                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `formal/vcpu8_alu_props.sv`         | The ALU properties, as a top module with `a`, `b`, `op` and `c_in` as free inputs |
| `formal/formal_core_top.sv`         | The core harness: `vcpu8_core` with `mem_rdata` driven by an `anyseq` value       |
| `formal/vcpu8_core_props.sv`        | The core properties, the reset assumption and the helper invariants               |
| `formal/alu_prove.sby`              | The ALU proof                                                                     |
| `formal/core_prove.sby`             | The core properties by k-induction                                                |
| `formal/core_bmc.sby`               | The same core properties by bounded model checking from reset                     |
| `formal/selftest/instret_frozen.*`  | The deliberately false property for `formal-selftest`                             |
| `mk/formal.mk`, `scripts/formal.sh` | The make targets and the runner that prints the result lines                      |

### Reading a failure

Each task runs in `build/formal/<task>/`, and its full log is `build/formal/<task>.log`. On a failure the result line lists the failed assertions by label, which are the labels in the property tables below, and the path of the counterexample:

- `build/formal/<task>/engine_0/trace.vcd`: a **basecase or BMC** failure. The trace starts at reset and is a real run of the design that breaks the property. Open it in GTKWave (`gtkwave build/formal/core_bmc/engine_0/trace.vcd`). The signals are under `formal_core_top.u_core`, the properties' nets are under `u_core.u_props`, and `mem_rdata` shows the bytes the solver chose for the RAM. `trace_tb.v` beside it replays the same run as a Verilog testbench.
- `build/formal/<task>/engine_0/trace_induct.vcd`: an **induction** failure, with no basecase failure. The trace starts from an arbitrary state that satisfies every property for k cycles and then breaks one. That state may be unreachable from reset. If it is, the properties are true but not inductive, and the fix is a helper invariant that rules the state out. If the state is reachable, the property is false: add the run to `core_bmc` or a simulation test to confirm it.

## How the proofs are set up

### The memory is unconstrained

`formal_core_top` leaves out `vcpu8_memory`. Its `mem_rdata` is an `(* anyseq *)` byte: the solver picks a fresh, arbitrary value every cycle. So the core sees every possible opcode stream and every possible data read, and a property proven here holds for **any program and any memory contents**.

This is an over-approximation of a real RAM. The anyseq "memory" need not return what was last written, and two reads of one address need not agree. That makes the core properties stronger, because they hold even for impossible memories. But it also means nothing here can depend on memory behaving like memory. For example, "RET returns to the address CALL pushed" cannot be stated, and the memory module itself is not verified here. `make test-memory` and the fixtures cover it.

### The reset assumption

The one assumption in the core tasks is `assume_reset`: `rst` is high in the first cycle. After that, `rst` is a free input, so a reset can arrive at any cycle and the properties still have to hold.

Two qualifiers in `vcpu8_core_props.sv` keep properties from being checked before the registers are defined:

- `f_live`: at least one clock edge has passed, so the first-cycle reset has taken effect. Invariants are checked when `f_live` is set.
- `f_run`: `f_live`, and the previous cycle was not a reset cycle. Properties that compare a cycle with the one before (`$past`, `$stable`) are checked when `f_run` is set. The cycle after a reset is covered by the reset properties instead.

The ALU task has no assumptions at all.

### How the properties reach the core's internals

The properties need nets inside `vcpu8_core`: the FSM state, `rf_we`, `flags_mask`, the bus select, SP and SD. The usual way to attach them is `bind`, but the pinned Yosys does not parse `bind` (`syntax error, unexpected TOK_ID`). `core/vcpu8_core.sv` therefore instantiates `vcpu8_core_props` itself, inside `` `ifdef FORMAL ``. Only the formal flow defines `FORMAL` (sby reads every file with `read -formal`). So `make lint`, every simulation and synthesis never see the instance, and the synthesizable core is unchanged.

### `proc -norom`

Each `.sby` script runs `proc -norom` before `prep`. Without it, Yosys's `proc_rom` turns the decoder's `case (opcode)` tables into ROMs (`$mem` cells with initial contents). The SMT model constrains a memory's contents only in the initial state, so in the induction step, which starts from an arbitrary state, the ROMs could hold anything. The first run without `proc -norom` failed induction on `stack_pop_addr` for exactly this reason: a RET in WRITEBACK whose decoded `mem_read` was 0. With `-norom` the tables are plain logic, as in synthesis, and the decoder is a pure function of its inputs in every step.

## ALU properties (`alu_prove`)

**Proof:** `mode prove`, depth 1, engine `smtbmc boolector`. **Assumptions:** none. **Scope:** `core/vcpu8_alu.sv` alone, for all 2²¹ combinations of `a`, `b`, `op` (all 16 codes, including the four `alu_op_t` leaves unnamed) and `c_in`.

The ALU has no state, so a check at one step covers every input combination: these are complete proofs, not samples. Each expected value is written from its arithmetic definition: a 9-bit unsigned sum or difference, and a 10-bit signed result tested against −128..127 for overflow. The RTL's own equations are not reused, so the proof checks them independently. `make test-alu` already compares all 2²¹ cases with the TypeScript ALU. The formal proof is the same claim made against the definitions instead of against another implementation.

| Label                                             | Statement                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `alu_z`, `alu_n`                                  | For every operation, Z = (R == 0) and N = R[7]                                                  |
| `alu_add_r`, `alu_add_v`                          | ADD: {C, R} = a + b as 9-bit unsigned; V = the signed sum is outside −128..127                  |
| `alu_sub_r`, `alu_sub_c`, `alu_sub_v`             | SUB: {C, R} = a − b as 9-bit unsigned, so C = (a < b), the borrow; V = signed overflow of a − b |
| `alu_inc_r`, `alu_inc_c`, `alu_inc_v`             | INC: R = a + 1 mod 256; C = c_in (preserved); V = signed overflow of a + 1                      |
| `alu_dec_r`, `alu_dec_c`, `alu_dec_v`             | DEC: R = a − 1 mod 256; C = c_in (preserved); V = signed overflow of a − 1                      |
| `alu_logic_cv`                                    | AND, OR, XOR and NOT clear C and V                                                              |
| `alu_and_r`, `alu_or_r`, `alu_xor_r`, `alu_not_r` | Their results are a & b, a \| b, a ^ b and ~a                                                   |
| `alu_shl`, `alu_shr`                              | SHL: {C, R} = {a, 0}; SHR: {R, C} = {0, a}; both clear V                                        |
| `alu_mul`                                         | MUL: R = low byte of a × b; C = V = (high byte ≠ 0)                                             |
| `alu_div_cv`, `alu_div_q`, `alu_div_0`            | DIV: C = V = 0; R = a / b when b ≠ 0; R = 0 when b = 0                                          |
| `alu_unused`                                      | The four unused op codes give R = 0, C = V = 0                                                  |

The FLAGS write mask (which flags an instruction may change) is applied outside the ALU and is not part of this proof.

## Core properties (`core_prove`, `core_bmc`)

**Proofs:**

- `core_prove`: `mode prove` (k-induction) with depth 20, engine `smtbmc boolector`. Its basecase is BMC from reset to depth 20, and its induction step closed at k = 3. Every property below, helpers included, is proven for unbounded time.
- `core_bmc`: `mode bmc`, depth 40, engine `smtbmc boolector`. It checks the same properties from reset for 40 cycles. Since all of them close by induction, `core_bmc` adds no claim. It is the reset-rooted check, whose counterexamples always start at reset and are easier to read, and it is where a future property that does not close by induction would go, labelled bounded with its depth.

**Assumptions:** `assume_reset` (rst in the first cycle) and the anyseq memory above. **Scope:** `vcpu8_core`, which is the control FSM, decoder, register file, FLAGS and ALU, without `vcpu8_memory`.

### 1. Deterministic reset

Checked in the cycle after any cycle with `rst` high, whatever the state before it.

| Label          | Statement                                             |
| -------------- | ----------------------------------------------------- |
| `reset_state`  | The FSM is in FETCH                                   |
| `reset_status` | status = `STATUS_READY` and fault_code = `FAULT_NONE` |
| `reset_pc`     | PC = `RESET_PC` (0x00)                                |
| `reset_sp_sd`  | SP = `RESET_SP` (0xFF) and SD = `RESET_SD` (0)        |
| `reset_flags`  | FLAGS = `RESET_FLAGS` (0)                             |
| `reset_regs`   | R0–R7 = `RESET_REG` (0)                               |
| `reset_retire` | retire = 0 and instret = 0                            |

### 2. Legal FSM

| Label             | Statement                                                                 |
| ----------------- | ------------------------------------------------------------------------- |
| `fsm_legal`       | The state is one of the eight `fsm_state_t` values                        |
| `fsm_t_fetch`     | FETCH → DECODE                                                            |
| `fsm_t_decode`    | DECODE → OPERAND1, EXECUTE or FAULTED                                     |
| `fsm_t_operand1`  | OPERAND1 → OPERAND2, EXECUTE or FAULTED                                   |
| `fsm_t_operand2`  | OPERAND2 → EXECUTE or FAULTED                                             |
| `fsm_t_execute`   | EXECUTE → WRITEBACK or FAULTED                                            |
| `fsm_t_writeback` | WRITEBACK → FETCH, HALTED or FAULTED                                      |
| `fsm_t_halted`    | HALTED → HALTED                                                           |
| `fsm_t_faulted`   | FAULTED → FAULTED                                                         |
| `fsm_t_other`     | No other source state exists (fails if the encoding grows without a case) |

The state is 3 bits and there are eight states, so every encoding is legal. `fsm_legal` stays as a guard in case the encoding ever grows. The transitions are checked across every edge that is not a reset (a reset goes to FETCH from any state, by `reset_state`). No running state can stay where it is, and every transition moves forward, so an instruction takes at most six cycles from FETCH to the end of WRITEBACK.

### 3. Register-write constraints

| Label           | Statement                                                        |
| --------------- | ---------------------------------------------------------------- |
| `we_rf`         | The register-file write enable `rf_we` is high only in WRITEBACK |
| `we_mem`        | The RAM write enable `mem_we` is high only in WRITEBACK          |
| `we_flags`      | The FLAGS write mask is non-zero only in WRITEBACK               |
| `wb_only_regs`  | R0–R7 change only across a WRITEBACK edge                        |
| `wb_only_flags` | FLAGS change only across a WRITEBACK edge                        |
| `wb_only_sp_sd` | SP and SD change only across a WRITEBACK edge                    |
| `wb_only_pc`    | PC changes only across a WRITEBACK edge                          |

"Never in HALTED or FAULTED" follows, since those states are not WRITEBACK. The first three check the enables themselves. The last four check the registers' values, so they would also catch a write that bypassed an enable.

### 4. Halt and fault

| Label            | Statement                                                               |
| ---------------- | ----------------------------------------------------------------------- |
| `status_running` | In FETCH … WRITEBACK, status = READY and fault_code = NONE              |
| `status_halted`  | In HALTED, status = HALTED and fault_code = NONE                        |
| `status_faulted` | In FAULTED, status = FAULTED and fault_code ≠ NONE                      |
| `stop_absorbing` | From HALTED or FAULTED, without reset, the next state is the same state |
| `stop_frozen`    | … and R0–R7, FLAGS, PC, SP and SD do not change                         |
| `stop_record`    | … and status, fault_code and fault_pc do not change                     |
| `stop_no_retire` | … and nothing retires and instret does not change                       |

`stop_no_retire` applies from the second cycle in the stopped state. HLT itself retires, so its retire pulse falls in the first HALTED cycle (see `retire_after_wb`).

### 5. Retirement

| Label                     | Statement                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `retire_after_wb`         | retire is high exactly in the cycles that follow a WRITEBACK cycle                                                         |
| `instret_count`           | instret = previous instret + retire: it increments exactly on retire                                                       |
| `retire_once`             | At most one retire pulse per instruction, counted from its FETCH to the cycle after its WRITEBACK                          |
| `fault_precise_no_retire` | Entering FAULTED from DECODE, OPERAND1, OPERAND2 or EXECUTE (a precise fault) retires nothing and leaves instret unchanged |
| `fault_wb_pc_overflow`    | The only fault entered from WRITEBACK is `PC_OVERFLOW`, the post-commit one that does retire                               |

`retire_once` uses a formal-only counter, `f_insn_retires`. It is cleared in FETCH, where the previous instruction's pulse lands, and counts the retire pulses after that.

### 6. Memory-access validity

| Label                 | Statement                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `mem_fetch_no_write`  | No write coincides with a fetch: `mem_we` is 0 in FETCH, DECODE, OPERAND1 and OPERAND2         |
| `mem_fetch_addr`      | In those states the RAM address is PC, PC + 1 or PC + 2                                        |
| `mem_write_data_addr` | A write is addressed by a data select (IR.tb, a register or SP), never by PC, PC + 1 or PC + 2 |
| `mem_fetch_pc1`       | The operand fetch at PC + 1 happens only when PC ≠ 0xFF, so it never wraps                     |
| `mem_fetch_pc2`       | The operand fetch at PC + 2 happens only when PC ≤ 0xFD, so it never wraps                     |
| `stack_inv`           | The stack invariant: SD ≤ 64 and SP = 0xFF − SD                                                |
| `stack_push_addr`     | A push (PUSH, CALL) in WRITEBACK writes at SP, and SP ≥ 0xC0                                   |
| `stack_pop_addr`      | A pop (POP, RET) in WRITEBACK reads at SP + 1, and SP ≠ 0xFF                                   |

With `stack_inv`, the two stack properties keep every stack access inside 0xC0..0xFF.

### Helper invariants

k-induction starts from any state that satisfies the properties for k cycles, including unreachable ones. These helpers rule out the unreachable states that the properties above need excluded. Each one is asserted and proven like every other property, so none is an assumption and none weakens the result.

| Label                   | Statement                                                                                | Needed by                      |
| ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------ |
| `h_ir_valid`            | In OPERAND1 … WRITEBACK, IR.op is a valid opcode and ir_len equals its length            | `mem_fetch_pc2`                |
| `h_ir_fits`             | In OPERAND1 … WRITEBACK, PC + ir_len ≤ 0x100 (DECODE faults an overrun)                  | `mem_fetch_pc2`                |
| `h_wb_push_room`        | A push in WRITEBACK has SD < 64 (EXECUTE faults `STACK_OVERFLOW`)                        | `stack_inv`, `stack_push_addr` |
| `h_wb_pop_data`         | A pop in WRITEBACK has SD > 0 (EXECUTE faults `STACK_UNDERFLOW`)                         | `stack_inv`, `stack_pop_addr`  |
| `h_in_flight_no_retire` | While an instruction is in FETCH … WRITEBACK, none of its retire pulses has been counted | `retire_once`                  |

## Checking that the checks can fail

A formal setup can pass vacuously, for example if an assumption rules out every run. Two targets show this one does not:

- `make formal-selftest` runs `formal/selftest/instret_frozen.sby`: the same harness and the same core properties, plus the deliberately false `selftest_instret_frozen` ("instret never changes after reset"). The target passes only if the task FAILs on that assertion with a counterexample trace. The solver finds one at step 6: reset, then one instruction from FETCH to its retire pulse, with the anyseq RAM supplying the opcode. The run on this commit:

  ```text
  FAIL    instret_frozen             BMC, depth 12, smtbmc boolector (2s)
            failed: selftest_instret_frozen.selftest_instret_frozen
            trace:  …/hardware/rtl/vcpu8/build/formal/instret_frozen/engine_0/trace.vcd
  formal-selftest: the false property fails with a counterexample, as it should
  ```

- `make formal-mutant` copies `core/` and `formal/` into `build/formal-mutant/` and edits the copy of `vcpu8_control.sv` so that `rf_we` is no longer gated by WRITEBACK (`assign rf_we = dec_rf_we;`). It then runs `core_prove` on the copy, and passes only if the task FAILs on `we_rf`. `core/` is never touched. The run on this commit:

  ```text
  FAIL    core_prove                 k-induction, depth 20, smtbmc boolector (0s)
            failed: formal_core_top.u_core.u_props.we_rf
            trace:  …/hardware/rtl/vcpu8/build/formal-mutant/out/core_prove/engine_0/trace.vcd
  formal-mutant: core_prove fails on we_rf for the broken rf_we, as it should
  ```

  `make formal FORMAL_DIR=build/formal-mutant/formal` runs all three tasks on the same copy: `alu_prove` passes, and `core_prove` and `core_bmc` both fail on `we_rf`, so `make formal` exits non-zero.

## What is not proven

- **ISA semantics.** Nothing here says that ADD writes a + b to Rd, that a taken JZ goes to its target, or that an instruction's flags match the emulator's. The ALU proofs cover the arithmetic in isolation. Routing operands to the ALU and results to the right register is covered only by simulation: the fixtures and the differential tests.
- **The decoder table.** The core properties hold for the decoder as written, whatever it decodes each opcode to, except where a property names a decoder output (the stack properties use `stack_op`). That the table matches the ISA is the decoder unit test's job (`make test-decoder`).
- **Fault priority and fault conditions.** Beyond the properties above (a precise fault writes and retires nothing, and only `PC_OVERFLOW` comes from WRITEBACK), nothing proves _which_ fault a given instruction raises or in what order the checks apply. The fixtures and differential tests cover that.
- **Memory contents and the memory module.** The RAM is abstracted away (see above), so nothing is proven about what a load returns, what a store leaves behind, or `vcpu8_memory` itself.
- **vcpu8_top.** The properties are proven on `vcpu8_core`. `vcpu8_top` adds only the RAM and wires.
- **Liveness beyond the FSM.** The transition properties bound each instruction to at most six cycles. Nothing is proven about whole programs, for example that a program terminates.
