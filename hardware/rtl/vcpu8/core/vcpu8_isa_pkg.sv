// GENERATED FILE - DO NOT EDIT.
// VCPU-8 ISA 1.0.0 constants for the RTL, rendered by @vcpu/rtl-tools
// (packages/rtl-tools/src/gen/isa-pkg.ts) from @vcpu/shared (packages/shared/src/isa).
// Regenerate with `pnpm hardware:gen`; `make -C hardware/rtl/vcpu8 check-isa` and the
// isa-pkg vitest test fail when this file drifts from the TypeScript ISA.

package vcpu8_isa_pkg;

  // A constants package: each module imports only the names it needs, so most are unused in
  // any one compilation unit.
  /* verilator lint_off UNUSEDPARAM */

  // ISA version.
  localparam int ISA_VERSION_MAJOR = 1;
  localparam int ISA_VERSION_MINOR = 0;
  localparam int ISA_VERSION_PATCH = 0;

  // Machine sizes.
  localparam int MEMORY_SIZE    = 256;
  localparam int REGISTER_COUNT = 8;
  localparam int STACK_CAPACITY = 64;
  localparam int OPCODE_COUNT   = 30;

  // Opcode bytes (30 opcodes, in byte order).
  localparam logic [7:0] OP_NOP       = 8'h00;
  localparam logic [7:0] OP_HLT       = 8'h01;
  localparam logic [7:0] OP_MOV       = 8'h10;
  localparam logic [7:0] OP_LDI       = 8'h11;
  localparam logic [7:0] OP_LOAD_ABS  = 8'h12;
  localparam logic [7:0] OP_LOAD_IND  = 8'h13;
  localparam logic [7:0] OP_STORE_ABS = 8'h14;
  localparam logic [7:0] OP_STORE_IND = 8'h15;
  localparam logic [7:0] OP_ADD       = 8'h20;
  localparam logic [7:0] OP_SUB       = 8'h21;
  localparam logic [7:0] OP_MUL       = 8'h22;
  localparam logic [7:0] OP_DIV       = 8'h23;
  localparam logic [7:0] OP_INC       = 8'h24;
  localparam logic [7:0] OP_DEC       = 8'h25;
  localparam logic [7:0] OP_AND       = 8'h30;
  localparam logic [7:0] OP_OR        = 8'h31;
  localparam logic [7:0] OP_XOR       = 8'h32;
  localparam logic [7:0] OP_NOT       = 8'h33;
  localparam logic [7:0] OP_SHL       = 8'h34;
  localparam logic [7:0] OP_SHR       = 8'h35;
  localparam logic [7:0] OP_CMP       = 8'h36;
  localparam logic [7:0] OP_JMP       = 8'h40;
  localparam logic [7:0] OP_JZ        = 8'h41;
  localparam logic [7:0] OP_JNZ       = 8'h42;
  localparam logic [7:0] OP_JC        = 8'h43;
  localparam logic [7:0] OP_JNC       = 8'h44;
  localparam logic [7:0] OP_CALL      = 8'h45;
  localparam logic [7:0] OP_RET       = 8'h46;
  localparam logic [7:0] OP_PUSH      = 8'h50;
  localparam logic [7:0] OP_POP       = 8'h51;

  // Fault codes (FAULT_CODE_NUMBERS); 0 = no fault.
  localparam logic [2:0] FAULT_NONE                = 3'd0;
  localparam logic [2:0] FAULT_INVALID_OPCODE      = 3'd1;
  localparam logic [2:0] FAULT_MALFORMED_OPERAND   = 3'd2;
  localparam logic [2:0] FAULT_INSTRUCTION_OVERRUN = 3'd3;
  localparam logic [2:0] FAULT_PC_OVERFLOW         = 3'd4;
  localparam logic [2:0] FAULT_DIVIDE_BY_ZERO      = 3'd5;
  localparam logic [2:0] FAULT_STACK_OVERFLOW      = 3'd6;
  localparam logic [2:0] FAULT_STACK_UNDERFLOW     = 3'd7;

  // CPU status (CPU_STATUS_NUMBERS). The RTL has one run state, reported as STATUS_READY.
  localparam logic [2:0] STATUS_READY              = 3'd0;
  localparam logic [2:0] STATUS_RUNNING            = 3'd1;
  localparam logic [2:0] STATUS_PAUSED             = 3'd2;
  localparam logic [2:0] STATUS_HALTED             = 3'd3;
  localparam logic [2:0] STATUS_FAULTED            = 3'd4;

  // Reset values of the architectural state. Reset does not touch memory.
  localparam logic [7:0] RESET_PC    = 8'h00;
  localparam logic [7:0] RESET_SP    = 8'hFF;
  localparam logic [6:0] RESET_SD    = 7'd0;
  localparam logic [3:0] RESET_FLAGS = 4'h0;
  localparam logic [7:0] RESET_REG   = 8'h00;

  // FLAGS bit positions; the 8-bit FLAGS byte reads {4'h0, Z, C, N, V}.
  localparam int FLAG_Z = 3;
  localparam int FLAG_C = 2;
  localparam int FLAG_N = 1;
  localparam int FLAG_V = 0;

  // isa_fields() codes.
  localparam logic [1:0] ISA_FIELDS_NONE = 2'd0;
  localparam logic [1:0] ISA_FIELDS_A    = 2'd1;
  localparam logic [1:0] ISA_FIELDS_AB   = 2'd2;

  // isa_ctrl() codes.
  localparam logic [2:0] ISA_CTRL_SEQ    = 3'd0;
  localparam logic [2:0] ISA_CTRL_HALT   = 3'd1;
  localparam logic [2:0] ISA_CTRL_JUMP   = 3'd2;
  localparam logic [2:0] ISA_CTRL_BRANCH = 3'd3;
  localparam logic [2:0] ISA_CTRL_CALL   = 3'd4;
  localparam logic [2:0] ISA_CTRL_RET    = 3'd5;

  // 1 for the opcodes of this ISA; every other byte is INVALID_OPCODE.
  function automatic logic isa_valid(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_valid = 1'b1;
      OP_HLT:       isa_valid = 1'b1;
      OP_MOV:       isa_valid = 1'b1;
      OP_LDI:       isa_valid = 1'b1;
      OP_LOAD_ABS:  isa_valid = 1'b1;
      OP_LOAD_IND:  isa_valid = 1'b1;
      OP_STORE_ABS: isa_valid = 1'b1;
      OP_STORE_IND: isa_valid = 1'b1;
      OP_ADD:       isa_valid = 1'b1;
      OP_SUB:       isa_valid = 1'b1;
      OP_MUL:       isa_valid = 1'b1;
      OP_DIV:       isa_valid = 1'b1;
      OP_INC:       isa_valid = 1'b1;
      OP_DEC:       isa_valid = 1'b1;
      OP_AND:       isa_valid = 1'b1;
      OP_OR:        isa_valid = 1'b1;
      OP_XOR:       isa_valid = 1'b1;
      OP_NOT:       isa_valid = 1'b1;
      OP_SHL:       isa_valid = 1'b1;
      OP_SHR:       isa_valid = 1'b1;
      OP_CMP:       isa_valid = 1'b1;
      OP_JMP:       isa_valid = 1'b1;
      OP_JZ:        isa_valid = 1'b1;
      OP_JNZ:       isa_valid = 1'b1;
      OP_JC:        isa_valid = 1'b1;
      OP_JNC:       isa_valid = 1'b1;
      OP_CALL:      isa_valid = 1'b1;
      OP_RET:       isa_valid = 1'b1;
      OP_PUSH:      isa_valid = 1'b1;
      OP_POP:       isa_valid = 1'b1;
      default:      isa_valid = 1'b0;
    endcase
  endfunction

  // Instruction length in bytes (1-3), opcode included; 0 for an invalid opcode.
  function automatic logic [1:0] isa_len(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_len = 2'd1;
      OP_HLT:       isa_len = 2'd1;
      OP_MOV:       isa_len = 2'd2;
      OP_LDI:       isa_len = 2'd3;
      OP_LOAD_ABS:  isa_len = 2'd3;
      OP_LOAD_IND:  isa_len = 2'd2;
      OP_STORE_ABS: isa_len = 2'd3;
      OP_STORE_IND: isa_len = 2'd2;
      OP_ADD:       isa_len = 2'd2;
      OP_SUB:       isa_len = 2'd2;
      OP_MUL:       isa_len = 2'd2;
      OP_DIV:       isa_len = 2'd2;
      OP_INC:       isa_len = 2'd2;
      OP_DEC:       isa_len = 2'd2;
      OP_AND:       isa_len = 2'd2;
      OP_OR:        isa_len = 2'd2;
      OP_XOR:       isa_len = 2'd2;
      OP_NOT:       isa_len = 2'd2;
      OP_SHL:       isa_len = 2'd2;
      OP_SHR:       isa_len = 2'd2;
      OP_CMP:       isa_len = 2'd2;
      OP_JMP:       isa_len = 2'd2;
      OP_JZ:        isa_len = 2'd2;
      OP_JNZ:       isa_len = 2'd2;
      OP_JC:        isa_len = 2'd2;
      OP_JNC:       isa_len = 2'd2;
      OP_CALL:      isa_len = 2'd2;
      OP_RET:       isa_len = 2'd1;
      OP_PUSH:      isa_len = 2'd2;
      OP_POP:       isa_len = 2'd2;
      default:      isa_len = 2'd0;
    endcase
  endfunction

  // Register-byte fields used: ISA_FIELDS_NONE (no register byte), _A (field b must be 0), _AB.
  function automatic logic [1:0] isa_fields(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_fields = ISA_FIELDS_NONE;
      OP_HLT:       isa_fields = ISA_FIELDS_NONE;
      OP_MOV:       isa_fields = ISA_FIELDS_AB;
      OP_LDI:       isa_fields = ISA_FIELDS_A;
      OP_LOAD_ABS:  isa_fields = ISA_FIELDS_A;
      OP_LOAD_IND:  isa_fields = ISA_FIELDS_AB;
      OP_STORE_ABS: isa_fields = ISA_FIELDS_A;
      OP_STORE_IND: isa_fields = ISA_FIELDS_AB;
      OP_ADD:       isa_fields = ISA_FIELDS_AB;
      OP_SUB:       isa_fields = ISA_FIELDS_AB;
      OP_MUL:       isa_fields = ISA_FIELDS_AB;
      OP_DIV:       isa_fields = ISA_FIELDS_AB;
      OP_INC:       isa_fields = ISA_FIELDS_A;
      OP_DEC:       isa_fields = ISA_FIELDS_A;
      OP_AND:       isa_fields = ISA_FIELDS_AB;
      OP_OR:        isa_fields = ISA_FIELDS_AB;
      OP_XOR:       isa_fields = ISA_FIELDS_AB;
      OP_NOT:       isa_fields = ISA_FIELDS_A;
      OP_SHL:       isa_fields = ISA_FIELDS_A;
      OP_SHR:       isa_fields = ISA_FIELDS_A;
      OP_CMP:       isa_fields = ISA_FIELDS_AB;
      OP_JMP:       isa_fields = ISA_FIELDS_NONE;
      OP_JZ:        isa_fields = ISA_FIELDS_NONE;
      OP_JNZ:       isa_fields = ISA_FIELDS_NONE;
      OP_JC:        isa_fields = ISA_FIELDS_NONE;
      OP_JNC:       isa_fields = ISA_FIELDS_NONE;
      OP_CALL:      isa_fields = ISA_FIELDS_NONE;
      OP_RET:       isa_fields = ISA_FIELDS_NONE;
      OP_PUSH:      isa_fields = ISA_FIELDS_A;
      OP_POP:       isa_fields = ISA_FIELDS_A;
      default:      isa_fields = ISA_FIELDS_NONE;
    endcase
  endfunction

  // FLAGS bits the instruction may change ({Z, C, N, V}): flagsWritten | flagsCleared.
  function automatic logic [3:0] isa_flag_mask(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_flag_mask = 4'b0000;
      OP_HLT:       isa_flag_mask = 4'b0000;
      OP_MOV:       isa_flag_mask = 4'b0000;
      OP_LDI:       isa_flag_mask = 4'b0000;
      OP_LOAD_ABS:  isa_flag_mask = 4'b0000;
      OP_LOAD_IND:  isa_flag_mask = 4'b0000;
      OP_STORE_ABS: isa_flag_mask = 4'b0000;
      OP_STORE_IND: isa_flag_mask = 4'b0000;
      OP_ADD:       isa_flag_mask = 4'b1111;
      OP_SUB:       isa_flag_mask = 4'b1111;
      OP_MUL:       isa_flag_mask = 4'b1111;
      OP_DIV:       isa_flag_mask = 4'b1111;
      OP_INC:       isa_flag_mask = 4'b1011;
      OP_DEC:       isa_flag_mask = 4'b1011;
      OP_AND:       isa_flag_mask = 4'b1111;
      OP_OR:        isa_flag_mask = 4'b1111;
      OP_XOR:       isa_flag_mask = 4'b1111;
      OP_NOT:       isa_flag_mask = 4'b1111;
      OP_SHL:       isa_flag_mask = 4'b1111;
      OP_SHR:       isa_flag_mask = 4'b1111;
      OP_CMP:       isa_flag_mask = 4'b1111;
      OP_JMP:       isa_flag_mask = 4'b0000;
      OP_JZ:        isa_flag_mask = 4'b0000;
      OP_JNZ:       isa_flag_mask = 4'b0000;
      OP_JC:        isa_flag_mask = 4'b0000;
      OP_JNC:       isa_flag_mask = 4'b0000;
      OP_CALL:      isa_flag_mask = 4'b0000;
      OP_RET:       isa_flag_mask = 4'b0000;
      OP_PUSH:      isa_flag_mask = 4'b0000;
      OP_POP:       isa_flag_mask = 4'b0000;
      default:      isa_flag_mask = 4'b0000;
    endcase
  endfunction

  // Next-PC behaviour: ISA_CTRL_SEQ, _HALT, _JUMP, _BRANCH, _CALL or _RET.
  function automatic logic [2:0] isa_ctrl(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_ctrl = ISA_CTRL_SEQ;
      OP_HLT:       isa_ctrl = ISA_CTRL_HALT;
      OP_MOV:       isa_ctrl = ISA_CTRL_SEQ;
      OP_LDI:       isa_ctrl = ISA_CTRL_SEQ;
      OP_LOAD_ABS:  isa_ctrl = ISA_CTRL_SEQ;
      OP_LOAD_IND:  isa_ctrl = ISA_CTRL_SEQ;
      OP_STORE_ABS: isa_ctrl = ISA_CTRL_SEQ;
      OP_STORE_IND: isa_ctrl = ISA_CTRL_SEQ;
      OP_ADD:       isa_ctrl = ISA_CTRL_SEQ;
      OP_SUB:       isa_ctrl = ISA_CTRL_SEQ;
      OP_MUL:       isa_ctrl = ISA_CTRL_SEQ;
      OP_DIV:       isa_ctrl = ISA_CTRL_SEQ;
      OP_INC:       isa_ctrl = ISA_CTRL_SEQ;
      OP_DEC:       isa_ctrl = ISA_CTRL_SEQ;
      OP_AND:       isa_ctrl = ISA_CTRL_SEQ;
      OP_OR:        isa_ctrl = ISA_CTRL_SEQ;
      OP_XOR:       isa_ctrl = ISA_CTRL_SEQ;
      OP_NOT:       isa_ctrl = ISA_CTRL_SEQ;
      OP_SHL:       isa_ctrl = ISA_CTRL_SEQ;
      OP_SHR:       isa_ctrl = ISA_CTRL_SEQ;
      OP_CMP:       isa_ctrl = ISA_CTRL_SEQ;
      OP_JMP:       isa_ctrl = ISA_CTRL_JUMP;
      OP_JZ:        isa_ctrl = ISA_CTRL_BRANCH;
      OP_JNZ:       isa_ctrl = ISA_CTRL_BRANCH;
      OP_JC:        isa_ctrl = ISA_CTRL_BRANCH;
      OP_JNC:       isa_ctrl = ISA_CTRL_BRANCH;
      OP_CALL:      isa_ctrl = ISA_CTRL_CALL;
      OP_RET:       isa_ctrl = ISA_CTRL_RET;
      OP_PUSH:      isa_ctrl = ISA_CTRL_SEQ;
      OP_POP:       isa_ctrl = ISA_CTRL_SEQ;
      default:      isa_ctrl = ISA_CTRL_SEQ;
    endcase
  endfunction

  // Branch condition {flag bit index[1:0], value}: taken when flags[c[2:1]] == c[0]. 0 unless ISA_CTRL_BRANCH.
  function automatic logic [2:0] isa_cond(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_cond = 3'b000;
      OP_HLT:       isa_cond = 3'b000;
      OP_MOV:       isa_cond = 3'b000;
      OP_LDI:       isa_cond = 3'b000;
      OP_LOAD_ABS:  isa_cond = 3'b000;
      OP_LOAD_IND:  isa_cond = 3'b000;
      OP_STORE_ABS: isa_cond = 3'b000;
      OP_STORE_IND: isa_cond = 3'b000;
      OP_ADD:       isa_cond = 3'b000;
      OP_SUB:       isa_cond = 3'b000;
      OP_MUL:       isa_cond = 3'b000;
      OP_DIV:       isa_cond = 3'b000;
      OP_INC:       isa_cond = 3'b000;
      OP_DEC:       isa_cond = 3'b000;
      OP_AND:       isa_cond = 3'b000;
      OP_OR:        isa_cond = 3'b000;
      OP_XOR:       isa_cond = 3'b000;
      OP_NOT:       isa_cond = 3'b000;
      OP_SHL:       isa_cond = 3'b000;
      OP_SHR:       isa_cond = 3'b000;
      OP_CMP:       isa_cond = 3'b000;
      OP_JMP:       isa_cond = 3'b000;
      OP_JZ:        isa_cond = 3'b111;
      OP_JNZ:       isa_cond = 3'b110;
      OP_JC:        isa_cond = 3'b101;
      OP_JNC:       isa_cond = 3'b100;
      OP_CALL:      isa_cond = 3'b000;
      OP_RET:       isa_cond = 3'b000;
      OP_PUSH:      isa_cond = 3'b000;
      OP_POP:       isa_cond = 3'b000;
      default:      isa_cond = 3'b000;
    endcase
  endfunction

  // 1 when the instruction reads one data byte (LOAD, POP, RET); fetches excluded.
  function automatic logic isa_data_read(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_data_read = 1'b0;
      OP_HLT:       isa_data_read = 1'b0;
      OP_MOV:       isa_data_read = 1'b0;
      OP_LDI:       isa_data_read = 1'b0;
      OP_LOAD_ABS:  isa_data_read = 1'b1;
      OP_LOAD_IND:  isa_data_read = 1'b1;
      OP_STORE_ABS: isa_data_read = 1'b0;
      OP_STORE_IND: isa_data_read = 1'b0;
      OP_ADD:       isa_data_read = 1'b0;
      OP_SUB:       isa_data_read = 1'b0;
      OP_MUL:       isa_data_read = 1'b0;
      OP_DIV:       isa_data_read = 1'b0;
      OP_INC:       isa_data_read = 1'b0;
      OP_DEC:       isa_data_read = 1'b0;
      OP_AND:       isa_data_read = 1'b0;
      OP_OR:        isa_data_read = 1'b0;
      OP_XOR:       isa_data_read = 1'b0;
      OP_NOT:       isa_data_read = 1'b0;
      OP_SHL:       isa_data_read = 1'b0;
      OP_SHR:       isa_data_read = 1'b0;
      OP_CMP:       isa_data_read = 1'b0;
      OP_JMP:       isa_data_read = 1'b0;
      OP_JZ:        isa_data_read = 1'b0;
      OP_JNZ:       isa_data_read = 1'b0;
      OP_JC:        isa_data_read = 1'b0;
      OP_JNC:       isa_data_read = 1'b0;
      OP_CALL:      isa_data_read = 1'b0;
      OP_RET:       isa_data_read = 1'b1;
      OP_PUSH:      isa_data_read = 1'b0;
      OP_POP:       isa_data_read = 1'b1;
      default:      isa_data_read = 1'b0;
    endcase
  endfunction

  // 1 when the instruction writes one data byte (STORE, PUSH, CALL).
  function automatic logic isa_data_write(input logic [7:0] op);
    case (op)
      OP_NOP:       isa_data_write = 1'b0;
      OP_HLT:       isa_data_write = 1'b0;
      OP_MOV:       isa_data_write = 1'b0;
      OP_LDI:       isa_data_write = 1'b0;
      OP_LOAD_ABS:  isa_data_write = 1'b0;
      OP_LOAD_IND:  isa_data_write = 1'b0;
      OP_STORE_ABS: isa_data_write = 1'b1;
      OP_STORE_IND: isa_data_write = 1'b1;
      OP_ADD:       isa_data_write = 1'b0;
      OP_SUB:       isa_data_write = 1'b0;
      OP_MUL:       isa_data_write = 1'b0;
      OP_DIV:       isa_data_write = 1'b0;
      OP_INC:       isa_data_write = 1'b0;
      OP_DEC:       isa_data_write = 1'b0;
      OP_AND:       isa_data_write = 1'b0;
      OP_OR:        isa_data_write = 1'b0;
      OP_XOR:       isa_data_write = 1'b0;
      OP_NOT:       isa_data_write = 1'b0;
      OP_SHL:       isa_data_write = 1'b0;
      OP_SHR:       isa_data_write = 1'b0;
      OP_CMP:       isa_data_write = 1'b0;
      OP_JMP:       isa_data_write = 1'b0;
      OP_JZ:        isa_data_write = 1'b0;
      OP_JNZ:       isa_data_write = 1'b0;
      OP_JC:        isa_data_write = 1'b0;
      OP_JNC:       isa_data_write = 1'b0;
      OP_CALL:      isa_data_write = 1'b1;
      OP_RET:       isa_data_write = 1'b0;
      OP_PUSH:      isa_data_write = 1'b1;
      OP_POP:       isa_data_write = 1'b0;
      default:      isa_data_write = 1'b0;
    endcase
  endfunction

  /* verilator lint_on UNUSEDPARAM */

endpackage
