// The result buffer of the INT8 matmul accelerator (revision matmul-os-r1): C, one INT32 per
// entry.
//
// docs/hardware/accelerators/memory.md documents the layout and the timing;
// docs/hardware/accelerators/architecture.md is the contract.
//
//   - Addresses are flat: C is row-major with a row stride of MAX_DIM, so C[i, j] is at
//     i * MAX_DIM + j.
//   - Write port (matmul_controller, during STORE): we, wr_addr, wdata write one element per clock.
//   - Read port (the host port): rd_data is registered, the element at the rd_addr of the previous
//     clock. A read and a write of the same address in one clock read the old element.
//
// One RAM inference pattern (one write, one registered read, no reset of the contents).
module output_buffer #(
  parameter int DEPTH = matmul_pkg::MAX_DIM * matmul_pkg::MAX_DIM,
  parameter int ACC_W = matmul_pkg::ACC_W
) (
  input  logic                     clk,
  input  logic                     we,
  input  logic [$clog2(DEPTH)-1:0] wr_addr,
  input  logic [ACC_W-1:0]         wdata,
  input  logic [$clog2(DEPTH)-1:0] rd_addr,
  output logic [ACC_W-1:0]         rd_data
);
  logic [ACC_W-1:0] mem [DEPTH];

  always_ff @(posedge clk) begin
    if (we) mem[wr_addr] <= wdata;
    rd_data <= mem[rd_addr];
  end
endmodule
