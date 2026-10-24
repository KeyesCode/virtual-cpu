// One multiply-accumulate cell of the output-stationary systolic array (revision matmul-os-r1).
//
// docs/hardware/accelerators/processing-element.md documents the ports, the timing and the
// overflow rule; docs/hardware/accelerators/architecture.md is the contract. Per clock:
//
//   - the operands and their valid bits are registered and forwarded, A to the right and B
//     downwards, every clock whether valid or not (one clock of latency, so the array skew is
//     exact). There is no stall input: the array is a no-stall architecture and the controller
//     gates the valid bits instead.
//   - the accumulator is zeroed by rst or clear (clear wins over a MAC in the same clock), else
//     takes acc + a_in * b_in when both a_valid_in and b_valid_in are high, else holds.
//
// The product is signed and exact (an INT8 × INT8 product always fits in 2 * DATA_W bits); the
// accumulator is ACC_W bits and wraps around in two's complement, like the reference's `| 0`.
// ACC_W must be at least 2 * DATA_W. rst clears the accumulator and both valid bits; the operand
// data registers are not reset, since nothing reads them while their valid bit is clear.
module processing_element #(
  parameter int DATA_W = matmul_pkg::DATA_W,
  parameter int ACC_W  = matmul_pkg::ACC_W
) (
  input  logic                     clk,
  input  logic                     rst,
  input  logic                     clear,
  input  logic signed [DATA_W-1:0] a_in,
  input  logic                     a_valid_in,
  input  logic signed [DATA_W-1:0] b_in,
  input  logic                     b_valid_in,
  output logic signed [DATA_W-1:0] a_out,
  output logic                     a_valid_out,
  output logic signed [DATA_W-1:0] b_out,
  output logic                     b_valid_out,
  output logic signed [ACC_W-1:0]  acc
);
  localparam int PROD_W = 2 * DATA_W;

  // Both operands are sign-extended to PROD_W before the multiply (a size cast of a signed value
  // keeps it signed), so the product is the exact signed one: −128 × −128 = +16384.
  logic signed [PROD_W-1:0] product;
  assign product = PROD_W'(a_in) * PROD_W'(b_in);

  // Operand forwarding: data every clock, valid bits cleared by rst.
  always_ff @(posedge clk) begin
    a_out <= a_in;
    b_out <= b_in;
    if (rst) begin
      a_valid_out <= 1'b0;
      b_valid_out <= 1'b0;
    end else begin
      a_valid_out <= a_valid_in;
      b_valid_out <= b_valid_in;
    end
  end

  // The accumulator: ACC_W-bit signed addition of the sign-extended product, wrapping on overflow.
  always_ff @(posedge clk) begin
    if (rst || clear) begin
      acc <= '0;
    end else if (a_valid_in && b_valid_in) begin
      acc <= acc + ACC_W'(product);
    end
  end
endmodule
