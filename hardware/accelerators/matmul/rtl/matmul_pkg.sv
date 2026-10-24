// Shared constants and types of the INT8 matmul accelerator (revision matmul-os-r1).
//
// docs/hardware/accelerators/architecture.md is the contract these encode: signed INT8 operands,
// signed INT32 accumulators with two's-complement wrap-around, M, N and K in 1 … MAX_DIM, and the
// controller's states and error codes. Modules take ROWS and COLS as their own parameters; the
// widths below are their defaults.
package matmul_pkg;

  // A constants package: each module imports only the names it needs, so most are unused in
  // any one compilation unit.
  /* verilator lint_off UNUSEDPARAM */

  // Operand width: signed INT8.
  localparam int DATA_W = 8;
  // Product width: an INT8 × INT8 product always fits in signed INT16.
  localparam int PROD_W = 2 * DATA_W;
  // Accumulator width: signed INT32, wrapping on overflow.
  localparam int ACC_W = 32;
  // The largest M, N or K accepted; buffer depths derive from it.
  localparam int MAX_DIM = 64;
  // Width of the cfg_m, cfg_n and cfg_k ports.
  localparam int CFG_W = 16;
  // Width of the host and buffer addresses: every matrix is row-major with a row stride of
  // MAX_DIM, so an element (r, c) is at r * MAX_DIM + c.
  localparam int ADDR_W = $clog2(MAX_DIM * MAX_DIM);

  /* verilator lint_on UNUSEDPARAM */

  // error_code, valid while error is high; cleared by the next start.
  typedef enum logic [1:0] {
    ERR_NONE          = 2'd0,
    ERR_DIM_ZERO      = 2'd1,  // M, N or K is 0
    ERR_DIM_TOO_LARGE = 2'd2   // M, N or K is above MAX_DIM
  } error_code_t;

  // matmul_controller states.
  typedef enum logic [3:0] {
    IDLE         = 4'd0,  // waiting for start
    LOAD         = 4'd1,  // configuration sampled and checked
    PREPARE_TILE = 4'd2,  // clear the accumulators, point at the next output tile
    COMPUTE      = 4'd3,  // stream K skewed operands into the array
    DRAIN        = 4'd4,  // wait for the last products to reach the far corner
    STORE        = 4'd5,  // write the tile's unmasked results to output_buffer
    NEXT_TILE    = 4'd6,  // advance in row-major tile order, or finish
    DONE         = 4'd7,  // one-clock done pulse
    ERROR        = 4'd8   // invalid configuration; error and error_code held
  } ctrl_state_t;

endpackage
