// Self-checking single-tile unit test for systolic_array at ROWS × COLS (set with -GROWS -GCOLS).
// Run by `make test-array`, which generates the cases with
// `pnpm --filter @vcpu/accelerator-reference gen-tile-suite`, so every expected C here came from
// the reference model (packages/accelerator-reference/src/model/matmul.ts).
//
// A suite directory holds cases.txt (one case name per line) and, per case, the matmul vector
// files of docs/hardware/accelerators/architecture.md with M = ROWS and N = COLS: <name>.in
// (`M N K`, then A row-major, then B row-major) and <name>.expected (C row-major). The cases run
// in order after one reset, with no reset between tiles, and cycle through three ways of starting
// the next tile: in the clock right after the previous tile_done, in the tile_done clock itself
// (busy is already low there), and after three idle clocks. In every clock between two tiles, and
// in the next tile's tile_start clock, c must still hold the previous tile's C. After the last case
// the driver resets the array in the middle of streaming a tile and reruns it from the clock after
// the reset, with every accumulator required to read 0 in that clock.
//
// One loop step is one clock: the inputs change on the falling edge and everything is sampled
// 1 ns later. With rel = 0 the tile_start clock, the driver presents A[i, k] / B[k, j] unskewed
// in rel = 1 + k for k = 0 … K−1, with no gaps, and invalid zeros otherwise. Every clock checks:
//
//   - the operand clocks the driver produced are exactly rel = 1 … K (a self-check of the driver's
//     no-gap rule, which the array relies on);
//   - each PE(i, j) accumulates (both input valid bits high) exactly when 0 ≤ rel − 1 − i − j < K,
//     and then its operands are A[i, k] and B[k, j] for k = rel − 1 − i − j: the skew is exact;
//   - tile_done is low before, and high in, rel = K + ROWS + COLS − 1; busy is high in between;
//   - in the tile_done clock every accumulator equals the expected C[i, j].
//
// In every odd-numbered case the driver also pulses tile_start, with a different tile_k, in the
// second operand clock and in the last busy clock (rel = K + ROWS + COLS − 2): the array is busy,
// so both must be ignored.
//
// Plusargs: +suite=<dir> (required); +trace=<case> prints that case clock by clock as a
// Markdown table (the one in docs/hardware/accelerators/systolic-array.md). It prints one line
// per case, the first MAX_REPORTED mismatches as `MISMATCH …`, and exits non-zero ($fatal) on a
// mismatch, a timing violation or a malformed vector file.

module tb_systolic_array #(
  parameter int ROWS = 4,
  parameter int COLS = 4
);
  localparam int DATA_W       = matmul_pkg::DATA_W;
  localparam int ACC_W        = matmul_pkg::ACC_W;
  localparam int CFG_W        = matmul_pkg::CFG_W;
  localparam int MAX_DIM      = matmul_pkg::MAX_DIM;
  localparam int MAX_REPORTED = 20;

  logic                            clk;
  logic                            rst;
  logic                            tile_start;
  logic [CFG_W-1:0]                tile_k;
  logic [ROWS-1:0]                 a_valid;
  logic [ROWS-1:0][DATA_W-1:0]     a_data;
  logic [COLS-1:0]                 b_valid;
  logic [COLS-1:0][DATA_W-1:0]     b_data;
  logic [ROWS*COLS-1:0][ACC_W-1:0] c;
  logic                            tile_done;
  logic                            busy;

  systolic_array #(.ROWS(ROWS), .COLS(COLS), .DATA_W(DATA_W), .ACC_W(ACC_W)) dut (
    .clk, .rst, .tile_start, .tile_k, .a_valid, .a_data, .b_valid, .b_data, .c, .tile_done, .busy
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  int a_m [ROWS][MAX_DIM];
  int b_m [MAX_DIM][COLS];
  int c_m [ROWS][COLS];
  // What c must hold until the end of the next accepted tile_start clock: the previous tile's C
  // (all zeros right after a reset).
  int held_c_m [ROWS][COLS];
  bit have_held = 1'b0;

  int mismatches = 0;

  function automatic string chomp(input string s);
    if (s.len() > 0 && s.getc(s.len() - 1) == 8'h0A) return s.substr(0, s.len() - 2);
    return s;
  endfunction

  function automatic bit is_int8(input int v);
    return v >= -(1 << (DATA_W - 1)) && v < (1 << (DATA_W - 1));
  endfunction

  // Reads one decimal integer, or stops the test naming the file.
  function automatic int read_int(input int fd, input string file);
    int v;
    if ($fscanf(fd, "%d", v) != 1) $fatal(1, "%s: expected another integer", file);
    return v;
  endfunction

  // Loads <dir>/<name>.in and .expected into a_m, b_m and c_m; returns K.
  function automatic int load_case(input string dir, input string name);
    string file;
    int    fd;
    int    m, n, k;
    file = {dir, "/", name, ".in"};
    fd = $fopen(file, "r");
    if (fd == 0) $fatal(1, "tb_systolic_array: cannot open %s", file);
    if ($fscanf(fd, "%d %d %d", m, n, k) != 3) $fatal(1, "%s:1: expected 'M N K'", file);
    if (m != ROWS || n != COLS) begin
      $fatal(1, "%s: a %0d x %0d tile, this array is %0d x %0d", file, m, n, ROWS, COLS);
    end
    if (k < 1 || k > MAX_DIM) $fatal(1, "%s: K = %0d is outside 1 … %0d", file, k, MAX_DIM);
    for (int i = 0; i < ROWS; i++) begin
      for (int kk = 0; kk < k; kk++) begin
        a_m[i][kk] = read_int(fd, file);
        if (!is_int8(a_m[i][kk])) $fatal(1, "%s: A[%0d][%0d] = %0d is not INT8", file, i, kk, a_m[i][kk]);
      end
    end
    for (int kk = 0; kk < k; kk++) begin
      for (int j = 0; j < COLS; j++) begin
        b_m[kk][j] = read_int(fd, file);
        if (!is_int8(b_m[kk][j])) $fatal(1, "%s: B[%0d][%0d] = %0d is not INT8", file, kk, j, b_m[kk][j]);
      end
    end
    $fclose(fd);
    file = {dir, "/", name, ".expected"};
    fd = $fopen(file, "r");
    if (fd == 0) $fatal(1, "tb_systolic_array: cannot open %s", file);
    for (int i = 0; i < ROWS; i++) begin
      for (int j = 0; j < COLS; j++) begin
        c_m[i][j] = read_int(fd, file);
      end
    end
    $fclose(fd);
    return k;
  endfunction

  function automatic void report(input string msg);
    mismatches++;
    if (mismatches <= MAX_REPORTED) $display("MISMATCH %s", msg);
  endfunction

  // The k PE(i, j) is due to multiply in clock rel of a tile, or -1 if it is due to be idle.
  function automatic int due_k(input int rel, input int i, input int j, input int k_len);
    int k;
    k = rel - 1 - i - j;
    return (k >= 0 && k < k_len) ? k : -1;
  endfunction

  // Checks that every element of c still equals held_c_m.
  function automatic void check_held(input string where);
    if (!have_held) return;
    for (int i = 0; i < ROWS; i++) begin
      for (int j = 0; j < COLS; j++) begin
        if (c[i*COLS+j] !== ACC_W'(held_c_m[i][j])) begin
          report($sformatf("%s: C[%0d][%0d] not held: expected %0d, got %0d", where, i, j,
                           held_c_m[i][j], $signed(c[i*COLS+j])));
        end
      end
    end
  endfunction

  // One clock between tiles: inputs idle; the array is neither busy nor done and holds c.
  task automatic idle_clock(input string after);
    @(negedge clk);
    tile_start = 1'b0;
    a_valid    = '0;
    a_data     = '0;
    b_valid    = '0;
    b_data     = '0;
    #1;
    if (tile_done !== 1'b0 || busy !== 1'b0) begin
      report($sformatf("idle clock after %s: tile_done %0d busy %0d, expected 0 0", after, tile_done, busy));
    end
    check_held($sformatf("idle clock after %s", after));
  endtask

  // Runs one tile from its tile_start clock through its tile_done clock (or through clock stop_at
  // when stop_at >= 0), checking every clock. With wait_edge clear, the tile_start clock is the
  // current one (the driver is already past its falling edge, in the previous tile's tile_done
  // clock when prev_done is set). done_seen is the first clock after tile_start with tile_done
  // high, or -1.
  task automatic run_tile(input string name, input int k_len, input bit wait_edge,
                          input bit prev_done, input bit poke_busy, input bit trace,
                          input int stop_at, output int done_seen);
    int    done_rel;
    int    macs;
    int    clock_macs;
    int    operand_clocks;
    int    k;
    bit    pe_mac;
    string pe_text;
    string row_text;
    string operand_text;
    string inputs_text;
    done_rel       = k_len + ROWS + COLS - 1;
    macs           = 0;
    operand_clocks = 0;
    done_seen      = -1;
    if (trace) begin
      $display("TRACE | Clock (from tile_start) | Operand clock | Inputs | %s | MACs | busy | tile_done |",
               trace_row_headers());
      $display("TRACE | ---: | ---: | --- | %s | ---: | :---: | :---: |", trace_row_rules());
    end
    for (int rel = 0; rel <= ((stop_at >= 0) ? stop_at : done_rel); rel++) begin
      if (rel > 0 || wait_edge) @(negedge clk);
      tile_start = (rel == 0) || (poke_busy && (rel == 2 || rel == done_rel - 1));
      tile_k     = (rel == 0) ? CFG_W'(k_len) : CFG_W'(k_len + 5);
      for (int i = 0; i < ROWS; i++) begin
        a_valid[i] = rel >= 1 && rel <= k_len;
        a_data[i]  = a_valid[i] ? DATA_W'(a_m[i][rel-1]) : '0;
      end
      for (int j = 0; j < COLS; j++) begin
        b_valid[j] = rel >= 1 && rel <= k_len;
        b_data[j]  = b_valid[j] ? DATA_W'(b_m[rel-1][j]) : '0;
      end
      #1;

      // The no-gap rule: valid operands in exactly rel = 1 … K.
      if (a_valid[0]) begin
        operand_clocks++;
        if (rel != operand_clocks) report($sformatf("%s rel %0d: an operand gap", name, rel));
      end

      // Every PE: accumulates exactly when due, with the operands of its k.
      row_text   = "";
      clock_macs = 0;
      for (int i = 0; i < ROWS; i++) begin
        for (int j = 0; j < COLS; j++) begin
          k      = due_k(rel, i, j, k_len);
          pe_mac = dut.a_hv[i][j] && dut.b_vv[i][j];
          if (pe_mac) clock_macs++;
          if (pe_mac != (k >= 0)) begin
            report($sformatf("%s rel %0d: PE(%0d,%0d) accumulate %0d, expected %0d (k %0d)", name,
                             rel, i, j, pe_mac, k >= 0, k));
          end else if (pe_mac) begin
            macs++;
            if (dut.a_h[i][j] !== DATA_W'(a_m[i][k]) || dut.b_v[i][j] !== DATA_W'(b_m[k][j])) begin
              report($sformatf("%s rel %0d: PE(%0d,%0d) k %0d multiplies %0d x %0d, expected A=%0d x B=%0d",
                               name, rel, i, j, k, $signed(dut.a_h[i][j]), $signed(dut.b_v[i][j]),
                               a_m[i][k], b_m[k][j]));
            end
          end
          if (trace) begin
            // What the PE did: the k of its operands when it accumulated, · when idle.
            pe_text = pe_mac ? $sformatf("%0d", rel - 1 - i - j) : "·";
            row_text = {row_text, (j == 0) ? ((i == 0) ? "" : " | ") : " ", pe_text};
          end
        end
      end

      // Completion timing (in the tile_start clock, tile_done is the previous tile's).
      if (rel > 0 && tile_done === 1'b1 && done_seen < 0) done_seen = rel;
      if (tile_done !== ((rel == done_rel) || (rel == 0 && prev_done))) begin
        report($sformatf("%s rel %0d: tile_done %0d, expected it only at rel %0d = K + ROWS + COLS - 1",
                         name, rel, tile_done, done_rel));
      end
      // The previous results stay readable through the tile_start clock.
      if (rel == 0) check_held($sformatf("%s rel 0", name));
      if (busy !== (rel >= 1 && rel < done_rel)) begin
        report($sformatf("%s rel %0d: busy %0d", name, rel, busy));
      end
      if (rel == done_rel) begin
        for (int i = 0; i < ROWS; i++) begin
          for (int j = 0; j < COLS; j++) begin
            if (c[i*COLS+j] !== ACC_W'(c_m[i][j])) begin
              report($sformatf("%s: C[%0d][%0d] expected %0d, got %0d", name, i, j, c_m[i][j],
                               $signed(c[i*COLS+j])));
            end
          end
        end
      end

      if (trace) begin
        operand_text = "–";
        inputs_text  = "–";
        if (rel == 0) inputs_text = "`tile_start`, `tile_k` = K";
        if (rel >= 1) operand_text = $sformatf("%0d", rel - 1);
        if (rel >= 1 && rel <= k_len) inputs_text = $sformatf("A[·, %0d], B[%0d, ·]", rel - 1, rel - 1);
        $display("TRACE | %0d | %s | %s | %s | %0d | %0d | %0d |", rel, operand_text, inputs_text,
                 row_text, clock_macs, busy, tile_done);
      end
    end
    if (stop_at < 0) begin
      if (macs != ROWS * COLS * k_len) begin
        report($sformatf("%s: %0d MACs, expected %0d", name, macs, ROWS * COLS * k_len));
      end
      held_c_m  = c_m;
      have_held = 1'b1;
    end
  endtask

  function automatic string trace_row_headers();
    string s = "";
    for (int i = 0; i < ROWS; i++) s = {s, (i == 0) ? "" : " | ", $sformatf("k at PE(%0d, 0…%0d)", i, COLS - 1)};
    return s;
  endfunction

  function automatic string trace_row_rules();
    string s = "";
    for (int i = 0; i < ROWS; i++) s = {s, (i == 0) ? "" : " | ", ":---:"};
    return s;
  endfunction

  initial begin
    string dir;
    string trace_name;
    string list_file;
    string name;
    int    fd;
    int    k_len;
    int    cases;
    int    random_cases;
    int    mismatches_before;
    int    done_seen;
    bit    trace;
    bit    traced;
    string notes;
    int    start_mode;
    int    reset_rel;
    string last_name;

    rst        = 1'b1;
    tile_start = 1'b0;
    tile_k     = '0;
    a_valid    = '0;
    a_data     = '0;
    b_valid    = '0;
    b_data     = '0;

    if (!$value$plusargs("suite=%s", dir)) $fatal(1, "tb_systolic_array: pass +suite=<dir>");
    if (!$value$plusargs("trace=%s", trace_name)) trace_name = "";
    list_file = {dir, "/cases.txt"};
    fd = $fopen(list_file, "r");
    if (fd == 0) $fatal(1, "tb_systolic_array: cannot open %s", list_file);

    repeat (2) @(negedge clk);
    rst = 1'b0;
    @(negedge clk);

    cases        = 0;
    random_cases = 0;
    traced       = 1'b0;
    while ($fgets(name, fd) != 0) begin
      name = chomp(name);
      if (name.len() == 0) continue;
      k_len = load_case(dir, name);
      trace = name == trace_name;
      mismatches_before = mismatches;
      // 0: the clock after the previous tile_done; 1: in the tile_done clock; 2: after idle clocks.
      start_mode = (cases == 0) ? 0 : cases % 3;
      if (start_mode == 2) repeat (3) idle_clock(name);
      run_tile(name, k_len, start_mode != 1, start_mode == 1, cases % 2 == 1, trace, -1, done_seen);
      notes = "";
      if (cases > 0 && start_mode == 0) notes = {notes, ", started the clock after the previous tile_done"};
      if (start_mode == 1) notes = {notes, ", started in the previous tile_done clock"};
      if (start_mode == 2) notes = {notes, ", started after 3 idle clocks holding the previous C"};
      if (cases % 2 == 1) notes = {notes, ", tile_start while busy ignored twice"};
      $display("case %s: K = %0d, tile_done %0d clocks after tile_start (K + ROWS + COLS - 1 = %0d), %0d MACs, %0d mismatches%s",
               name, k_len, done_seen, k_len + ROWS + COLS - 1, ROWS * COLS * k_len,
               mismatches - mismatches_before, notes);
      cases++;
      // gen-tile-suite names its random tiles rand<NNN>-…; the directed ones never start so.
      if (name.len() > 4 && name.substr(0, 3) == "rand" && name.getc(4) >= "0" && name.getc(4) <= "9") begin
        random_cases++;
      end
      if (trace) traced = 1'b1;
      last_name = name;
    end
    $fclose(fd);

    // Reset in the middle of the last tile, while operands are inside the skew registers, then
    // rerun it from the clock after the reset clock: busy and tile_done must be low, every
    // accumulator 0, and no operand from before the reset may reach a PE.
    if (cases > 0) begin
      mismatches_before = mismatches;
      reset_rel = (k_len + 1) / 2;
      run_tile({last_name, " (to be reset)"}, k_len, 1'b1, 1'b0, 1'b0, 1'b0, reset_rel, done_seen);
      @(negedge clk);
      rst        = 1'b1;
      tile_start = 1'b0;
      a_valid    = '0;
      b_valid    = '0;
      @(negedge clk);
      rst = 1'b0;
      for (int i = 0; i < ROWS; i++) begin
        for (int j = 0; j < COLS; j++) held_c_m[i][j] = 0;
      end
      run_tile({last_name, " (after reset)"}, k_len, 1'b0, 1'b0, 1'b0, 1'b0, -1, done_seen);
      $display("reset: %s reset in clock %0d of %0d, rerun from the next clock: tile_done after %0d clocks, %0d mismatches",
               last_name, reset_rel + 1, k_len + ROWS + COLS - 1, done_seen, mismatches - mismatches_before);
    end

    if (trace_name != "" && !traced) $fatal(1, "tb_systolic_array: +trace=%s is not in %s", trace_name, list_file);
    if (mismatches > MAX_REPORTED) $display("... %0d more mismatches", mismatches - MAX_REPORTED);
    if (cases == 0) $fatal(1, "tb_systolic_array: %s lists no cases", list_file);
    if (mismatches != 0) begin
      $fatal(1, "tb_systolic_array %0dx%0d: %0d mismatches over %0d cases", ROWS, COLS, mismatches, cases);
    end
    $display("tb_systolic_array %0dx%0d: PASS (%0d cases: %0d directed, %0d random; %0d started without a reset in between; mid-tile reset and rerun)",
             ROWS, COLS, cases, cases - random_cases, random_cases, cases - 1);
    $finish;
  end
endmodule
