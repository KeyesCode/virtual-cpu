// The INT8 matmul accelerator (revision matmul-os-r1): C (M × N) = A (M × K) · B (K × N) for any
// M, N and K in 1 … MAX_DIM, on a ROWS × COLS output-stationary systolic array, one RTL for every
// size.
//
// docs/hardware/accelerators/architecture.md is the contract (ports, handshake, tiling);
// docs/hardware/accelerators/controller.md documents the FSM and its cycle counts, and
// docs/hardware/accelerators/memory.md the buffers and the host port.
//
//   - The host port is a testbench convenience, one element per clock: host_a_* and host_b_*
//     write A[i, k] at i * MAX_DIM + k and B[k, j] at k * MAX_DIM + j, and host_c_addr reads
//     C[i, j] at i * MAX_DIM + j into host_c_rdata one clock later. Writes while busy is high are
//     ignored.
//   - cfg_m, cfg_n and cfg_k are sampled by a start accepted while busy is low; busy rises in the
//     next clock and is low again in the one-clock done pulse. An invalid dimension sets error
//     and error_code instead (busy stays low), both held until the next start.
//   - cycles_compute and cycles_store count the last run's compute (PREPARE_TILE, COMPUTE,
//     DRAIN) and store clocks; dbg_* are taps for waveforms.
module matmul_top #(
  parameter int ROWS    = 4,
  parameter int COLS    = 4,
  parameter int DATA_W  = matmul_pkg::DATA_W,
  parameter int ACC_W   = matmul_pkg::ACC_W,
  parameter int MAX_DIM = matmul_pkg::MAX_DIM
) (
  input  logic                                  clk,
  input  logic                                  rst,
  // Configuration and handshake.
  input  logic [matmul_pkg::CFG_W-1:0]          cfg_m,
  input  logic [matmul_pkg::CFG_W-1:0]          cfg_n,
  input  logic [matmul_pkg::CFG_W-1:0]          cfg_k,
  input  logic                                  start,
  output logic                                  busy,
  output logic                                  done,
  output logic                                  error,
  output matmul_pkg::error_code_t               error_code,
  // The host port.
  input  logic                                  host_a_we,
  input  logic [$clog2(MAX_DIM*MAX_DIM)-1:0]    host_a_addr,
  input  logic signed [DATA_W-1:0]              host_a_wdata,
  input  logic                                  host_b_we,
  input  logic [$clog2(MAX_DIM*MAX_DIM)-1:0]    host_b_addr,
  input  logic signed [DATA_W-1:0]              host_b_wdata,
  input  logic [$clog2(MAX_DIM*MAX_DIM)-1:0]    host_c_addr,
  output logic signed [ACC_W-1:0]               host_c_rdata,
  // Clock counters of the last run.
  output logic [31:0]                           cycles_compute,
  output logic [31:0]                           cycles_store,
  // Debug taps.
  output matmul_pkg::ctrl_state_t               dbg_state,
  output logic [$clog2(MAX_DIM)-1:0]            dbg_tile_i,
  output logic [$clog2(MAX_DIM)-1:0]            dbg_tile_j,
  output logic [$clog2(MAX_DIM)-1:0]            dbg_k
);
  localparam int ADDR_W  = $clog2(MAX_DIM * MAX_DIM);
  localparam int LOG_DIM = $clog2(MAX_DIM);
  localparam int DEPTH   = MAX_DIM * MAX_DIM;

  logic [ADDR_W-1:0]               a_rd_addr;
  logic [ROWS-1:0][DATA_W-1:0]     a_rd_data;
  logic [ADDR_W-1:0]               b_rd_addr;
  logic [COLS-1:0][DATA_W-1:0]     b_rd_data;
  logic                            tile_start;
  logic [matmul_pkg::CFG_W-1:0]    tile_k;
  logic [ROWS-1:0]                 a_valid;
  logic [ROWS-1:0][DATA_W-1:0]     a_data;
  logic [COLS-1:0]                 b_valid;
  logic [COLS-1:0][DATA_W-1:0]     b_data;
  logic [ROWS*COLS-1:0][ACC_W-1:0] c;
  logic                            tile_done;
  // The controller never starts a tile before tile_done, so it does not need the array's busy.
  /* verilator lint_off UNUSEDSIGNAL */
  logic                            array_busy;
  /* verilator lint_on UNUSEDSIGNAL */
  logic                            c_we;
  logic [ADDR_W-1:0]               c_addr;
  logic [ACC_W-1:0]                c_wdata;

  matmul_controller #(
    .ROWS   (ROWS),
    .COLS   (COLS),
    .DATA_W (DATA_W),
    .ACC_W  (ACC_W),
    .MAX_DIM(MAX_DIM)
  ) u_controller (
    .clk,
    .rst,
    .cfg_m,
    .cfg_n,
    .cfg_k,
    .start,
    .busy,
    .done,
    .error,
    .error_code,
    .a_rd_addr,
    .a_rd_data,
    .b_rd_addr,
    .b_rd_data,
    .tile_start,
    .tile_k,
    .a_valid,
    .a_data,
    .b_valid,
    .b_data,
    .c,
    .tile_done,
    .c_we,
    .c_addr,
    .c_wdata,
    .cycles_compute,
    .cycles_store,
    .state (dbg_state),
    .tile_i(dbg_tile_i),
    .tile_j(dbg_tile_j),
    .k_idx (dbg_k)
  );

  // A is banked by row (bank = i mod ROWS, the address bits above the column), B by column
  // (bank = j mod COLS, the lowest address bits).
  input_buffer #(
    .BANKS   (ROWS),
    .BANK_LSB(LOG_DIM),
    .DEPTH   (DEPTH),
    .DATA_W  (DATA_W)
  ) u_a_buffer (
    .clk,
    .we     (host_a_we && !busy),
    .wr_addr(host_a_addr),
    .wdata  (host_a_wdata),
    .rd_addr(a_rd_addr),
    .rd_data(a_rd_data)
  );

  input_buffer #(
    .BANKS   (COLS),
    .BANK_LSB(0),
    .DEPTH   (DEPTH),
    .DATA_W  (DATA_W)
  ) u_b_buffer (
    .clk,
    .we     (host_b_we && !busy),
    .wr_addr(host_b_addr),
    .wdata  (host_b_wdata),
    .rd_addr(b_rd_addr),
    .rd_data(b_rd_data)
  );

  systolic_array #(
    .ROWS  (ROWS),
    .COLS  (COLS),
    .DATA_W(DATA_W),
    .ACC_W (ACC_W)
  ) u_array (
    .clk,
    .rst,
    .tile_start,
    .tile_k,
    .a_valid,
    .a_data,
    .b_valid,
    .b_data,
    .c,
    .tile_done,
    .busy(array_busy)
  );

  output_buffer #(
    .DEPTH(DEPTH),
    .ACC_W(ACC_W)
  ) u_c_buffer (
    .clk,
    .we     (c_we),
    .wr_addr(c_addr),
    .wdata  (c_wdata),
    .rd_addr(host_c_addr),
    .rd_data(host_c_rdata)
  );
endmodule
