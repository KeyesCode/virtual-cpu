// The ROWS × COLS output-stationary systolic array of processing elements (revision
// matmul-os-r1), one RTL for every size.
//
// docs/hardware/accelerators/systolic-array.md documents the dataflow, the skew and the
// completion timing clock by clock; docs/hardware/accelerators/architecture.md is the contract.
//
//   - The caller presents the tile's operands UNSKEWED: in operand clock k (k = 0 … K−1, the K
//     clocks right after tile_start, with no gaps) a_data[i] = A[i, k] for every row and
//     b_data[j] = B[k, j] for every column, with their valid bits high; outside them the valid
//     bits are low. The array skews them itself: row i passes through i delay registers before
//     PE(i, 0), and column j through j delay registers before PE(0, j).
//   - A moves right one PE per clock and B moves down one PE per clock (each PE registers and
//     forwards its operands), so PE(i, j) multiplies A[i, k] by B[k, j] in operand clock
//     k + i + j. A PE accumulates only when both arriving valid bits are high.
//   - tile_start (ignored while busy) clears every accumulator at the end of its clock and loads
//     the completion counter. tile_done pulses K + ROWS + COLS − 1 clocks after tile_start, the
//     first clock in which every accumulator holds its final sum: operand clock
//     K + ROWS + COLS − 2, one clock after the far corner's last MAC. busy is high from the clock
//     after an accepted tile_start until the clock before tile_done; it is low in the tile_done
//     clock, so the next tile_start may come in that clock or any later one.
//   - c holds every accumulator, PE(i, j) at index i * COLS + j. The results stay valid from the
//     tile_done clock until the end of the clock of the next accepted tile_start.
//
// There is no back-pressure: the array is a no-stall pipeline, and the caller never inserts idle
// clocks into the K operand clocks (the completion counter counts clocks, not operands).
//
// The ports are packed vectors, not unpacked arrays, because Yosys' read_verilog -sv rejects
// unpacked array ports; element i of a_data is row i's operand, element j of b_data column j's,
// each a signed INT8 in two's complement.
module systolic_array #(
  parameter int ROWS   = 4,
  parameter int COLS   = 4,
  parameter int DATA_W = matmul_pkg::DATA_W,
  parameter int ACC_W  = matmul_pkg::ACC_W
) (
  input  logic                                clk,
  input  logic                                rst,
  input  logic                                tile_start,
  input  logic [matmul_pkg::CFG_W-1:0]        tile_k,
  input  logic [ROWS-1:0]                     a_valid,
  input  logic [ROWS-1:0][DATA_W-1:0]         a_data,
  input  logic [COLS-1:0]                     b_valid,
  input  logic [COLS-1:0][DATA_W-1:0]         b_data,
  output logic [ROWS*COLS-1:0][ACC_W-1:0]     c,
  output logic                                tile_done,
  output logic                                busy
);
  localparam int CFG_W = matmul_pkg::CFG_W;
  // Wide enough for tile_k + ROWS + COLS − 2 with any 16-bit tile_k and sides up to MAX_DIM.
  localparam int CNT_W = CFG_W + 1;

  // The operands and valid bits at each PE's inputs: a_h[i][j] / a_hv[i][j] enter PE(i, j) from
  // the left and b_v[i][j] / b_vv[i][j] from above. Index COLS of a_h (and ROWS of b_v) is what
  // leaves the right (bottom) edge, which nothing reads.
  /* verilator lint_off UNUSEDSIGNAL */
  logic [ROWS-1:0][COLS:0][DATA_W-1:0] a_h;
  logic [ROWS-1:0][COLS:0]             a_hv;
  logic [ROWS:0][COLS-1:0][DATA_W-1:0] b_v;
  logic [ROWS:0][COLS-1:0]             b_vv;
  /* verilator lint_on UNUSEDSIGNAL */

  // Accepting a tile clears every accumulator in the same clock.
  logic clear;
  assign clear = tile_start && !busy;

  // Input skew: row i is delayed by i registers, column j by j registers, so that A[i, k] and
  // B[k, j] presented together in operand clock k meet at PE(i, j) in operand clock k + i + j.
  for (genvar i = 0; i < ROWS; i++) begin : g_a_skew
    if (i == 0) begin : g_direct
      assign a_h[i][0]  = a_data[i];
      assign a_hv[i][0] = a_valid[i];
    end else begin : g_delay
      // Stage s holds the operand presented s + 1 clocks ago (flat, not packed 2-D, which
      // Yosys cannot size inside a generate block).
      logic [i*DATA_W-1:0] data_q;
      logic [i-1:0]        valid_q;
      always_ff @(posedge clk) begin
        data_q[0 +: DATA_W] <= a_data[i];
        for (int s = 1; s < i; s++) begin
          data_q[s*DATA_W +: DATA_W] <= data_q[(s-1)*DATA_W +: DATA_W];
        end
        if (rst) begin
          valid_q <= '0;
        end else begin
          valid_q[0] <= a_valid[i];
          for (int s = 1; s < i; s++) begin
            valid_q[s] <= valid_q[s-1];
          end
        end
      end
      assign a_h[i][0]  = data_q[(i-1)*DATA_W +: DATA_W];
      assign a_hv[i][0] = valid_q[i-1];
    end
  end

  for (genvar j = 0; j < COLS; j++) begin : g_b_skew
    if (j == 0) begin : g_direct
      assign b_v[0][j]  = b_data[j];
      assign b_vv[0][j] = b_valid[j];
    end else begin : g_delay
      // Stage s holds the operand presented s + 1 clocks ago (flat, not packed 2-D, which
      // Yosys cannot size inside a generate block).
      logic [j*DATA_W-1:0] data_q;
      logic [j-1:0]        valid_q;
      always_ff @(posedge clk) begin
        data_q[0 +: DATA_W] <= b_data[j];
        for (int s = 1; s < j; s++) begin
          data_q[s*DATA_W +: DATA_W] <= data_q[(s-1)*DATA_W +: DATA_W];
        end
        if (rst) begin
          valid_q <= '0;
        end else begin
          valid_q[0] <= b_valid[j];
          for (int s = 1; s < j; s++) begin
            valid_q[s] <= valid_q[s-1];
          end
        end
      end
      assign b_v[0][j]  = data_q[(j-1)*DATA_W +: DATA_W];
      assign b_vv[0][j] = valid_q[j-1];
    end
  end

  // The PE grid: PE(i, j) passes A to PE(i, j + 1) and B to PE(i + 1, j).
  for (genvar i = 0; i < ROWS; i++) begin : g_row
    for (genvar j = 0; j < COLS; j++) begin : g_col
      processing_element #(
        .DATA_W(DATA_W),
        .ACC_W (ACC_W)
      ) u_pe (
        .clk        (clk),
        .rst        (rst),
        .clear      (clear),
        .a_in       (a_h[i][j]),
        .a_valid_in (a_hv[i][j]),
        .b_in       (b_v[i][j]),
        .b_valid_in (b_vv[i][j]),
        .a_out      (a_h[i][j+1]),
        .a_valid_out(a_hv[i][j+1]),
        .b_out      (b_v[i+1][j]),
        .b_valid_out(b_vv[i+1][j]),
        .acc        (c[i*COLS+j])
      );
    end
  end

  // Completion: tile_start loads tile_k + ROWS + COLS − 2, the counter counts down one per clock,
  // and tile_done is the clock it is zero, K + ROWS + COLS − 1 clocks after tile_start.
  logic             running;
  logic [CNT_W-1:0] remaining;

  assign tile_done = running && (remaining == '0);
  assign busy      = running && (remaining != '0);

  always_ff @(posedge clk) begin
    if (rst) begin
      running   <= 1'b0;
      remaining <= '0;
    end else if (clear) begin
      running   <= 1'b1;
      remaining <= CNT_W'(tile_k) + CNT_W'(ROWS + COLS - 2);
    end else if (tile_done) begin
      running <= 1'b0;
    end else if (running) begin
      remaining <= remaining - 1'b1;
    end
  end
endmodule
