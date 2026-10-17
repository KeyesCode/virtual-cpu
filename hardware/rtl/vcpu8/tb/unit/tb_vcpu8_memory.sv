// Self-checking unit test for vcpu8_memory. Run by `make test-memory`, which passes the fixture
// path as FIXTURE_HEX.
//
// Inputs change on the falling edge. rdata is registered, so a read presented before a rising
// edge is checked just after it. Contents are inspected and compared through the `mem` array
// hierarchically, the way later testbenches load and dump programs.
// Any failure ends the run with $fatal(1, …), which makes the simulator exit non-zero.

module tb_vcpu8_memory #(
  parameter FIXTURE_HEX = ""
);
  localparam int SIZE = vcpu8_isa_pkg::MEMORY_SIZE;

  logic       clk;
  logic       rst = 1'b0;
  logic [7:0] addr, wdata, rdata, init_rdata;
  logic       we;

  // Core-level state on the same reset, to show that reset reaches registers but not memory.
  logic [7:0]  ra_data, rb_data;
  logic [63:0] dbg_regs;

  logic [7:0] model    [0:SIZE-1];
  logic [7:0] snapshot [0:SIZE-1];
  int         errors = 0;
  int         checks = 0;

  vcpu8_memory dut (.clk, .addr, .we, .wdata, .rdata);

  // A second instance loaded from INIT_FILE; it is only ever read.
  vcpu8_memory #(.INIT_FILE(FIXTURE_HEX)) u_init (
    .clk, .addr, .we(1'b0), .wdata(8'h00), .rdata(init_rdata)
  );

  vcpu8_registers u_regs (
    .clk, .rst, .ra_addr(3'd0), .rb_addr(3'd7), .ra_data, .rb_data,
    .we(1'b1), .wa(3'd0), .wd(8'hA5), .dbg_regs
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  task automatic check8(input string what, input logic [7:0] got, input logic [7:0] want);
    checks++;
    if (got !== want) begin
      errors++;
      $display("FAIL %s: got %02h, want %02h (t=%0t)", what, got, want, $time);
    end
  endtask

  // One clock with the port driven as given; rdata is checked against `want` after the edge.
  task automatic access(input logic w, input logic [7:0] a, input logic [7:0] d,
                        input string what, input logic [7:0] want);
    @(negedge clk);
    we = w;
    addr = a;
    wdata = d;
    @(posedge clk);
    #1;
    check8(what, rdata, want);
    if (w) model[a] = d;
  endtask

  task automatic write_byte(input logic [7:0] a, input logic [7:0] d);
    access(1'b1, a, d, $sformatf("write %02h old byte", a), model[a]);
  endtask

  task automatic read_byte(input logic [7:0] a);
    access(1'b0, a, 8'h00, $sformatf("read %02h", a), model[a]);
  endtask

  task automatic take_snapshot();
    for (int i = 0; i < SIZE; i++) snapshot[i] = dut.mem[i];
  endtask

  task automatic check_snapshot(input string what);
    for (int i = 0; i < SIZE; i++) check8($sformatf("%s mem[%02h]", what, i), dut.mem[i], snapshot[i]);
  endtask

  // The INIT_FILE instance must hold the fixture byte for byte. The file is read independently
  // here, and it must have exactly one parseable byte per line for all 256 addresses.
  task automatic check_init_file();
    int    fd;
    int    lines;
    int    value;
    string line;

    fd = $fopen(FIXTURE_HEX, "r");
    checks++;
    if (fd == 0) begin
      errors++;
      $display("FAIL INIT_FILE: cannot open '%s'", FIXTURE_HEX);
      return;
    end
    lines = 0;
    while ($fgets(line, fd) != 0) begin
      checks++;
      if ($sscanf(line, "%h", value) != 1 || value < 0 || value > 255) begin
        errors++;
        $display("FAIL INIT_FILE: line %0d is not a hex byte: %s", lines + 1, line);
      end else if (lines < SIZE) begin
        check8($sformatf("INIT_FILE mem[%02h]", lines), u_init.mem[lines], 8'(value));
      end
      lines++;
    end
    $fclose(fd);
    checks++;
    if (lines != SIZE) begin
      errors++;
      $display("FAIL INIT_FILE: %0d lines, want %0d", lines, SIZE);
    end
  endtask

  initial begin
    we = 1'b0;
    addr = 8'h00;
    wdata = 8'h00;

    // INIT_FILE load, and a registered read through the port of the loaded instance.
    check_init_file();
    for (int i = 0; i < SIZE; i++) begin
      @(negedge clk);
      addr = 8'(i);
      @(posedge clk);
      #1;
      check8($sformatf("INIT_FILE read %02h", i), init_rdata, u_init.mem[i]);
    end

    // Write and read back all 256 addresses, 0x00 and 0xFF included, with two patterns so
    // that each address is shown to be its own storage.
    for (int i = 0; i < SIZE; i++) model[i] = dut.mem[i];
    for (int i = 0; i < SIZE; i++) write_byte(8'(i), 8'(i) ^ 8'h5A);
    for (int i = 0; i < SIZE; i++) read_byte(8'(i));
    for (int i = SIZE - 1; i >= 0; i--) write_byte(8'(i), ~8'(i));
    for (int i = 0; i < SIZE; i++) read_byte(8'(i));
    write_byte(8'h00, 8'hC3);
    write_byte(8'hFF, 8'h3C);
    read_byte(8'h00);
    read_byte(8'hFF);

    // One-cycle read latency: rdata keeps the previous read until the edge after a new address.
    write_byte(8'h10, 8'h11);
    write_byte(8'h20, 8'h22);
    read_byte(8'h10);
    @(negedge clk);
    addr = 8'h20;
    #1;
    check8("latency: before edge", rdata, 8'h11);
    @(posedge clk);
    #1;
    check8("latency: after edge", rdata, 8'h22);

    // Read during write (read-first): the write cycle returns the old byte, the next read the new.
    for (int i = 0; i < SIZE; i += 17) begin
      access(1'b1, 8'(i), 8'(i) ^ 8'hF0, $sformatf("rdw %02h returns old byte", i), model[i]);
      check8($sformatf("rdw %02h stored", i), dut.mem[i], model[i]);
      read_byte(8'(i));
    end

    // we = 0 changes nothing, whatever addr and wdata are.
    take_snapshot();
    for (int i = 0; i < SIZE; i++) access(1'b0, 8'(i), 8'hEE, $sformatf("we=0 %02h", i), snapshot[i]);
    check_snapshot("we=0");

    // Core-level reset: registers clear, memory keeps its contents, and reads still work.
    take_snapshot();
    @(negedge clk);
    rst = 1'b1;
    for (int n = 0; n < 8; n++) begin
      access(1'b0, 8'(n * 31), 8'h00, $sformatf("read in reset %0d", n), snapshot[n * 31]);
    end
    checks++;
    if (dbg_regs !== {8{vcpu8_isa_pkg::RESET_REG}}) begin
      errors++;
      $display("FAIL reset clears registers: dbg_regs %016h", dbg_regs);
    end
    @(negedge clk);
    rst = 1'b0;
    @(negedge clk);
    rst = 1'b1;
    @(negedge clk);
    rst = 1'b0;
    @(posedge clk);
    #1;
    check8("R0 written after reset", ra_data, 8'hA5);
    check8("R7 still reset", rb_data, vcpu8_isa_pkg::RESET_REG);
    check_snapshot("reset toggled");

    if (errors != 0) $fatal(1, "tb_vcpu8_memory: %0d of %0d checks failed", errors, checks);
    $display("tb_vcpu8_memory: PASS (%0d checks, INIT_FILE %s)", checks, FIXTURE_HEX);
    $finish;
  end
endmodule
