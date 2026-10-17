// VCPU-8 top level: the core plus its 256-byte RAM, on one clock and one synchronous active-high
// reset. Reset clears the core's state but not the RAM (docs/hardware-porting.md#reset).
//
// INIT_FILE is passed to vcpu8_memory: a $readmemh image (256 lines, one byte each) that becomes
// the RAM's power-on contents in simulation and on an FPGA. A testbench can instead load
// u_mem.mem hierarchically before it releases reset, as the RTL runner does.
//
// Every output except clk/rst is for observation: status and fault, the retirement pulse and the
// debug taps (see vcpu8_core), and the memory bus. An FPGA build can leave them unconnected.
module vcpu8_top #(
  parameter INIT_FILE = ""
) (
  input  logic        clk,
  input  logic        rst,

  output logic [2:0]  status,
  output logic [2:0]  fault_code,
  output logic [7:0]  fault_pc,

  output logic        retire,
  output logic [7:0]  retire_pc,
  output logic [7:0]  retire_op,
  output logic [31:0] instret,
  output logic [63:0] dbg_regs,
  output logic [7:0]  dbg_pc,
  output logic [7:0]  dbg_sp,
  output logic [6:0]  dbg_sd,
  output logic [7:0]  dbg_flags,
  output logic [2:0]  dbg_state,
  output logic [7:0]  dbg_ir_op,
  output logic [7:0]  dbg_ir_rb,
  output logic [7:0]  dbg_ir_tb,
  output logic [1:0]  dbg_ir_len,

  output logic [7:0]  mem_addr,
  output logic        mem_we,
  output logic [7:0]  mem_wdata,
  output logic [7:0]  mem_rdata
);
  vcpu8_core u_core (
    .clk        (clk),
    .rst        (rst),
    .mem_addr   (mem_addr),
    .mem_we     (mem_we),
    .mem_wdata  (mem_wdata),
    .mem_rdata  (mem_rdata),
    .status     (status),
    .fault_code (fault_code),
    .fault_pc   (fault_pc),
    .retire     (retire),
    .retire_pc  (retire_pc),
    .retire_op  (retire_op),
    .instret    (instret),
    .dbg_regs   (dbg_regs),
    .dbg_pc     (dbg_pc),
    .dbg_sp     (dbg_sp),
    .dbg_sd     (dbg_sd),
    .dbg_flags  (dbg_flags),
    .dbg_state  (dbg_state),
    .dbg_ir_op  (dbg_ir_op),
    .dbg_ir_rb  (dbg_ir_rb),
    .dbg_ir_tb  (dbg_ir_tb),
    .dbg_ir_len (dbg_ir_len)
  );

  vcpu8_memory #(
    .INIT_FILE (INIT_FILE)
  ) u_mem (
    .clk   (clk),
    .addr  (mem_addr),
    .we    (mem_we),
    .wdata (mem_wdata),
    .rdata (mem_rdata)
  );
endmodule
