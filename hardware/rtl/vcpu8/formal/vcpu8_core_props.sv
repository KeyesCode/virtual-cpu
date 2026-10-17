// Formal properties of vcpu8_core. vcpu8_core instantiates this module inside `ifdef FORMAL, so
// the properties read its internal nets (the FSM state, the write enables, PC, SP, SD, FLAGS).
// That instance stands in for a `bind`, which the pinned Yosys does not parse; only the formal
// flow defines FORMAL, so lint, simulation and synthesis never see it.
//
// The harness is formal_core_top.sv: RAM read data is anyseq, so every property holds for any
// program and any memory contents. The one assumption is rst in the first cycle. Clocked
// properties compare a cycle with the one before it and skip a cycle that follows a reset
// (f_run); invariants are checked in every cycle after the first (f_live).
//
// Properties are grouped as in docs/hardware/formal-verification.md, which gives each one's
// statement, scope and proof. A label names each assertion in a counterexample report. Helper
// invariants (labelled h_*) are true statements about reachable states that k-induction needs:
// they are proven like every other assertion, so they add no assumption.
//
// DIV_ITER is the core's: with the iterative divider, DIV stays in EXECUTE until div_done, so
// fsm_t_execute allows EXECUTE → EXECUTE exactly then, and div_wait_bounded limits the wait.
module vcpu8_core_props #(
  parameter int DIV_ITER = 0
) (
  input logic        clk,
  input logic        rst,
  input logic [2:0]  state,
  input logic        rf_we,
  input logic        mem_we,
  input logic [3:0]  flags_mask,
  input logic [2:0]  bus_addr_sel,
  input logic [7:0]  mem_addr,
  input logic [7:0]  pc,
  input logic [7:0]  sp,
  input logic [6:0]  sd,
  input logic [1:0]  ir_len,
  input logic [1:0]  dec_len,
  input logic        dec_valid,
  input logic [1:0]  dec_stack_op,
  input logic        dec_is_div,
  input logic        div_busy,
  input logic        div_done,
  input logic [3:0]  flags,
  input logic [63:0] dbg_regs,
  input logic [2:0]  status,
  input logic [2:0]  fault_code,
  input logic [7:0]  fault_pc,
  input logic        retire,
  input logic [31:0] instret
);
  localparam logic [2:0] FETCH     = vcpu8_types_pkg::FSM_FETCH;
  localparam logic [2:0] DECODE    = vcpu8_types_pkg::FSM_DECODE;
  localparam logic [2:0] OPERAND1  = vcpu8_types_pkg::FSM_OPERAND1;
  localparam logic [2:0] OPERAND2  = vcpu8_types_pkg::FSM_OPERAND2;
  localparam logic [2:0] EXECUTE   = vcpu8_types_pkg::FSM_EXECUTE;
  localparam logic [2:0] WRITEBACK = vcpu8_types_pkg::FSM_WRITEBACK;
  localparam logic [2:0] HALTED    = vcpu8_types_pkg::FSM_HALTED;
  localparam logic [2:0] FAULTED   = vcpu8_types_pkg::FSM_FAULTED;

  // ---- Reset assumption and cycle qualifiers -----------------------------------------------

  // f_live: at least one clock edge has passed, and the first cycle held rst, so every register
  // has been reset. f_run: also, the previous cycle was not a reset cycle.
  logic f_live = 1'b0;
  always @(posedge clk) f_live <= 1'b1;

  always @(*) if (!f_live) assume_reset: assume (rst);

  logic f_run;
  logic f_past_rst;
  always @(posedge clk) f_past_rst <= rst;
  assign f_run = f_live && !f_past_rst;

  logic running, stopped, fetching;
  assign running  = state == FETCH || state == DECODE || state == OPERAND1
                 || state == OPERAND2 || state == EXECUTE || state == WRITEBACK;
  assign stopped  = state == HALTED || state == FAULTED;
  assign fetching = state == FETCH || state == DECODE || state == OPERAND1 || state == OPERAND2;

  logic is_push, is_pop;
  assign is_push = dec_stack_op == vcpu8_types_pkg::STACK_PUSH;
  assign is_pop  = dec_stack_op == vcpu8_types_pkg::STACK_POP;

  // ---- 1. Deterministic reset ---------------------------------------------------------------

  // One cycle after rst, whatever came before: every architectural register holds its reset
  // value, the FSM is in FETCH and the status is READY.
  always @(posedge clk) begin
    if (f_live && $past(rst)) begin
      reset_state:   assert (state == FETCH);
      reset_status:  assert (status == vcpu8_isa_pkg::STATUS_READY
                             && fault_code == vcpu8_isa_pkg::FAULT_NONE);
      reset_pc:      assert (pc == vcpu8_isa_pkg::RESET_PC);
      reset_sp_sd:   assert (sp == vcpu8_isa_pkg::RESET_SP && sd == vcpu8_isa_pkg::RESET_SD);
      reset_flags:   assert (flags == vcpu8_isa_pkg::RESET_FLAGS);
      reset_regs:    assert (dbg_regs == {8{vcpu8_isa_pkg::RESET_REG}});
      reset_retire:  assert (!retire && instret == 32'd0);
    end
  end

  // ---- 2. Legal FSM -------------------------------------------------------------------------

  // fsm_t_*: every transition is in the allowed set. With 3 bits and 8 states every encoding is
  // a state, so fsm_legal is the check that it stays so if the encoding ever grows.
  always @(*) if (f_live) fsm_legal: assert (running || stopped);

  always @(posedge clk) begin
    if (f_run) begin
      case ($past(state))
        FETCH:     fsm_t_fetch:     assert (state == DECODE);
        DECODE:    fsm_t_decode:    assert (state == OPERAND1 || state == EXECUTE
                                            || state == FAULTED);
        OPERAND1:  fsm_t_operand1:  assert (state == OPERAND2 || state == EXECUTE
                                            || state == FAULTED);
        OPERAND2:  fsm_t_operand2:  assert (state == EXECUTE || state == FAULTED);
        // EXECUTE repeats only for a DIV still waiting for the iterative divider; with the
        // combinational one div_done is tied high, so EXECUTE always lasts one cycle.
        EXECUTE:   fsm_t_execute:   assert (state == WRITEBACK || state == FAULTED
                                            || (state == EXECUTE && $past(dec_is_div && !div_done)));
        WRITEBACK: fsm_t_writeback: assert (state == FETCH || state == HALTED || state == FAULTED);
        HALTED:    fsm_t_halted:    assert (state == HALTED);
        FAULTED:   fsm_t_faulted:   assert (state == FAULTED);
        default:   fsm_t_other:     assert (1'b0);
      endcase
    end
  end

  // The DIV wait is bounded: the first EXECUTE cycle starts the divider and done comes 8 cycles
  // later, so EXECUTE lasts at most 9 consecutive cycles (1 without the iterative divider).
  // f_exec counts the EXECUTE cycles before this one, saturating so a violation stays visible.
  localparam logic [3:0] EXEC_MAX = (DIV_ITER != 0) ? 4'd8 : 4'd0;
  logic [3:0] f_exec;
  always @(posedge clk) begin
    if (rst || state != EXECUTE) f_exec <= 4'd0;
    else if (f_exec != 4'hF)     f_exec <= f_exec + 4'd1;
  end
  always @(*) begin
    if (f_run) begin
      div_wait_bounded: assert (state != EXECUTE || f_exec <= EXEC_MAX);
      // The divider is busy, or reports done, only during a DIV's EXECUTE. So a DIV that faults in
      // EXECUTE (divide by zero) never started it: it would still be busy in FAULTED.
      div_busy_execute: assert (!div_busy || (state == EXECUTE && dec_is_div));
      div_done_execute: assert (DIV_ITER == 0 || !div_done || (state == EXECUTE && dec_is_div));
    end
  end

  // ---- 3. Register-write constraints --------------------------------------------------------

  // The write enables are raised only in WRITEBACK (so never in HALTED or FAULTED) ...
  always @(*) begin
    we_rf:    assert (!rf_we || state == WRITEBACK);
    we_mem:   assert (!mem_we || state == WRITEBACK);
    we_flags: assert (flags_mask == 4'h0 || state == WRITEBACK);
  end

  // ... and no architectural register changes except across a WRITEBACK edge.
  always @(posedge clk) begin
    if (f_run && $past(state) != WRITEBACK) begin
      wb_only_regs:  assert ($stable(dbg_regs));
      wb_only_flags: assert ($stable(flags));
      wb_only_sp_sd: assert ($stable(sp) && $stable(sd));
      wb_only_pc:    assert ($stable(pc));
    end
  end

  // ---- 4. Halt and fault --------------------------------------------------------------------

  // The status always agrees with the FSM state, and a fault code is set exactly when FAULTED.
  always @(*) begin
    if (f_live) begin
      status_running: assert (!running || (status == vcpu8_isa_pkg::STATUS_READY
                                            && fault_code == vcpu8_isa_pkg::FAULT_NONE));
      status_halted:  assert (state != HALTED || (status == vcpu8_isa_pkg::STATUS_HALTED
                                                  && fault_code == vcpu8_isa_pkg::FAULT_NONE));
      status_faulted: assert (state != FAULTED || (status == vcpu8_isa_pkg::STATUS_FAULTED
                                                   && fault_code != vcpu8_isa_pkg::FAULT_NONE));
    end
  end

  // HALTED and FAULTED are absorbing until reset: the state, every architectural register, the
  // status and fault record and instret hold, and nothing retires.
  always @(posedge clk) begin
    if (f_run && ($past(state) == HALTED || $past(state) == FAULTED)) begin
      stop_absorbing: assert (state == $past(state));
      stop_frozen:    assert ($stable(dbg_regs) && $stable(flags) && $stable(pc)
                              && $stable(sp) && $stable(sd));
      stop_record:    assert ($stable(status) && $stable(fault_code) && $stable(fault_pc));
      stop_no_retire: assert (!retire && $stable(instret));
    end
  end

  // ---- 5. Retirement ------------------------------------------------------------------------

  // retire is high exactly in the cycle after a WRITEBACK, so it pulses once per WRITEBACK.
  always @(posedge clk) begin
    if (f_run) begin
      retire_after_wb: assert (retire == ($past(state) == WRITEBACK));
      // instret counts retirements exactly: +1 on retire, unchanged otherwise.
      instret_count:   assert (instret == $past(instret) + {31'd0, retire});
      // A precise fault (found before WRITEBACK) does not retire. The one fault raised in
      // WRITEBACK is the post-commit PC_OVERFLOW, which does retire.
      if (state == FAULTED && $past(state) != FAULTED && $past(state) != WRITEBACK)
        fault_precise_no_retire: assert (!retire && instret == $past(instret));
      if (state == FAULTED && $past(state) == WRITEBACK)
        fault_wb_pc_overflow: assert (fault_code == vcpu8_isa_pkg::FAULT_PC_OVERFLOW);
    end
  end

  // At most one retirement per instruction. f_insn_retires counts the retirements of the
  // instruction being executed: it is cleared in FETCH (where the previous instruction's pulse
  // lands), so it covers the instruction's DECODE .. WRITEBACK and the cycle after.
  logic [1:0] f_insn_retires;
  always @(posedge clk) begin
    if (rst || state == FETCH) f_insn_retires <= 2'd0;
    else if (retire && f_insn_retires != 2'd3) f_insn_retires <= f_insn_retires + 2'd1;
  end
  always @(*) begin
    if (f_live) begin
      retire_once: assert (f_insn_retires + {1'b0, retire} <= 2'd1);
      // Helper: nothing of the current instruction has retired while it is in flight.
      h_in_flight_no_retire: assert (!running || f_insn_retires == 2'd0);
    end
  end

  // ---- 6. Memory-access validity ------------------------------------------------------------

  always @(*) begin
    // No write coincides with a fetch: the fetch states address PC, PC+1 or PC+2 and never
    // write; a write (WRITEBACK) is always addressed by a data select.
    mem_fetch_no_write: assert (!fetching || !mem_we);
    mem_fetch_addr:     assert (!fetching || bus_addr_sel == vcpu8_types_pkg::BUS_PC
                                || bus_addr_sel == vcpu8_types_pkg::BUS_PC1
                                || bus_addr_sel == vcpu8_types_pkg::BUS_PC2);
    mem_write_data_addr: assert (!mem_we || (bus_addr_sel != vcpu8_types_pkg::BUS_PC
                                             && bus_addr_sel != vcpu8_types_pkg::BUS_PC1
                                             && bus_addr_sel != vcpu8_types_pkg::BUS_PC2));

    if (f_live) begin
      // Operand fetches never wrap past 0xFF: an instruction that would overrun faults first.
      mem_fetch_pc1: assert (!(state == DECODE && bus_addr_sel == vcpu8_types_pkg::BUS_PC1)
                             || pc != 8'hFF);
      mem_fetch_pc2: assert (!(state == OPERAND1 && bus_addr_sel == vcpu8_types_pkg::BUS_PC2)
                             || pc <= 8'hFD);

      // The stack invariant: SP == 0xFF - SD and SD <= 64.
      stack_inv: assert (sd <= 7'(vcpu8_isa_pkg::STACK_CAPACITY) && sp == 8'hFF - {1'b0, sd});

      // Stack accesses stay inside 0xC0..0xFF: a push writes at SP with room left, a pop reads
      // SP + 1 with something on the stack.
      if (state == WRITEBACK && is_push)
        stack_push_addr: assert (mem_addr == sp && sp >= 8'hC0);
      if (state == WRITEBACK && is_pop)
        stack_pop_addr:  assert (mem_addr == sp + 8'd1 && sp != 8'hFF);

      // Helpers. Past DECODE, IR holds a valid opcode whose length is the one latched in ir_len
      // and which fits in memory (DECODE faulted otherwise). In WRITEBACK, a push has room and a
      // pop has data (EXECUTE faulted otherwise).
      if (state == OPERAND1 || state == OPERAND2 || state == EXECUTE || state == WRITEBACK) begin
        h_ir_valid: assert (dec_valid && ir_len == dec_len && dec_len != 2'd0);
        h_ir_fits:  assert ({1'b0, pc} + {7'd0, ir_len} <= 9'h100);
      end
      if (state == WRITEBACK) begin
        h_wb_push_room: assert (!is_push || sd < 7'(vcpu8_isa_pkg::STACK_CAPACITY));
        h_wb_pop_data:  assert (!is_pop || sd != 7'd0);
      end
    end
  end
endmodule

