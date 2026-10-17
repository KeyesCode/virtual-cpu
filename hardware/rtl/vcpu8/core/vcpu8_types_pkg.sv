// VCPU-8 microarchitecture types, written by hand.
//
// Nothing here is part of the ISA. These are internal encodings chosen by this RTL design, and
// another implementation of ISA 1.0.0 may pick different ones. Architectural numbers (opcodes,
// fault and status codes, reset values, flag positions) live only in the generated
// vcpu8_isa_pkg.sv. Later tickets add their select enums here.

package vcpu8_types_pkg;

  // ALU operation select. CMP has no entry of its own: the decoder selects ALU_SUB and disables
  // the register write, so CMP sets exactly the flags SUB would.
  typedef enum logic [3:0] {
    ALU_ADD = 4'd0,
    ALU_SUB = 4'd1,
    ALU_MUL = 4'd2,
    ALU_DIV = 4'd3,
    ALU_INC = 4'd4,
    ALU_DEC = 4'd5,
    ALU_AND = 4'd6,
    ALU_OR  = 4'd7,
    ALU_XOR = 4'd8,
    ALU_NOT = 4'd9,
    ALU_SHL = 4'd10,
    ALU_SHR = 4'd11
  } alu_op_t;

  // Decoder selects (vcpu8_decoder). Each enum's 0 value is the decoder's default, so an output
  // the instruction does not use reads 0, and an invalid opcode drives every select to 0.

  // Register write-back data source. The write address is always field a of the register byte.
  typedef enum logic [1:0] {
    WSEL_ALU = 2'd0,  // alu_r
    WSEL_TB  = 2'd1,  // IR.tb, the trailing byte (LDI's immediate)
    WSEL_MEM = 2'd2,  // ram_rdata (LOAD, POP)
    WSEL_RB  = 2'd3   // rb_data, register port B (MOV)
  } wsel_t;

  // Data-memory address source for a LOAD, STORE, PUSH, POP, CALL or RET access.
  typedef enum logic [2:0] {
    MEM_ADDR_TB  = 3'd0,  // IR.tb, the absolute address byte
    MEM_ADDR_RA  = 3'd1,  // ra_data
    MEM_ADDR_RB  = 3'd2,  // rb_data
    MEM_ADDR_SP  = 3'd3,  // SP (push)
    MEM_ADDR_SP1 = 3'd4   // SP + 1 (pop)
  } mem_addr_sel_t;

  // Data-memory write data source.
  typedef enum logic [1:0] {
    MEM_WDATA_RA       = 2'd0,  // ra_data
    MEM_WDATA_RB       = 2'd1,  // rb_data
    MEM_WDATA_RET_ADDR = 2'd2   // PC + len, CALL's return address
  } mem_wdata_sel_t;

  // SP/SD update: push is SP - 1 and SD + 1, pop is SP + 1 and SD - 1.
  typedef enum logic [1:0] {
    STACK_NONE = 2'd0,
    STACK_PUSH = 2'd1,
    STACK_POP  = 2'd2
  } stack_op_t;

  // Next-PC select.
  typedef enum logic [2:0] {
    PC_SEQ  = 3'd0,  // PC + len
    PC_HOLD = 3'd1,  // unchanged (HLT)
    PC_TB   = 3'd2,  // IR.tb (JMP, CALL)
    PC_COND = 3'd3,  // IR.tb if the branch condition holds, else PC + len
    PC_MEM  = 3'd4   // ram_rdata, the popped return address (RET)
  } pc_sel_t;

  // Branch condition, encoded {flag, value}: cond[1] picks the flag (0 = Z, 1 = C) and cond[0] is
  // the value it must have, so the branch is taken when (cond[1] ? C : Z) == cond[0].
  typedef enum logic [1:0] {
    COND_NZ = 2'b00,
    COND_Z  = 2'b01,
    COND_NC = 2'b10,
    COND_C  = 2'b11
  } cond_t;

  // Control FSM (vcpu8_control). OPERAND1 latches byte 1 and, for a 3-byte instruction, OPERAND2
  // latches byte 2. HALTED and FAULTED are terminal until reset.
  typedef enum logic [2:0] {
    FSM_FETCH     = 3'd0,
    FSM_DECODE    = 3'd1,
    FSM_OPERAND1  = 3'd2,
    FSM_OPERAND2  = 3'd3,
    FSM_EXECUTE   = 3'd4,
    FSM_WRITEBACK = 3'd5,
    FSM_HALTED    = 3'd6,
    FSM_FAULTED   = 3'd7
  } fsm_state_t;

  // RAM address source, chosen by the FSM state. The FSM maps the decoder's mem_addr_sel_t onto
  // BUS_TB … BUS_SP1 for the data access of EXECUTE and WRITEBACK.
  typedef enum logic [2:0] {
    BUS_PC  = 3'd0,  // opcode fetch; also the idle address
    BUS_PC1 = 3'd1,  // operand byte 1
    BUS_PC2 = 3'd2,  // operand byte 2
    BUS_TB  = 3'd3,  // IR.tb, the absolute address byte
    BUS_RA  = 3'd4,  // ra_data
    BUS_RB  = 3'd5,  // rb_data
    BUS_SP  = 3'd6,  // SP (push)
    BUS_SP1 = 3'd7   // SP + 1 (pop)
  } bus_addr_sel_t;

endpackage
