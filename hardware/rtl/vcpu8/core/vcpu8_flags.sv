// VCPU-8 FLAGS register: {Z, C, N, V} at the bit positions vcpu8_isa_pkg defines (Z = 3 … V = 0).
//
// Each instruction updates only the flags in its mask and keeps the rest:
// flags <= (flags & ~mask) | (new_flags & mask). A zero mask holds every flag, so the register
// needs no separate write enable. The 8-bit view reads {4'h0, Z, C, N, V}.
//
// Reset is synchronous and active-high, and clears FLAGS to RESET_FLAGS.
module vcpu8_flags (
  input  logic       clk,
  input  logic       rst,
  input  logic [3:0] mask,
  input  logic [3:0] new_flags,
  output logic [3:0] flags,
  output logic [7:0] flags_byte
);
  always_ff @(posedge clk) begin
    if (rst) flags <= vcpu8_isa_pkg::RESET_FLAGS;
    else     flags <= (flags & ~mask) | (new_flags & mask);
  end

  assign flags_byte = {
    4'h0,
    flags[vcpu8_isa_pkg::FLAG_Z],
    flags[vcpu8_isa_pkg::FLAG_C],
    flags[vcpu8_isa_pkg::FLAG_N],
    flags[vcpu8_isa_pkg::FLAG_V]
  };
endmodule
