// VCPU-8 iterative divider: unsigned 8-bit restoring division, one quotient bit per clock.
//
// The alternative to the ALU's combinational divider, chosen by DIV_ITER = 1 on vcpu8_core and
// vcpu8_top (research/cpu/experiments/div-impl/). docs/hardware/alu.md#iterative-divider explains
// the algorithm and the handshake.
//
// Handshake. start is sampled when the divider is idle (!busy); it latches b and performs the
// first iteration from a at that same edge. The other seven iterations follow, one per clock, with
// busy high. done pulses for one cycle, exactly 8 cycles after the cycle start was high, and q and
// rem are valid from then until the next start. start while busy is ignored. rst returns the
// divider to idle from any state.
//
// Each iteration shifts the next dividend bit (from the top of the shift register, which fills
// with quotient bits from the bottom) into the partial remainder and subtracts b if it fits:
//   t = {rem, q[7]};  if (t >= b) { rem = t - b; q = {q[6:0], 1} } else { rem = t; q = {q[6:0], 0} }
// rem < b holds after every step, so t fits 9 bits and t - b fits 8.
//
// b = 0 is never started: the control unit raises DIVIDE_BY_ZERO first. If it were, every step
// would subtract nothing and give q = 0xFF, rem = a; no X can arise.
module vcpu8_divider (
  input  logic       clk,
  input  logic       rst,
  input  logic       start,
  input  logic [7:0] a,      // dividend
  input  logic [7:0] b,      // divisor, non-zero
  output logic       busy,
  output logic       done,   // one-cycle pulse: q and rem are final
  output logic [7:0] q,      // quotient a / b
  output logic [7:0] rem     // remainder a % b; for the unit test, the core leaves it open
);
  logic [7:0] div_b;
  logic [2:0] step;           // iterations completed since start, while busy

  // One iteration on the current state, or, at start, on the fresh operands.
  logic       load;
  logic [7:0] in_rem, in_q, in_b;
  logic [8:0] trial;          // {rem, next dividend bit}
  logic [9:0] diff;           // trial - b, with a borrow bit
  logic [7:0] next_rem, next_q;

  assign load   = start && !busy;
  assign in_rem = load ? 8'h00 : rem;
  assign in_q   = load ? a     : q;
  assign in_b   = load ? b     : div_b;

  always_comb begin
    trial = {in_rem, in_q[7]};
    diff  = {1'b0, trial} - {2'b00, in_b};
    if (diff[9]) begin
      next_rem = trial[7:0];
      next_q   = {in_q[6:0], 1'b0};
    end else begin
      next_rem = diff[7:0];
      next_q   = {in_q[6:0], 1'b1};
    end
  end

  // Without a borrow, trial - b < b <= 0xFF, so diff[8] is always 0.
  logic unused_diff;
  assign unused_diff = &{1'b0, diff[8]};

  always_ff @(posedge clk) begin
    if (rst) begin
      busy  <= 1'b0;
      done  <= 1'b0;
      step  <= 3'd0;
      div_b <= 8'h00;
      q     <= 8'h00;
      rem   <= 8'h00;
    end else begin
      done <= 1'b0;
      if (load) begin
        busy  <= 1'b1;
        step  <= 3'd1;
        div_b <= b;
        q     <= next_q;
        rem   <= next_rem;
      end else if (busy) begin
        q    <= next_q;
        rem  <= next_rem;
        step <= step + 3'd1;
        if (step == 3'd7) begin
          busy <= 1'b0;
          done <= 1'b1;
        end
      end
    end
  end
endmodule
