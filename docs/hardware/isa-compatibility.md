# ISA Compatibility Audit

This audit fixes exactly which instruction set the VCPU-8 RTL (Project 2) implements. It records the ISA version, the full opcode table, the architectural state, the fault model, every cross-check between the Project 1 documents and code, and every discrepancy between the Project 2 brief and this repository, with its resolution.

**Result:** the RTL implements **VCPU-8 ISA 1.0.0**, unchanged. Every documented rule that was cross-checked matches the code. No Project 1 feature is impossible to build in hardware, and nothing in the ISA needs to change.

The authoritative sources are, in order:

1. The code: `@vcpu/shared` (`packages/shared/src/isa/`) for encodings and constants, and `@vcpu/cpu-core` for behaviour.
2. The committed fixtures in `fixtures/v1/` (98 of them), which record what that code does.
3. The documents [instruction-set.md](../instruction-set.md), [cpu-execution.md](../cpu-execution.md), [memory-model.md](../memory-model.md) and the hand-off [hardware-porting.md](../hardware-porting.md).

Where a document and the code disagree, the code wins. No such disagreement was found (see [Doc-vs-code cross-checks](#doc-vs-code-cross-checks)).

## ISA version

| Item                  | Value                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| ISA                   | VCPU-8 **1.0.0** (`ISA_VERSION` in `packages/shared/src/isa/constants.ts`), frozen                   |
| Opcodes               | 30 valid opcode bytes (28 mnemonics; LOAD and STORE each have `_ABS` and `_IND` variants)            |
| Invalid opcode bytes  | 226: `0x02`–`0x0F`, `0x16`–`0x1F`, `0x26`–`0x2F`, `0x37`–`0x3F`, `0x47`–`0x4F`, `0x52`–`0xFF`        |
| Formats               | N (1 byte), R, RR, A (2 bytes), RI, RA (3 bytes)                                                     |
| Fixtures              | `fixtures/v1/`, format `vcpu8-fixture/1`: 20 examples, 61 instruction vectors, 17 fault vectors = 98 |
| RTL constants package | `hardware/rtl/vcpu8/core/vcpu8_isa_pkg.sv`, generated from `@vcpu/shared` and drift-checked          |

### Opcode table

This table was rendered from the same data the generator uses (`OPCODES` plus `flagMask()` and `condCode()` in `packages/rtl-tools/src/gen/isa-pkg.ts`), so it matches the lookup functions in `vcpu8_isa_pkg.sv` row for row.

- **Fields** is `isa_fields(op)`: `NONE` means there is no register byte, `A` means only field a is used (field b must be `0000`), and `AB` means both fields are used.
- **Flag mask** is `isa_flag_mask(op)`, `flagsWritten ∪ flagsCleared` in FLAGS bit order (bit 3 = Z … bit 0 = V).
- **Ctrl** is `isa_ctrl(op)`, the next-PC behaviour.
- **Cond** is `isa_cond(op)` = `{flag bit index[1:0], value}`. A branch is taken when `flags[cond[2:1]] == cond[0]`.
- **Data R/W** is `isa_data_read(op)` / `isa_data_write(op)`, one data byte at most. Instruction fetches are not counted.

| Opcode | `OP_` name     | Syntax              | Format | Len | Fields | Flag mask `ZCNV` | Ctrl   | Cond `{bit,val}` | Data R/W |
| ------ | -------------- | ------------------- | ------ | --- | ------ | ---------------- | ------ | ---------------- | -------- |
| `0x00` | `OP_NOP`       | `NOP`               | N      | 1   | NONE   | `0000`           | SEQ    | —                | —        |
| `0x01` | `OP_HLT`       | `HLT`               | N      | 1   | NONE   | `0000`           | HALT   | —                | —        |
| `0x10` | `OP_MOV`       | `MOV Rd, Rs`        | RR     | 2   | AB     | `0000`           | SEQ    | —                | —        |
| `0x11` | `OP_LDI`       | `LDI Rd, imm8`      | RI     | 3   | A      | `0000`           | SEQ    | —                | —        |
| `0x12` | `OP_LOAD_ABS`  | `LOAD Rd, [addr8]`  | RA     | 3   | A      | `0000`           | SEQ    | —                | R        |
| `0x13` | `OP_LOAD_IND`  | `LOAD Rd, [Rp]`     | RR     | 2   | AB     | `0000`           | SEQ    | —                | R        |
| `0x14` | `OP_STORE_ABS` | `STORE [addr8], Rs` | RA     | 3   | A      | `0000`           | SEQ    | —                | W        |
| `0x15` | `OP_STORE_IND` | `STORE [Rp], Rs`    | RR     | 2   | AB     | `0000`           | SEQ    | —                | W        |
| `0x20` | `OP_ADD`       | `ADD Rd, Rs`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x21` | `OP_SUB`       | `SUB Rd, Rs`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x22` | `OP_MUL`       | `MUL Rd, Rs`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x23` | `OP_DIV`       | `DIV Rd, Rs`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x24` | `OP_INC`       | `INC Rd`            | R      | 2   | A      | `1011`           | SEQ    | —                | —        |
| `0x25` | `OP_DEC`       | `DEC Rd`            | R      | 2   | A      | `1011`           | SEQ    | —                | —        |
| `0x30` | `OP_AND`       | `AND Rd, Rs`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x31` | `OP_OR`        | `OR Rd, Rs`         | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x32` | `OP_XOR`       | `XOR Rd, Rs`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x33` | `OP_NOT`       | `NOT Rd`            | R      | 2   | A      | `1111`           | SEQ    | —                | —        |
| `0x34` | `OP_SHL`       | `SHL Rd`            | R      | 2   | A      | `1111`           | SEQ    | —                | —        |
| `0x35` | `OP_SHR`       | `SHR Rd`            | R      | 2   | A      | `1111`           | SEQ    | —                | —        |
| `0x36` | `OP_CMP`       | `CMP Ra, Rb`        | RR     | 2   | AB     | `1111`           | SEQ    | —                | —        |
| `0x40` | `OP_JMP`       | `JMP addr8`         | A      | 2   | NONE   | `0000`           | JUMP   | —                | —        |
| `0x41` | `OP_JZ`        | `JZ addr8`          | A      | 2   | NONE   | `0000`           | BRANCH | `111` (Z = 1)    | —        |
| `0x42` | `OP_JNZ`       | `JNZ addr8`         | A      | 2   | NONE   | `0000`           | BRANCH | `110` (Z = 0)    | —        |
| `0x43` | `OP_JC`        | `JC addr8`          | A      | 2   | NONE   | `0000`           | BRANCH | `101` (C = 1)    | —        |
| `0x44` | `OP_JNC`       | `JNC addr8`         | A      | 2   | NONE   | `0000`           | BRANCH | `100` (C = 0)    | —        |
| `0x45` | `OP_CALL`      | `CALL addr8`        | A      | 2   | NONE   | `0000`           | CALL   | —                | W        |
| `0x46` | `OP_RET`       | `RET`               | N      | 1   | NONE   | `0000`           | RET    | —                | R        |
| `0x50` | `OP_PUSH`      | `PUSH Rs`           | R      | 2   | A      | `0000`           | SEQ    | —                | W        |
| `0x51` | `OP_POP`       | `POP Rd`            | R      | 2   | A      | `0000`           | SEQ    | —                | R        |

## Architectural state

The RTL must match this state at every instruction boundary (see [hardware-porting.md](../hardware-porting.md#what-the-rtl-must-match)). The reset values come from `constants.ts` and are generated into `vcpu8_isa_pkg.sv` as `RESET_*`.

| State      | Width      | Reset              | Notes                                                                                                          |
| ---------- | ---------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| R0–R7      | 8 × 8 bits | `8'h00` each       | Register fields are 4 bits in the encoding; only 0–7 are valid                                                 |
| PC         | 8 bits     | `8'h00`            | Never wraps (`INSTRUCTION_OVERRUN`, `PC_OVERFLOW`)                                                             |
| SP         | 8 bits     | `8'hFF`            | The address the next push writes. Invariant `SP == 8'hFF − SD`; no instruction writes SP directly              |
| SD         | 7 bits     | `7'd0`             | Stack depth 0–64 (`STACK_CAPACITY`). Overflow and underflow are detected on SD, never on SP wrapping           |
| FLAGS      | 4 bits     | `4'h0`             | `{Z, C, N, V}` = bits 3–0 (`FLAG_Z` = 3, `FLAG_C` = 2, `FLAG_N` = 1, `FLAG_V` = 0); the byte reads `{4'h0, …}` |
| memory     | 256 × 8    | not reset          | One address space for code, data and stack. The testbench loads the image before releasing reset               |
| status     | 3 bits     | `STATUS_READY` (0) | `CPU_STATUS_NUMBERS`: READY 0, RUNNING 1, PAUSED 2, HALTED 3, FAULTED 4                                        |
| fault code | 3 bits     | `FAULT_NONE` (0)   | `FAULT_CODE_NUMBERS` (below)                                                                                   |
| fault PC   | 8 bits     | `8'h00`            | Address of the faulting instruction                                                                            |
| instret    | ≥ 32 bits  | 0                  | Retired instructions; compared with a fixture's `expected.instructions`                                        |

IR and clock cycles are not compared.

## Faults

| Number | Fault                 | Raised when                                                       | Kind        |
| ------ | --------------------- | ----------------------------------------------------------------- | ----------- |
| 0      | no fault              | —                                                                 | —           |
| 1      | `INVALID_OPCODE`      | `mem[PC]` is not one of the 30 opcodes                            | precise     |
| 2      | `MALFORMED_OPERAND`   | a used register field is 8–15, or an unused field b is not `0000` | precise     |
| 3      | `INSTRUCTION_OVERRUN` | PC + length > `0x100`                                             | precise     |
| 4      | `PC_OVERFLOW`         | a CALL at `0xFE`, whose return address would be `0x100` (D1)      | precise     |
| 4      | `PC_OVERFLOW`         | a sequential next PC of `0x100`                                   | post-commit |
| 5      | `DIVIDE_BY_ZERO`      | DIV with Rs = 0                                                   | precise     |
| 6      | `STACK_OVERFLOW`      | PUSH or CALL with SD = 64                                         | precise     |
| 7      | `STACK_UNDERFLOW`     | POP or RET with SD = 0                                            | precise     |

- **Priority (D2).** The first of these wins: `INVALID_OPCODE` → `INSTRUCTION_OVERRUN` → `MALFORMED_OPERAND` (field a before field b) → `PC_OVERFLOW` (CALL) → `DIVIDE_BY_ZERO` / `STACK_OVERFLOW` / `STACK_UNDERFLOW`. At most one of the last three can apply. `decode()` in `packages/cpu-core/src/decoder.ts` checks the first three in that order, and `cpu.ts` checks the CALL `PC_OVERFLOW` before the stack-depth check.
- **Precise faults** change nothing: no register, FLAGS, memory, SP or SD write, and PC stays at the instruction. The step is not retired, so `instret` does not change.
- **The post-commit `PC_OVERFLOW`** commits the instruction's effects and retires it, then enters FAULTED with PC left at the instruction. It is the only fault detected after the commit point (WRITEBACK).
- **Status.** The emulator's READY, RUNNING and PAUSED describe its software run loop. Architecturally they are one "can execute" state. The RTL has a single run state and reports it as `STATUS_READY` (0). It reports `STATUS_HALTED` (3) and `STATUS_FAULTED` (4) as the emulator does. RUNNING (1) and PAUSED (2) are never driven by the RTL; the generated package declares them only for completeness.

## Doc-vs-code cross-checks

Each check below compared a document against the code and was run for this audit with a script against the code at commit `6e9ee4c`. The script parsed the document tables and compared them cell by cell, or exhaustively evaluated the documented rule. All results are recorded, and there are no mismatches.

| #   | Document rule                                                                                                                               | Compared with                                      | Result                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | instruction-set.md opcode map (opcode, mnemonic, syntax, format, bytes, encoding, flag effects, cycles)                                     | `OPCODES`                                          | match: enforced by `docs-sync.test.ts` in `pnpm test`             |
| 2   | hardware-porting.md decoder table, 30 rows: len, fields, alu_op, rf_we, mem read/write, flag mask, stack push/pop, pc_sel and its condition | `OPCODES`, `INSTRUCTION_FORMATS`, `ALU_OPERATIONS` | match, 30 of 30 rows                                              |
| 3   | hardware-porting.md ALU equations, applied through the flag mask `flags_next = (flags & ~mask) \| (alu & mask)`                             | `packages/cpu-core/src/alu.ts`                     | match, 1,703,424 cases (below)                                    |
| 4   | instruction-set.md "Exact flag rules" table, 13 rows × Z C N V                                                                              | `flagsWritten`, `flagsCleared`                     | match                                                             |
| 5   | instruction-set.md list of instructions that leave all flags unchanged                                                                      | opcodes whose flag mask is `0000`                  | match                                                             |
| 6   | Flag masks `1111` for ADD…CMP except INC/DEC `1011`, `0000` otherwise (hardware-porting.md)                                                 | generated `isa_flag_mask`                          | match: enforced by `isa-pkg.test.ts`                              |
| 7   | Fault numbers in the cpu-execution.md fault table and the hardware-porting.md fault table                                                   | `FAULT_CODE_NUMBERS`                               | match, 7 of 7                                                     |
| 8   | Status numbers in hardware-porting.md and D6                                                                                                | `CPU_STATUS_NUMBERS`                               | match                                                             |
| 9   | Reset values in cpu-execution.md and hardware-porting.md                                                                                    | `RESET_*`, `STACK_CAPACITY`                        | match                                                             |
| 10  | hardware-porting.md register-byte rule (`a`: `rb[7]` or `rb[3:0] != 0` is malformed; `ab`: `rb[7]` or `rb[3]`)                              | `decodeRegisterByte`, all 256 bytes × 2 modes      | match; 64 valid RR bytes and 8 valid R/RI/RA bytes, as documented |
| 11  | instruction-set.md invalid-opcode ranges (226 bytes)                                                                                        | `lookupOpcode` over all 256 bytes                  | match, 226 invalid                                                |
| 12  | hardware-porting.md timing table, "Model (baseCycles + taken)" column                                                                       | `baseCycles`                                       | match                                                             |
| 13  | Branch conditions JZ Z = 1, JNZ Z = 0, JC C = 1, JNC C = 0 in both documents                                                                | `condition`                                        | match                                                             |
| 14  | Fault priority (cpu-execution.md, hardware-porting.md, D2)                                                                                  | check order in `decoder.ts` and `cpu.ts`           | match, by reading the code; the priority fixtures cover it        |
| 15  | Fixture counts in fixtures/README.md (20 + 61 + 17) and hardware-porting.md (98)                                                            | `fixtures/v1/*.json`                               | match: 98 fixtures plus `fixture.schema.json`                     |

Check 3 evaluated every ALU operation over all `a, b` in 0..255 and both values of the incoming C flag. That is 13 operations (CMP included) × 65,536 × 2, minus the 512 DIV cases with `b = 0`, for 1,703,424 cases. The doc's equation, masked into FLAGS, gave the same result and the same FLAGS byte as `alu.ts` in every case. DIV with `b = 0` is excluded on purpose. The CPU raises `DIVIDE_BY_ZERO` before it calls the ALU, and `alu.ts` throws for it, so the ALU has no defined output there.

## Brief-vs-repo discrepancies

The Project 2 brief (`project-2-brief.md`) was written for a generic "Silicon Lab" monorepo. These are the places where it differs from this repository, and how each is resolved.

| #   | The brief says                                                                                                     | This repository                                                                                                        | Resolution                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Work inside the `silicon-lab` monorepo                                                                             | The repo is `vcpu-8` (checked out as `virtual-cpu`)                                                                    | `silicon-lab` means this repo. No new repository is created.                                                                                                                                                                                                                                                                                        |
| 2   | Inspect `packages/isa`                                                                                             | There is no `packages/isa`. The ISA lives in `packages/shared/src/isa/` (`@vcpu/shared`)                               | `@vcpu/shared` is the ISA source. The RTL constants are generated from it into `vcpu8_isa_pkg.sv`, and nothing hand-copies an encoding.                                                                                                                                                                                                             |
| 3   | Inspect `apps/cpu-simulator`                                                                                       | There is no `apps/cpu-simulator`. The apps are `apps/web` (dashboard) and `apps/cli` (`pnpm cpu`)                      | The reference model is `@vcpu/cpu-core`, executed live from `@vcpu/rtl-tools`. The apps are not used by the hardware flow.                                                                                                                                                                                                                          |
| 4   | Test "invalid register encodings" in the register file (§6)                                                        | Register fields are 4 bits in the encoding, but the register file has only 8 entries                                   | Values 8–15 (and a non-zero unused field b) are `MALFORMED_OPERAND`, raised by the decoder in OPERANDS before any register is read or written. The register file takes a 3-bit index, so an invalid index cannot reach it. The register-file ticket therefore tests the full 3-bit index space, and the decoder ticket tests the invalid encodings. |
| 5   | "Carry detection" and "borrow semantics" (§7)                                                                      | C is the **borrow** on SUB and CMP: `C = (a < b)`, bit 8 of `{1'b0,a} − {1'b0,b}`                                      | The RTL uses the borrow directly. It is not the inverted "carry = not borrow" of some CPUs. Cross-check 3 confirms it.                                                                                                                                                                                                                              |
| 6   | "Do not assume the stack pointer itself can detect overflow" (§10)                                                 | The ISA already defines the 7-bit stack depth SD (0–64) as architectural state, compared by every fixture              | The RTL keeps SD as a register. `STACK_OVERFLOW` is `SD == 64` on PUSH or CALL, and `STACK_UNDERFLOW` is `SD == 0` on POP or RET. SP never wraps (it stays in `0xBF`–`0xFF`).                                                                                                                                                                       |
| 7   | GitHub Actions CI (§19). hardware-porting.md also says "Drift is caught in CI"                                     | There is no `.github/workflows/` yet. The fixture drift test runs only in `pnpm test`                                  | Until CI exists, `pnpm check` and the `make` targets run locally. The CI ticket (VIRT-35SUFJ) adds a workflow that runs Project 1 tests and the hardware flow with the same pinned toolchain.                                                                                                                                                       |
| 8   | Reuse the Project 1 fixtures (§13, §21 Phase 1)                                                                    | `fixtures/v1/` (format `vcpu8-fixture/1`) was designed for an RTL testbench, but no simulator has ever run it          | The fixtures are frozen. The fixture-runner ticket (VIRT-TIJ8HB) is their first simulator consumer. If the format proves awkward, the runner converts it (for example to flat `$readmemh` vectors). A real format change would get a new `vcpu8-fixture/2`, and `fixtures/v1/` would never be edited.                                               |
| 9   | Phase 1: "generate compatibility fixtures" (§21)                                                                   | 98 compatibility fixtures already exist, generated by `pnpm fixtures:export` and drift-tested                          | Phase 1 reuses them. Its new generated artefact is the hardware representation of the ISA (`vcpu8_isa_pkg.sv`).                                                                                                                                                                                                                                     |
| 10  | Suggested FSM: RESET → FETCH → DECODE → FETCH_OPERANDS → EXECUTE → MEMORY_ACCESS → WRITEBACK (§5)                  | hardware-porting.md derives FETCH → DECODE → OPERANDS → EXECUTE → WRITEBACK from the ISA and a 1-cycle synchronous RAM | The RTL follows hardware-porting.md. Reset is a synchronous active-high `rst` input, not a state. MEMORY_ACCESS is not needed, because a data read is issued in EXECUTE and consumed in WRITEBACK. WRITEBACK is the single commit point, which makes the faults precise.                                                                            |
| 11  | Status as halt state plus faults (§1)                                                                              | The emulator has five statuses: READY, RUNNING, PAUSED, HALTED and FAULTED                                             | READY, RUNNING and PAUSED collapse into one RTL run state, reported as `STATUS_READY` (0). See [Faults](#faults).                                                                                                                                                                                                                                   |
| 12  | "Division-by-zero behavior" of the ALU (§7)                                                                        | DIV by zero is a precise CPU fault, detected before the ALU is used. `alu.ts` throws for it                            | The RTL ALU may output anything for `b = 0`, because the FSM faults in EXECUTE and never commits it. The exhaustive ALU test checks DIV for `b ≠ 0`, and the fault fixtures check `DIVIDE_BY_ZERO`.                                                                                                                                                 |
| 13  | Python for test-vector orchestration (§3)                                                                          | The reference model is TypeScript, and the workspace already has Node.js                                               | Orchestrator decision: no Python. Vector generation and comparison run in `@vcpu/rtl-tools` (TypeScript) against `@vcpu/cpu-core`.                                                                                                                                                                                                                  |
| 14  | MUL and DIV may be combinational or multicycle (§7). hardware-porting.md suggests an iterative divider             | —                                                                                                                      | Orchestrator decision: v1 MUL and DIV are combinational, the simplest correct design. The iterative divider is the first microarchitecture experiment (VIRT-IROK3C). Only cycle counts change, never results.                                                                                                                                       |
| 15  | Directories `hardware/accelerators`, `hardware/fpga`, `hardware/asic`, `research/cpu`, `docs/hardware/*` (§2, §20) | Only `hardware/rtl/vcpu8/` and `docs/hardware/` exist after this ticket                                                | Each directory is created by the ticket that first puts something in it. Empty placeholders are not committed. `docs/hardware/README.md` lists the planned documents.                                                                                                                                                                               |

The table records the repository as this audit found it at the start of Project 2. By the end of Project 2 ([project-2-report.md](project-2-report.md)):

- **Row 7:** CI exists. `.github/workflows/ci.yml` runs Project 1 and `.github/workflows/hardware.yml` runs the RTL gates on the pinned toolchain ([README.md](README.md#ci)).
- **Row 8:** `make fixtures` runs all 98 fixtures unmodified, end state and lock-step trace. The format needed no change, and `fixtures/v1/` is untouched.
- **Row 14:** the iterative divider exists as `DIV_IMPL=ITER`, and the [divider experiment](performance-analysis.md#the-divider-experiment) compares it with the default.
- **Row 15:** `hardware/fpga/` and `research/cpu/` exist. Project 2 put nothing in `hardware/accelerators` or `hardware/asic`, so neither exists.

## Gaps

**None.** Every Project 1 feature can be built in synthesizable RTL as specified:

- Every encoding, length and flag rule maps onto the decoder table and the ALU equations, which cross-checks 2 and 3 confirm.
- Every fault is detectable before the WRITEBACK edge. The only exception is the post-commit `PC_OVERFLOW`, which is detected in WRITEBACK by design. So precise faults need no undo logic.
- The 256-byte memory fits a single-port synchronous RAM, and no address ever wraps.
- The stack bound is a 7-bit counter.

### Tool constraints found during setup

These are not ISA gaps. They are limits of the pinned Yosys (0.70, OSS CAD Suite 2026-10-16) that the RTL must code around. Each was observed with that Yosys while checking the generated package:

- **`import` inside a module is rejected**, both in the module header (`module m import pkg::*; (…)`) and in the module body, with a syntax error at `TOK_IMPORT`. A file-scope `import vcpu8_isa_pkg::*;` before the module works for localparams and types.
- **Calling a package function through a wildcard import crashes Yosys** (`Assert 'wire != nullptr' failed in frontends/ast/simplify.cc`). Calling it with an explicit scope works: `vcpu8_isa_pkg::isa_len(op)`.
- **`return` in a function is a syntax error.** The generated functions assign to the function name instead.

`hardware/rtl/vcpu8/tb/isa_pkg_probe.sv` demonstrates the working pattern, and `make check-isa` synthesizes it with Yosys, so a change that breaks it is caught. Verilator accepts the in-module imports that Yosys rejects.
