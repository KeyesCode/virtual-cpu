# VCPU-8 hardware test fixtures

Machine-code test vectors for verifying an RTL implementation of VCPU-8 (Project 2) against the
TypeScript emulator. Each fixture is a full 256-byte memory image, an instruction limit and the
exact final state `@vcpu/cpu-core` reaches from reset. A per-step trace is included for
lock-step comparison. [docs/hardware-porting.md](../docs/hardware-porting.md#using-the-fixtures-in-a-testbench)
explains how to use them in a testbench.

`fixtures/v1/` holds the fixtures for **ISA 1.0.0** in format **`vcpu8-fixture/1`**. Everything
in it is generated, so do not edit it by hand:

```sh
pnpm fixtures:export   # regenerates fixtures/v1/ from examples/ and scripts/fixtures/vectors.ts
```

The output is deterministic. It has no timestamps, and fixtures are sorted by name, so
regenerating a clean tree changes nothing. The exporter writes nothing and exits non-zero if an
example no longer assembles, no longer meets its `examples/<name>.expect.json`, or any program
does not halt or fault within its instruction limit. The drift test
(`packages/cpu-core/src/__tests__/fixtures.drift.test.ts`, part of `pnpm test`) runs every
committed fixture again on cpu-core and checks its JSON, hex and trace files.

## What is in `fixtures/v1/`

| Kind          | Names               | Count | Source                                                         |
| ------------- | ------------------- | ----- | -------------------------------------------------------------- |
| `example`     | `example-01-…` …    | 20    | every `examples/*.asm`, checked against its `.expect.json`     |
| `instruction` | `op-<instruction>…` | 61    | targeted vectors: every opcode, the flag corner cases, edges   |
| `fault`       | `fault-<fault>…`    | 17    | every fault code, the fault-priority cases, post-commit faults |

Every one of the 30 opcodes completes in at least one fixture, and every `FaultCode` ends at
least one fixture. The drift test asserts both. The vectors cover, among others: ADD, SUB and CMP
carry, borrow and overflow corners; INC `0x7F` and `0xFF`; DEC `0x80` and `0x00`; INC and DEC
keeping C; SHL and SHR carry out; MUL above `0xFF`; DIV clearing C and V; logic ops clearing C
and V; every conditional branch taken and not taken; nested CALL/RET; a full 64-byte stack;
invalid opcodes; malformed register bytes; instruction overrun at `0xFE` and `0xFF`; both kinds of
`PC_OVERFLOW`; divide by zero; stack overflow by PUSH and by CALL; and stack underflow by POP and
by RET.

## Files per fixture

| File                  | Content                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `<name>.json`         | The fixture, format `vcpu8-fixture/1` (below)                                                |
| `<name>.mem.hex`      | The initial memory image for `$readmemh`: 256 lines, one byte per line, two uppercase digits |
| `<name>.expected.hex` | The expected final memory image, same format                                                 |
| `<name>.trace.jsonl`  | One JSON object per executed step, including a final faulting step                           |
| `fixture.schema.json` | JSON Schema (draft 2020-12) of the fixture format, generated from the Zod `FixtureSchemaV1`  |

Line `n` (counting from 0) of a `.hex` file is the byte at address `n`. Each line matches
`^[0-9A-F]{2}$`, and the file ends with a newline.

## Fixture format `vcpu8-fixture/1`

The format is defined by `FixtureSchemaV1` in `@vcpu/shared` (`packages/shared/src/fixtures/fixture.ts`).
All numbers are plain decimal JSON integers, and every memory image lists all 256 bytes.

```jsonc
{
  "format": "vcpu8-fixture/1",
  "isaVersion": "1.0.0", // ISA_VERSION the fixture was generated for
  "name": "op-add", // also the file's base name
  "kind": "instruction", // "example" | "instruction" | "fault"
  "description": "ADD 10 + 20 = 30: every flag 0.",
  "source": "LDI R0, 0x0A\n…", // the assembly the image was assembled from
  "initial": {
    "registers": [0, 0, 0, 0, 0, 0, 0, 0], // R0–R7
    "pc": 0,
    "sp": 255,
    "sd": 0,
    "flags": 0, // FLAGS byte: Z = bit 3, C = bit 2, N = bit 1, V = bit 0
    "memory": [17, 0, 10 /* … 256 bytes */],
  },
  "maxInstructions": 1000, // step limit; the program must halt or fault before it
  "expected": {
    "status": "HALTED", // "HALTED" | "FAULTED"
    "fault": null, // or { "code": "DIVIDE_BY_ZERO", "number": 5, "pc": 11 }
    "instructions": 4, // retired instructions
    "registers": [30, 20, 0, 0, 0, 0, 0, 0],
    "pc": 8,
    "sp": 255,
    "sd": 0,
    "flags": 0,
    "memory": [17, 0, 10 /* … 256 bytes */],
  },
}
```

- **`initial`** is always the architectural reset state in v1: R0–R7 = 0, PC = 0, SP = `0xFF`,
  SD = 0 and FLAGS = 0. Only the memory image differs between fixtures. An RTL core starts from
  reset in the same way. The format still records the registers so that a later format can start
  elsewhere, and `executeFixture` rejects a v1 fixture whose initial registers are not the reset
  values.
- **`maxInstructions`** limits the number of steps, and a faulting step counts as one.
- **`expected.fault`** is `null` exactly when the status is `HALTED`. `number` is the 3-bit
  hardware code from `FAULT_CODE_NUMBERS`, and `pc` is the address of the faulting instruction.
- **`expected.instructions`** counts retired instructions. HLT counts, and so does an
  instruction that raises the post-commit `PC_OVERFLOW`. An instruction that faults precisely does
  not count.
- IR is not architectural state, and fixtures do not compare it.

## Trace format (`<name>.trace.jsonl`)

There is one line per `step()`, oldest first. Each line is defined by `FixtureTraceStepSchema`:

```text
{"step":0,"pc":0,"ir":[69,3],"status":"READY","fault":null,"regs":[0,0,0,0,0,0,0,0],"flags":0,"sp":254,"sd":1,"nextPc":3,"memWrites":[{"address":255,"value":2}]}
```

| Field       | Meaning                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`      | 0-based step number                                                                                                                               |
| `pc`        | address of the instruction                                                                                                                        |
| `ir`        | the fetched bytes, opcode first. Only the opcode is listed when the fault (`INVALID_OPCODE`, `INSTRUCTION_OVERRUN`) came before the operand fetch |
| `status`    | status after the step: `READY` (continue), `HALTED` or `FAULTED`                                                                                  |
| `fault`     | the fault code raised by this step, or `null`                                                                                                     |
| `regs`      | R0–R7 after the step                                                                                                                              |
| `flags`     | FLAGS after the step                                                                                                                              |
| `sp`, `sd`  | SP and SD after the step                                                                                                                          |
| `nextPc`    | PC after the step. It equals `pc` for HLT, for a precise fault and for the post-commit `PC_OVERFLOW`                                              |
| `memWrites` | data-memory writes of the step in order, as `{ address, value }`. Instruction fetches and reads are not listed                                    |

A precisely faulting step is the last line. Its state equals the line before it, and its
`status` is `FAULTED`.

## Versioning

The folder is tied to the ISA version. ISA 1.0.0 is frozen, and any change to an encoding, flag
rule, fault rule, reset value or the timing model bumps `ISA_VERSION`. The fixtures are then
regenerated into a new folder (for example `fixtures/v2/`), and `fixtures/v1/` stays unchanged
for RTL built against 1.0.0. A change to the JSON shape bumps the format string
(`vcpu8-fixture/2`). See [docs/hardware-porting.md](../docs/hardware-porting.md#isa-version-freeze-policy).
