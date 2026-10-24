// INT8 matmul accelerator FPGA wrapper: matmul_top with a pin-legal handful of ports, for the
// synthesis and place-and-route flows (docs/hardware/accelerators/synthesis-guide.md). It is not a
// board design: no board has been brought up with it, and it has no UART, no flow control and no
// clock other than the pin.
//
// matmul_top has well over 200 port bits (the three 12-bit host addresses, the 32-bit read data
// and cycle counters, the debug taps), far more than a small FPGA package has pins. The wrapper
// keeps clk and rst and replaces the host port with a narrow command port, so every buffer, the
// controller and the whole array stay live:
//   - data_in[7:0], cmd[2:0] and strobe: each rising edge of strobe runs cmd with data_in;
//   - data_out[7:0]: one byte of host_c_rdata, the C element at the address register;
//   - led_busy, led_done, led_error: busy, a done that stays lit until the next start, and error.
// Only the cycle counters, error_code and the debug taps are left unconnected, so synthesis removes the logic
// that only they use (the guide compares the counts with the generic matmul_top's).
//
// Commands (CMD_*): the 12-bit address register is written a byte at a time (ADDR_LO, ADDR_HI);
// WRITE_A and WRITE_B write data_in to A or B at the address and then increment it, so a matrix
// streams in one byte per strobe; SET_M, SET_N and SET_K load a dimension (data_in, 0 … 255, so
// the controller's range checks stay reachable); CTRL selects the byte of C shown on data_out
// (data_in[1:0]) and, with data_in[7], pulses start.
//
// rst, strobe, cmd and data_in come from pins, asynchronous to clk. rst passes through a two-flop
// synchronizer before it reaches the synchronous reset; strobe passes through another, and the
// command is taken on its synchronized rising edge, by which time cmd and data_in have been
// steady for two clocks (the host's side of the contract: hold them while strobe is high).
module matmul_fpga_wrapper #(
  parameter int ROWS = 4,
  parameter int COLS = 4
) (
  input  logic       clk,
  input  logic       rst,       // active-high, asynchronous to clk
  input  logic       strobe,    // rising edge runs cmd
  input  logic [2:0] cmd,
  input  logic [7:0] data_in,
  output logic [7:0] data_out,
  output logic       led_busy,
  output logic       led_done,
  output logic       led_error
);
  localparam int ADDR_W = matmul_pkg::ADDR_W;
  localparam int CFG_W  = matmul_pkg::CFG_W;
  localparam int ACC_W  = matmul_pkg::ACC_W;

  localparam logic [2:0] CMD_ADDR_LO = 3'd0;
  localparam logic [2:0] CMD_ADDR_HI = 3'd1;
  localparam logic [2:0] CMD_WRITE_A = 3'd2;
  localparam logic [2:0] CMD_WRITE_B = 3'd3;
  localparam logic [2:0] CMD_SET_M   = 3'd4;
  localparam logic [2:0] CMD_SET_N   = 3'd5;
  localparam logic [2:0] CMD_SET_K   = 3'd6;
  localparam logic [2:0] CMD_CTRL    = 3'd7;

  // The initial values are the FPGA's power-on values: the accelerator starts held in reset.
  /* verilator lint_off PROCASSINIT */
  logic [1:0] rst_sync = 2'b11;
  /* verilator lint_on PROCASSINIT */
  always_ff @(posedge clk) rst_sync <= {rst_sync[0], rst};
  logic rst_q;
  assign rst_q = rst_sync[1];

  // strobe synchronizer and rising-edge detector.
  logic [2:0] strobe_sync;
  logic       run;
  always_ff @(posedge clk) begin
    if (rst_q) strobe_sync <= '0;
    else       strobe_sync <= {strobe_sync[1:0], strobe};
  end
  assign run = strobe_sync[1] && !strobe_sync[2];

  logic [ADDR_W-1:0] addr;
  logic [CFG_W-1:0]  cfg_m, cfg_n, cfg_k;
  logic [1:0]        byte_sel;
  logic              start;
  logic              host_a_we, host_b_we;
  logic              busy, done, error;
  logic              done_seen;

  always_ff @(posedge clk) begin
    if (rst_q) begin
      addr     <= '0;
      cfg_m    <= '0;
      cfg_n    <= '0;
      cfg_k    <= '0;
      byte_sel <= '0;
    end else if (run) begin
      case (cmd)
        CMD_ADDR_LO: addr[7:0] <= data_in;
        CMD_ADDR_HI: addr[ADDR_W-1:8] <= data_in[ADDR_W-9:0];
        CMD_WRITE_A, CMD_WRITE_B: addr <= addr + 1'b1;
        CMD_SET_M:   cfg_m <= CFG_W'(data_in);
        CMD_SET_N:   cfg_n <= CFG_W'(data_in);
        CMD_SET_K:   cfg_k <= CFG_W'(data_in);
        CMD_CTRL:    byte_sel <= data_in[1:0];
        default:     ;
      endcase
    end
  end

  // The writes and the start pulse are combinational from run, so they see the address and the
  // dimensions before this command's update.
  assign host_a_we = run && cmd == CMD_WRITE_A;
  assign host_b_we = run && cmd == CMD_WRITE_B;
  assign start     = run && cmd == CMD_CTRL && data_in[7];

  always_ff @(posedge clk) begin
    if (rst_q || start) done_seen <= 1'b0;
    else if (done)      done_seen <= 1'b1;
  end

  logic signed [ACC_W-1:0] host_c_rdata;

  // The cycle counters, the error code and the debug taps are left unconnected on purpose, so
  // synthesis removes the logic only they use.
  /* verilator lint_off PINCONNECTEMPTY */
  matmul_top #(
    .ROWS(ROWS),
    .COLS(COLS)
  ) u_matmul (
    .clk,
    .rst           (rst_q),
    .cfg_m,
    .cfg_n,
    .cfg_k,
    .start,
    .busy,
    .done,
    .error,
    .error_code    (),
    .host_a_we,
    .host_a_addr   (addr),
    .host_a_wdata  (data_in),
    .host_b_we,
    .host_b_addr   (addr),
    .host_b_wdata  (data_in),
    .host_c_addr   (addr),
    .host_c_rdata,
    .cycles_compute(),
    .cycles_store  (),
    .dbg_state     (),
    .dbg_tile_i    (),
    .dbg_tile_j    (),
    .dbg_k         ()
  );
  /* verilator lint_on PINCONNECTEMPTY */

  assign data_out  = host_c_rdata[8*byte_sel +: 8];
  assign led_busy  = busy;
  assign led_done  = done_seen;
  assign led_error = error;
endmodule
