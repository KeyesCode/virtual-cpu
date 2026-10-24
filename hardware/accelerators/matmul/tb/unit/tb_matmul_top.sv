// Self-checking unit test for matmul_top at ROWS × COLS (set with -GROWS -GCOLS): whole tiled
// matmuls through the host port and the start/busy/done handshake. Run by `make test-top`, which
// generates the cases with `pnpm --filter @vcpu/accelerator-reference gen-top-suite`, so every
// expected C here came from the reference model (packages/accelerator-reference/src/model/matmul.ts).
//
// A suite directory holds cases.txt (one case per line: its name, then ` reuse` for a case that
// runs on the A and B already in the buffers) and, per case, the matmul vector files of
// docs/hardware/accelerators/architecture.md: <name>.in (`M N K`, then A row-major, then B
// row-major) and <name>.expected (C row-major). The cases run in order after one reset, with no
// reset anywhere after it. Per case the driver
//
//   1. writes A and B through the host port, both ports in parallel, one element per clock
//      (in = max(M·K, K·N) clocks), or, for a reuse case, checks that its A and B are the leading
//      submatrices of what it last wrote and writes nothing (in = 0);
//   2. pulses start with cfg_m/n/k and checks every clock until done: error and error_code clear
//      from the next clock, busy high until done, the tiles in row-major order (dbg_tile_i/j in
//      each PREPARE_TILE clock) and dbg_k = 0 … K−1 in COMPUTE; at done, busy low, and the
//      cycle counters and the number of busy clocks equal the formulas of
//      docs/hardware/accelerators/controller.md:
//        compute = tiles · (K + ROWS + COLS), store = M · N,
//        busy    = 1 + tiles · (K + ROWS + COLS + 1) + M · N;
//      in every odd-numbered case it also pulses start (with cfg_m = 0) in the third busy clock
//      and drives host writes of wrong values into A and B through the first busy clocks, all of
//      which must be ignored;
//   3. reads C through the host port (out = M·N + 1 clocks: the read is registered) and compares
//      every element, checking that done was a one-clock pulse.
//
// It prints `case <name>: PASS compute=<n> store=<n> in=<n> out=<n> busy=<n> tiles=<n>` per case.
// After the suite, on the buffers of the last case:
//
//   - back-to-back: three runs of it with no clock in between, the second started in the first's
//     done clock and the third in the clock after the second's done, then C is read;
//   - errors: starts with K = 0, M = 65, M = 65 with N = 0 (ERR_DIM_ZERO wins), K = 0xFFFF and
//     M = N = K = 0 must each raise error with the right error_code from the next clock, pass
//     through ERROR to IDLE, and never raise busy or done; the last error's ERROR clock starts a
//     valid run, which must clear error and produce the last case's C again.
//
// Plusargs: +suite=<dir> (required). The first MAX_REPORTED problems are printed as `MISMATCH …`
// and the test exits non-zero ($fatal) on any, on a timeout or on a malformed vector file.

module tb_matmul_top #(
  parameter int ROWS = 4,
  parameter int COLS = 4
);
  localparam int DATA_W       = matmul_pkg::DATA_W;
  localparam int ACC_W        = matmul_pkg::ACC_W;
  localparam int CFG_W        = matmul_pkg::CFG_W;
  localparam int MAX_DIM      = matmul_pkg::MAX_DIM;
  localparam int ADDR_W       = $clog2(MAX_DIM * MAX_DIM);
  localparam int LOG_DIM      = $clog2(MAX_DIM);
  localparam int MAX_REPORTED = 20;

  logic                          clk;
  logic                          rst;
  logic [CFG_W-1:0]              cfg_m;
  logic [CFG_W-1:0]              cfg_n;
  logic [CFG_W-1:0]              cfg_k;
  logic                          start;
  logic                          busy;
  logic                          done;
  logic                          error;
  matmul_pkg::error_code_t       error_code;
  logic                          host_a_we;
  logic [ADDR_W-1:0]             host_a_addr;
  logic signed [DATA_W-1:0]      host_a_wdata;
  logic                          host_b_we;
  logic [ADDR_W-1:0]             host_b_addr;
  logic signed [DATA_W-1:0]      host_b_wdata;
  logic [ADDR_W-1:0]             host_c_addr;
  logic signed [ACC_W-1:0]       host_c_rdata;
  logic [31:0]                   cycles_compute;
  logic [31:0]                   cycles_store;
  matmul_pkg::ctrl_state_t       dbg_state;
  logic [LOG_DIM-1:0]            dbg_tile_i;
  logic [LOG_DIM-1:0]            dbg_tile_j;
  logic [LOG_DIM-1:0]            dbg_k;

  matmul_top #(.ROWS(ROWS), .COLS(COLS)) dut (
    .clk, .rst, .cfg_m, .cfg_n, .cfg_k, .start, .busy, .done, .error, .error_code,
    .host_a_we, .host_a_addr, .host_a_wdata, .host_b_we, .host_b_addr, .host_b_wdata,
    .host_c_addr, .host_c_rdata, .cycles_compute, .cycles_store,
    .dbg_state, .dbg_tile_i, .dbg_tile_j, .dbg_k
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  // The current case.
  int m, n, k;
  int a_m [MAX_DIM][MAX_DIM];
  int b_m [MAX_DIM][MAX_DIM];
  int c_m [MAX_DIM][MAX_DIM];
  // What the driver last wrote into the buffers: the A and B of the last case that was not a
  // reuse case.
  int  a_buf [MAX_DIM][MAX_DIM];
  int  b_buf [MAX_DIM][MAX_DIM];
  int  buf_m, buf_n, buf_k;
  bit  have_buf = 1'b0;

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

  function automatic void report(input string msg);
    mismatches++;
    if (mismatches <= MAX_REPORTED) $display("MISMATCH %s", msg);
  endfunction

  function automatic int ceil_div(input int a, input int b);
    return (a + b - 1) / b;
  endfunction

  function automatic int tiles_of(input int rows, input int cols);
    return ceil_div(rows, ROWS) * ceil_div(cols, COLS);
  endfunction

  // Loads <dir>/<name>.in and .expected into m, n, k, a_m, b_m and c_m.
  function automatic void load_case(input string dir, input string name);
    string file;
    int    fd;
    file = {dir, "/", name, ".in"};
    fd = $fopen(file, "r");
    if (fd == 0) $fatal(1, "tb_matmul_top: cannot open %s", file);
    if ($fscanf(fd, "%d %d %d", m, n, k) != 3) $fatal(1, "%s:1: expected 'M N K'", file);
    if (m < 1 || m > MAX_DIM || n < 1 || n > MAX_DIM || k < 1 || k > MAX_DIM) begin
      $fatal(1, "%s: M N K = %0d %0d %0d, each must be 1 … %0d", file, m, n, k, MAX_DIM);
    end
    for (int i = 0; i < m; i++) begin
      for (int kk = 0; kk < k; kk++) begin
        a_m[i][kk] = read_int(fd, file);
        if (!is_int8(a_m[i][kk])) $fatal(1, "%s: A[%0d][%0d] = %0d is not INT8", file, i, kk, a_m[i][kk]);
      end
    end
    for (int kk = 0; kk < k; kk++) begin
      for (int j = 0; j < n; j++) begin
        b_m[kk][j] = read_int(fd, file);
        if (!is_int8(b_m[kk][j])) $fatal(1, "%s: B[%0d][%0d] = %0d is not INT8", file, kk, j, b_m[kk][j]);
      end
    end
    $fclose(fd);
    file = {dir, "/", name, ".expected"};
    fd = $fopen(file, "r");
    if (fd == 0) $fatal(1, "tb_matmul_top: cannot open %s", file);
    for (int i = 0; i < m; i++) begin
      for (int j = 0; j < n; j++) begin
        c_m[i][j] = read_int(fd, file);
      end
    end
    $fclose(fd);
  endfunction

  // A reuse case runs on the buffers as they are: its A and B must be inside what was written.
  function automatic void check_reuse(input string name);
    if (!have_buf) $fatal(1, "tb_matmul_top: reuse case %s has no earlier case to reuse", name);
    if (m > buf_m || n > buf_n || k > buf_k) begin
      $fatal(1, "tb_matmul_top: reuse case %s (%0d %0d %0d) is larger than the buffers' %0d %0d %0d",
             name, m, n, k, buf_m, buf_n, buf_k);
    end
    for (int i = 0; i < m; i++) begin
      for (int kk = 0; kk < k; kk++) begin
        if (a_m[i][kk] != a_buf[i][kk]) $fatal(1, "tb_matmul_top: reuse case %s: A[%0d][%0d] is not in the buffer", name, i, kk);
      end
    end
    for (int kk = 0; kk < k; kk++) begin
      for (int j = 0; j < n; j++) begin
        if (b_m[kk][j] != b_buf[kk][j]) $fatal(1, "tb_matmul_top: reuse case %s: B[%0d][%0d] is not in the buffer", name, kk, j);
      end
    end
  endfunction

  // At every falling edge: no start and no host write unless the caller then sets one.
  function automatic void quiet();
    start     = 1'b0;
    host_a_we = 1'b0;
    host_b_we = 1'b0;
  endfunction

  // Writes A and B of the case through the host port, both ports in parallel.
  task automatic write_operands(output int clocks);
    int t;
    clocks = (m * k > k * n) ? m * k : k * n;
    for (t = 0; t < clocks; t++) begin
      @(negedge clk);
      quiet();
      if (t < m * k) begin
        host_a_we    = 1'b1;
        host_a_addr  = ADDR_W'((t / k) * MAX_DIM + t % k);
        host_a_wdata = DATA_W'(a_m[t / k][t % k]);
      end
      if (t < k * n) begin
        host_b_we    = 1'b1;
        host_b_addr  = ADDR_W'((t / n) * MAX_DIM + t % n);
        host_b_wdata = DATA_W'(b_m[t / n][t % n]);
      end
    end
    a_buf    = a_m;
    b_buf    = b_m;
    buf_m    = m;
    buf_n    = n;
    buf_k    = k;
    have_buf = 1'b1;
  endtask

  // Runs the case from its start clock through its done clock. With start_now set, the start
  // clock is the current one (the driver is already past its falling edge); otherwise the next.
  // With poke set, a start and wrong host writes are driven while busy, to be ignored.
  task automatic run(input string name, input bit start_now, input bit poke,
                     output int compute, output int store, output int busy_clocks);
    int rel;
    int tiles;
    int tile;
    int k_seen;
    int busy_expected;
    int timeout;
    tiles         = tiles_of(m, n);
    busy_expected = 1 + tiles * (k + ROWS + COLS + 1) + m * n;
    timeout       = 4 * busy_expected + 100;
    if (!start_now) begin
      @(negedge clk);
      quiet();
    end
    cfg_m = CFG_W'(m);
    cfg_n = CFG_W'(n);
    cfg_k = CFG_W'(k);
    start = 1'b1;
    busy_clocks = 0;
    tile        = 0;
    k_seen      = 0;
    for (rel = 1; ; rel++) begin
      @(negedge clk);
      quiet();
      if (poke && rel == 3) begin
        start = 1'b1;
        cfg_m = '0;
      end
      if (poke && rel >= 2 && rel < 2 + m * k && rel < busy_expected) begin
        host_a_we    = 1'b1;
        host_a_addr  = ADDR_W'(((rel - 2) / k) * MAX_DIM + (rel - 2) % k);
        host_a_wdata = ~DATA_W'(a_m[(rel - 2) / k][(rel - 2) % k]);
      end
      if (poke && rel >= 2 && rel < 2 + k * n && rel < busy_expected) begin
        host_b_we    = 1'b1;
        host_b_addr  = ADDR_W'(((rel - 2) / n) * MAX_DIM + (rel - 2) % n);
        host_b_wdata = ~DATA_W'(b_m[(rel - 2) / n][(rel - 2) % n]);
      end
      #1;
      if (rel == 1 && (error !== 1'b0 || error_code !== matmul_pkg::ERR_NONE)) begin
        report($sformatf("%s: error %0d error_code %0d in the clock after start, expected 0 0",
                         name, error, error_code));
      end
      // The tile order: row-major, the tile column fastest.
      if (dbg_state == matmul_pkg::PREPARE_TILE) begin
        if (int'(dbg_tile_i) != tile / ceil_div(n, COLS) || int'(dbg_tile_j) != tile % ceil_div(n, COLS)) begin
          report($sformatf("%s: tile %0d is (%0d, %0d), expected (%0d, %0d)", name, tile, dbg_tile_i,
                           dbg_tile_j, tile / ceil_div(n, COLS), tile % ceil_div(n, COLS)));
        end
        tile++;
        k_seen = 0;
      end
      if (dbg_state == matmul_pkg::COMPUTE) begin
        if (int'(dbg_k) != k_seen) report($sformatf("%s rel %0d: dbg_k %0d, expected %0d", name, rel, dbg_k, k_seen));
        k_seen++;
        // The edge mask, which C alone cannot show (masked PEs are never stored): every edge
        // input valid, and zero for rows past M and columns past N.
        if (dut.a_valid !== '1 || dut.b_valid !== '1) begin
          report($sformatf("%s rel %0d: a_valid %b b_valid %b in COMPUTE", name, rel, dut.a_valid, dut.b_valid));
        end
        for (int i = 0; i < ROWS; i++) begin
          if (int'(dbg_tile_i) * ROWS + i >= m && dut.a_data[i] !== '0) begin
            report($sformatf("%s rel %0d: row %0d is past M but a_data is %0d", name, rel,
                             int'(dbg_tile_i) * ROWS + i, dut.a_data[i]));
          end
        end
        for (int j = 0; j < COLS; j++) begin
          if (int'(dbg_tile_j) * COLS + j >= n && dut.b_data[j] !== '0) begin
            report($sformatf("%s rel %0d: column %0d is past N but b_data is %0d", name, rel,
                             int'(dbg_tile_j) * COLS + j, dut.b_data[j]));
          end
        end
      end
      if (done === 1'b1) begin
        if (busy !== 1'b0) report($sformatf("%s: busy high in the done clock", name));
        break;
      end
      if (busy !== 1'b1) begin
        report($sformatf("%s rel %0d: busy %0d before done, state %0d", name, rel, busy, dbg_state));
      end
      busy_clocks++;
      if (rel > timeout) $fatal(1, "tb_matmul_top: %s: no done within %0d clocks of start", name, timeout);
    end
    compute = int'(cycles_compute);
    store   = int'(cycles_store);
    if (tile != tiles) report($sformatf("%s: %0d tiles, expected %0d", name, tile, tiles));
    if (compute != tiles * (k + ROWS + COLS)) begin
      report($sformatf("%s: cycles_compute %0d, expected tiles * (K + ROWS + COLS) = %0d", name,
                       compute, tiles * (k + ROWS + COLS)));
    end
    if (store != m * n) report($sformatf("%s: cycles_store %0d, expected M * N = %0d", name, store, m * n));
    if (busy_clocks != busy_expected) begin
      report($sformatf("%s: busy for %0d clocks, expected 1 + tiles * (K + ROWS + COLS + 1) + M * N = %0d",
                       name, busy_clocks, busy_expected));
    end
  endtask

  // Reads C through the host port from the clock after done, comparing every element.
  task automatic read_c(input string name, output int clocks);
    int t;
    clocks = m * n + 1;
    for (t = 0; t < clocks; t++) begin
      @(negedge clk);
      quiet();
      if (t < m * n) host_c_addr = ADDR_W'((t / n) * MAX_DIM + t % n);
      #1;
      if (t == 0 && (done !== 1'b0 || busy !== 1'b0)) begin
        report($sformatf("%s: done %0d busy %0d in the clock after done, expected 0 0", name, done, busy));
      end
      if (t > 0 && host_c_rdata !== ACC_W'(c_m[(t - 1) / n][(t - 1) % n])) begin
        report($sformatf("%s: C[%0d][%0d] expected %0d, got %0d", name, (t - 1) / n, (t - 1) % n,
                         c_m[(t - 1) / n][(t - 1) % n], host_c_rdata));
      end
    end
  endtask

  // Starts with an invalid configuration: error with `code` from the next clock, through ERROR
  // to IDLE, busy and done never high. Checks `hold` clocks after the start clock.
  task automatic error_start(input int em, input int en, input int ek,
                             input matmul_pkg::error_code_t code, input int hold);
    string what;
    what = $sformatf("start with M N K = %0d %0d %0d", em, en, ek);
    @(negedge clk);
    quiet();
    cfg_m = CFG_W'(em);
    cfg_n = CFG_W'(en);
    cfg_k = CFG_W'(ek);
    start = 1'b1;
    for (int rel = 1; rel <= hold; rel++) begin
      @(negedge clk);
      quiet();
      #1;
      if (error !== 1'b1 || error_code !== code) begin
        report($sformatf("%s, clock %0d: error %0d error_code %0d, expected 1 %0d", what, rel, error,
                         error_code, code));
      end
      if (busy !== 1'b0 || done !== 1'b0) begin
        report($sformatf("%s, clock %0d: busy %0d done %0d, expected 0 0", what, rel, busy, done));
      end
      if (dbg_state != ((rel == 1) ? matmul_pkg::ERROR : matmul_pkg::IDLE)) begin
        report($sformatf("%s, clock %0d: state %0d", what, rel, dbg_state));
      end
    end
  endtask

  initial begin
    string dir;
    string list_file;
    string line;
    string name;
    string flag;
    string last_name;
    string notes;
    int    fd;
    int    fields;
    int    cases;
    int    random_cases;
    int    reuse_cases;
    int    mismatches_before;
    int    in_clocks;
    int    out_clocks;
    int    compute;
    int    store;
    int    busy_clocks;
    bit    reuse;

    rst       = 1'b1;
    cfg_m     = '0;
    cfg_n     = '0;
    cfg_k     = '0;
    host_a_addr  = '0;
    host_a_wdata = '0;
    host_b_addr  = '0;
    host_b_wdata = '0;
    host_c_addr  = '0;
    quiet();

    if (!$value$plusargs("suite=%s", dir)) $fatal(1, "tb_matmul_top: pass +suite=<dir>");
    list_file = {dir, "/cases.txt"};
    fd = $fopen(list_file, "r");
    if (fd == 0) $fatal(1, "tb_matmul_top: cannot open %s", list_file);

    repeat (2) @(negedge clk);
    rst = 1'b0;

    cases        = 0;
    random_cases = 0;
    reuse_cases  = 0;
    while ($fgets(line, fd) != 0) begin
      line = chomp(line);
      if (line.len() == 0) continue;
      flag   = "";
      fields = $sscanf(line, "%s %s", name, flag);
      if (fields == 2 && flag != "reuse") $fatal(1, "%s: unknown flag in '%s'", list_file, line);
      reuse = fields == 2;
      load_case(dir, name);
      mismatches_before = mismatches;
      if (reuse) begin
        check_reuse(name);
        in_clocks = 0;
        reuse_cases++;
      end else begin
        write_operands(in_clocks);
      end
      run(name, 1'b0, cases % 2 == 1, compute, store, busy_clocks);
      read_c(name, out_clocks);
      notes = "";
      if (reuse) notes = {notes, ", reused the buffers"};
      if (cases % 2 == 1) notes = {notes, ", start and host writes while busy ignored"};
      $display("case %s: %s compute=%0d store=%0d in=%0d out=%0d busy=%0d tiles=%0d%s", name,
               (mismatches == mismatches_before) ? "PASS" : "FAIL", compute, store, in_clocks,
               out_clocks, busy_clocks, tiles_of(m, n), notes);
      cases++;
      // gen-top-suite names its random cases rand<NNN>-…; the directed ones never start so.
      if (name.len() > 4 && name.substr(0, 3) == "rand" && name.getc(4) >= "0" && name.getc(4) <= "9") begin
        random_cases++;
      end
      last_name = name;
    end
    $fclose(fd);
    if (cases == 0) $fatal(1, "tb_matmul_top: %s lists no cases", list_file);

    // Back-to-back runs of the last case on the buffers as they are.
    mismatches_before = mismatches;
    run({last_name, " (back-to-back 1)"}, 1'b0, 1'b0, compute, store, busy_clocks);
    run({last_name, " (back-to-back 2, started in the done clock)"}, 1'b1, 1'b0, compute, store, busy_clocks);
    run({last_name, " (back-to-back 3, started the clock after done)"}, 1'b0, 1'b0, compute, store, busy_clocks);
    read_c({last_name, " (back-to-back)"}, out_clocks);
    $display("back-to-back: %s run 3 times without a reset or an idle clock: %s busy=%0d each", last_name,
             (mismatches == mismatches_before) ? "PASS" : "FAIL", busy_clocks);

    // Invalid configurations, then a valid start from the last one's ERROR clock.
    mismatches_before = mismatches;
    error_start(m, n, 0, matmul_pkg::ERR_DIM_ZERO, 4);
    error_start(MAX_DIM + 1, n, k, matmul_pkg::ERR_DIM_TOO_LARGE, 4);
    error_start(MAX_DIM + 1, 0, k, matmul_pkg::ERR_DIM_ZERO, 3);
    error_start(m, n, 'hFFFF, matmul_pkg::ERR_DIM_TOO_LARGE, 3);
    error_start(0, 0, 0, matmul_pkg::ERR_DIM_ZERO, 1);
    run({last_name, " (after errors)"}, 1'b1, 1'b0, compute, store, busy_clocks);
    read_c({last_name, " (after errors)"}, out_clocks);
    $display("errors: K = 0, M = 65, M = 65 with N = 0, K = 0xFFFF and 0 0 0 raised the right error_code without busy; a start in the ERROR clock ran %s: %s",
             last_name, (mismatches == mismatches_before) ? "PASS" : "FAIL");

    if (mismatches > MAX_REPORTED) $display("... %0d more mismatches", mismatches - MAX_REPORTED);
    if (mismatches != 0) begin
      $fatal(1, "tb_matmul_top %0dx%0d: %0d mismatches over %0d cases", ROWS, COLS, mismatches, cases);
    end
    $display("tb_matmul_top %0dx%0d: PASS (%0d cases: %0d directed, %0d random, %0d on reused buffers; no reset after the first; back-to-back runs; 5 invalid starts)",
             ROWS, COLS, cases, cases - random_cases, random_cases, reuse_cases);
    $finish;
  end
endmodule
