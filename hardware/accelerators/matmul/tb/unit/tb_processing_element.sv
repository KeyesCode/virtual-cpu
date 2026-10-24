// Self-checking unit test for processing_element, one clock per vector line. Run by
// `make test-pe`, which generates the vectors with
// `pnpm --filter @vcpu/accelerator-reference gen-pe-vectors`, so every expected value here came
// from the clock-level PE model (packages/accelerator-reference/src/model/pe.ts).
//
// The format is in packages/accelerator-reference/src/harness/pe-vectors.ts: a header line
// `pe-vectors 1 <clocks> <random clocks> <seed>`, `# <description>` lines that start a segment,
// and one line per clock, `rst clear a a_valid b b_valid acc a_out a_valid_out b_out b_valid_out`.
// Inputs change on the falling edge; the five outputs are compared bit for bit (=== so X/Z fail)
// just after the rising edge. One check is one clock, all five outputs.
//
// Plusargs: +vectors=<pe.vec> (required). It prints one summary line per segment, the first
// MAX_REPORTED mismatches as `MISMATCH line <n> …`, and exits non-zero ($fatal) on a mismatch,
// a malformed line, or a clock count that disagrees with the header.

module tb_processing_element;
  localparam int DATA_W       = matmul_pkg::DATA_W;
  localparam int ACC_W        = matmul_pkg::ACC_W;
  localparam int MAX_REPORTED = 20;

  logic                     clk;
  logic                     rst;
  logic                     clear;
  logic signed [DATA_W-1:0] a_in;
  logic                     a_valid_in;
  logic signed [DATA_W-1:0] b_in;
  logic                     b_valid_in;
  logic signed [DATA_W-1:0] a_out;
  logic                     a_valid_out;
  logic signed [DATA_W-1:0] b_out;
  logic                     b_valid_out;
  logic signed [ACC_W-1:0]  acc;

  processing_element #(.DATA_W(DATA_W), .ACC_W(ACC_W)) dut (
    .clk, .rst, .clear, .a_in, .a_valid_in, .b_in, .b_valid_in,
    .a_out, .a_valid_out, .b_out, .b_valid_out, .acc
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  // The text of a line without its trailing newline.
  function automatic string chomp(input string s);
    if (s.len() > 0 && s.getc(s.len() - 1) == 8'h0A) return s.substr(0, s.len() - 2);
    return s;
  endfunction

  function automatic bit is_bit(input int v);
    return v == 0 || v == 1;
  endfunction

  function automatic bit is_int8(input int v);
    return v >= -(1 << (DATA_W - 1)) && v < (1 << (DATA_W - 1));
  endfunction

  initial begin
    string path;
    string line;
    string segment;
    int    fd;
    int    version;
    int    header_clocks;
    int    header_random;
    int    seed;
    int    line_no;
    int    checks;
    int    mismatches;
    int    random_clocks;
    bit    in_random;
    int    seg_clocks;
    int    seg_mismatches;
    int    v_rst, v_clear, v_a, v_av, v_b, v_bv;
    int    e_acc, e_a, e_av, e_b, e_bv;

    rst        = 1'b0;
    clear      = 1'b0;
    a_in       = '0;
    a_valid_in = 1'b0;
    b_in       = '0;
    b_valid_in = 1'b0;

    if (!$value$plusargs("vectors=%s", path)) $fatal(1, "tb_processing_element: pass +vectors=<pe.vec>");
    fd = $fopen(path, "r");
    if (fd == 0) $fatal(1, "tb_processing_element: cannot open %s", path);
    if ($fgets(line, fd) == 0 ||
        $sscanf(line, "pe-vectors %d %d %d %d", version, header_clocks, header_random, seed) != 4) begin
      $fatal(1, "%s:1: expected 'pe-vectors <version> <clocks> <random clocks> <seed>', got '%s'", path, chomp(line));
    end
    if (version != 1) $fatal(1, "%s:1: format version %0d, this testbench reads version 1", path, version);

    line_no        = 1;
    checks         = 0;
    mismatches     = 0;
    random_clocks  = 0;
    in_random      = 1'b0;
    segment        = "";
    seg_clocks     = 0;
    seg_mismatches = 0;
    while ($fgets(line, fd) != 0) begin
      line_no++;
      line = chomp(line);
      if (line.len() > 0 && line.getc(0) == "#") begin
        if (segment != "") begin
          $display("segment '%s': %0d clocks, %0d mismatches, acc after the last clock %0d",
                   segment, seg_clocks, seg_mismatches, acc);
        end
        segment        = (line.len() > 2) ? line.substr(2, line.len() - 1) : "";
        in_random      = segment.len() >= 7 && segment.substr(0, 6) == "random:";
        seg_clocks     = 0;
        seg_mismatches = 0;
        continue;
      end
      if ($sscanf(line, "%d %d %d %d %d %d %d %d %d %d %d", v_rst, v_clear, v_a, v_av, v_b, v_bv,
                  e_acc, e_a, e_av, e_b, e_bv) != 11) begin
        $fatal(1, "%s:%0d: expected 11 integers, got '%s'", path, line_no, line);
      end
      if (!is_bit(v_rst) || !is_bit(v_clear) || !is_bit(v_av) || !is_bit(v_bv) || !is_bit(e_av) ||
          !is_bit(e_bv) || !is_int8(v_a) || !is_int8(v_b) || !is_int8(e_a) || !is_int8(e_b)) begin
        $fatal(1, "%s:%0d: a valid, rst or clear field is not 0 or 1, or an operand is not INT8: '%s'",
               path, line_no, line);
      end

      @(negedge clk);
      rst        = v_rst[0];
      clear      = v_clear[0];
      a_in       = DATA_W'(v_a);
      a_valid_in = v_av[0];
      b_in       = DATA_W'(v_b);
      b_valid_in = v_bv[0];
      @(posedge clk);
      #1;

      checks++;
      seg_clocks++;
      if (in_random) random_clocks++;
      if (acc !== ACC_W'(e_acc) || a_out !== DATA_W'(e_a) || a_valid_out !== e_av[0] ||
          b_out !== DATA_W'(e_b) || b_valid_out !== e_bv[0]) begin
        mismatches++;
        seg_mismatches++;
        if (mismatches <= MAX_REPORTED) begin
          $display("MISMATCH line %0d (segment '%s'): rst=%0d clear=%0d a=%0d a_valid=%0d b=%0d b_valid=%0d: expected acc=%0d a_out=%0d/%0d b_out=%0d/%0d, got acc=%0d a_out=%0d/%0b b_out=%0d/%0b",
                   line_no, segment, v_rst, v_clear, v_a, v_av, v_b, v_bv, e_acc, e_a, e_av, e_b,
                   e_bv, acc, a_out, a_valid_out, b_out, b_valid_out);
        end
      end
    end
    $fclose(fd);
    if (segment != "") begin
      $display("segment '%s': %0d clocks, %0d mismatches, acc after the last clock %0d", segment,
               seg_clocks, seg_mismatches, acc);
    end
    if (mismatches > MAX_REPORTED) $display("... %0d more mismatches", mismatches - MAX_REPORTED);

    if (checks != header_clocks) begin
      $fatal(1, "tb_processing_element: %s has %0d clock lines, its header promises %0d", path, checks, header_clocks);
    end
    if (random_clocks != header_random) begin
      $fatal(1, "tb_processing_element: %s has %0d random clocks, its header promises %0d", path, random_clocks, header_random);
    end
    if (mismatches != 0) begin
      $fatal(1, "tb_processing_element: %0d of %0d checks failed", mismatches, checks);
    end
    $display("tb_processing_element: PASS (%0d checks, %0d random clocks, seed %0d)", checks, random_clocks, seed);
    $finish;
  end
endmodule
