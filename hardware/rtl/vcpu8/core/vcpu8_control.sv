// VCPU-8 control unit: the multicycle FSM and the state it owns.
//
// Every instruction walks FETCH → DECODE → [OPERAND1 → [OPERAND2]] → EXECUTE → WRITEBACK, and the
// CPU stops in HALTED or FAULTED until reset. docs/hardware/control-unit.md#control-fsm explains
// the states; docs/hardware-porting.md#control-fsm-control_fsm is the specification.
//
// - The FSM owns PC, SP, SD, IR (op, rb, tb), status, fault_code, fault_pc and instret. The
//   register file and FLAGS live in their own modules; the FSM drives their write enables.
// - WRITEBACK is the only state that writes architectural state: PC, SP, SD, FLAGS, a register
//   and RAM. Every precise fault is found in DECODE, OPERAND1/2 or EXECUTE and goes straight to
//   FAULTED, so it writes nothing and needs no undo logic.
// - The one fault raised in WRITEBACK is the post-commit PC_OVERFLOW of a sequential instruction
//   that ends at 0xFF: its writes still commit, it retires, and PC stays at the instruction.
// - retire pulses for one cycle after each WRITEBACK edge, when every debug tap already shows the
//   state after the instruction. A precise fault does not retire.
//
// The decoder sits beside the FSM in vcpu8_core. The FSM picks its inputs: the opcode comes
// straight from the RAM in DECODE (before IR.op is latched) and from IR.op afterwards, and the
// register byte comes from the RAM in OPERAND1 and from IR.rb afterwards.
module vcpu8_control (
  input  logic                              clk,
  input  logic                              rst,

  // RAM read data: mem[addr] of the previous cycle.
  input  logic [7:0]                        mem_rdata,

  // Decoder inputs, chosen by the FSM, and the decoder outputs the FSM uses.
  output logic [7:0]                        dec_opcode,
  output logic [7:0]                        dec_rb,
  input  logic                              dec_valid,
  input  logic [1:0]                        dec_len,
  input  logic                              dec_rb_malformed,
  input  logic                              dec_rf_we,
  input  logic                              dec_mem_read,
  input  logic                              dec_mem_write,
  input  vcpu8_types_pkg::mem_addr_sel_t    dec_mem_addr_sel,
  input  logic [3:0]                        dec_flag_mask,
  input  vcpu8_types_pkg::stack_op_t        dec_stack_op,
  input  vcpu8_types_pkg::pc_sel_t          dec_pc_sel,
  input  vcpu8_types_pkg::cond_t            dec_cond,
  input  logic                              dec_is_halt,
  input  logic                              dec_is_call,
  input  logic                              dec_is_div,

  // Datapath values the FSM tests.
  input  logic [7:0]                        rb_data,      // the DIV divisor
  input  logic [3:0]                        flags,        // branch conditions

  // Datapath controls.
  output vcpu8_types_pkg::bus_addr_sel_t    bus_addr_sel,
  output logic                              mem_we,
  output logic                              rf_we,
  output logic [3:0]                        flags_mask,   // FLAGS bits written this cycle

  // State.
  output vcpu8_types_pkg::fsm_state_t       state,
  output logic [7:0]                        pc,
  output logic [7:0]                        sp,
  output logic [6:0]                        sd,
  output logic [7:0]                        ir_op,
  output logic [7:0]                        ir_rb,
  output logic [7:0]                        ir_tb,        // the instruction's last byte
  output logic [1:0]                        ir_len,       // bytes fetched into IR, 1-3
  output logic [2:0]                        status,
  output logic [2:0]                        fault_code,
  output logic [7:0]                        fault_pc,

  // Retirement.
  output logic                              retire,
  output logic [7:0]                        retire_pc,
  output logic [7:0]                        retire_op,
  output logic [31:0]                       instret
);
  vcpu8_types_pkg::fsm_state_t state_next;

  // seq = PC + len with a 9th bit: 0x100 means "past the end of memory".
  logic [8:0] seq;
  assign seq = {1'b0, pc} + {7'd0, dec_len};

  logic overrun;
  assign overrun = seq > 9'h100;

  logic is_push, is_pop;
  assign is_push = dec_stack_op == vcpu8_types_pkg::STACK_PUSH;
  assign is_pop  = dec_stack_op == vcpu8_types_pkg::STACK_POP;

  // Branch condition: cond = {flag is C, value it must have}.
  logic [1:0] cond_bits;
  logic       taken;
  assign cond_bits = dec_cond;
  assign taken = (cond_bits[1] ? flags[vcpu8_isa_pkg::FLAG_C]
                                : flags[vcpu8_isa_pkg::FLAG_Z]) == cond_bits[0];

  // A sequential next PC: PC_SEQ, or a branch whose condition fails.
  logic sequential;
  assign sequential = dec_pc_sel == vcpu8_types_pkg::PC_SEQ
                   || (dec_pc_sel == vcpu8_types_pkg::PC_COND && !taken);

  // Decoder inputs.
  assign dec_opcode = (state == vcpu8_types_pkg::FSM_DECODE)   ? mem_rdata : ir_op;
  assign dec_rb     = (state == vcpu8_types_pkg::FSM_OPERAND1) ? mem_rdata : ir_rb;

  // Precise faults, in the order the FSM discovers them, which is the emulator's priority order.
  // At most one EXECUTE fault can apply to an instruction, so their order there is immaterial.
  logic [2:0] fault_now;
  always_comb begin
    fault_now = vcpu8_isa_pkg::FAULT_NONE;
    case (state)
      vcpu8_types_pkg::FSM_DECODE:
        if (!dec_valid)   fault_now = vcpu8_isa_pkg::FAULT_INVALID_OPCODE;
        else if (overrun) fault_now = vcpu8_isa_pkg::FAULT_INSTRUCTION_OVERRUN;
      // The register byte is checked once every byte is in: in OPERAND1 for len 2, OPERAND2 for 3.
      vcpu8_types_pkg::FSM_OPERAND1:
        if (dec_len == 2'd2 && dec_rb_malformed)
          fault_now = vcpu8_isa_pkg::FAULT_MALFORMED_OPERAND;
      vcpu8_types_pkg::FSM_OPERAND2:
        if (dec_rb_malformed)
          fault_now = vcpu8_isa_pkg::FAULT_MALFORMED_OPERAND;
      vcpu8_types_pkg::FSM_EXECUTE:
        if (dec_is_call && seq[8])
          fault_now = vcpu8_isa_pkg::FAULT_PC_OVERFLOW;
        else if (dec_is_div && rb_data == 8'h00)
          fault_now = vcpu8_isa_pkg::FAULT_DIVIDE_BY_ZERO;
        else if (is_push && sd == 7'(vcpu8_isa_pkg::STACK_CAPACITY))
          fault_now = vcpu8_isa_pkg::FAULT_STACK_OVERFLOW;
        else if (is_pop && sd == 7'd0)
          fault_now = vcpu8_isa_pkg::FAULT_STACK_UNDERFLOW;
      default: ;
    endcase
  end

  // WRITEBACK outcomes.
  logic halt_now, pc_overflow_now;
  assign halt_now        = state == vcpu8_types_pkg::FSM_WRITEBACK && dec_is_halt;
  assign pc_overflow_now = state == vcpu8_types_pkg::FSM_WRITEBACK && sequential && seq[8];

  // Next PC. A sequential PC of 0x100 holds PC (the post-commit PC_OVERFLOW).
  logic [7:0] pc_next;
  always_comb begin
    case (dec_pc_sel)
      vcpu8_types_pkg::PC_HOLD: pc_next = pc;
      vcpu8_types_pkg::PC_TB:   pc_next = ir_tb;
      vcpu8_types_pkg::PC_MEM:  pc_next = mem_rdata;
      default:                  pc_next = (dec_pc_sel == vcpu8_types_pkg::PC_COND && taken) ? ir_tb
                                        : seq[8] ? pc
                                        : seq[7:0];
    endcase
  end

  // Next state.
  always_comb begin
    state_next = state;
    if (fault_now != vcpu8_isa_pkg::FAULT_NONE) begin
      state_next = vcpu8_types_pkg::FSM_FAULTED;
    end else begin
      case (state)
        vcpu8_types_pkg::FSM_FETCH:
          state_next = vcpu8_types_pkg::FSM_DECODE;
        vcpu8_types_pkg::FSM_DECODE:
          state_next = (dec_len == 2'd1) ? vcpu8_types_pkg::FSM_EXECUTE
                                         : vcpu8_types_pkg::FSM_OPERAND1;
        vcpu8_types_pkg::FSM_OPERAND1:
          state_next = (dec_len == 2'd3) ? vcpu8_types_pkg::FSM_OPERAND2
                                         : vcpu8_types_pkg::FSM_EXECUTE;
        vcpu8_types_pkg::FSM_OPERAND2:
          state_next = vcpu8_types_pkg::FSM_EXECUTE;
        vcpu8_types_pkg::FSM_EXECUTE:
          state_next = vcpu8_types_pkg::FSM_WRITEBACK;
        vcpu8_types_pkg::FSM_WRITEBACK:
          state_next = halt_now        ? vcpu8_types_pkg::FSM_HALTED
                     : pc_overflow_now ? vcpu8_types_pkg::FSM_FAULTED
                     :                   vcpu8_types_pkg::FSM_FETCH;
        default:
          state_next = state;  // HALTED, FAULTED: until reset
      endcase
    end
  end

  // RAM address. DECODE asks for byte 1 only when the instruction has one and fits in memory, and
  // OPERAND1 asks for byte 2 only for a 3-byte instruction, so no address past 0xFF is wanted.
  // The data access of LOAD, STORE, PUSH, POP, CALL and RET is addressed in EXECUTE (a read's data
  // arrives in WRITEBACK) and held through WRITEBACK (a write happens at the WRITEBACK edge).
  always_comb begin
    bus_addr_sel = vcpu8_types_pkg::BUS_PC;
    case (state)
      vcpu8_types_pkg::FSM_DECODE:
        if (fault_now == vcpu8_isa_pkg::FAULT_NONE && dec_len != 2'd1)
          bus_addr_sel = vcpu8_types_pkg::BUS_PC1;
      vcpu8_types_pkg::FSM_OPERAND1:
        if (dec_len == 2'd3) bus_addr_sel = vcpu8_types_pkg::BUS_PC2;
      vcpu8_types_pkg::FSM_EXECUTE, vcpu8_types_pkg::FSM_WRITEBACK:
        if (dec_mem_read || dec_mem_write) begin
          case (dec_mem_addr_sel)
            vcpu8_types_pkg::MEM_ADDR_TB:  bus_addr_sel = vcpu8_types_pkg::BUS_TB;
            vcpu8_types_pkg::MEM_ADDR_RA:  bus_addr_sel = vcpu8_types_pkg::BUS_RA;
            vcpu8_types_pkg::MEM_ADDR_RB:  bus_addr_sel = vcpu8_types_pkg::BUS_RB;
            vcpu8_types_pkg::MEM_ADDR_SP:  bus_addr_sel = vcpu8_types_pkg::BUS_SP;
            vcpu8_types_pkg::MEM_ADDR_SP1: bus_addr_sel = vcpu8_types_pkg::BUS_SP1;
            default:                       bus_addr_sel = vcpu8_types_pkg::BUS_PC;
          endcase
        end
      default: ;
    endcase
  end

  // Write enables: WRITEBACK only.
  assign mem_we     = state == vcpu8_types_pkg::FSM_WRITEBACK && dec_mem_write;
  assign rf_we      = state == vcpu8_types_pkg::FSM_WRITEBACK && dec_rf_we;
  assign flags_mask = (state == vcpu8_types_pkg::FSM_WRITEBACK) ? dec_flag_mask : 4'h0;

  always_ff @(posedge clk) begin
    if (rst) begin
      state      <= vcpu8_types_pkg::FSM_FETCH;
      pc         <= vcpu8_isa_pkg::RESET_PC;
      sp         <= vcpu8_isa_pkg::RESET_SP;
      sd         <= vcpu8_isa_pkg::RESET_SD;
      ir_op      <= 8'h00;
      ir_rb      <= 8'h00;
      ir_tb      <= 8'h00;
      ir_len     <= 2'd0;
      status     <= vcpu8_isa_pkg::STATUS_READY;
      fault_code <= vcpu8_isa_pkg::FAULT_NONE;
      fault_pc   <= 8'h00;
      retire     <= 1'b0;
      retire_pc  <= 8'h00;
      retire_op  <= 8'h00;
      instret    <= 32'd0;
    end else begin
      state  <= state_next;
      retire <= 1'b0;

      case (state)
        vcpu8_types_pkg::FSM_DECODE: begin
          ir_op  <= mem_rdata;
          ir_len <= (fault_now == vcpu8_isa_pkg::FAULT_NONE) ? dec_len : 2'd1;
        end
        // Byte 1 goes into both IR.rb and IR.tb, and byte 2 overwrites IR.tb. So IR.rb is the
        // register byte and IR.tb the last byte (imm8 or addr8) for every format.
        vcpu8_types_pkg::FSM_OPERAND1: begin
          ir_rb <= mem_rdata;
          ir_tb <= mem_rdata;
        end
        vcpu8_types_pkg::FSM_OPERAND2: ir_tb <= mem_rdata;
        vcpu8_types_pkg::FSM_WRITEBACK: begin
          pc <= pc_next;
          case (dec_stack_op)
            vcpu8_types_pkg::STACK_PUSH: begin
              sp <= sp - 8'd1;
              sd <= sd + 7'd1;
            end
            vcpu8_types_pkg::STACK_POP: begin
              sp <= sp + 8'd1;
              sd <= sd - 7'd1;
            end
            default: ;
          endcase
          retire    <= 1'b1;
          retire_pc <= pc;
          retire_op <= ir_op;
          instret   <= instret + 32'd1;
          if (halt_now) begin
            status <= vcpu8_isa_pkg::STATUS_HALTED;
          end else if (pc_overflow_now) begin
            status     <= vcpu8_isa_pkg::STATUS_FAULTED;
            fault_code <= vcpu8_isa_pkg::FAULT_PC_OVERFLOW;
            fault_pc   <= pc;
          end
        end
        default: ;
      endcase

      if (fault_now != vcpu8_isa_pkg::FAULT_NONE) begin
        status     <= vcpu8_isa_pkg::STATUS_FAULTED;
        fault_code <= fault_now;
        fault_pc   <= pc;
      end
    end
  end
endmodule
