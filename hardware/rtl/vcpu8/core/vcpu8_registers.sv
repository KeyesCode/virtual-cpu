// VCPU-8 general register file: R0–R7, eight 8-bit registers built from flip-flops.
//
// Two combinational read ports serve the two register fields of an instruction, and one
// synchronous write port writes the destination, which is always register-byte field a. The
// 3-bit addresses cannot name a ninth register: the decoder rejects register encodings 8–15 as
// MALFORMED_OPERAND before they reach these ports.
//
// Read-during-write: a read of the register being written returns the old value until the clock
// edge, and the new value from then on. There is no bypass, which is what makes `ADD R0, R0` and
// `LOAD R1, [R1]` read their sources before the write-back.
//
// Reset is synchronous and active-high, and clears every register to RESET_REG. R0 is an
// ordinary register (there is no hard-wired zero).
module vcpu8_registers (
  input  logic        clk,
  input  logic        rst,
  input  logic [2:0]  ra_addr,
  input  logic [2:0]  rb_addr,
  output logic [7:0]  ra_data,
  output logic [7:0]  rb_data,
  input  logic        we,
  input  logic [2:0]  wa,
  input  logic [7:0]  wd,
  output logic [63:0] dbg_regs    // packed R7..R0; R0 is bits 7:0
);
  logic [7:0] r [0:7];

  // Read ports: two 8:1 multiplexers of the register outputs.
  assign ra_data = r[ra_addr];
  assign rb_data = r[rb_addr];

  // Write port: the 3-to-8 decode of wa, gated by we, enables one register's flip-flops.
  always_ff @(posedge clk) begin
    if (rst) begin
      for (int i = 0; i < 8; i++) r[i] <= vcpu8_isa_pkg::RESET_REG;
    end else if (we) begin
      r[wa] <= wd;
    end
  end

  for (genvar i = 0; i < 8; i++) begin : g_dbg
    assign dbg_regs[8*i +: 8] = r[i];
  end
endmodule
