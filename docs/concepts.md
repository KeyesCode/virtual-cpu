# Concepts: From Transistors to Fetch-Decode-Execute

This guide is a short course for a software engineer who is starting out in semiconductor design. It walks from a single transistor up to a CPU that runs programs, and ties each step to VCPU-8 so that you can see the idea working in the emulator, the assembler and the dashboard.

Read it in order. Each section builds on the one before, and each has an ASCII diagram or a worked example. The precise rules live in the reference documents, and this guide links to them rather than repeating them:

| Document                                   | Use it for                                                    |
| ------------------------------------------ | ------------------------------------------------------------- |
| [architecture.md](architecture.md)         | Registers, FLAGS, the block diagram, design principles        |
| [instruction-set.md](instruction-set.md)   | Encodings, the opcode map, exact flag rules, timing, assembly |
| [memory-model.md](memory-model.md)         | The memory map and the stack                                  |
| [cpu-execution.md](cpu-execution.md)       | The execution cycle, faults, reset, metrics                   |
| [hardware-porting.md](hardware-porting.md) | How VCPU-8 maps onto SystemVerilog (Project 2)                |

When a section simplifies something, it says so in a **Simplification** note. Where this guide and the reference documents disagree, the reference documents and the `@vcpu/shared` opcode table win.

## 1. What a transistor does

A digital chip is built from billions of **transistors**. For digital logic, the one that matters is the **MOSFET** (metal-oxide-semiconductor field-effect transistor). It has three terminals that matter here: the **gate**, the **source** and the **drain**. The voltage on the gate decides whether current can flow between source and drain. So, for our purposes, a MOSFET is a **voltage-controlled switch**.

MOSFETs come in two complementary kinds:

| Kind | Conducts (switch closed) when the gate is… | Good at passing… | Typically connects the output to… |
| ---- | ------------------------------------------ | ---------------- | --------------------------------- |
| nMOS | high (logic 1)                             | a strong 0       | ground (GND, logic 0)             |
| pMOS | low (logic 0)                              | a strong 1       | the supply (VDD, logic 1)         |

**CMOS** (complementary MOS) logic pairs them. A network of pMOS transistors tries to pull the output up to VDD, and a mirror-image network of nMOS transistors tries to pull it down to GND. For any input, exactly one of the two networks conducts. The output is therefore always driven firmly to 0 or 1, and in a steady state no current flows straight from VDD to GND. That is why CMOS uses so little power when it is not switching, and why it has dominated chip design for decades.

The simplest CMOS circuit is the **inverter** (a NOT gate), which uses one transistor of each kind:

```
              VDD (1)
               │
            ┌──┴──┐
     ┌─────o┤ pMOS│   closed when A = 0
     │      └──┬──┘
 A ──┤         ├──────── Y = NOT A
     │      ┌──┴──┐
     └──────┤ nMOS│   closed when A = 1
            └──┬──┘
               │
             GND (0)

 A = 0 → pMOS closed, nMOS open   → Y pulled up to 1
 A = 1 → pMOS open,   nMOS closed → Y pulled down to 0
```

The small circle (`o`) on the pMOS gate is the usual symbol for "active when low".

> **Simplification.** A real MOSFET is an analog device. It turns on gradually around a **threshold voltage**, it leaks a little current when "off", it has resistance when "on", and charging the capacitance of the next gate takes time and energy. The digital abstraction (0 or 1, switch open or closed) holds because circuits are designed so that signals settle well clear of the threshold before anyone looks at them. That settling time is what ultimately limits the clock frequency of a chip.

**In VCPU-8:** the emulator never simulates transistors. Everything from section 2 onward, however, is something you could build from them, and Project 2 describes it in SystemVerilog, which a synthesis tool turns into these gates (or, on an FPGA, into configurable lookup tables that behave like them).

## 2. How logic gates form circuits

### Gates from transistors

Arrange pMOS and nMOS transistors in series and in parallel and you get other gates. In CMOS, the pull-up network is always the **dual** of the pull-down network: series in one becomes parallel in the other.

```
 NAND: Y = NOT (A AND B)               NOR: Y = NOT (A OR B)

        VDD         VDD                      VDD
         │           │                        │
   A ─o[pMOS]  B ─o[pMOS]  parallel     A ─o[pMOS]  series
         │           │                        │
         └─────┬─────┘                  B ─o[pMOS]
               │                              │
               ├─────── Y                     ├─────────── Y
               │                        ┌─────┴─────┐
          A ─[nMOS]  series        A ─[nMOS]   B ─[nMOS] parallel
               │                        │           │
          B ─[nMOS]                    GND         GND
               │
              GND
```

| A   | B   | NOT A | A NAND B | A NOR B | A AND B | A OR B | A XOR B |
| --- | --- | ----- | -------- | ------- | ------- | ------ | ------- |
| 0   | 0   | 1     | 1        | 1       | 0       | 0      | 0       |
| 0   | 1   | 1     | 1        | 0       | 0       | 1      | 1       |
| 1   | 0   | 0     | 1        | 0       | 0       | 1      | 1       |
| 1   | 1   | 0     | 0        | 0       | 1       | 1      | 0       |

A single CMOS stage is naturally **inverting**: NAND and NOR are the cheap gates, and AND is a NAND followed by an inverter (6 transistors). NAND alone is **universal**: every other gate, and therefore every digital circuit, can be built from NAND gates.

### Combinational versus sequential logic

Digital circuits fall into two classes.

- **Combinational logic** has no memory. Its outputs depend only on its current inputs, after a short **propagation delay** while the signals settle. Adders, multiplexers, decoders and comparators are combinational. VCPU-8's ALU and instruction decoder are combinational.
- **Sequential logic** has state. Its outputs depend on its inputs **and** on what it stored earlier. Registers, counters and memories are sequential. VCPU-8's R0–R7, PC, SP, SD and FLAGS are sequential.

Two building blocks appear everywhere:

- A **multiplexer** (mux) selects one of several inputs, steered by select bits. An 8:1 mux has 3 select bits.
- A **decoder** turns an n-bit number into 2ⁿ "one-hot" lines, exactly one of which is 1. A 3-to-8 decoder turns `101` into "line 5".

### Storing a bit: the flip-flop

Feed the outputs of two NAND gates back into each other's inputs and the loop has two stable states. That is a **latch**, the simplest circuit that remembers one bit. Add gating and you get a **D latch**, which copies its input D to its output Q while an enable signal is high and holds Q while it is low.

Chain two D latches with opposite enables (a master-slave arrangement) and you get a **D flip-flop**: it samples D only at the instant the **clock** rises (the **rising edge**) and holds that value until the next rising edge. Changes on D between edges are ignored.

```
edge        ↑t1         ↑t2         ↑t3
CLK   ______/‾‾‾‾‾\_____/‾‾‾‾‾\_____/‾‾‾‾‾\__
D     ‾‾‾‾‾‾‾‾‾‾\___/‾\_________/‾‾‾‾‾‾‾‾‾‾‾‾
Q     ______/‾‾‾‾‾‾‾‾‾‾‾\___________/‾‾‾‾‾‾‾‾

t1: D = 1, so Q becomes 1.
    The short pulse on D between t1 and t2 is ignored: no edge happened.
t2: D = 0, so Q becomes 0.
t3: D = 1, so Q becomes 1.
```

Real flip-flops need D to be stable for a short **setup time** before the edge and a **hold time** after it. The clock period must be long enough for the slowest combinational path between two flip-flops to settle; that path is the **critical path**, and it sets the maximum clock frequency.

This gives the basic shape of every synchronous digital design, including a CPU:

```
      ┌──────────────┐        ┌─────────────────────┐
  ┌──►│ flip-flops   │──────► │ combinational logic │───┐
  │   │ (state)      │  Q     │ (next state)        │   │ D
  │   └──────▲───────┘        └─────────────────────┘   │
  │          │ clk                                      │
  └──────────┴──────────────────────────────────────────┘
```

On each clock edge the flip-flops capture the next state, and between edges the combinational logic computes the one after that.

## 3. How an ALU works

The **ALU** (arithmetic logic unit) is the combinational block that computes. VCPU-8's ALU performs ADD, SUB, MUL, DIV, INC, DEC, AND, OR, XOR, NOT, SHL, SHR and CMP on 8-bit values and produces a result plus four flag values.

### The full adder

Binary addition works column by column, like decimal addition by hand. Each column adds two bits and a carry from the column to its right. A **full adder** does one column:

```
          a   b
          │   │
        ┌─▼───▼─┐
 cout ◄─┤  FA   │◄─ cin          s    = a XOR b XOR cin
        └───┬───┘                cout = (a AND b) OR (cin AND (a XOR b))
            ▼
            s
```

| a   | b   | cin | cout | s   |
| --- | --- | --- | ---- | --- |
| 0   | 0   | 0   | 0    | 0   |
| 0   | 0   | 1   | 0    | 1   |
| 0   | 1   | 0   | 0    | 1   |
| 0   | 1   | 1   | 1    | 0   |
| 1   | 0   | 0   | 0    | 1   |
| 1   | 0   | 1   | 1    | 0   |
| 1   | 1   | 0   | 1    | 0   |
| 1   | 1   | 1   | 1    | 1   |

`cout s` read as a 2-bit number is simply the count of 1s among `a`, `b` and `cin`.

### The ripple-carry adder

Chain eight full adders and each carry-out feeds the next column's carry-in. That is an 8-bit **ripple-carry adder**. Call the carry into bit `i` `cᵢ`, so `c0` is the carry into bit 0 and `c8` is the carry out of bit 7:

```
       a7 b7        a6 b6                a1 b1        a0 b0
        │  │         │  │                 │  │         │  │
      ┌─▼──▼─┐     ┌─▼──▼─┐             ┌─▼──▼─┐     ┌─▼──▼─┐
 c8 ◄─┤  FA  │◄────┤  FA  │◄── · · · ◄──┤  FA  │◄────┤  FA  │◄── c0
      └──┬───┘ c7  └──┬───┘ c6       c2 └──┬───┘ c1  └──┬───┘
         ▼            ▼                    ▼            ▼
         r7           r6                   r1           r0
```

The name comes from the carry "rippling" from bit 0 to bit 7: the top bit is not correct until every carry below it has settled. That chain is the adder's critical path. Faster adders (carry-lookahead, carry-select) compute the carries in parallel at the cost of more gates. A common textbook full adder (the "mirror adder") uses 28 transistors, so even this small 8-bit adder is a couple of hundred transistors.

### Carry and overflow come out of the adder

Two flags fall straight out of the carry chain:

- **C (carry)** is `c8`, the carry out of the top bit. It is 1 when the **unsigned** sum does not fit in 8 bits. This is VCPU-8's ADD rule `C = a + b > 0xFF`.
- **V (signed overflow)** is `c7 XOR c8`. It is 1 when the carry into the sign bit differs from the carry out of it, which happens exactly when two operands of the same sign produce a result of the other sign. This is VCPU-8's ADD rule `V = a[7] == b[7] and r[7] != a[7]`, computed with one XOR gate.

The other two are just as cheap: **Z** is a NOR of all eight result bits, and **N** is the wire `r7`.

Worked example: `ADD` with `a = 0x7F` (127) and `b = 0x01` (1).

```
 carries  c8..c1   0 1 1 1 1 1 1 1        (c0 = 0)
 a        0x7F       0 1 1 1 1 1 1 1
 b        0x01     + 0 0 0 0 0 0 0 1
                   ─────────────────
 r        0x80       1 0 0 0 0 0 0 0

 Z = 0   r is not zero
 C = 0   c8 = 0: as unsigned, 127 + 1 = 128 fits in a byte
 N = 1   r7 = 1: as signed, the result reads as −128
 V = 1   c7 XOR c8 = 1 XOR 0: as signed, 127 + 1 = −128 is wrong
```

That matches the `ADD (0x7F, 0x01)` row in [instruction-set.md](instruction-set.md#exact-flag-rules): `r = 0x80`, Z = 0, C = 0, N = 1, V = 1. Compare `ADD (0xFF, 0x01)`: the result is `0x00` with C = 1 (unsigned 255 + 1 wrapped) but V = 0 (signed −1 + 1 = 0 is correct).

### Subtraction uses the same adder

Hardware subtracts by adding the two's-complement negation: `a − b = a + (NOT b) + 1`. Invert `b` with XOR gates and set `c0 = 1`, and the adder subtracts.

With that trick, `c8 = 1` means "no borrow" (`a ≥ b` as unsigned). VCPU-8 defines C after SUB and CMP as the **borrow**, `C = a < b`, so its C is `NOT c8` for subtraction. CPUs differ here: x86 also stores the borrow, while ARM and the 6502 store `c8` itself. V is still `c7 XOR c8`. For example, `SUB (0x80, 0x01)` computes `0x80 + 0xFE + 1 = 0x17F`, so `r = 0x7F`, `c8 = 1` (no borrow, C = 0) and V = 1 (−128 − 1 overflows), as the reference table says.

**CMP** is a SUB whose register write is switched off: the flags are updated and the result is thrown away.

### Selecting the operation

The ALU computes several candidate results side by side and a **mux** picks one. The select lines come from the instruction decoder, which derives them from the opcode:

```
              ┌──► [ add / subtract   ] ──┐
              ├──► [ AND OR XOR NOT   ] ──┤     ┌──────────┐
  a, b ───────┼──► [ shift left/right ] ──┼────►│  result  ├──► r ──► register write
              └──► [ multiply / divide] ──┘     │   mux    │    └───► Z = NOR(r), N = r7
                                                └────▲─────┘
                                                     │ select
                                          ALU op, decoded from the opcode
```

A second control signal, the **flag-write mask**, decides which of Z, C, N and V are actually updated. That is how `INC` and `DEC` leave C unchanged, how `AND` clears C and V, and how `MOV` leaves every flag alone. Both the ALU op and the mask come from the same opcode-table row in `@vcpu/shared`.

> **Simplification.** Multiplication and division are much bigger than addition. A combinational 8×8 multiplier is an array of adders; a smaller design takes several clock cycles to shift and add. Division is usually iterative. VCPU-8's timing model charges `MUL` 3 extra cycles and `DIV` 7 extra cycles as a nod to this. Those numbers are an instructional estimate, not a real circuit's latency.

## 4. How CPU registers work

A **register** is a group of flip-flops that share a clock: an 8-bit register is eight D flip-flops side by side. To make a register hold its value on cycles when it should not change, each flip-flop gets a 2:1 mux in front of it: `D = write_enable ? new_value : Q`.

A **register file** is a set of registers with shared access paths called **ports**:

- A **write port** has data, a register number and an enable. A decoder turns the register number into one enable line per register, so only the chosen register loads the new value on the next clock edge.
- A **read port** has a register number and data out. It is a wide mux that selects one register's outputs.

VCPU-8's register file is R0–R7: 8 registers × 8 bits = 64 flip-flops, with **two read ports and one write port** (see the block diagram in [architecture.md](architecture.md#block-diagram)):

```
                      ┌──────────┐
  write number (3) ──►│ 3-to-8   ├── en0 ─┐   en1 ─┐         en7 ─┐
  write enable ──────►│ decoder  │        ▼        ▼              ▼
                      └──────────┘     ┌──────┐ ┌──────┐       ┌──────┐
  write data (8) ─────────────────────►│  R0  │ │  R1  │  ...  │  R7  │  each: 8 D flip-flops
  clock ──────────────────────────────►│      │ │      │       │      │
                                       └──┬───┘ └──┬───┘       └──┬───┘
                                          │        │              │
                                    ┌─────▼────────▼──────────────▼─────┐
  read number a (3) ───────────────►│ 8:1 mux, 8 bits wide              ├──► port a
                                    ├───────────────────────────────────┤
  read number b (3) ───────────────►│ 8:1 mux, 8 bits wide              ├──► port b
                                    └───────────────────────────────────┘
```

Why this shape fits VCPU-8's instructions:

- `ADD Rd, Rs` reads Rd on port a and Rs on port b, feeds both to the ALU, and writes the result back into Rd through the write port.
- Reading happens combinationally during the cycle, and writing happens at the clock edge. So in `ADD R0, R0` both operands are the old value of R0, and the new value appears only after the edge. The rule in [cpu-execution.md](cpu-execution.md#the-execution-cycle), "the source is always the value from before the instruction", is what edge-triggered registers give you for free.
- A register field in a VCPU-8 instruction is 4 bits wide, but only 3 bits are needed to select one of 8 registers. A field value of 8–15 (top bit set) is the `MALFORMED_OPERAND` fault rather than a ninth register.

The CPU has other registers that are not in the register file. **PC** (program counter) holds the address of the next instruction. **SP** (stack pointer) and **SD** (stack depth) describe the stack. **FLAGS** holds Z, C, N and V. **IR** (instruction register) holds the instruction being executed. They are built the same way, from flip-flops with enables, but they are wired to their own logic instead of to general read and write ports.

> **Simplification.** Large register files in real CPUs are built as small, fast SRAM-like arrays with many ports rather than individual flip-flops and muxes. For 64 bits, plain flip-flops are exactly what a synthesis tool would produce.

## 5. How memory addressing works

A **memory** is a large array of storage cells plus the logic to pick one. You present an **address**, and the memory either returns the stored **data** (a read) or stores new data (a write).

VCPU-8 has 256 bytes of memory: a **256 × 8** array, which is 2048 bits. The address is 8 bits wide because 2⁸ = 256, so every 8-bit value is a valid address and a data access can never be out of range.

### The address decoder

Conceptually, an 8-to-256 **decoder** turns the address into 256 "word lines", one per byte, and exactly one is active. The active word line connects that byte's 8 cells to the data lines.

Real memories fold the array into a rectangle so that the wires stay short. Split VCPU-8's address into a high nibble (row) and a low nibble (column) and the 256 bytes become a 16 × 16 grid. The memory map from [memory-model.md](memory-model.md#memory-map) falls on whole rows:

```
 address 0x83 = 1000 0011
                └┬─┘ └┬─┘
                 8    3
                row  column

                     column (low nibble), selected by a 16:1 mux
                     0 1 2 3 4 5 6 7 8 9 A B C D E F
                   ┌─────────────────────────────────┐
 row           0   │ . . . . . . . . . . . . . . . . │ ┐
 (high nibble) 1   │ . . . . . . . . . . . . . . . . │ │
 chosen by a   …   │                                 │ │ program  0x00–0x7F
 4-to-16       7   │ . . . . . . . . . . . . . . . . │ ┘
 decoder       8   │ . . . ■ . . . . . . . . . . . . │ ┐
               …   │                                 │ │ data     0x80–0xBF
               B   │ . . . . . . . . . . . . . . . . │ ┘
               C   │ . . . . . . . . . . . . . . . . │ ┐
               …   │                                 │ │ stack    0xC0–0xFF
               F   │ . . . . . . . . . . . . . . . . │ ┘
                   └─────────────────────────────────┘

 ■ = the byte at 0x83: the row decoder enables row 8, the column mux picks column 3
```

Hex dumps conventionally print memory in rows of 16 bytes for the same reason: each row is one value of the high nibble.

> **Simplification.** Real on-chip memory uses dense **SRAM** cells (commonly six transistors per bit) or **DRAM** cells (one transistor and one capacitor per bit), with sense amplifiers to read the tiny signals reliably. The emulator stores memory as a plain array of 256 numbers. The addressing logic is the same idea either way.

### Absolute versus register-indirect addressing

The CPU's **address mux** decides where the address comes from. VCPU-8's LOAD and STORE have two addressing modes:

| Mode              | Assembly          | Bytes      | Address comes from                    |
| ----------------- | ----------------- | ---------- | ------------------------------------- |
| Absolute          | `LOAD R1, [0x80]` | `12 10 80` | the instruction itself (byte 2)       |
| Register-indirect | `LOAD R1, [R2]`   | `13 12`    | the value currently in R2 (a pointer) |

```
                     ┌───────────────────────┐
  PC, PC+1, PC+2 ───►│                       │
  addr8 (from IR) ──►│     ADDRESS MUX       ├──► address (8) ──► memory 256 × 8
  Rp (read port) ───►│                       │
  SP / SP+1 ────────►│                       │
                     └───────────▲───────────┘
                                 │ select: fetch / absolute / indirect / stack
```

Absolute addressing is right for a fixed variable, such as a result cell at `0x80`. Register-indirect addressing is what makes arrays and loops possible, because the program can change the address at run time:

```
        LDI R2, 0x80      ; R2 points at the first element
        LDI R3, 0         ; running sum
        LDI R4, 4         ; element count
loop:   LOAD R1, [R2]     ; R1 ← mem[R2]
        ADD R3, R1
        INC R2            ; point at the next byte
        DEC R4
        JNZ loop
```

The same instruction, `LOAD R1, [R2]` (`13 12`), reads `0x80`, then `0x81`, `0x82` and `0x83`.

## 6. What machine code is

**Machine code** is the CPU's native language: instructions encoded as bytes in memory. The CPU fetches those bytes and the decoder turns them into control signals. VCPU-8 is a **von Neumann** machine: code and data share the same 256 bytes, so a program is just bytes that happen to be executed. The CPU cannot tell code from data, which is why a STORE into the program region creates self-modifying code (allowed in VCPU-8).

### VCPU-8's instruction formats

Every instruction is 1, 2 or 3 bytes long. Byte 0 is the **opcode**, and the opcode alone decides the format and length ([instruction-set.md](instruction-set.md#instruction-formats)):

| Format | Bytes | Layout                     | Used by                                               |
| ------ | ----- | -------------------------- | ----------------------------------------------------- |
| N      | 1     | `[op]`                     | NOP, HLT, RET                                         |
| R      | 2     | `[op] [rrrr 0000]`         | INC, DEC, NOT, SHL, SHR, PUSH, POP                    |
| RR     | 2     | `[op] [aaaa bbbb]`         | MOV, LOAD [Rp], STORE [Rp], ADD … DIV, AND … XOR, CMP |
| RI     | 3     | `[op] [rrrr 0000] [imm8]`  | LDI                                                   |
| RA     | 3     | `[op] [rrrr 0000] [addr8]` | LOAD [addr8], STORE [addr8]                           |
| A      | 2     | `[op] [addr8]`             | JMP, JZ, JNZ, JC, JNC, CALL                           |

The second byte of formats R, RR, RI and RA is the **register byte**: bits 7–4 are field **a** and bits 3–0 are field **b**. A used field holds a register number 0–7, and an unused field must be `0000`.

### Worked example: `ADD R0, R1`

`ADD` is opcode `0x20`, format RR. Rd goes in field a and Rs in field b:

```
 ADD R0, R1
  │   │   └── Rs = R1 → field b = 0001
  │   └────── Rd = R0 → field a = 0000
  └────────── opcode ADD = 0x20

 byte 0: opcode         byte 1: register byte
 0010 0000              0000 0001
 = 0x20                 └┬─┘ └┬─┘
                         a    b      (fields)
                        = 0x01

 machine code: 20 01
```

More encodings, all from the opcode table:

| Assembly           | Bytes      | How it breaks down                                                                |
| ------------------ | ---------- | --------------------------------------------------------------------------------- |
| `LDI R0, 10`       | `11 00 0A` | LDI = `0x11`; register byte `00` (R0 in field a, b unused); immediate 10 = `0x0A` |
| `LDI R3, -1`       | `11 30 FF` | −1 in two's complement is `0xFF`                                                  |
| `JNZ 0x04`         | `42 04`    | JNZ = `0x42`, format A; the target address follows                                |
| `INC R7`           | `24 70`    | INC = `0x24`, format R; field a = 7, field b = 0                                  |
| `STORE [0x81], R4` | `14 40 81` | STORE [addr8] = `0x14`; Rs goes in field a, the address in byte 2                 |

The last row is worth noticing: in assembly the destination comes first (`[0x81]`), but the encoding puts the register in field a and the address last. [instruction-set.md](instruction-set.md#operand-order-versus-encoding-order) lists both such cases.

Decoding runs the same table backwards. The bytes `42 06` are opcode `0x42` = JNZ, format A, so the next byte is a target address: `JNZ 0x06`. A byte that is not one of the 30 opcodes, such as `0x02`, has no meaning and faults with `INVALID_OPCODE`. The register byte `0x80` after an `ADD` names "register 8" in field a and faults with `MALFORMED_OPERAND`.

## 7. How assembly becomes machine code

**Assembly language** is a readable, one-line-per-instruction notation for machine code. An **assembler** translates it. The hard part is **labels**: a name such as `loop` stands for an address, and a jump can refer to a label that is defined further down the file (a **forward reference**). When the assembler reaches `CALL save`, it does not yet know where `save` is.

The classic answer, and the one VCPU-8's assembler uses, is **two passes**:

1. **Pass 1** walks the source and tracks the **location counter**, the address of the next byte. For each instruction it works out the length from the mnemonic and operand form, without emitting anything. Each label gets the current location counter, and each `.equ` gets its value. The result is the **symbol table**.
2. **Pass 2** walks the source again and emits bytes, now that every symbol has a value. It looks up opcodes in the shared table, packs register bytes and substitutes addresses.

### Worked example

This program sums 5 + 4 + 3 + 2 + 1 and stores the result at `0x80` through a subroutine:

```
        .equ OUT, 0x80     ; a named constant; emits no bytes
        LDI R0, 5          ; counter
        LDI R1, 0          ; sum
loop:   ADD R1, R0         ; sum ← sum + counter
        DEC R0             ; counter ← counter − 1, sets Z when it reaches 0
        JNZ loop           ; backward reference
        CALL save          ; forward reference: save is not defined yet
        HLT
save:   STORE [OUT], R1
        RET
```

**Pass 1** computes each address from the instruction lengths (3 for LDI and STORE [addr8], 2 for ADD, DEC, JNZ and CALL, 1 for HLT and RET):

| Address | Source            | Length | Symbol defined |
| ------- | ----------------- | ------ | -------------- |
| —       | `.equ OUT, 0x80`  | 0      | `OUT = 0x80`   |
| `0x00`  | `LDI R0, 5`       | 3      |                |
| `0x03`  | `LDI R1, 0`       | 3      |                |
| `0x06`  | `ADD R1, R0`      | 2      | `loop = 0x06`  |
| `0x08`  | `DEC R0`          | 2      |                |
| `0x0A`  | `JNZ loop`        | 2      |                |
| `0x0C`  | `CALL save`       | 2      |                |
| `0x0E`  | `HLT`             | 1      |                |
| `0x0F`  | `STORE [OUT], R1` | 3      | `save = 0x0F`  |
| `0x12`  | `RET`             | 1      |                |

Symbol table: `OUT = 0x80`, `loop = 0x06`, `save = 0x0F`.

**Pass 2** emits the bytes:

| Address | Source            | Bytes      | Notes                                        |
| ------- | ----------------- | ---------- | -------------------------------------------- |
| `0x00`  | `LDI R0, 5`       | `11 00 05` |                                              |
| `0x03`  | `LDI R1, 0`       | `11 10 00` | R1 in field a                                |
| `0x06`  | `ADD R1, R0`      | `20 10`    | Rd = R1 in field a, Rs = R0 in field b       |
| `0x08`  | `DEC R0`          | `25 00`    |                                              |
| `0x0A`  | `JNZ loop`        | `42 06`    | `loop` resolved from the symbol table        |
| `0x0C`  | `CALL save`       | `45 0F`    | the forward reference, now known             |
| `0x0E`  | `HLT`             | `01`       |                                              |
| `0x0F`  | `STORE [OUT], R1` | `14 10 80` | Rs = R1 in field a, `OUT` = `0x80` in byte 2 |
| `0x12`  | `RET`             | `46`       |                                              |

The 19-byte program image is:

```
11 00 05 11 10 00 20 10 25 00 42 06 45 0F 01 14 10 80 46
```

When it halts, R0 = 0, R1 = 15 (`0x0F`) and `mem[0x80]` = `0x0F`. This program reappears in sections 8, 10 and 11.

A **disassembler** does the reverse. It walks the bytes, uses each opcode to find the length and format, and prints canonical assembly. It cannot recover label names or comments, because those never made it into the machine code: `42 06` comes back as `JNZ 0x06`.

## 8. Fetch-decode-execute

A CPU runs a program by repeating one loop forever: **fetch** the instruction at PC, **decode** it, **execute** it, and move PC on. VCPU-8 makes this loop precise in [cpu-execution.md](cpu-execution.md#the-execution-cycle), where each call to `step()` runs one instruction:

```
 ┌─► 0. Gate      HALTED or FAULTED?                         yes → stop
 │   1. Fetch     opcode ← mem[PC]                           not an opcode      → FAULT
 │   2. Bounds    L ← the opcode's length                    PC + L > 0x100     → FAULT
 │   3. Decode    operand bytes ← mem[PC+1 … PC+L−1]         bad register byte  → FAULT
 │   4. Next PC   seq ← PC + L                               CALL at 0xFE       → FAULT
 │   5. Execute   read registers and memory;                 divide by zero,    → FAULT
 │                compute result, flags, target              stack full/empty
 │   ─────────────── nothing above this line changes architectural state ───────────────
 │   6. Commit    write register, memory byte, FLAGS, SP, SD
 │   7. PC        target (taken jump, CALL, RET), else seq;  HLT: PC unchanged, HALTED
 │   8. Metrics   instructions, estimated cycles, memory and branch counts
 │   9. Trace     one entry describing what changed
 └── next step()
```

### Worked example: `JNZ loop` at `0x0A`

In the program from section 7, after the first `DEC R0` has made R0 = 4 (so Z = 0):

| Step    | What happens                                                                   |
| ------- | ------------------------------------------------------------------------------ |
| Fetch   | `mem[0x0A]` = `0x42`: the opcode table says JNZ, format A, length 2            |
| Bounds  | `0x0A + 2 = 0x0C ≤ 0x100`: the whole instruction is inside memory              |
| Decode  | operand byte `mem[0x0B]` = `0x06`; format A has no register byte to check      |
| Next PC | `seq = 0x0C`                                                                   |
| Execute | Z = 0, so the condition holds and the target is `0x06`                         |
| Commit  | nothing to write: JNZ changes no register, memory or flags                     |
| PC      | PC ← `0x06` (control transferred)                                              |
| Metrics | instructions + 1, estimated cycles + 3 + 1 (taken penalty), branches taken + 1 |

On the fifth pass DEC makes R0 = 0 and sets Z = 1, so JNZ falls through to `0x0C`, costs 3 cycles and counts as a branch not taken.

### Fault rules

Steps 1–5 only **read** state, and step 6 is the single point where anything changes. A fault detected in steps 1–5 therefore leaves every register, flag and memory byte untouched, and PC still points at the bad instruction. Such faults are called **precise**, and they mean the debugger shows exactly the state the faulting instruction saw. When several faults apply, the earliest step wins.

VCPU-8 has seven fault codes, listed in [cpu-execution.md](cpu-execution.md#fault-table): `INVALID_OPCODE`, `MALFORMED_OPERAND`, `INSTRUCTION_OVERRUN`, `PC_OVERFLOW`, `DIVIDE_BY_ZERO`, `STACK_OVERFLOW` and `STACK_UNDERFLOW`. The one exception to precision is the sequential `PC_OVERFLOW`: an instruction such as `NOP` at `0xFF` completes its effects, and only then does the CPU fault, because the next PC (`0x100`) cannot be stored in 8 bits. Addresses never wrap from `0xFF` back to `0x00`.

After a fault, or after `HLT`, the CPU does nothing until it is reset.

> **Simplification.** Real CPUs **pipeline** this loop: while one instruction executes, the next is being decoded and the one after that fetched, so several instructions are in flight at once. High-performance CPUs also execute out of order and speculate past branches. Even a simple non-pipelined hardware CPU spreads one instruction over several clock cycles. The VCPU-8 emulator does none of this. It executes each instruction as one atomic `step()`, and the dashboard's FETCH → DECODE → EXECUTE → WRITEBACK display is a conceptual picture, not a cycle-accurate one.

## 9. What CPU flags mean

The **flags** are single bits that describe the last result. Conditional branches read them, which is how a program makes decisions. VCPU-8's FLAGS register is `0000 ZCNV`:

| Flag | Name     | Set when                                                                                                                                         |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Z    | Zero     | the result is `0x00`                                                                                                                             |
| C    | Carry    | an unsigned result did not fit: carry out of ADD, **borrow** out of SUB/CMP, the high byte of MUL is not zero, or the bit shifted out by SHL/SHR |
| N    | Negative | bit 7 of the result is 1 (the sign bit in two's complement)                                                                                      |
| V    | Overflow | the signed (two's-complement) result is wrong for the operands                                                                                   |

### Signed versus unsigned

A byte is just 8 bits. Whether it means 0..255 (**unsigned**) or −128..127 (**signed**, two's complement) is up to the program. The CPU has no signed mode: ADD produces the same bits either way, and it reports both interpretations at once, with **C for unsigned** and **V for signed**.

| Bits        | Hex    | Unsigned | Signed |
| ----------- | ------ | -------- | ------ |
| `0000 0000` | `0x00` | 0        | 0      |
| `0000 0001` | `0x01` | 1        | 1      |
| `0111 1111` | `0x7F` | 127      | 127    |
| `1000 0000` | `0x80` | 128      | −128   |
| `1111 1111` | `0xFF` | 255      | −1     |

Worked examples (from [instruction-set.md](instruction-set.md#exact-flag-rules)):

| Operation     | Result | Z C N V | Unsigned view           | Signed view                   |
| ------------- | ------ | ------- | ----------------------- | ----------------------------- |
| `0xFF + 0x01` | `0x00` | 1 1 0 0 | 255 + 1 wrapped (C = 1) | −1 + 1 = 0, correct (V = 0)   |
| `0x7F + 0x01` | `0x80` | 0 0 1 1 | 127 + 1 = 128, fine     | 127 + 1 ≠ −128, wrong (V = 1) |
| `0x80 + 0x80` | `0x00` | 1 1 0 1 | 128 + 128 wrapped       | −128 + −128 overflowed        |
| `0x00 − 0x01` | `0xFF` | 0 1 1 0 | 0 − 1 borrowed (C = 1)  | 0 − 1 = −1, correct           |
| `0x80 − 0x01` | `0x7F` | 0 0 0 1 | 128 − 1 = 127, fine     | −128 − 1 ≠ 127, wrong (V = 1) |

### Comparing and branching

`CMP Ra, Rb` subtracts Rb from Ra, sets the flags and discards the result. VCPU-8 can branch on Z and C:

| After `CMP Ra, Rb` | Unsigned meaning | Branch |
| ------------------ | ---------------- | ------ |
| Z = 1              | Ra == Rb         | `JZ`   |
| Z = 0              | Ra != Rb         | `JNZ`  |
| C = 1              | Ra < Rb          | `JC`   |
| C = 0              | Ra ≥ Rb          | `JNC`  |

Take R0 = `0x05` and R1 = `0xFB`. As unsigned, that is 5 and 251. As signed, it is 5 and −5. `CMP R0, R1` computes `0x05 − 0xFB = 0x0A` (mod 256), with C = 1, N = 0 and V = 0:

- **Unsigned:** C = 1 means 5 < 251, which is true, and `JC` is taken.
- **Signed:** the rule is "Ra < Rb exactly when N ≠ V". Here N = V = 0, so 5 < −5 is false, which is also correct.

ISA v1.0 has no branch on N or V. To compare signed values, flip the sign bit of both operands with `XOR` against `0x80` first. That maps −128..127 onto 0..255 in the same order, so the unsigned branches then give the signed answer.

Two common surprises, both by design: loading a zero with `LDI`, `LOAD` or `POP` does **not** set Z, because only ALU instructions change flags; and `INC` and `DEC` do not touch C. The second is what lets a loop counter be updated between an `ADD` and a `JC` without losing the carry.

## 10. How a stack works

A **stack** is a last-in, first-out region of memory. **Push** puts a byte on top, and **pop** takes the top byte off. CPUs use a stack to save registers and, most importantly, to remember where to return to after a subroutine call.

VCPU-8's stack occupies `0xC0`–`0xFF` and **grows down** from `0xFF` ([memory-model.md](memory-model.md#stack)). Two registers track it:

- **SP** (stack pointer) is the address the **next push** writes. It starts at `0xFF`.
- **SD** (stack depth) counts the bytes on the stack, from 0 to 64. It starts at 0.

```
push(v):  mem[SP] ← v;  SP ← SP − 1;  SD ← SD + 1
pop():    SP ← SP + 1;  v ← mem[SP];  SD ← SD − 1
```

`PUSH Rs` and `POP Rd` move a register to and from the stack. `CALL addr8` pushes the **return address** (the address just after the CALL) and jumps. `RET` pops that address back into PC.

### Push and pop, step by step

Starting from reset, with R0 = 7 (this is the example from [memory-model.md](memory-model.md#example)):

```
            reset           PUSH R0          POP R1
            SP=0xFF SD=0    SP=0xFE SD=1     SP=0xFF SD=0

  0xFD     │  00  │         │  00  │         │  00  │
  0xFE     │  00  │   SP ──►│  00  │         │  00  │
  0xFF SP ►│  00  │         │  07  │   SP ──►│  07  │  R1 ← 07
           └──────┘         └──────┘         └──────┘
```

Pop does not erase the byte. `0xFF` still holds `07` until a later push overwrites it.

### CALL and RET in the section 7 program

`CALL save` sits at `0x0C` and is 2 bytes long, so its return address is `0x0E`, the `HLT`:

```
 before CALL save        after CALL save         after RET
 (PC = 0x0C)             (PC = 0x0F, in save)    (PC = 0x0E, the HLT)
 SP=0xFF SD=0            SP=0xFE SD=1            SP=0xFF SD=0

 0xFE     │  00  │       0xFE SP►│  00  │        0xFE     │  00  │
 0xFF SP ►│  00  │       0xFF    │  0E  │◄─ ret  0xFF SP ►│  0E  │  (stale)
          └──────┘               └──────┘                 └──────┘
```

Because the return address lives on a stack, subroutines can call other subroutines, and each RET returns to its own caller in reverse order.

### Overflow and underflow

The stack has room for 64 bytes. Pushing onto a full stack, or popping from an empty one, is a bug in the program:

- A push (`PUSH` or `CALL`) when SD = 64 faults with `STACK_OVERFLOW`. Unbounded recursion is the usual cause.
- A pop (`POP` or `RET`) when SD = 0 faults with `STACK_UNDERFLOW`. A `RET` with no matching `CALL` is the usual cause.

Both faults are precise, so nothing is written. VCPU-8 keeps SD as a separate counter because an 8-bit SP alone cannot tell a full stack from an empty one once it wraps around. Since nothing else writes SP, `SP == 0xFF − SD` always holds.

> **Simplification.** The stack region is a convention, not protected memory. A `STORE` can still overwrite a saved return address, and the CPU will happily return to the corrupted address. Real systems add memory protection, guard pages or stack canaries to catch that.

## 11. How performance is measured

"How fast is it?" has three different answers for VCPU-8, and they must not be confused:

| Measure               | What it counts                                                     | Depends on                                                 |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| **Host time**         | wall-clock time for the emulator to run a program on your computer | your CPU, the JavaScript engine, tracing, the OS           |
| **Estimated cycles**  | VCPU-8's instructional timing model, added up per instruction      | only the program and its data (deterministic)              |
| **Real clock cycles** | clock edges a physical (or RTL-simulated) VCPU-8 actually needs    | the hardware design: pipelining, memory, multi-cycle units |

The emulator measures **host time** and reports **estimated cycles**. It cannot report real clock cycles, because no VCPU-8 hardware exists yet; Project 2 will be able to count them in RTL simulation. The dashboard and the CLI label cycle counts as estimates.

### The timing model

[instruction-set.md](instruction-set.md#timing-model) gives the formula. One instruction costs:

```
cycles = L                          1 per instruction byte fetched
       + 1                          execute
       + 1 per data-memory access   LOAD, STORE, PUSH, POP, CALL, RET
       + 3 extra for MUL, 7 extra for DIV
       + 1 when control transfers   JMP, CALL, RET always; Jcc only when taken
```

So `ADD` (2 bytes) costs 3, `LDI` (3 bytes) costs 4, `CALL` costs 2 + 1 + 1 = 4, plus 1 because it transfers control.

### Two ratios

- **CPI** (cycles per instruction) = cycles ÷ instructions retired. It describes how much work an average instruction takes.
- **IPS** (instructions per second) = instructions retired ÷ seconds. For the emulator this is host IPS, a measure of how fast the simulator runs on your machine, not of VCPU-8.

For real hardware, the "iron law" of processor performance ties them together:

```
time = instructions × CPI ÷ clock frequency
```

### Worked example: the section 7 program

| Instructions                      | Count  | Estimated cycles each | Subtotal |
| --------------------------------- | ------ | --------------------- | -------- |
| `LDI R0, 5`, `LDI R1, 0`          | 2      | 4                     | 8        |
| `ADD R1, R0`, `DEC R0` (5 passes) | 10     | 3                     | 30       |
| `JNZ loop` taken                  | 4      | 3 + 1                 | 16       |
| `JNZ loop` not taken              | 1      | 3                     | 3        |
| `CALL save`                       | 1      | 4 + 1                 | 5        |
| `STORE [OUT], R1`                 | 1      | 5                     | 5        |
| `RET`                             | 1      | 3 + 1                 | 4        |
| `HLT`                             | 1      | 2                     | 2        |
| **Total**                         | **21** |                       | **73**   |

CPI = 73 ÷ 21 ≈ 3.48. The run also makes 2 data writes (CALL, STORE) and 1 data read (RET), and 4 branches are taken and 1 is not (only JZ, JNZ, JC and JNC count as branches).

As a hypothetical, a hardware VCPU-8 that matched this timing model at a 1 MHz clock would take 73 µs. That number is arithmetic, not a measurement. How long the emulator takes on your laptop is a separate, host-time question, and the benchmark suite answers it ([benchmarks.md](benchmarks.md)) by running warm-up iterations and reporting the median of several samples, because host time varies from run to run.

## 12. How this maps to physical hardware

Everything in this guide has a direct hardware counterpart, which is what Project 2 builds in SystemVerilog:

| Concept in this guide                   | VCPU-8 element                                | Hardware                                              |
| --------------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Flip-flops with enables (sections 2, 4) | R0–R7, PC, SP, SD, FLAGS, IR                  | sequential logic: registers clocked on an edge        |
| Combinational logic (sections 2, 3)     | ALU, flag logic, instruction decoder, next-PC | combinational logic between the registers             |
| Decoders and muxes (sections 4, 5)      | register file ports, address mux, result mux  | combinational logic                                   |
| Memory array (section 5)                | 256 × 8 memory                                | a memory array (registers, or on-chip RAM on an FPGA) |
| Opcode table (sections 6, 7)            | `@vcpu/shared` opcode table                   | decoder logic, or a lookup table ROM                  |
| Fetch-decode-execute (section 8)        | `step()`                                      | a control state machine over one or more clock cycles |

The design principles in [architecture.md](architecture.md#design-principles) exist to make this mapping exact: arithmetic is defined bit by bit rather than by JavaScript numbers, reset is fully defined, faults are precise and the address space never wraps. A SystemVerilog CPU can therefore be checked against the emulator byte for byte, using test fixtures exported from it.

[hardware-porting.md](hardware-porting.md) describes that mapping in detail: which state becomes registers, which logic is combinational, how memory is modelled, and how the exported fixtures drive RTL verification.

From there the path continues outside this project: simulate the RTL, synthesize it onto an **FPGA** (a chip of reconfigurable logic and memory blocks), and eventually lay it out as an **ASIC**, where it becomes real transistors again, which closes the loop back to section 1.

## Glossary

| Term                | Meaning                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| ALU                 | Arithmetic logic unit: the combinational block that computes results and flags                     |
| Assembler           | A program that translates assembly language into machine code                                      |
| ASIC                | Application-specific integrated circuit: a chip manufactured for one design                        |
| Clock               | A square-wave signal whose edges tell flip-flops when to capture new values                        |
| CMOS                | Complementary MOS: logic built from paired pMOS pull-up and nMOS pull-down networks                |
| Combinational logic | Logic whose outputs depend only on its current inputs                                              |
| CPI                 | Cycles per instruction                                                                             |
| Critical path       | The slowest path through combinational logic between two flip-flops; it limits the clock frequency |
| Decoder             | A circuit that turns an n-bit number into 2ⁿ one-hot select lines                                  |
| Disassembler        | A program that turns machine code back into assembly                                               |
| FPGA                | Field-programmable gate array: a chip whose logic can be reconfigured after manufacture            |
| Flip-flop           | A circuit that stores one bit, sampling its input on a clock edge                                  |
| Fault               | An error condition that stops the CPU, such as an invalid opcode or a stack overflow               |
| IPS                 | Instructions per second                                                                            |
| IR                  | Instruction register: holds the instruction being executed                                         |
| Machine code        | Instructions encoded as bytes that the CPU executes directly                                       |
| MOSFET              | Metal-oxide-semiconductor field-effect transistor: a voltage-controlled switch in digital logic    |
| Mux (multiplexer)   | A circuit that selects one of several inputs                                                       |
| Opcode              | The byte that identifies an instruction                                                            |
| PC                  | Program counter: the address of the next instruction                                               |
| Pipeline            | Overlapping the stages of several instructions so that more than one is in flight                  |
| Precise fault       | A fault that leaves all architectural state as it was before the faulting instruction              |
| Propagation delay   | The time a combinational circuit takes to settle after its inputs change                           |
| Register file       | A set of registers with shared read and write ports                                                |
| RTL                 | Register-transfer level: a hardware description in terms of registers and the logic between them   |
| SD                  | VCPU-8's stack depth counter                                                                       |
| SP                  | Stack pointer: the address the next push writes                                                    |
| Symbol table        | The assembler's map from label and constant names to values                                        |
| Two's complement    | The standard encoding of signed integers; in 8 bits, `0x80`–`0xFF` represent −128 to −1            |
| Von Neumann machine | A computer whose code and data share one memory                                                    |

## Further reading

These are standard references. The first two have free online material.

- Noam Nisan and Shimon Schocken, _The Elements of Computing Systems_ (MIT Press), and its free course at [nand2tetris.org](https://www.nand2tetris.org/). You build a computer from NAND gates up, in exactly the order of this guide.
- Ben Eater's 8-bit breadboard computer video series ([eater.net/8bit](https://eater.net/8bit)). A CPU close in spirit to VCPU-8, built from logic chips on breadboards.
- Charles Petzold, _Code: The Hidden Language of Computer Hardware and Software_ (Microsoft Press). A gentle, narrative introduction from switches to computers.
- Sarah L. Harris and David Money Harris, _Digital Design and Computer Architecture_ (Morgan Kaufmann). Transistors, logic, sequential design, SystemVerilog and processor design; the natural next step toward Project 2.
- David A. Patterson and John L. Hennessy, _Computer Organization and Design_ (Morgan Kaufmann). The standard text on instruction sets, datapaths, pipelining and performance, including the iron law.
- Neil H. E. Weste and David Money Harris, _CMOS VLSI Design: A Circuits and Systems Perspective_ (Pearson). For when you want to go below the gate level: transistor behaviour, layout and timing.
