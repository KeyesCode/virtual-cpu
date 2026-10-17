// VCPU-8 microarchitecture types, written by hand.
//
// Nothing here is part of the ISA. These are internal encodings chosen by this RTL design, and
// another implementation of ISA 1.0.0 may pick different ones. Architectural numbers (opcodes,
// fault and status codes, reset values, flag positions) live only in the generated
// vcpu8_isa_pkg.sv. Later tickets add their select enums here (for example the decoder's
// write-back and address mux selects).

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

endpackage
