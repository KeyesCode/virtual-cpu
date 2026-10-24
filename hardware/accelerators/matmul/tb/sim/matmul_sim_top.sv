// Simulation wrapper for the Verilator matmul runner (matmul_sim.cpp): matmul_top at ROWS × COLS
// (set with -GROWS -GCOLS), its ports unchanged, plus three constant outputs that tell the runner
// which array it was built for, so the C++ never hardcodes a size. The runner drives every port
// directly through the Verilated model; there is no DPI. Simulation only; nothing here is
// synthesized.
module matmul_sim_top #(
  parameter int ROWS = 4,
  parameter int COLS = 4
) (
  input  logic                                           clk,
  input  logic                                           rst,
  input  logic [matmul_pkg::CFG_W-1:0]                   cfg_m,
  input  logic [matmul_pkg::CFG_W-1:0]                   cfg_n,
  input  logic [matmul_pkg::CFG_W-1:0]                   cfg_k,
  input  logic                                           start,
  output logic                                           busy,
  output logic                                           done,
  output logic                                           error,
  output matmul_pkg::error_code_t                        error_code,
  input  logic                                           host_a_we,
  input  logic [matmul_pkg::ADDR_W-1:0]                  host_a_addr,
  input  logic signed [matmul_pkg::DATA_W-1:0]           host_a_wdata,
  input  logic                                           host_b_we,
  input  logic [matmul_pkg::ADDR_W-1:0]                  host_b_addr,
  input  logic signed [matmul_pkg::DATA_W-1:0]           host_b_wdata,
  input  logic [matmul_pkg::ADDR_W-1:0]                  host_c_addr,
  output logic signed [matmul_pkg::ACC_W-1:0]            host_c_rdata,
  output logic [31:0]                                    cycles_compute,
  output logic [31:0]                                    cycles_store,
  output matmul_pkg::ctrl_state_t                        dbg_state,
  output logic [$clog2(matmul_pkg::MAX_DIM)-1:0]         dbg_tile_i,
  output logic [$clog2(matmul_pkg::MAX_DIM)-1:0]         dbg_tile_j,
  output logic [$clog2(matmul_pkg::MAX_DIM)-1:0]         dbg_k,
  // The build's parameters, for `matmul_sim --info` and the cycles JSON.
  output logic [15:0]                                    array_rows,
  output logic [15:0]                                    array_cols,
  output logic [15:0]                                    max_dim
);
  matmul_top #(.ROWS(ROWS), .COLS(COLS)) u_top (
    .clk, .rst, .cfg_m, .cfg_n, .cfg_k, .start, .busy, .done, .error, .error_code,
    .host_a_we, .host_a_addr, .host_a_wdata, .host_b_we, .host_b_addr, .host_b_wdata,
    .host_c_addr, .host_c_rdata, .cycles_compute, .cycles_store,
    .dbg_state, .dbg_tile_i, .dbg_tile_j, .dbg_k
  );

  assign array_rows = 16'(ROWS);
  assign array_cols = 16'(COLS);
  assign max_dim    = 16'(matmul_pkg::MAX_DIM);
endmodule
