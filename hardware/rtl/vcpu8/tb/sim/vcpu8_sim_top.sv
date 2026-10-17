// Simulation wrapper for the RTL runner (vcpu8_sim.cpp): vcpu8_top plus two DPI functions that
// reach the RAM array hierarchically, so the runner can load an image before it releases reset
// and dump the memory at the end. Simulation only; nothing here is synthesized.
//
// `cycle` counts the rising edges since reset was released, exactly as the runner counts cycles:
// it reads N during the clock cycle that follows edge N. Waveforms show it so that a cycle number
// in the runner's trace (its `cycle` field) can be found on the time axis.
//
// DIV_ITER is passed to vcpu8_top: `make … DIV_IMPL=ITER` and experiment variants set it with -G.
module vcpu8_sim_top #(
  parameter int DIV_ITER = 0
) (
  input  logic        clk,
  input  logic        rst,
  output logic [31:0] cycle,

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
  vcpu8_top #(.DIV_ITER(DIV_ITER)) u_top (.*);

  always_ff @(posedge clk) begin
    if (rst) cycle <= 32'd0;
    else     cycle <= cycle + 32'd1;
  end

  export "DPI-C" function vcpu8_mem_write;
  export "DPI-C" function vcpu8_mem_read;

  function void vcpu8_mem_write(input int address, input byte value);
    u_top.u_mem.mem[address[7:0]] = value;
  endfunction

  function byte vcpu8_mem_read(input int address);
    return u_top.u_mem.mem[address[7:0]];
  endfunction
endmodule
