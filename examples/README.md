# VCPU-8 example programs

Twenty small assembly programs, one per concept in the project brief (§11). Each one is a test:
the integration suite assembles it with `@vcpu/assembler`, runs it on `@vcpu/cpu-core` and checks
the final state against its `<name>.expect.json`.

Each `.asm` file opens with a comment header that states its purpose, its expected result
(derived by hand, not copied from a run) and any 8-bit overflow. Together the examples execute
every opcode in ISA v1.0, and the suite checks that too.

| Program                     | Demonstrates                                              | Expected result                                       | Overflow notes                                                 |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| `01-addition.asm`           | `LDI`, `ADD`, `HLT`                                       | R0 = 10 + 20 = 30 (0x1E), halted at PC 0x08           | None                                                           |
| `02-subtraction.asm`        | `SUB`, borrow (C), two's-complement results, `STORE`      | 0x80 = 30; 0x81 = 20 − 50 = 0xE2 (−30), C=1 N=1       | 20 − 50 wraps below zero: 226 unsigned, −30 signed             |
| `03-multiplication.asm`     | `MUL` low byte, C/V on a lost high byte                   | 0x80 = 12 × 10 = 0x78; 0x81 = 20 × 13 → 0x04, C=1 V=1 | 260 (0x104) loses its 0x100                                    |
| `04-division.asm`           | `DIV`, `MOV`, remainder as a − q × b                      | 200 ÷ 7: 0x80 = 28, 0x81 = 4                          | None; dividing by zero faults with `DIVIDE_BY_ZERO`            |
| `05-and.asm`                | `AND` masks, `NOT` to build a clearing mask               | 0x80..0x82 = 06 86 00, Z=1                            | Not possible; logic ops clear C and V                          |
| `06-or.asm`                 | `OR` to set bits                                          | 0x80 = 0x5A, 0x81 = 0x81, N=1                         | Not possible                                                   |
| `07-xor.asm`                | `XOR` toggle, three-XOR register swap, self-clear         | 0x80..0x82 = A5 34 12, R0 = 0, Z=1                    | Not possible                                                   |
| `08-shift-left.asm`         | `SHL` as ×2; bit 7 into C                                 | 0x80 = 3 × 8 = 0x18; 0x81 = 0xC1 << 1 = 0x82, C=1     | 0xC1 × 2 = 386 loses its 0x100 into C                          |
| `09-shift-right.asm`        | `SHR` as ÷2; bit 0 into C; popcount with `JNC`            | 0x80 = 200 >> 1 = 100; 0x81 = popcount(0xB5) = 5      | None; C keeps the last bit shifted out                         |
| `10-compare.asm`            | `CMP`, `JC`, `JNC`, `JNZ`; unsigned vs signed order       | 0x80..0x82 = 01 01 01; registers unchanged            | None; 0x90 vs 0x10 is "above" unsigned, "less" signed          |
| `11-conditional-branch.asm` | if/else: `JNC` on the sign bit, `JZ`, `JMP` over an else  | 0x80 = abs(−25) = 0x19, 0x81 = 0x11                   | abs(−128) cannot be represented (stays 0x80)                   |
| `12-countdown.asm`          | `DEC`/`JNZ` loop, `STORE [Rp]`, `NOP`                     | 0x80..0x8A = 10, 9, …, 1, 0                           | None                                                           |
| `13-sum-integers.asm`       | While loop: `CMP` + `JZ` exit, `JMP` back                 | 0x80 = 1 + … + 10 = 55 (0x37)                         | Fits up to N = 22 (253); N = 23 gives 276 → 0x14, C=1          |
| `14-fibonacci.asm`          | Two-term iteration, pointer writes                        | 0x80..0x89 = 00 01 01 02 03 05 08 0D 15 22            | F(13) = 233 is the last that fits; F(14) = 377 → 0x79, C=1     |
| `15-factorial-overflow.asm` | Running product, `MUL` carry, `INC`/`DEC` preserve C      | 0x80..0x85 = 01 02 06 18 78 D0; 0x88 = 6; final C=1   | 6! = 720 (0x2D0) wraps to 0xD0 with C=1 from `MUL`             |
| `16-array-sum.asm`          | `.byte` array, `LOAD [Rp]`, 16-bit sum via carries        | 830 = 0x033E: 0x80 = 0x3E, 0x81 = 0x03                | The low byte wraps three times; each carry bumps the high byte |
| `17-array-max.asm`          | `LOAD [addr]`, `CMP` borrow as "greater than", search     | 0x80 = max 201 (0xC9), 0x81 = index 5                 | None; unsigned comparison                                      |
| `18-memory-copy.asm`        | Block copy with source and destination pointers           | "VCPU-8" copied from 0xA0 to 0x80 (56 43 50 55 2D 38) | None                                                           |
| `19-subroutines.asm`        | `CALL`/`RET`, nested calls, return addresses on the stack | 0x80 = 3² + 4² = 25; SP back to 0xFF                  | None; `square` fits for inputs up to 15                        |
| `20-stack.asm`              | `PUSH`/`POP`, last in first out                           | 0x80..0x84 = 05 04 03 02 01 (1 2 3 4 5 reversed)      | None; > 64 pushes would fault with `STACK_OVERFLOW`            |

## Memory layout

Programs start at 0x00. Inputs (`.byte` arrays placed with `.org 0xA0`) and outputs (from 0x80)
live in the data region 0x80–0xBF, and the stack grows down from 0xFF. See
[`docs/memory-model.md`](../docs/memory-model.md).

## Expectation files

`<name>.expect.json` is validated by `ExpectationSchema` in `@vcpu/shared`
(`packages/shared/src/fixtures/expectation.ts`). Bytes may be written as numbers or as hex strings
such as `"0x2A"`. Registers, flags and memory ranges that are not listed are not checked. This
is `02-subtraction.expect.json`:

```json
{
  "maxInstructions": 20,
  "status": "HALTED",
  "registers": { "R0": 30, "R2": "0xE2" },
  "flags": { "Z": 0, "C": 1, "N": 1, "V": 0 },
  "memory": [{ "address": "0x80", "bytes": ["0x1E", "0xE2"] }]
}
```

- `maxInstructions` is the run's instruction limit. A program still running at the limit fails.
- `status` is the final CPU status: `HALTED` or `FAULTED`.
- `registers` may list `R0`–`R7`, `PC` and `SP`. HLT does not advance PC, so a halted PC is the
  address of the `HLT`.
- `flags` may list `Z`, `C`, `N` and `V`, each 0 or 1.
- `memory` lists byte ranges, each starting at `address`.

## Running the examples

```sh
pnpm test        # the whole suite, including the examples
pnpm vitest run packages/cpu-core/src/__tests__/examples.integration.test.ts
```

To add an example, drop `NN-name.asm` and `NN-name.expect.json` in this folder. The suite finds
every `examples/*.asm` on its own, and it fails if an example has no expectation file, if an
expectation file has no program, or if there are fewer than 20 examples.
