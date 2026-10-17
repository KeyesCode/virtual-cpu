// Unit test for vcpu8_decoder (`make -C hardware/rtl/vcpu8 test-decoder`).
//
// Three checks, every one against something outside the RTL:
//   1. Opcode sweep: all 256 opcode bytes against decoder-ops.hex, which @vcpu/rtl-tools derives
//      from OPCODES in @vcpu/shared: valid, len, fields, flag_mask, the control flow (pc_sel and
//      is_halt/is_call/is_ret), the branch condition, mem_read/mem_write against the data reads
//      and writes, and rf_we against "has a dest operand". Invalid bytes must drive everything 0.
//   2. Register-byte sweep: all 65,536 (opcode, rb) pairs against decoder-rb.hex, which records
//      whether cpu-core decode() faults the pair with MALFORMED_OPERAND.
//   3. Directed table: the 30 rows of the decoder table in docs/hardware-porting.md, transcribed
//      below, covering the selects TypeScript has no notion of (alu_op, wsel, the memory address
//      and write-data selects, stack_op). A "—" in the doc is the select's 0 default here.
//
// Prints the first mismatches, naming the opcode, and exits non-zero if there is any.
// Plusargs: +ops=<decoder-ops.hex> +rb=<decoder-rb.hex>.
module tb_vcpu8_decoder;
  import vcpu8_isa_pkg::*;
  import vcpu8_types_pkg::*;

  localparam int OPS_RECORDS = 256;
  localparam int RB_RECORDS  = 65536;
  localparam int MAX_REPORTS = 20;

  logic [7:0]     opcode;
  logic [7:0]     rb;
  logic           valid;
  logic [1:0]     len;
  logic [1:0]     fields;
  logic           rb_malformed;
  logic [2:0]     ra_idx;
  logic [2:0]     rb_idx;
  alu_op_t        alu_op;
  logic           rf_we;
  wsel_t          wsel;
  logic           mem_read;
  logic           mem_write;
  mem_addr_sel_t  mem_addr_sel;
  mem_wdata_sel_t mem_wdata_sel;
  logic [3:0]     flag_mask;
  stack_op_t      stack_op;
  pc_sel_t        pc_sel;
  cond_t          cond;
  logic           is_halt;
  logic           is_call;
  logic           is_ret;
  logic           is_div;

  vcpu8_decoder dut (.*);

  logic [43:0] ops_vec [OPS_RECORDS];
  logic [19:0] rb_vec  [RB_RECORDS];

  int failures = 0;
  int directed_rows = 0;
  int valid_opcodes = 0;
  logic [OPS_RECORDS-1:0] directed_seen = '0;

  // Opcode names for messages. Bytes come from the generated package, never typed here.
  function automatic string op_name(input logic [7:0] op);
    case (op)
      OP_NOP:       op_name = "NOP";
      OP_HLT:       op_name = "HLT";
      OP_MOV:       op_name = "MOV";
      OP_LDI:       op_name = "LDI";
      OP_LOAD_ABS:  op_name = "LOAD_ABS";
      OP_LOAD_IND:  op_name = "LOAD_IND";
      OP_STORE_ABS: op_name = "STORE_ABS";
      OP_STORE_IND: op_name = "STORE_IND";
      OP_ADD:       op_name = "ADD";
      OP_SUB:       op_name = "SUB";
      OP_MUL:       op_name = "MUL";
      OP_DIV:       op_name = "DIV";
      OP_INC:       op_name = "INC";
      OP_DEC:       op_name = "DEC";
      OP_AND:       op_name = "AND";
      OP_OR:        op_name = "OR";
      OP_XOR:       op_name = "XOR";
      OP_NOT:       op_name = "NOT";
      OP_SHL:       op_name = "SHL";
      OP_SHR:       op_name = "SHR";
      OP_CMP:       op_name = "CMP";
      OP_JMP:       op_name = "JMP";
      OP_JZ:        op_name = "JZ";
      OP_JNZ:       op_name = "JNZ";
      OP_JC:        op_name = "JC";
      OP_JNC:       op_name = "JNC";
      OP_CALL:      op_name = "CALL";
      OP_RET:       op_name = "RET";
      OP_PUSH:      op_name = "PUSH";
      OP_POP:       op_name = "POP";
      default:      op_name = "invalid";
    endcase
  endfunction

  // Compares one output; `check` names the sweep, the opcode and the register byte on failure.
  task automatic check(input string sweep, input string signal, input int got, input int expected);
    if (got != expected) begin
      failures++;
      if (failures <= MAX_REPORTS) begin
        $display("MISMATCH %s: opcode 0x%02h (%s) rb 0x%02h: %s = %0d, expected %0d",
                 sweep, opcode, op_name(opcode), rb, signal, got, expected);
      end
    end
  endtask

  // ---- 1. Opcode sweep ------------------------------------------------------------------------

  task automatic sweep_opcodes();
    logic [43:0] rec;
    logic [2:0]  exp_ctrl;
    logic [3:0]  exp_cond;
    pc_sel_t     exp_pc_sel;
    cond_t       exp_cond_sel;
    for (int i = 0; i < OPS_RECORDS; i++) begin
      rec    = ops_vec[i];
      opcode = 8'(i);
      rb     = 8'h00;
      #1;
      check("ops", "record opcode", int'(rec[43:36]), i);
      check("ops", "valid",         int'(valid),      int'(rec[35:32]));
      check("ops", "len",           int'(len),        int'(rec[31:28]));
      check("ops", "fields",        int'(fields),     int'(rec[27:24]));
      check("ops", "flag_mask",     int'(flag_mask),  int'(rec[23:20]));
      check("ops", "mem_read",      int'(mem_read),   int'(rec[11:8]));
      check("ops", "mem_write",     int'(mem_write),  int'(rec[7:4]));
      check("ops", "rf_we",         int'(rf_we),      int'(rec[3:0]));

      check("ops", "record ctrl[3]", int'(rec[19]), 0);
      exp_ctrl = rec[18:16];
      case (exp_ctrl)
        ISA_CTRL_HALT:   exp_pc_sel = PC_HOLD;
        ISA_CTRL_JUMP:   exp_pc_sel = PC_TB;
        ISA_CTRL_BRANCH: exp_pc_sel = PC_COND;
        ISA_CTRL_CALL:   exp_pc_sel = PC_TB;
        ISA_CTRL_RET:    exp_pc_sel = PC_MEM;
        default:         exp_pc_sel = PC_SEQ;
      endcase
      check("ops", "pc_sel",  int'(pc_sel),  int'(exp_pc_sel));
      check("ops", "is_halt", int'(is_halt), int'(exp_ctrl == ISA_CTRL_HALT));
      check("ops", "is_call", int'(is_call), int'(exp_ctrl == ISA_CTRL_CALL));
      check("ops", "is_ret",  int'(is_ret),  int'(exp_ctrl == ISA_CTRL_RET));

      // The record's cond is {flag bit index, value}; a non-branch must read COND_NZ (0).
      exp_cond = rec[15:12];
      if (exp_ctrl != ISA_CTRL_BRANCH) begin
        exp_cond_sel = COND_NZ;
        check("ops", "record cond of a non-branch", int'(exp_cond), 0);
      end else if (int'(exp_cond[2:1]) == FLAG_Z) begin
        exp_cond_sel = exp_cond[0] ? COND_Z : COND_NZ;
      end else if (int'(exp_cond[2:1]) == FLAG_C) begin
        exp_cond_sel = exp_cond[0] ? COND_C : COND_NC;
      end else begin
        exp_cond_sel = COND_NZ;
        check("ops", "branch flag (only Z and C exist)", int'(exp_cond[2:1]), FLAG_Z);
      end
      check("ops", "cond", int'(cond), int'(exp_cond_sel));

      if (valid) begin
        valid_opcodes++;
      end else begin
        // Every enable and select is 0 for a byte that is not an opcode.
        check("ops", "alu_op",        int'(alu_op),        0);
        check("ops", "wsel",          int'(wsel),          0);
        check("ops", "mem_addr_sel",  int'(mem_addr_sel),  0);
        check("ops", "mem_wdata_sel", int'(mem_wdata_sel), 0);
        check("ops", "stack_op",      int'(stack_op),      0);
        check("ops", "is_div",        int'(is_div),        0);
      end
    end
    check("ops", "number of valid opcodes", valid_opcodes, OPCODE_COUNT);
  endtask

  // ---- 2. Register-byte sweep -----------------------------------------------------------------

  task automatic sweep_register_bytes();
    logic [19:0] rec;
    for (int i = 0; i < RB_RECORDS; i++) begin
      rec    = rb_vec[i];
      opcode = 8'(i >> 8);
      rb     = 8'(i);
      #1;
      check("rb", "record {opcode, rb}", int'(rec[19:4]), i);
      check("rb", "rb_malformed", int'(rb_malformed), int'(rec[3:0]));
      check("rb", "ra_idx",       int'(ra_idx),       int'(rb[6:4]));
      check("rb", "rb_idx",       int'(rb_idx),       int'(rb[2:0]));
    end
  endtask

  // ---- 3. Directed table ----------------------------------------------------------------------

  // One row of docs/hardware-porting.md#decoder-decoder, in its column order.
  task automatic row(
    input logic [7:0]     op,
    input int             exp_len,
    input logic [1:0]     exp_fields,
    input alu_op_t        exp_alu,
    input logic           exp_we,
    input wsel_t          exp_wsel,
    input logic           exp_read,
    input logic           exp_write,
    input mem_addr_sel_t  exp_addr,
    input mem_wdata_sel_t exp_wdata,
    input logic [3:0]     exp_mask,
    input stack_op_t      exp_stack,
    input pc_sel_t        exp_pc,
    input cond_t          exp_cond
  );
    opcode = op;
    rb     = 8'h00;
    #1;
    check("directed", "row already listed", int'(directed_seen[op]), 0);
    directed_seen[op] = 1'b1;
    directed_rows++;
    check("directed", "valid",         int'(valid),         1);
    check("directed", "len",           int'(len),           exp_len);
    check("directed", "fields",        int'(fields),        int'(exp_fields));
    check("directed", "alu_op",        int'(alu_op),        int'(exp_alu));
    check("directed", "rf_we",         int'(rf_we),         int'(exp_we));
    check("directed", "wsel",          int'(wsel),          int'(exp_wsel));
    check("directed", "mem_read",      int'(mem_read),      int'(exp_read));
    check("directed", "mem_write",     int'(mem_write),     int'(exp_write));
    check("directed", "mem_addr_sel",  int'(mem_addr_sel),  int'(exp_addr));
    check("directed", "mem_wdata_sel", int'(mem_wdata_sel), int'(exp_wdata));
    check("directed", "flag_mask",     int'(flag_mask),     int'(exp_mask));
    check("directed", "stack_op",      int'(stack_op),      int'(exp_stack));
    check("directed", "pc_sel",        int'(pc_sel),        int'(exp_pc));
    check("directed", "cond",          int'(cond),          int'(exp_cond));
    check("directed", "is_halt",       int'(is_halt),       int'(op == OP_HLT));
    check("directed", "is_call",       int'(is_call),       int'(op == OP_CALL));
    check("directed", "is_ret",        int'(is_ret),        int'(op == OP_RET));
    check("directed", "is_div",        int'(is_div),        int'(exp_alu == ALU_DIV));
  endtask

  localparam logic [1:0] F_NONE = ISA_FIELDS_NONE;
  localparam logic [1:0] F_A    = ISA_FIELDS_A;
  localparam logic [1:0] F_AB   = ISA_FIELDS_AB;

  task automatic directed_table();
    //   op            len fields  alu_op   we wsel      rd wr addr          wdata               mask     stack       pc_sel   cond
    row(OP_NOP,       1, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_HLT,       1, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_HOLD, COND_NZ);
    row(OP_MOV,       2, F_AB,   ALU_ADD, 1, WSEL_RB,  0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_LDI,       3, F_A,    ALU_ADD, 1, WSEL_TB,  0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_LOAD_ABS,  3, F_A,    ALU_ADD, 1, WSEL_MEM, 1, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_LOAD_IND,  2, F_AB,   ALU_ADD, 1, WSEL_MEM, 1, 0, MEM_ADDR_RB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_STORE_ABS, 3, F_A,    ALU_ADD, 0, WSEL_ALU, 0, 1, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_STORE_IND, 2, F_AB,   ALU_ADD, 0, WSEL_ALU, 0, 1, MEM_ADDR_RA,  MEM_WDATA_RB,       4'b0000, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_ADD,       2, F_AB,   ALU_ADD, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_SUB,       2, F_AB,   ALU_SUB, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_MUL,       2, F_AB,   ALU_MUL, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_DIV,       2, F_AB,   ALU_DIV, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_INC,       2, F_A,    ALU_INC, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1011, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_DEC,       2, F_A,    ALU_DEC, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1011, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_AND,       2, F_AB,   ALU_AND, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_OR,        2, F_AB,   ALU_OR,  1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_XOR,       2, F_AB,   ALU_XOR, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_NOT,       2, F_A,    ALU_NOT, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_SHL,       2, F_A,    ALU_SHL, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_SHR,       2, F_A,    ALU_SHR, 1, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_CMP,       2, F_AB,   ALU_SUB, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b1111, STACK_NONE, PC_SEQ,  COND_NZ);
    row(OP_JMP,       2, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_TB,   COND_NZ);
    row(OP_JZ,        2, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_COND, COND_Z);
    row(OP_JNZ,       2, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_COND, COND_NZ);
    row(OP_JC,        2, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_COND, COND_C);
    row(OP_JNC,       2, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 0, MEM_ADDR_TB,  MEM_WDATA_RA,       4'b0000, STACK_NONE, PC_COND, COND_NC);
    row(OP_CALL,      2, F_NONE, ALU_ADD, 0, WSEL_ALU, 0, 1, MEM_ADDR_SP,  MEM_WDATA_RET_ADDR, 4'b0000, STACK_PUSH, PC_TB,   COND_NZ);
    row(OP_RET,       1, F_NONE, ALU_ADD, 0, WSEL_ALU, 1, 0, MEM_ADDR_SP1, MEM_WDATA_RA,       4'b0000, STACK_POP,  PC_MEM,  COND_NZ);
    row(OP_PUSH,      2, F_A,    ALU_ADD, 0, WSEL_ALU, 0, 1, MEM_ADDR_SP,  MEM_WDATA_RA,       4'b0000, STACK_PUSH, PC_SEQ,  COND_NZ);
    row(OP_POP,       2, F_A,    ALU_ADD, 1, WSEL_MEM, 1, 0, MEM_ADDR_SP1, MEM_WDATA_RA,       4'b0000, STACK_POP,  PC_SEQ,  COND_NZ);
  endtask

  // ---- Run ------------------------------------------------------------------------------------

  initial begin
    string ops_file;
    string rb_file;
    if (!$value$plusargs("ops=%s", ops_file) || !$value$plusargs("rb=%s", rb_file)) begin
      $fatal(1, "usage: +ops=<decoder-ops.hex> +rb=<decoder-rb.hex>");
    end
    $readmemh(ops_file, ops_vec);
    $readmemh(rb_file, rb_vec);

    sweep_opcodes();
    sweep_register_bytes();
    directed_table();

    // The directed table must cover the valid opcodes exactly.
    for (int i = 0; i < OPS_RECORDS; i++) begin
      opcode = 8'(i);
      rb     = 8'h00;
      #1;
      check("directed", "row present for each valid opcode", int'(directed_seen[i]), int'(valid));
    end

    if (failures > MAX_REPORTS) begin
      $display("... %0d more mismatches not shown", failures - MAX_REPORTS);
    end
    $display("tb_vcpu8_decoder: %0d opcode records (%0d valid), %0d register-byte records, %0d directed rows, %0d mismatches",
             OPS_RECORDS, valid_opcodes, RB_RECORDS, directed_rows, failures);
    if (failures != 0) begin
      $fatal(1, "tb_vcpu8_decoder: FAIL");
    end
    $display("tb_vcpu8_decoder: PASS");
    $finish;
  end

endmodule
