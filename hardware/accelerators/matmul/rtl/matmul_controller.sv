// The control unit of the INT8 matmul accelerator (revision matmul-os-r1): the start/busy/done
// handshake, the dimension checks, the output-tile schedule, the buffer read addresses, the edge
// masks and the stores of C.
//
// docs/hardware/accelerators/controller.md documents the FSM clock by clock, with the cycle
// formulas; docs/hardware/accelerators/architecture.md is the contract.
//
//   - start is accepted whenever busy is low (in IDLE, DONE or ERROR) and samples cfg_m, cfg_n and
//     cfg_k. A dimension of 0 sets error with ERR_DIM_ZERO, one above MAX_DIM ERR_DIM_TOO_LARGE
//     (ERR_DIM_ZERO wins), and the controller passes through ERROR back to IDLE without busy ever
//     rising. Otherwise busy is high from the next clock (LOAD) until done pulses in DONE. Every
//     accepted start clears error and error_code first.
//   - Output tiles of ROWS × COLS go in row-major tile order (the tile column fastest). A tile is
//     PREPARE_TILE (one clock: tile_start, which clears the accumulators, and the read address of
//     k = 0), COMPUTE (K clocks: the buffers' registered data of k presented unskewed to the array
//     while the address of k + 1 is issued), DRAIN (until tile_done, ROWS + COLS − 1 clocks) and
//     STORE (one clock per unmasked element), then NEXT_TILE (one clock).
//   - The whole reduction length K streams through each tile: the accumulators are cleared once,
//     at tile_start, never during K, so no partial sum is written back.
//   - Edge tiles: rows i ≥ M are fed valid zeros for A and columns j ≥ N valid zeros for B (so
//     the tile's timing does not depend on M or N), and STORE skips them, writing only the
//     R′ × C′ elements with R′ = min(ROWS, M − row0) and C′ = min(COLS, N − col0).
//   - cycles_compute counts the PREPARE_TILE, COMPUTE and DRAIN clocks of the last accepted start,
//     cycles_store its STORE clocks; both are cleared by every accepted start.
//
// Addresses are flat with a row stride of MAX_DIM (element (r, c) at r * MAX_DIM + c), so an
// address is a row index and a column index side by side. MAX_DIM, ROWS and COLS are powers of
// two, ROWS and COLS at most MAX_DIM.
module matmul_controller #(
  parameter int ROWS    = 4,
  parameter int COLS    = 4,
  parameter int DATA_W  = matmul_pkg::DATA_W,
  parameter int ACC_W   = matmul_pkg::ACC_W,
  parameter int MAX_DIM = matmul_pkg::MAX_DIM
) (
  input  logic                                     clk,
  input  logic                                     rst,
  // The handshake.
  input  logic [matmul_pkg::CFG_W-1:0]             cfg_m,
  input  logic [matmul_pkg::CFG_W-1:0]             cfg_n,
  input  logic [matmul_pkg::CFG_W-1:0]             cfg_k,
  input  logic                                     start,
  output logic                                     busy,
  output logic                                     done,
  output logic                                     error,
  output matmul_pkg::error_code_t                  error_code,
  // input_buffer reads: bank r of A returns A[row0 + r, k], bank c of B returns B[k, col0 + c].
  output logic [$clog2(MAX_DIM*MAX_DIM)-1:0]       a_rd_addr,
  input  logic [ROWS-1:0][DATA_W-1:0]              a_rd_data,
  output logic [$clog2(MAX_DIM*MAX_DIM)-1:0]       b_rd_addr,
  input  logic [COLS-1:0][DATA_W-1:0]              b_rd_data,
  // systolic_array.
  output logic                                     tile_start,
  output logic [matmul_pkg::CFG_W-1:0]             tile_k,
  output logic [ROWS-1:0]                          a_valid,
  output logic [ROWS-1:0][DATA_W-1:0]              a_data,
  output logic [COLS-1:0]                          b_valid,
  output logic [COLS-1:0][DATA_W-1:0]              b_data,
  input  logic [ROWS*COLS-1:0][ACC_W-1:0]          c,
  input  logic                                     tile_done,
  // output_buffer writes.
  output logic                                     c_we,
  output logic [$clog2(MAX_DIM*MAX_DIM)-1:0]       c_addr,
  output logic [ACC_W-1:0]                         c_wdata,
  // Clock counters of the last accepted start.
  output logic [31:0]                              cycles_compute,
  output logic [31:0]                              cycles_store,
  // Debug taps: the state, the current tile (row and column index) and the k being presented.
  output matmul_pkg::ctrl_state_t                  state,
  output logic [$clog2(MAX_DIM)-1:0]               tile_i,
  output logic [$clog2(MAX_DIM)-1:0]               tile_j,
  output logic [$clog2(MAX_DIM)-1:0]               k_idx
);
  localparam int CFG_W    = matmul_pkg::CFG_W;
  localparam int LOG_DIM  = $clog2(MAX_DIM);
  // Holds 0 … MAX_DIM: a dimension, a tile offset, or an offset plus a side.
  localparam int IDX_W    = LOG_DIM + 1;
  localparam int LOG_ROWS = $clog2(ROWS);
  localparam int LOG_COLS = $clog2(COLS);
  localparam int SEL_W    = $clog2(ROWS * COLS);

  // The configuration of the run (valid while busy).
  logic [IDX_W-1:0] m_q, n_q, k_q;
  // The current tile's first row and first column.
  logic [IDX_W-1:0] row0, col0;
  // The k of the operands presented in this COMPUTE clock.
  logic [IDX_W-1:0] k_cnt;
  // The element STORE writes in this clock, within the tile.
  logic [IDX_W-1:0] st_r, st_c;
  logic                    error_q;
  matmul_pkg::error_code_t error_code_q;
  logic [31:0]             compute_q, store_q;

  // The dimension check of a start.
  matmul_pkg::error_code_t cfg_code;
  always_comb begin
    cfg_code = matmul_pkg::ERR_NONE;
    if (cfg_m > CFG_W'(MAX_DIM) || cfg_n > CFG_W'(MAX_DIM) ||
        cfg_k > CFG_W'(MAX_DIM)) begin
      cfg_code = matmul_pkg::ERR_DIM_TOO_LARGE;
    end
    if (cfg_m == '0 || cfg_n == '0 || cfg_k == '0) cfg_code = matmul_pkg::ERR_DIM_ZERO;
  end

  // The edge mask of the current tile: R′ rows and C′ columns of it are inside C.
  logic [IDX_W-1:0] rows_left, cols_left, rows_here, cols_here;
  logic             last_tile, last_k, last_store;
  assign rows_left  = m_q - row0;
  assign cols_left  = n_q - col0;
  assign rows_here  = (rows_left >= IDX_W'(ROWS)) ? IDX_W'(ROWS) : rows_left;
  assign cols_here  = (cols_left >= IDX_W'(COLS)) ? IDX_W'(COLS) : cols_left;
  assign last_tile  = (row0 + IDX_W'(ROWS) >= m_q) && (col0 + IDX_W'(COLS) >= n_q);
  assign last_k     = k_cnt == k_q - 1'b1;
  assign last_store = (st_r == rows_here - 1'b1) && (st_c == cols_here - 1'b1);

  always_ff @(posedge clk) begin
    if (rst) begin
      state        <= matmul_pkg::IDLE;
      m_q          <= '0;
      n_q          <= '0;
      k_q          <= '0;
      row0         <= '0;
      col0         <= '0;
      k_cnt        <= '0;
      st_r         <= '0;
      st_c         <= '0;
      error_q      <= 1'b0;
      error_code_q <= matmul_pkg::ERR_NONE;
      compute_q    <= '0;
      store_q      <= '0;
    end else begin
      case (state)
        matmul_pkg::IDLE, matmul_pkg::DONE, matmul_pkg::ERROR: begin
          state <= matmul_pkg::IDLE;
          if (start) begin
            error_q      <= cfg_code != matmul_pkg::ERR_NONE;
            error_code_q <= cfg_code;
            compute_q    <= '0;
            store_q      <= '0;
            if (cfg_code != matmul_pkg::ERR_NONE) begin
              state <= matmul_pkg::ERROR;
            end else begin
              state <= matmul_pkg::LOAD;
              m_q   <= IDX_W'(cfg_m);
              n_q   <= IDX_W'(cfg_n);
              k_q   <= IDX_W'(cfg_k);
            end
          end
        end
        matmul_pkg::LOAD: begin
          row0  <= '0;
          col0  <= '0;
          state <= matmul_pkg::PREPARE_TILE;
        end
        matmul_pkg::PREPARE_TILE: begin
          compute_q <= compute_q + 1'b1;
          k_cnt     <= '0;
          state     <= matmul_pkg::COMPUTE;
        end
        matmul_pkg::COMPUTE: begin
          compute_q <= compute_q + 1'b1;
          k_cnt     <= k_cnt + 1'b1;
          if (last_k) state <= matmul_pkg::DRAIN;
        end
        matmul_pkg::DRAIN: begin
          compute_q <= compute_q + 1'b1;
          st_r      <= '0;
          st_c      <= '0;
          if (tile_done) state <= matmul_pkg::STORE;
        end
        matmul_pkg::STORE: begin
          store_q <= store_q + 1'b1;
          if (st_c == cols_here - 1'b1) begin
            st_c <= '0;
            st_r <= st_r + 1'b1;
          end else begin
            st_c <= st_c + 1'b1;
          end
          if (last_store) state <= matmul_pkg::NEXT_TILE;
        end
        matmul_pkg::NEXT_TILE: begin
          if (last_tile) begin
            state <= matmul_pkg::DONE;
          end else begin
            state <= matmul_pkg::PREPARE_TILE;
            if (col0 + IDX_W'(COLS) >= n_q) begin
              col0 <= '0;
              row0 <= row0 + IDX_W'(ROWS);
            end else begin
              col0 <= col0 + IDX_W'(COLS);
            end
          end
        end
        default: state <= matmul_pkg::IDLE;
      endcase
    end
  end

  // The handshake.
  // busy: every state but IDLE, DONE and ERROR.
  assign busy       = state != matmul_pkg::IDLE && state != matmul_pkg::DONE &&
                      state != matmul_pkg::ERROR;
  assign done       = state == matmul_pkg::DONE;
  assign error      = error_q;
  assign error_code = error_code_q;

  // Reads: the address of k = 0 in PREPARE_TILE and of k + 1 in COMPUTE, one clock before the
  // operands are presented (the buffers' read is registered). The address after the last k
  // (k = K, possibly MAX_DIM, which wraps to 0) is read but never used.
  logic [LOG_DIM-1:0] k_rd;
  assign k_rd      = (state == matmul_pkg::COMPUTE) ? LOG_DIM'(k_cnt + 1'b1) : '0;
  assign a_rd_addr = {LOG_DIM'(row0), k_rd};
  assign b_rd_addr = {k_rd, LOG_DIM'(col0)};

  // The array: every edge input is valid for the K COMPUTE clocks, with zeros past M or N.
  assign tile_start = state == matmul_pkg::PREPARE_TILE;
  assign tile_k     = CFG_W'(k_q);
  always_comb begin
    a_valid = '0;
    a_data  = '0;
    b_valid = '0;
    b_data  = '0;
    if (state == matmul_pkg::COMPUTE) begin
      for (int i = 0; i < ROWS; i++) begin
        a_valid[i] = 1'b1;
        if (row0 + IDX_W'(i) < m_q) a_data[i] = a_rd_data[i];
      end
      for (int j = 0; j < COLS; j++) begin
        b_valid[j] = 1'b1;
        if (col0 + IDX_W'(j) < n_q) b_data[j] = b_rd_data[j];
      end
    end
  end

  // Stores: C[row0 + st_r, col0 + st_c] from PE(st_r, st_c).
  assign c_we    = state == matmul_pkg::STORE;
  assign c_addr  = {LOG_DIM'(row0 + st_r), LOG_DIM'(col0 + st_c)};
  assign c_wdata = c[SEL_W'(int'(st_r) * COLS + int'(st_c))];

  assign cycles_compute = compute_q;
  assign cycles_store   = store_q;

  assign tile_i = LOG_DIM'(row0 >> LOG_ROWS);
  assign tile_j = LOG_DIM'(col0 >> LOG_COLS);
  assign k_idx  = LOG_DIM'(k_cnt);
endmodule
