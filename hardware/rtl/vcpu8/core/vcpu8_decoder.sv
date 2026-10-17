// VCPU-8 instruction decoder: purely combinational, opcode and register byte in, control out.
//
// Two kinds of output, kept apart on purpose:
//   - ISA-derived: valid, len, fields, flag_mask, mem_read, mem_write, pc_sel, cond, is_halt,
//     is_call and is_ret come from the lookup functions of the generated vcpu8_isa_pkg, so they
//     cannot drift from the TypeScript opcode table.
//   - Microarchitectural: alu_op, rf_we/wsel, the memory address and write-data selects and
//     stack_op are choices of this datapath. They come from the hand-written case below, which
//     follows the decoder table in docs/hardware-porting.md.
//
// An invalid opcode drives valid = 0 and every other output to 0 (no enable, every select at its
// 0 default), and the control FSM raises INVALID_OPCODE. rb_malformed is 0 for an opcode without
// a register byte; for one with a register byte it is 1 exactly when the byte raises
// MALFORMED_OPERAND. See docs/hardware/control-unit.md#decoder.
module vcpu8_decoder (
  input  logic [7:0]                      opcode,
  input  logic [7:0]                      rb,             // register byte {0, a[2:0], 0, b[2:0]}

  output logic                            valid,          // 0: INVALID_OPCODE
  output logic [1:0]                      len,            // 1-3 bytes; 0 when !valid
  output logic [1:0]                      fields,         // vcpu8_isa_pkg::ISA_FIELDS_*
  output logic                            rb_malformed,   // 1: MALFORMED_OPERAND

  output logic [2:0]                      ra_idx,         // field a, register port A
  output logic [2:0]                      rb_idx,         // field b, register port B

  output vcpu8_types_pkg::alu_op_t        alu_op,
  output logic                            rf_we,          // write R[ra_idx]
  output vcpu8_types_pkg::wsel_t          wsel,
  output logic                            mem_read,       // one data read (LOAD, POP, RET)
  output logic                            mem_write,      // one data write (STORE, PUSH, CALL)
  output vcpu8_types_pkg::mem_addr_sel_t  mem_addr_sel,
  output vcpu8_types_pkg::mem_wdata_sel_t mem_wdata_sel,

  output logic [3:0]                      flag_mask,      // FLAGS bits written, {Z, C, N, V}
  output vcpu8_types_pkg::stack_op_t      stack_op,
  output vcpu8_types_pkg::pc_sel_t        pc_sel,
  output vcpu8_types_pkg::cond_t          cond,           // meaningful when pc_sel == PC_COND

  output logic                            is_halt,
  output logic                            is_call,
  output logic                            is_ret,
  output logic                            is_div          // the EXECUTE divide-by-zero check
);

  // ISA lookups.
  logic [2:0] ctrl;
  logic [2:0] isa_cond;

  assign valid     = vcpu8_isa_pkg::isa_valid(opcode);
  assign len       = vcpu8_isa_pkg::isa_len(opcode);
  assign fields    = vcpu8_isa_pkg::isa_fields(opcode);
  assign flag_mask = vcpu8_isa_pkg::isa_flag_mask(opcode);
  assign mem_read  = vcpu8_isa_pkg::isa_data_read(opcode);
  assign mem_write = vcpu8_isa_pkg::isa_data_write(opcode);
  assign ctrl      = vcpu8_isa_pkg::isa_ctrl(opcode);
  assign isa_cond  = vcpu8_isa_pkg::isa_cond(opcode);

  assign is_halt = ctrl == vcpu8_isa_pkg::ISA_CTRL_HALT;
  assign is_call = ctrl == vcpu8_isa_pkg::ISA_CTRL_CALL;
  assign is_ret  = ctrl == vcpu8_isa_pkg::ISA_CTRL_RET;
  assign is_div  = opcode == vcpu8_isa_pkg::OP_DIV;

  // Next-PC select, one per control-flow kind. An invalid opcode reads ISA_CTRL_SEQ, so PC_SEQ.
  always_comb begin
    case (ctrl)
      vcpu8_isa_pkg::ISA_CTRL_HALT:   pc_sel = vcpu8_types_pkg::PC_HOLD;
      vcpu8_isa_pkg::ISA_CTRL_JUMP:   pc_sel = vcpu8_types_pkg::PC_TB;
      vcpu8_isa_pkg::ISA_CTRL_BRANCH: pc_sel = vcpu8_types_pkg::PC_COND;
      vcpu8_isa_pkg::ISA_CTRL_CALL:   pc_sel = vcpu8_types_pkg::PC_TB;
      vcpu8_isa_pkg::ISA_CTRL_RET:    pc_sel = vcpu8_types_pkg::PC_MEM;
      default:                        pc_sel = vcpu8_types_pkg::PC_SEQ;
    endcase
  end

  // isa_cond is {flag bit index, value}; the ISA only branches on Z and C, so cond_t keeps just
  // "is it C" and the value. A non-branch reads isa_cond = 0 and so COND_NZ (0).
  assign cond = vcpu8_types_pkg::cond_t'({isa_cond[2:1] == 2'(vcpu8_isa_pkg::FLAG_C), isa_cond[0]});

  // Register byte: field a is rb[7:4], field b is rb[3:0]. The top bit of a field selects
  // registers 8-15, which do not exist; field b must be all zero when the format uses only a.
  assign ra_idx = rb[6:4];
  assign rb_idx = rb[2:0];

  always_comb begin
    case (fields)
      vcpu8_isa_pkg::ISA_FIELDS_A:  rb_malformed = rb[7] | (rb[3:0] != 4'h0);
      vcpu8_isa_pkg::ISA_FIELDS_AB: rb_malformed = rb[7] | rb[3];
      default:                      rb_malformed = 1'b0;
    endcase
  end

  // Microarchitectural selects: the opcode table of docs/hardware-porting.md#decoder-decoder.
  // Defaults first, so a row names only what it uses and an invalid opcode enables nothing.
  always_comb begin
    alu_op        = vcpu8_types_pkg::ALU_ADD;
    rf_we         = 1'b0;
    wsel          = vcpu8_types_pkg::WSEL_ALU;
    mem_addr_sel  = vcpu8_types_pkg::MEM_ADDR_TB;
    mem_wdata_sel = vcpu8_types_pkg::MEM_WDATA_RA;
    stack_op      = vcpu8_types_pkg::STACK_NONE;

    case (opcode)
      vcpu8_isa_pkg::OP_MOV: begin
        rf_we = 1'b1;
        wsel  = vcpu8_types_pkg::WSEL_RB;
      end
      vcpu8_isa_pkg::OP_LDI: begin
        rf_we = 1'b1;
        wsel  = vcpu8_types_pkg::WSEL_TB;
      end
      vcpu8_isa_pkg::OP_LOAD_ABS: begin
        rf_we        = 1'b1;
        wsel         = vcpu8_types_pkg::WSEL_MEM;
        mem_addr_sel = vcpu8_types_pkg::MEM_ADDR_TB;
      end
      vcpu8_isa_pkg::OP_LOAD_IND: begin
        rf_we        = 1'b1;
        wsel         = vcpu8_types_pkg::WSEL_MEM;
        mem_addr_sel = vcpu8_types_pkg::MEM_ADDR_RB;
      end
      // STORE [addr8], Rs carries Rs in field a.
      vcpu8_isa_pkg::OP_STORE_ABS: begin
        mem_addr_sel  = vcpu8_types_pkg::MEM_ADDR_TB;
        mem_wdata_sel = vcpu8_types_pkg::MEM_WDATA_RA;
      end
      // STORE [Rp], Rs carries the pointer in field a and Rs in field b.
      vcpu8_isa_pkg::OP_STORE_IND: begin
        mem_addr_sel  = vcpu8_types_pkg::MEM_ADDR_RA;
        mem_wdata_sel = vcpu8_types_pkg::MEM_WDATA_RB;
      end
      vcpu8_isa_pkg::OP_ADD: begin
        alu_op = vcpu8_types_pkg::ALU_ADD;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_SUB: begin
        alu_op = vcpu8_types_pkg::ALU_SUB;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_MUL: begin
        alu_op = vcpu8_types_pkg::ALU_MUL;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_DIV: begin
        alu_op = vcpu8_types_pkg::ALU_DIV;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_INC: begin
        alu_op = vcpu8_types_pkg::ALU_INC;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_DEC: begin
        alu_op = vcpu8_types_pkg::ALU_DEC;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_AND: begin
        alu_op = vcpu8_types_pkg::ALU_AND;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_OR: begin
        alu_op = vcpu8_types_pkg::ALU_OR;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_XOR: begin
        alu_op = vcpu8_types_pkg::ALU_XOR;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_NOT: begin
        alu_op = vcpu8_types_pkg::ALU_NOT;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_SHL: begin
        alu_op = vcpu8_types_pkg::ALU_SHL;
        rf_we  = 1'b1;
      end
      vcpu8_isa_pkg::OP_SHR: begin
        alu_op = vcpu8_types_pkg::ALU_SHR;
        rf_we  = 1'b1;
      end
      // CMP sets exactly the flags SUB would and writes no register.
      vcpu8_isa_pkg::OP_CMP: begin
        alu_op = vcpu8_types_pkg::ALU_SUB;
      end
      vcpu8_isa_pkg::OP_CALL: begin
        mem_addr_sel  = vcpu8_types_pkg::MEM_ADDR_SP;
        mem_wdata_sel = vcpu8_types_pkg::MEM_WDATA_RET_ADDR;
        stack_op      = vcpu8_types_pkg::STACK_PUSH;
      end
      vcpu8_isa_pkg::OP_RET: begin
        mem_addr_sel = vcpu8_types_pkg::MEM_ADDR_SP1;
        stack_op     = vcpu8_types_pkg::STACK_POP;
      end
      vcpu8_isa_pkg::OP_PUSH: begin
        mem_addr_sel  = vcpu8_types_pkg::MEM_ADDR_SP;
        mem_wdata_sel = vcpu8_types_pkg::MEM_WDATA_RA;
        stack_op      = vcpu8_types_pkg::STACK_PUSH;
      end
      vcpu8_isa_pkg::OP_POP: begin
        rf_we        = 1'b1;
        wsel         = vcpu8_types_pkg::WSEL_MEM;
        mem_addr_sel = vcpu8_types_pkg::MEM_ADDR_SP1;
        stack_op     = vcpu8_types_pkg::STACK_POP;
      end
      // NOP, HLT, JMP, Jcc and every invalid byte: the defaults.
      default: ;
    endcase
  end

endmodule
