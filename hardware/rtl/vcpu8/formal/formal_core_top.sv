// Formal harness for vcpu8_core: the core with its RAM read data left unconstrained.
//
// mem_rdata is an anyseq value, a fresh arbitrary byte every cycle, in place of vcpu8_memory. The
// core therefore sees every possible program and every possible data read, and a property proven
// here holds for any memory contents. vcpu8_core_props (instantiated in vcpu8_core) assumes rst in the
// first cycle; after that rst is a free input, so a reset may come at any time.
module formal_core_top (
  input logic clk,
  input logic rst
);
  (* anyseq *) logic [7:0] mem_rdata;

  // Every output is left open: the properties read them inside the core (vcpu8_core_props).
  vcpu8_core u_core (
    .clk        (clk),
    .rst        (rst),
    .mem_addr   (),
    .mem_we     (),
    .mem_wdata  (),
    .mem_rdata  (mem_rdata),
    .status     (),
    .fault_code (),
    .fault_pc   (),
    .retire     (),
    .retire_pc  (),
    .retire_op  (),
    .instret    (),
    .dbg_regs   (),
    .dbg_pc     (),
    .dbg_sp     (),
    .dbg_sd     (),
    .dbg_flags  (),
    .dbg_state  (),
    .dbg_ir_op  (),
    .dbg_ir_rb  (),
    .dbg_ir_tb  (),
    .dbg_ir_len ()
  );
endmodule
