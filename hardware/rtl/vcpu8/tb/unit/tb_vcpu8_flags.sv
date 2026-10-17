// Self-checking unit test for vcpu8_flags. Run by `make test-flags`.
//
// Exhaustive over every (old flags, mask, new flags) triple: 16 × 16 × 16 = 4,096 updates, each
// checked against flags = (old & ~mask) | (new & mask) and the {4'h0, Z, C, N, V} byte view.
// Any failure ends the run with $fatal(1, …), which makes the simulator exit non-zero.

module tb_vcpu8_flags;
  logic       clk;
  logic       rst;
  logic [3:0] mask, new_flags, flags;
  logic [7:0] flags_byte;

  int errors = 0;
  int checks = 0;

  vcpu8_flags dut (.*);

  initial clk = 1'b0;
  always #5 clk = ~clk;

  task automatic check4(input string what, input logic [3:0] got, input logic [3:0] want);
    checks++;
    if (got !== want) begin
      errors++;
      $display("FAIL %s: got %h, want %h (t=%0t)", what, got, want, $time);
    end
  endtask

  // The byte view must be {4'h0, Z, C, N, V} for whatever FLAGS holds now.
  task automatic check_byte(input string what, input logic [3:0] want);
    checks++;
    if (flags_byte[7:4] !== 4'h0
        || flags_byte[3] !== want[vcpu8_isa_pkg::FLAG_Z]
        || flags_byte[2] !== want[vcpu8_isa_pkg::FLAG_C]
        || flags_byte[1] !== want[vcpu8_isa_pkg::FLAG_N]
        || flags_byte[0] !== want[vcpu8_isa_pkg::FLAG_V]) begin
      errors++;
      $display("FAIL %s: flags_byte %02h for flags %h (t=%0t)", what, flags_byte, want, $time);
    end
  endtask

  // Loads `value` with a full mask, so the next update starts from a known old value.
  task automatic load(input logic [3:0] value);
    @(negedge clk);
    mask = 4'hF;
    new_flags = value;
    @(posedge clk);
    #1;
    check4("load", flags, value);
  endtask

  initial begin
    logic [3:0] want;

    rst = 1'b0;
    mask = 4'h0;
    new_flags = 4'h0;

    // Reset clears FLAGS, even with an update presented on the same edge.
    @(negedge clk);
    rst = 1'b1;
    mask = 4'hF;
    new_flags = 4'hF;
    @(posedge clk);
    #1;
    check4("reset", flags, vcpu8_isa_pkg::RESET_FLAGS);
    check_byte("reset", vcpu8_isa_pkg::RESET_FLAGS);
    @(negedge clk);
    rst = 1'b0;

    for (int old = 0; old < 16; old++) begin
      for (int m = 0; m < 16; m++) begin
        for (int n = 0; n < 16; n++) begin
          load(4'(old));
          @(negedge clk);
          mask = 4'(m);
          new_flags = 4'(n);
          #1;
          check4($sformatf("hold before edge old=%0h mask=%0h new=%0h", old, m, n), flags, 4'(old));
          @(posedge clk);
          #1;
          want = (4'(old) & ~4'(m)) | (4'(n) & 4'(m));
          check4($sformatf("update old=%0h mask=%0h new=%0h", old, m, n), flags, want);
          check_byte($sformatf("byte old=%0h mask=%0h new=%0h", old, m, n), want);
        end
      end
    end

    // Reset after use returns to zero.
    @(negedge clk);
    rst = 1'b1;
    @(posedge clk);
    #1;
    check4("reset after use", flags, vcpu8_isa_pkg::RESET_FLAGS);
    check_byte("reset after use", vcpu8_isa_pkg::RESET_FLAGS);

    if (errors != 0) $fatal(1, "tb_vcpu8_flags: %0d of %0d checks failed", errors, checks);
    $display("tb_vcpu8_flags: PASS (%0d checks, 4096 masked updates)", checks);
    $finish;
  end
endmodule
