// Formal properties of the combinational ALU (core/vcpu8_alu.sv), proven for every input.
//
// a, b, op and c_in are free inputs of this top module, so the solver ranges over all 2^21
// combinations, including the four unused alu_op_t codes. The ALU has no state, so a proof at
// depth 1 is complete. Each expected value is written from its arithmetic definition (9-bit
// unsigned and 10-bit signed sums), not copied from the RTL's equations.
//
// docs/hardware/formal-verification.md lists the properties; alu_prove.sby runs them.
module vcpu8_alu_props (
  input logic [7:0] a,
  input logic [7:0] b,
  input logic [3:0] op,
  input logic       c_in
);
  logic [7:0] r;
  logic       z, c, n, v;

  // The default ALU (DIV_ITER = 0), with its combinational divider; it ignores div_q.
  vcpu8_alu u_alu (
    .a     (a),
    .b     (b),
    .op    (vcpu8_types_pkg::alu_op_t'(op)),
    .c_in  (c_in),
    .div_q (8'h00),
    .r     (r),
    .z     (z),
    .c     (c),
    .n     (n),
    .v     (v)
  );

  // The definitions: unsigned 9-bit results, and signed results wide enough never to wrap.
  logic [8:0]        u_sum, u_diff;
  logic signed [9:0] s_sum, s_diff, s_inc, s_dec;
  logic [15:0]       u_prod;
  assign u_sum  = {1'b0, a} + {1'b0, b};
  assign u_diff = {1'b0, a} - {1'b0, b};
  assign s_sum  = 10'(signed'(a)) + 10'(signed'(b));
  assign s_diff = 10'(signed'(a)) - 10'(signed'(b));
  assign s_inc  = 10'(signed'(a)) + 10'sd1;
  assign s_dec  = 10'(signed'(a)) - 10'sd1;
  assign u_prod = 16'(a) * 16'(b);

  // A signed result outside -128..127 is a two's-complement overflow.
  function automatic logic ovf(input logic signed [9:0] s);
    ovf = (s > 10'sd127) || (s < -10'sd128);
  endfunction

  logic is_logic;
  assign is_logic = op == vcpu8_types_pkg::ALU_AND || op == vcpu8_types_pkg::ALU_OR
                 || op == vcpu8_types_pkg::ALU_XOR || op == vcpu8_types_pkg::ALU_NOT;

  always @(*) begin
    // alu_zn: Z and N follow the result, for every operation.
    alu_z: assert (z == (r == 8'h00));
    alu_n: assert (n == r[7]);

    // alu_add: {C, R} is the 9-bit sum; V is signed overflow.
    if (op == vcpu8_types_pkg::ALU_ADD) begin
      alu_add_r: assert ({c, r} == u_sum);
      alu_add_v: assert (v == ovf(s_sum));
    end

    // alu_sub: {C, R} is the 9-bit difference, so C is the borrow a < b; V is signed overflow.
    if (op == vcpu8_types_pkg::ALU_SUB) begin
      alu_sub_r: assert ({c, r} == u_diff);
      alu_sub_c: assert (c == (a < b));
      alu_sub_v: assert (v == ovf(s_diff));
    end

    // alu_incdec: INC and DEC wrap, preserve C, and set V on signed overflow.
    if (op == vcpu8_types_pkg::ALU_INC) begin
      alu_inc_r: assert (r == 8'(a + 8'd1));
      alu_inc_c: assert (c == c_in);
      alu_inc_v: assert (v == ovf(s_inc));
    end
    if (op == vcpu8_types_pkg::ALU_DEC) begin
      alu_dec_r: assert (r == 8'(a - 8'd1));
      alu_dec_c: assert (c == c_in);
      alu_dec_v: assert (v == ovf(s_dec));
    end

    // alu_logic: AND, OR, XOR and NOT compute their bitwise result and clear C and V.
    if (is_logic) begin
      alu_logic_cv: assert (!c && !v);
    end
    if (op == vcpu8_types_pkg::ALU_AND) alu_and_r: assert (r == (a & b));
    if (op == vcpu8_types_pkg::ALU_OR)  alu_or_r:  assert (r == (a | b));
    if (op == vcpu8_types_pkg::ALU_XOR) alu_xor_r: assert (r == (a ^ b));
    if (op == vcpu8_types_pkg::ALU_NOT) alu_not_r: assert (r == ~a);

    // alu_shift: SHL and SHR shift in a 0, put the bit shifted out in C, and clear V.
    if (op == vcpu8_types_pkg::ALU_SHL) begin
      alu_shl: assert ({c, r} == {a, 1'b0} && !v);
    end
    if (op == vcpu8_types_pkg::ALU_SHR) begin
      alu_shr: assert ({r, c} == {1'b0, a} && !v);
    end

    // alu_mul: R is the low byte of the product; C = V = "the high byte is not zero".
    if (op == vcpu8_types_pkg::ALU_MUL) begin
      alu_mul: assert (r == u_prod[7:0] && c == (u_prod[15:8] != 8'h00) && v == c);
    end

    // alu_div: R is the unsigned quotient, C = V = 0; a zero divisor gives the defined R = 0.
    if (op == vcpu8_types_pkg::ALU_DIV) begin
      alu_div_cv: assert (!c && !v);
      if (b != 8'h00) alu_div_q: assert (r == a / b);
      else            alu_div_0: assert (r == 8'h00);
    end

    // alu_unused: the codes alu_op_t does not name give R = 0 and C = V = 0.
    if (op > vcpu8_types_pkg::ALU_SHR) begin
      alu_unused: assert (r == 8'h00 && !c && !v);
    end
  end
endmodule
