# Memory Interface

VCPU-8 has one 256-byte memory that holds code, data and the stack ([memory-model.md](../memory-model.md)). In the RTL it is `vcpu8_memory` in `hardware/rtl/vcpu8/core/vcpu8_memory.sv`: a 256 × 8 single-port synchronous RAM. This page defines its timing and explains how it is built, initialised, inspected and, later, mapped onto an FPGA.

## Ports

```systemverilog
module vcpu8_memory #(parameter INIT_FILE = "") (
  input  logic       clk,
  input  logic [7:0] addr,
  input  logic       we,
  input  logic [7:0] wdata,
  output logic [7:0] rdata     // registered: mem[addr] from the previous clock edge
);
```

There is one port. Every clock cycle it does one access at `addr`: a read when `we` is 0, and a write plus a read of the old byte when `we` is 1. The memory has **no reset input**.

## Timing

Both reads and writes take effect on the rising edge of `clk`.

- **Write.** If `we` is 1 at a rising edge, `mem[addr]` takes `wdata` at that edge.
- **Read, with a one-cycle latency.** At every rising edge, `rdata` loads `mem[addr]`. Data for an address presented during cycle _n_ is on `rdata` during cycle _n_ + 1, and `rdata` holds it until the next edge. This is a _registered_ (synchronous) read, which is how FPGA block RAM behaves. It differs from the register file's combinational reads.

A timing diagram of four cycles. Each row is one rising edge, with the inputs as they are just before it:

| Edge | `addr` | `we` | `wdata` | At the edge          | `rdata` after the edge |
| ---- | ------ | ---- | ------- | -------------------- | ---------------------- |
| e1   | `0x10` | 0    | –       | read                 | `mem[0x10]`            |
| e2   | `0x20` | 0    | –       | read                 | `mem[0x20]`            |
| e3   | `0x20` | 1    | `0x99`  | `mem[0x20]` ← `0x99` | old `mem[0x20]`        |
| e4   | `0x20` | 0    | –       | read                 | `0x99`                 |

- Between e1 and e2, `addr` is already `0x20` but `rdata` still shows `mem[0x10]`. Changing `addr` does nothing until the edge.
- At e3 the write and the read happen together, and the read gets the byte from before the write.
- The next read of `0x20`, at e4, returns the new byte.

The control FSM therefore presents an address one state before the state that uses the byte. [Sharing the port](#sharing-the-port) shows how fetches and data accesses take turns on it.

## Sharing the port

The CPU has one memory port for everything: opcode fetches, operand-byte fetches, data reads (LOAD, POP, RET) and data writes (STORE, PUSH, CALL). The control FSM ([control-unit.md](control-unit.md#control-fsm)) gives each access its own state, so there is exactly one access per cycle and they never compete. `vcpu8_core` drives `mem_addr` from the address mux and `mem_we` from the FSM:

| FSM state       | `mem_addr`                                      | `mem_we`                | `mem_rdata` during this state holds                    |
| --------------- | ----------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| FETCH           | PC                                              | 0                       | (the previous instruction's last access; unused)       |
| DECODE          | PC + 1 if the instruction has a byte 1, else PC | 0                       | the opcode, `mem[PC]`                                  |
| OPERAND1        | PC + 2 if it has a byte 2, else PC              | 0                       | byte 1, `mem[PC + 1]`                                  |
| OPERAND2        | PC                                              | 0                       | byte 2, `mem[PC + 2]`                                  |
| EXECUTE         | the data address, or PC if there is none        | 0                       | (unused)                                               |
| WRITEBACK       | the data address, or PC if there is none        | 1 for STORE, PUSH, CALL | the data byte for LOAD, POP, RET (`mem[data address]`) |
| HALTED, FAULTED | PC                                              | 0                       | (unused)                                               |

The data address is IR.tb for the absolute forms, a register for the `[Rp]` forms, SP for a push and SP + 1 for a pop ([datapath.md](datapath.md#multiplexers-and-their-selects)). It is presented in EXECUTE and held through WRITEBACK, which serves both directions:

- **A read** issued in EXECUTE has its byte on `mem_rdata` in WRITEBACK, where the register write (LOAD, POP) or the next PC (RET) takes it. The one-cycle latency costs no extra state.
- **A write** happens at the edge that ends WRITEBACK, the CPU's single commit point, together with the register, FLAGS, SP, SD and PC updates.

Here is a 2-byte `PUSH R1` at address `0x03` with SP = `0xFF` (from the fixture `op-push-full-stack`), one row per cycle:

| Cycle | State     | `mem_addr` | `mem_we` | `mem_wdata` | `mem_rdata` | At the rising edge that ends the cycle                                      |
| ----- | --------- | ---------- | -------- | ----------- | ----------- | --------------------------------------------------------------------------- |
| 1     | FETCH     | `0x03`     | 0        | –           | –           | RAM reads `mem[0x03]`                                                       |
| 2     | DECODE    | `0x04`     | 0        | –           | `0x50`      | IR.op ← `0x50` (PUSH); RAM reads `mem[0x04]`                                |
| 3     | OPERAND1  | `0x03`     | 0        | –           | `0x10`      | IR.rb, IR.tb ← `0x10` (R1)                                                  |
| 4     | EXECUTE   | `0xFF`     | 0        | –           | –           | stack check: SD < 64, no fault                                              |
| 5     | WRITEBACK | `0xFF`     | 1        | `0x40` (R1) | –           | `mem[0xFF]` ← `0x40`; SP ← `0xFE`, SD ← 1, PC ← `0x05`; `retire` next cycle |

**A write never coincides with a fetch.** Writes happen only in WRITEBACK, and fetches (of the opcode or an operand byte) only in FETCH, DECODE and OPERAND1. These are different states of one FSM, so they are always different cycles. The next instruction's FETCH starts in the cycle after the write and reads the memory as the write left it: a program that stores into its own next instruction executes the new byte. Within one instruction, a read and a write never share a cycle either: no instruction both reads and writes data memory.

Because one access is all a cycle can do, the clocks an instruction takes are set by its memory accesses: one per instruction byte, plus EXECUTE and WRITEBACK, whose data access overlaps the work done there. Overlapping one instruction's WRITEBACK with the next one's FETCH, or prefetching, would need the two accesses to be ordered or the port duplicated. That is future work.

## Read-during-write: read-first

When `we` is 1, the read half of the access returns the byte that was at `addr` **before** the write (read-first, also called "old data"). The write is still done at the same edge, so the next read of that address returns the new byte. The RTL gets this from the two nonblocking assignments in one `always_ff`: `rdata <= mem[addr]` samples the array before `mem[addr] <= wdata` updates it.

The CPU never needs the byte it is writing, so any defined behaviour would do. Read-first is chosen because it is the plain inference template, it is deterministic in simulation, and the unit test pins it down.

## Address overflow

The address is 8 bits wide and the memory has exactly 256 entries, so **every address is valid and an address overflow cannot happen** at the memory. There is no out-of-range case to detect, and no address check exists in the RTL.

The ISA makes sure nothing wraps around to reach `0x00` from `0xFF` either. An instruction that would run past `0xFF` faults with `INSTRUCTION_OVERRUN` before its operand bytes are read, a sequential PC of `0x100` faults with `PC_OVERFLOW`, a CALL whose return address would be `0x100` faults, and the stack is bounded by its depth counter SD, never by SP wrapping. These checks live in the control unit. The memory only ever sees an 8-bit address.

## No reset

The memory has no `rst` input, and the core reset does not clear it. This matches the emulator, whose `reset()` leaves memory alone and reloads the program image itself, and it matches the hardware: FPGA block RAM has no reset of its contents. A testbench loads the program before it releases reset ([hardware-porting.md](../hardware-porting.md#reset)).

`rdata` is not reset either. It is defined by the memory's contents: after the first clock edge it holds `mem[addr]`.

## Four different things

The memory system involves four separate things, which are easy to confuse.

### 1. Synthesizable memory hardware

This is `vcpu8_memory`'s `always_ff` block, an array of 256 bytes with one synchronous write and one registered read. It is the only part of the module that becomes hardware. It is written in the standard inference template, so synthesis tools recognise it as a RAM and not as a pile of logic. With the pinned Yosys:

| Command (from `hardware/rtl/vcpu8/`)                                                                               | Result                                                          |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `yosys -p 'read_verilog -sv core/vcpu8_isa_pkg.sv core/vcpu8_memory.sv; synth -top vcpu8_memory -run :fine; stat'` | 4 cells: 1 `$mem_v2` (the inferred 256 × 8 memory) and 3 `$mux` |
| `yosys -p 'read_verilog -sv core/vcpu8_isa_pkg.sv core/vcpu8_memory.sv; synth_ice40 -top vcpu8_memory; stat'`      | 1 `SB_RAM40_4K` block RAM, 26 `SB_DFF` and 17 `SB_LUT4`         |
| the same with `synth_ice40 -no-rw-check`                                                                           | 1 `SB_RAM40_4K` and nothing else                                |

A plain `synth -top vcpu8_memory` with no target ends with `memory_map`, which turns every memory into flip-flops because a generic netlist has no RAM cell. That run reports 2,048 `$_DFFE_PP_`. The stage before `memory_map` (`-run :fine` above) shows that the RAM was inferred as one memory.

On iCE40 the extra 26 flip-flops and 17 LUTs are not storage. The iCE40 block RAM does not define what a read returns when it hits the address being written in the same cycle, so Yosys adds logic around it to produce the read-first behaviour this module promises. With `-no-rw-check`, which declares that behaviour don't-care, the RAM is used alone. The CPU never uses `rdata` in a write cycle, so a later synthesis ticket can mark the memory `no_rw_check` to save that logic. It must then also relax the read-during-write unit test.

### 2. Simulation initialisation

This is how a program gets into the memory before a simulation starts. It is not hardware, and there are two ways:

- **From a testbench**, by hierarchical access to the array, which is why the array is named `mem`: `$readmemh("prog.mem.hex", dut.u_mem.mem);`, or `dut.u_mem.mem[i] = byte;` in a loop. The fixtures' `*.mem.hex` files hold one two-digit hex byte per line, 256 lines, which is exactly `$readmemh` format.
- **With the `INIT_FILE` parameter**. If it is not empty, `initial $readmemh(INIT_FILE, mem);` loads the file at time zero. This is the only `initial` block in `core/`, and it is there because it doubles as FPGA initialisation (below).

The unit test loads `fixtures/v1/example-01-addition.mem.hex` through `INIT_FILE`, reads the file again on its own, and checks the memory against it byte for byte. It also fails unless the file has exactly 256 lines that each parse as one byte. A short or malformed image fails the test instead of leaving part of memory unset.

### 3. Debug interface

This is how a testbench or tool reads and changes memory outside the CPU's own accesses. **Today it is hierarchical access to `mem`**: a testbench dumps the final memory with `dut.u_mem.mem[i]` and compares it with the fixture's `*.expected.hex`. Hierarchical references work only in simulation.

**Later**, a real debug or loader port could load programs and dump memory in hardware: a second port on the RAM, or a mux in front of the single port that the loader owns while the CPU is held in reset. It is future work and not part of ISA 1.0.0's hardware.

### 4. Future FPGA memory

On an FPGA the array becomes a block RAM, as the `synth_ice40` run above shows. Two things carry over unchanged:

- the read latency, because block RAM has a registered read, which is why the RTL uses one from the start;
- `INIT_FILE`, because FPGA tools turn `$readmemh` in an `initial` block into the RAM's power-on contents, so a program can be built into the bitstream.

What changes on an FPGA is how a new program gets in without rebuilding the bitstream, which needs the loader from the previous section. The FPGA readiness ticket covers this.

## Tests

`tb/unit/tb_vcpu8_memory.sv`, run by `make -C hardware/rtl/vcpu8 test-memory`, checks:

- the `INIT_FILE` load against the fixture, byte for byte, and its line count, then a registered read of every loaded address through the port;
- writing and reading back all 256 addresses with two different patterns, including `0x00` and `0xFF`;
- the one-cycle read latency: `rdata` keeps the previous byte until the edge after a new address;
- read-during-write returning the old byte, with the new byte stored and read back on the next access;
- `we = 0` leaving every byte unchanged, whatever `addr` and `wdata` are;
- a core-level reset toggled around the memory: a register file on the same `rst` clears, while all 256 bytes stay unchanged and reads keep working.

The testbench counts errors and ends with `$fatal(1, …)` if any check failed, so `make test` exits non-zero.
