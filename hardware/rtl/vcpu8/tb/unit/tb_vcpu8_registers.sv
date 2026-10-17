// Self-checking unit test for vcpu8_registers. Run by `make test-registers`.
//
// Inputs change on the falling edge and are checked half a cycle later, before the rising edge
// that writes, so "before the edge" and "after the edge" are separate, unambiguous checks.
// Any failure ends the run with $fatal(1, …), which makes the simulator exit non-zero.

module tb_vcpu8_registers;
  localparam int RANDOM_OPS = 10000;

  logic        clk;
  logic        rst;
  logic [2:0]  ra_addr, rb_addr, wa;
  logic [7:0]  ra_data, rb_data, wd;
  logic        we;
  logic [63:0] dbg_regs;

  logic [7:0]  model [0:7];
  int          errors = 0;
  int          checks = 0;
  logic [31:0] rng = 32'h5EED_0008;   // fixed seed: the random phase is the same on every run

  vcpu8_registers dut (.*);

  initial clk = 1'b0;
  always #5 clk = ~clk;

  // xorshift32, so the random sequence does not depend on the simulator's $urandom.
  function automatic logic [31:0] next_rand(input logic [31:0] s);
    logic [31:0] x;
    x = s;
    x = x ^ (x << 13);
    x = x ^ (x >> 17);
    x = x ^ (x << 5);
    next_rand = x;
  endfunction

  task automatic check8(input string what, input logic [7:0] got, input logic [7:0] want);
    checks++;
    if (got !== want) begin
      errors++;
      $display("FAIL %s: got %02h, want %02h (t=%0t)", what, got, want, $time);
    end
  endtask

  // Both read ports at the given addresses, and the debug tap, against the model.
  task automatic check_reads(input string what, input logic [2:0] a, input logic [2:0] b);
    ra_addr = a;
    rb_addr = b;
    #1;
    check8($sformatf("%s ra R%0d", what, a), ra_data, model[a]);
    check8($sformatf("%s rb R%0d", what, b), rb_data, model[b]);
    for (int i = 0; i < 8; i++) check8($sformatf("%s dbg R%0d", what, i), dbg_regs[8*i +: 8], model[i]);
  endtask

  task automatic check_all(input string what);
    for (int i = 0; i < 8; i++) check_reads(what, 3'(i), 3'(7 - i));
  endtask

  // One clock: drive on the falling edge, write on the rising edge, update the model.
  task automatic cycle(input logic w, input logic [2:0] addr, input logic [7:0] data);
    @(negedge clk);
    we = w;
    wa = addr;
    wd = data;
    @(posedge clk);
    if (w) model[addr] = data;
    @(negedge clk);
    we = 1'b0;
  endtask

  task automatic do_reset();
    @(negedge clk);
    rst = 1'b1;
    @(posedge clk);
    for (int i = 0; i < 8; i++) model[i] = vcpu8_isa_pkg::RESET_REG;
    @(negedge clk);
    rst = 1'b0;
  endtask

  initial begin
    rst = 1'b0;
    we = 1'b0;
    wa = 3'd0;
    wd = 8'h00;
    ra_addr = 3'd0;
    rb_addr = 3'd0;

    // Reset: every register reads 8'h00, including after registers were dirtied.
    do_reset();
    check_all("reset");
    for (int i = 0; i < 8; i++) cycle(1'b1, 3'(i), 8'hA0 + 8'(i));
    check_all("dirty");
    do_reset();
    check_all("reset again");

    // Write and read back each register alone: the 8 indices are distinct storage.
    for (int i = 0; i < 8; i++) begin
      cycle(1'b1, 3'(i), 8'h11 * 8'(i + 1));
      check_all($sformatf("write R%0d", i));
    end
    for (int i = 0; i < 8; i++) begin
      cycle(1'b1, 3'(i), ~(8'h11 * 8'(i + 1)));
      check_all($sformatf("rewrite R%0d", i));
    end

    // we = 0 holds every register, whatever wa and wd are.
    for (int i = 0; i < 8; i++) begin
      cycle(1'b0, 3'(i), 8'h5A);
      check_all($sformatf("we=0 wa=R%0d", i));
    end

    // Back-to-back writes, one per clock: the same register, then different registers.
    @(negedge clk);
    for (int v = 0; v < 4; v++) begin
      we = 1'b1;
      wa = 3'd3;
      wd = 8'h30 + 8'(v);
      @(posedge clk);
      model[3] = wd;
      @(negedge clk);
      check_reads($sformatf("b2b same %0d", v), 3'd3, 3'd3);
    end
    for (int i = 0; i < 8; i++) begin
      we = 1'b1;
      wa = 3'(i);
      wd = 8'hC0 + 8'(i);
      @(posedge clk);
      model[i] = wd;
      @(negedge clk);
      check_all($sformatf("b2b diff R%0d", i));
    end
    we = 1'b0;

    // Read during write: both ports read the register being written. Before the edge they see the
    // old value, after it the new one. There is no bypass.
    for (int i = 0; i < 8; i++) begin
      @(negedge clk);
      we = 1'b1;
      wa = 3'(i);
      wd = 8'hE0 ^ 8'(i * 7);
      ra_addr = 3'(i);
      rb_addr = 3'(i);
      #1;
      check8($sformatf("rdw before ra R%0d", i), ra_data, model[i]);
      check8($sformatf("rdw before rb R%0d", i), rb_data, model[i]);
      @(posedge clk);
      model[i] = wd;
      #1;
      check8($sformatf("rdw after ra R%0d", i), ra_data, model[i]);
      check8($sformatf("rdw after rb R%0d", i), rb_data, model[i]);
    end
    @(negedge clk);
    we = 1'b0;

    // Both ports on every pair of addresses, the same and different.
    for (int a = 0; a < 8; a++)
      for (int b = 0; b < 8; b++) check_reads($sformatf("pair %0d,%0d", a, b), 3'(a), 3'(b));

    // Random operations against the model: random read addresses, write enable, address and data.
    // Reads are checked before each edge, so a read of the register being written must still
    // return the old value.
    for (int n = 0; n < RANDOM_OPS; n++) begin
      @(negedge clk);
      rng = next_rand(rng);
      ra_addr = rng[2:0];
      rb_addr = rng[5:3];
      wa      = rng[8:6];
      wd      = rng[16:9];
      we      = rng[17];
      rst     = (rng[27:18] == 10'd0);   // an occasional reset among the random operations
      #1;
      check8("random ra", ra_data, model[ra_addr]);
      check8("random rb", rb_data, model[rb_addr]);
      for (int i = 0; i < 8; i++) check8("random dbg", dbg_regs[8*i +: 8], model[i]);
      @(posedge clk);
      if (rst) begin
        for (int i = 0; i < 8; i++) model[i] = vcpu8_isa_pkg::RESET_REG;
      end else if (we) begin
        model[wa] = wd;
      end
    end
    @(negedge clk);
    we = 1'b0;
    rst = 1'b0;
    check_all("after random");

    if (errors != 0) $fatal(1, "tb_vcpu8_registers: %0d of %0d checks failed", errors, checks);
    $display("tb_vcpu8_registers: PASS (%0d checks, %0d random operations)", checks, RANDOM_OPS);
    $finish;
  end
endmodule
