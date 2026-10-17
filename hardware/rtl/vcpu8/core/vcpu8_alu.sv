// VCPU-8 ALU: purely combinational, no state.
//
// Reproduces packages/cpu-core/src/alu.ts bit for bit, result and flags, for every operation; the
// equations are the table in docs/hardware-porting.md#alu-alu and docs/hardware/alu.md explains
// them. Z = (r == 0) and N = r[7] for every operation. C on SUB is the borrow (a < b unsigned), not
// an inverted carry. c_in is read only by INC and DEC, which pass C through. The FLAGS write mask
// (which flags an instruction may change) is applied outside the ALU.
//
// MUL and DIV are combinational in v1. DIV by zero is a fault the control unit raises before any
// write, so its result is never used; the ALU gives the defined, X-free value r = 0, C = V = 0.
//
// DIV_ITER = 1 removes the combinational divider: ALU_DIV then passes through div_q, the quotient
// vcpu8_core's iterative vcpu8_divider computed, with the same flags (Z and N from it, C = V = 0).
// The default, 0, is the v1 design and ignores div_q; research/cpu/experiments/div-impl/ compares
// the two.

module vcpu8_alu #(
  parameter int DIV_ITER = 0
) (
  input  logic [7:0]               a,
  input  logic [7:0]               b,
  input  vcpu8_types_pkg::alu_op_t op,
  input  logic                     c_in,
  input  logic [7:0]               div_q,  // DIV_ITER = 1 only
  output logic [7:0]               r,
  output logic                     z,
  output logic                     c,
  output logic                     n,
  output logic                     v
);
  logic [8:0]  sum;   // {carry, a + b}
  logic [8:0]  diff;  // {borrow, a - b}
  logic [15:0] prod;
  logic [7:0]  quot;

  assign sum  = {1'b0, a} + {1'b0, b};
  assign diff = {1'b0, a} - {1'b0, b};
  assign prod = {8'h00, a} * {8'h00, b};
  assign quot = (DIV_ITER != 0) ? div_q : (b == 8'h00) ? 8'h00 : a / b;

  always_comb begin
    r = 8'h00;
    c = 1'b0;
    v = 1'b0;
    case (op)
      vcpu8_types_pkg::ALU_ADD: begin
        r = sum[7:0];
        c = sum[8];
        v = (a[7] == b[7]) && (sum[7] != a[7]);
      end
      vcpu8_types_pkg::ALU_SUB: begin
        r = diff[7:0];
        c = diff[8];
        v = (a[7] != b[7]) && (diff[7] != a[7]);
      end
      vcpu8_types_pkg::ALU_MUL: begin
        r = prod[7:0];
        c = |prod[15:8];
        v = |prod[15:8];
      end
      vcpu8_types_pkg::ALU_DIV: r = quot;
      vcpu8_types_pkg::ALU_INC: begin
        r = a + 8'd1;
        c = c_in;
        v = (a == 8'h7F);
      end
      vcpu8_types_pkg::ALU_DEC: begin
        r = a - 8'd1;
        c = c_in;
        v = (a == 8'h80);
      end
      vcpu8_types_pkg::ALU_AND: r = a & b;
      vcpu8_types_pkg::ALU_OR:  r = a | b;
      vcpu8_types_pkg::ALU_XOR: r = a ^ b;
      vcpu8_types_pkg::ALU_NOT: r = ~a;
      vcpu8_types_pkg::ALU_SHL: begin
        r = {a[6:0], 1'b0};
        c = a[7];
      end
      vcpu8_types_pkg::ALU_SHR: begin
        r = {1'b0, a[7:1]};
        c = a[0];
      end
      default: ;  // unused alu_op_t codes: r = 0, C = V = 0
    endcase
  end

  assign z = (r == 8'h00);
  assign n = r[7];

endmodule
