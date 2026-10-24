// A banked operand buffer of the INT8 matmul accelerator (revision matmul-os-r1): matmul_top has
// one for A (ROWS banks, by row) and one for B (COLS banks, by column).
//
// docs/hardware/accelerators/memory.md documents the layout, the banking and the timing;
// docs/hardware/accelerators/architecture.md is the contract.
//
//   - Addresses are flat: a matrix is row-major with a row stride of MAX_DIM, so element (r, c)
//     is at r * MAX_DIM + c. The bank of an address is its BANK_BITS = log2(BANKS) bits from bit
//     BANK_LSB up: BANK_LSB = log2(MAX_DIM) banks A by row (bank = r mod ROWS) and BANK_LSB = 0
//     banks B by column (bank = c mod COLS). The address within the bank is the flat address with
//     those bits removed, so no address needs a division.
//   - Write port (the host port): we, wr_addr, wdata write one element per clock into its bank.
//   - Read port: one shared rd_addr, whose bank bits must be zero. Bank b reads the element
//     b * 2^BANK_LSB after it (for A, the same column b rows down; for B, b columns along), so
//     one clock reads a whole tile edge: A[r0 + b, k] or B[k, c0 + b] for every b. rd_data is
//     registered: it shows the elements addressed in the previous clock.
//
// Each bank is a separate RAM inference pattern (one write, one registered read, no reset of the
// contents). A read and a write of the same bank in one clock read the old element.
module input_buffer #(
  parameter int BANKS    = 4,
  parameter int BANK_LSB = 0,
  parameter int DEPTH    = matmul_pkg::MAX_DIM * matmul_pkg::MAX_DIM,
  parameter int DATA_W   = matmul_pkg::DATA_W
) (
  input  logic                           clk,
  input  logic                           we,
  input  logic [$clog2(DEPTH)-1:0]       wr_addr,
  input  logic [DATA_W-1:0]              wdata,
  input  logic [$clog2(DEPTH)-1:0]       rd_addr,
  output logic [BANKS-1:0][DATA_W-1:0]   rd_data
);
  localparam int ADDR_W     = $clog2(DEPTH);
  localparam int BANK_BITS  = $clog2(BANKS);
  localparam int BANK_DEPTH = DEPTH / BANKS;
  localparam int LOCAL_W    = ADDR_W - BANK_BITS;

  // The bank of a flat address is its BANK_BITS bits from BANK_LSB up; the address within the
  // bank is the bits above them moved down onto the BANK_LSB bits below them.
  localparam logic [ADDR_W-1:0] LOW_MASK = ADDR_W'((1 << BANK_LSB) - 1);

  logic [BANK_BITS-1:0] wr_bank;
  logic [LOCAL_W-1:0]   wr_local;
  logic [LOCAL_W-1:0]   rd_local;
  assign wr_bank  = BANK_BITS'(wr_addr >> BANK_LSB);
  assign wr_local = LOCAL_W'(((wr_addr >> (BANK_LSB + BANK_BITS)) << BANK_LSB) | (wr_addr & LOW_MASK));
  // rd_addr's bank bits are zero, so every bank reads the same address within itself.
  assign rd_local = LOCAL_W'(((rd_addr >> (BANK_LSB + BANK_BITS)) << BANK_LSB) | (rd_addr & LOW_MASK));

  for (genvar b = 0; b < BANKS; b++) begin : g_bank
    logic [DATA_W-1:0] mem [BANK_DEPTH];
    logic [DATA_W-1:0] q;

    always_ff @(posedge clk) begin
      if (we && wr_bank == BANK_BITS'(b)) mem[wr_local] <= wdata;
      q <= mem[rd_local];
    end

    assign rd_data[b] = q;
  end
endmodule
