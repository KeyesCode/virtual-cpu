// Synthesis probe for the ISA and types packages, used by `make check-isa`.
//
// A package's functions are only elaborated where something calls them, so a plain
// `read_verilog -sv` of the package would not catch a function body Yosys cannot synthesize. This
// module calls every lookup function and uses the types package, and check-isa runs `synth` on it.
//
// It also shows the calling convention that works in both Verilator and Yosys: package functions
// are called with an explicit `vcpu8_isa_pkg::` scope. Yosys 0.70 cannot parse an `import` in a
// module header or body, and crashes when a function is called through a file-scope wildcard
// import (localparams and types are fine through one).
module isa_pkg_probe (
  input  logic [7:0]  op,
  output logic [17:0] decoded,
  output logic [3:0]  alu_sel
);
  vcpu8_types_pkg::alu_op_t alu_op;

  assign decoded = {
    vcpu8_isa_pkg::isa_valid(op),
    vcpu8_isa_pkg::isa_len(op),
    vcpu8_isa_pkg::isa_fields(op),
    vcpu8_isa_pkg::isa_flag_mask(op),
    vcpu8_isa_pkg::isa_ctrl(op),
    vcpu8_isa_pkg::isa_cond(op),
    vcpu8_isa_pkg::isa_data_read(op),
    vcpu8_isa_pkg::isa_data_write(op),
    op == vcpu8_isa_pkg::OP_HLT
  };

  assign alu_op  = (op == vcpu8_isa_pkg::OP_CMP) ? vcpu8_types_pkg::ALU_SUB : vcpu8_types_pkg::ALU_ADD;
  assign alu_sel = alu_op;
endmodule
