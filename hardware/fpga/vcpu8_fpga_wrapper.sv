// VCPU-8 FPGA wrapper: vcpu8_top with a pin-legal handful of ports, for the synthesis and
// place-and-route flows (docs/hardware/synthesis-guide.md). It is not a board design; bring-up
// and programming are Project 5.
//
// vcpu8_top has 214 port bits, far more than any small FPGA package has pins, and every one of
// them is an observation port. The wrapper keeps clk and rst and brings out eight status bits,
// enough for LEDs or a logic analyser:
//   - status: READY, HALTED or FAULTED (vcpu8_isa_pkg::STATUS_*);
//   - retire: the one-cycle pulse after each instruction;
//   - pc_lo:  PC[3:0].
// Because these depend on the PC, the FSM, the branch flags and so on back through the ALU, the
// register file and the RAM, synthesis cannot remove the CPU. It does remove the logic that only
// the unconnected debug taps use (instret, retire_pc/op, fault_code/pc and the dbg_* buses); the
// synthesis guide compares the wrapper's counts with the generic vcpu8_top's.
//
// INIT_FILE becomes the RAM's power-on contents, so the program is built into the configuration.
// The synthesis flow sets it to an absolute path (mk/synth.mk); a relative path would be resolved
// from the tool's working directory. rst comes from a pin, so it is passed through a two-flop
// synchronizer before it reaches the core's synchronous reset.
//
// DIV_ITER is passed to vcpu8_top (0: combinational divider, 1: iterative); the synthesis flow
// sets it with chparam for `make synth DIV_IMPL=ITER` and experiment variants.
module vcpu8_fpga_wrapper #(
  parameter     INIT_FILE = "",
  parameter int DIV_ITER  = 0
) (
  input  logic       clk,
  input  logic       rst,      // active-high, asynchronous to clk
  output logic [2:0] status,
  output logic       retire,
  output logic [3:0] pc_lo
);
  // The initial value is the FPGA's power-on value: the core starts held in reset.
  /* verilator lint_off PROCASSINIT */
  logic [1:0] rst_sync = 2'b11;
  /* verilator lint_on PROCASSINIT */
  always_ff @(posedge clk) rst_sync <= {rst_sync[0], rst};

  logic [7:0] dbg_pc;

  // The debug taps are left unconnected on purpose, so synthesis removes the logic only they use.
  /* verilator lint_off PINCONNECTEMPTY */
  vcpu8_top #(
    .INIT_FILE (INIT_FILE),
    .DIV_ITER  (DIV_ITER)
  ) u_cpu (
    .clk        (clk),
    .rst        (rst_sync[1]),
    .status     (status),
    .fault_code (),
    .fault_pc   (),
    .retire     (retire),
    .retire_pc  (),
    .retire_op  (),
    .instret    (),
    .dbg_regs   (),
    .dbg_pc     (dbg_pc),
    .dbg_sp     (),
    .dbg_sd     (),
    .dbg_flags  (),
    .dbg_state  (),
    .dbg_ir_op  (),
    .dbg_ir_rb  (),
    .dbg_ir_tb  (),
    .dbg_ir_len (),
    .mem_addr   (),
    .mem_we     (),
    .mem_wdata  (),
    .mem_rdata  ()
  );
  /* verilator lint_on PINCONNECTEMPTY */

  assign pc_lo = dbg_pc[3:0];

  logic unused_pc;
  assign unused_pc = &{1'b0, dbg_pc[7:4]};
endmodule
