// VCPU-8 memory: 256 × 8 single-port synchronous RAM holding code, data and the stack.
//
// - Registered read: rdata shows mem[addr] the cycle after addr is presented (1-cycle latency).
// - Read-first: when we is high, rdata gets the byte that was at addr before this write.
// - The address is 8 bits, so every address is valid and none can overflow.
// - No reset: like the emulator's reset, the core reset leaves memory contents alone.
//
// The array is named `mem` so testbenches can load and dump it hierarchically. Its contents are
// set only by writes, by a testbench, or by the optional INIT_FILE ($readmemh hex, one byte per
// line), which simulators and FPGA block-RAM inference both honour. This form infers a Yosys
// memory ($mem_v2) and iCE40 block RAM.
module vcpu8_memory #(
  parameter INIT_FILE = ""
) (
  input  logic       clk,
  input  logic [7:0] addr,
  input  logic       we,
  input  logic [7:0] wdata,
  output logic [7:0] rdata
);
  logic [7:0] mem [0:vcpu8_isa_pkg::MEMORY_SIZE-1];

  initial if (INIT_FILE != "") $readmemh(INIT_FILE, mem);

  always_ff @(posedge clk) begin
    if (we) mem[addr] <= wdata;
    rdata <= mem[addr];
  end
endmodule
