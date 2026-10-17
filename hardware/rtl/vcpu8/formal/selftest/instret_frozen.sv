// Formal self-test: a property that is deliberately FALSE, so that `make formal-selftest` can
// show the formal setup finds counterexamples. If this ever passed, the harness would be vacuous
// (for example, an assumption that rules out every run), and so would every PASS of `make formal`.
//
// The claim "instret never changes after reset" fails as soon as the first instruction retires:
// the anyseq RAM can supply a NOP at address 0. The harness is the one formal_core_top.sv uses,
// and vcpu8_core still carries the real properties (vcpu8_core_props), which must not fail first.
module selftest_instret_frozen (
  input logic clk,
  input logic rst
);
  (* anyseq *) logic [7:0] mem_rdata;
  logic [31:0] instret;

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
    .instret    (instret),
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

  // vcpu8_core_props assumes rst in the first cycle; this only waits for it to take effect.
  logic f_live = 1'b0;
  always @(posedge clk) f_live <= 1'b1;

  always @(posedge clk) begin
    if (f_live && !$past(rst)) selftest_instret_frozen: assert ($stable(instret));
  end
endmodule
