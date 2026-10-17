// Exhaustive divider test: vcpu8_divider against vectors generated from the TypeScript ALU.
//
// `pnpm --filter @vcpu/rtl-tools gen:div-vectors` writes build/vectors/div.hex by calling div()
// in @vcpu/cpu-core for every (a, b != 0) pair, so every expected quotient here came from
// executing the reference. Each 24-bit record is {a, b, q}; div.meta beside the vectors holds the
// record count (65,280).
//
// For every record the test pulses start for one cycle, then drives different operands, so the
// divider must use the ones it latched at start. It requires:
//   - q equal to the vector's quotient, and q * b + rem == a with rem < b;
//   - busy high and done low for the LATENCY - 1 cycles after start, then done high (with busy
//     low) exactly LATENCY cycles after the start cycle, and done low again the cycle after.
// Directed checks: start while busy is ignored, rst while busy returns the divider to idle with no
// done, and b = 0 (which the CPU never starts, faulting first) gives X-free outputs.
//
// Plusargs: +vectors=<div.hex> (required); +meta=<file> (default: the vectors path with .meta).
// It prints the totals and the first MAX_REPORTED mismatches, and exits non-zero ($fatal) if
// anything failed.

module tb_vcpu8_divider;
  localparam int MAX_VECTORS  = 1 << 17;
  localparam int MAX_REPORTED = 20;
  localparam int LATENCY      = 8;   // cycles from the start cycle to the done cycle
  localparam int TIMEOUT      = 32;
  // Fills the array before $readmemh, so a short or long div.hex is caught: FF / FF is 1, not FF.
  localparam logic [23:0] NO_RECORD = '1;

  logic [23:0] vectors [MAX_VECTORS];

  logic       clk;
  logic       rst;
  logic       start;
  logic [7:0] a;
  logic [7:0] b;
  logic       busy;
  logic       done;
  logic [7:0] q;
  logic [7:0] rem;

  vcpu8_divider dut (
    .clk(clk), .rst(rst), .start(start), .a(a), .b(b),
    .busy(busy), .done(done), .q(q), .rem(rem)
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  // Inputs change and outputs are sampled at the falling edge, half a cycle from every update.

  // Starts a / b, then waits for done. Returns the cycles from the start cycle to the done cycle
  // (TIMEOUT if done never came) and whether busy and done followed the handshake on the way.
  task automatic divide(input logic [7:0] fa, input logic [7:0] fb, output int cycles,
                        output logic handshake_ok);
    @(negedge clk);
    a     = fa;
    b     = fb;
    start = 1'b1;
    cycles       = 0;
    handshake_ok = 1'b1;
    do begin
      @(negedge clk);
      start = 1'b0;
      a     = ~fa;  // the divider must work from what it latched at start
      b     = ~fb;
      cycles++;
      if (!done && !busy) handshake_ok = 1'b0;  // neither working nor finished
    end while (!done && cycles < TIMEOUT);
    if (busy) handshake_ok = 1'b0;               // done comes with busy low
  endtask

  initial begin
    string vectors_path;
    string meta_path;
    int    meta_fd;
    int    count;
    int    mismatches;
    int    directed_failures;
    int    cycles;
    logic  handshake_ok;
    logic  ok;
    logic [7:0]  va, vb, vq;
    logic [15:0] product;

    if (!$value$plusargs("vectors=%s", vectors_path)) begin
      $fatal(1, "tb_vcpu8_divider: pass +vectors=<path to div.hex>");
    end
    if (!$value$plusargs("meta=%s", meta_path)) begin
      meta_path = {vectors_path.substr(0, vectors_path.len() - 5), ".meta"};
    end
    meta_fd = $fopen(meta_path, "r");
    if (meta_fd == 0) $fatal(1, "tb_vcpu8_divider: cannot open %s", meta_path);
    if ($fscanf(meta_fd, "%d", count) != 1 || count <= 0 || count >= MAX_VECTORS) begin
      $fatal(1, "tb_vcpu8_divider: %s must hold a record count in 1..%0d", meta_path, MAX_VECTORS - 1);
    end
    $fclose(meta_fd);
    foreach (vectors[i]) vectors[i] = NO_RECORD;
    $readmemh(vectors_path, vectors);
    for (int i = 0; i < count; i++) begin
      if (vectors[i] == NO_RECORD) begin
        $fatal(1, "tb_vcpu8_divider: %s has only %0d of the %0d records %s promises", vectors_path,
               i, count, meta_path);
      end
    end
    if (vectors[count] != NO_RECORD) begin
      $fatal(1, "tb_vcpu8_divider: %s has more than the %0d records %s promises", vectors_path,
             count, meta_path);
    end

    rst   = 1'b1;
    start = 1'b0;
    a     = 8'h00;
    b     = 8'h01;
    repeat (2) @(negedge clk);
    rst = 1'b0;
    if (busy || done) $fatal(1, "tb_vcpu8_divider: busy or done after reset");

    // Exhaustive sweep.
    mismatches = 0;
    for (int i = 0; i < count; i++) begin
      {va, vb, vq} = vectors[i];
      divide(va, vb, cycles, handshake_ok);
      product = 16'(q) * 16'(vb) + 16'(rem);
      ok = q === vq && product == 16'(va) && rem < vb && cycles == LATENCY && handshake_ok;
      @(negedge clk);
      if (done) ok = 1'b0;  // done is a one-cycle pulse
      if (!ok) begin
        mismatches++;
        if (mismatches <= MAX_REPORTED) begin
          $display("MISMATCH vector %0d: a=%02h b=%02h: expected q=%02h in %0d cycles, got q=%02h rem=%02h in %0d cycles%s",
                   i, va, vb, vq, LATENCY, q, rem, cycles, handshake_ok ? "" : ", busy/done out of step");
        end
      end
    end
    if (mismatches > MAX_REPORTED) $display("... %0d more mismatches", mismatches - MAX_REPORTED);

    directed_failures = 0;

    // start while busy is ignored: 200 / 3 = 66 r 2 runs to the end undisturbed.
    @(negedge clk);
    a = 8'd200; b = 8'd3; start = 1'b1;
    @(negedge clk);
    start = 1'b0;
    repeat (2) @(negedge clk);
    a = 8'd7; b = 8'd2; start = 1'b1;
    @(negedge clk);
    start = 1'b0;
    cycles = 4;
    while (!done && cycles < TIMEOUT) begin
      @(negedge clk);
      cycles++;
    end
    ok = cycles == LATENCY && q == 8'd66 && rem == 8'd2;
    if (!ok) directed_failures++;
    $display("%s start while busy is ignored: 200 / 3 gave q=%0d rem=%0d in %0d cycles", ok ? "ok  " : "FAIL",
             q, rem, cycles);

    // rst while busy returns to idle at once, and no done follows.
    @(negedge clk);
    a = 8'd255; b = 8'd5; start = 1'b1;
    @(negedge clk);
    start = 1'b0;
    repeat (3) @(negedge clk);
    rst = 1'b1;
    @(negedge clk);
    rst = 1'b0;
    ok = !busy && !done;
    repeat (TIMEOUT) begin
      @(negedge clk);
      if (busy || done) ok = 1'b0;
    end
    divide(8'd255, 8'd5, cycles, handshake_ok);  // and it divides normally afterwards
    ok = ok && q == 8'd51 && rem == 8'd0 && cycles == LATENCY && handshake_ok;
    if (!ok) directed_failures++;
    $display("%s rst while busy returns to idle with no done; 255 / 5 afterwards gave q=%0d in %0d cycles",
             ok ? "ok  " : "FAIL", q, cycles);

    // b = 0: never started by the CPU, but the outputs must be defined.
    ok = 1'b1;
    for (int i = 0; i < 256; i++) begin
      divide(8'(i), 8'h00, cycles, handshake_ok);
      if ($isunknown({q, rem, busy, done}) || cycles != LATENCY) ok = 1'b0;
    end
    if (!ok) directed_failures++;
    $display("%s b = 0 sweep: 256 values, X-free outputs and done after %0d cycles", ok ? "ok  " : "FAIL",
             LATENCY);

    $display("divider: %0d vectors, %0d mismatches, done %0d cycles after start; 3 directed checks, %0d failed",
             count, mismatches, LATENCY, directed_failures);
    if (mismatches != 0 || directed_failures != 0) begin
      $fatal(1, "tb_vcpu8_divider: FAILED");
    end
    $display("tb_vcpu8_divider: PASSED");
    $finish;
  end

endmodule
