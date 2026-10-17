// VCPU-8 core: the control FSM, decoder, register file, FLAGS and ALU, and the datapath muxes
// between them. The RAM is outside, on the memory bus (vcpu8_top joins the two).
//
// The datapath has three muxes besides the next-PC mux inside vcpu8_control
// (docs/hardware/datapath.md draws them):
//   - RAM address:        PC, PC+1, PC+2, IR.tb, ra_data, rb_data, SP, SP+1 (bus_addr_sel)
//   - RAM write data:     ra_data, rb_data, PC+2 = CALL's return address (mem_wdata_sel)
//   - register write data: alu_r, IR.tb, mem_rdata, rb_data (wsel)
// The register file's read ports are addressed by the register byte's fields a and b, and its
// write port always writes field a.
//
// Everything below "Retirement and debug" is a plain output for testbenches, the RTL runner and
// formal properties. Left unconnected, synthesis removes the logic only they use.
module vcpu8_core (
  input  logic        clk,
  input  logic        rst,

  // Memory bus: one shared port for fetches and data (vcpu8_memory).
  output logic [7:0]  mem_addr,
  output logic        mem_we,
  output logic [7:0]  mem_wdata,
  input  logic [7:0]  mem_rdata,

  // Status.
  output logic [2:0]  status,       // vcpu8_isa_pkg::STATUS_READY, _HALTED or _FAULTED
  output logic [2:0]  fault_code,   // vcpu8_isa_pkg::FAULT_*; FAULT_NONE until a fault
  output logic [7:0]  fault_pc,

  // Retirement and debug.
  output logic        retire,       // one cycle after each instruction's WRITEBACK edge
  output logic [7:0]  retire_pc,
  output logic [7:0]  retire_op,
  output logic [31:0] instret,
  output logic [63:0] dbg_regs,     // packed R7..R0; R0 is bits 7:0
  output logic [7:0]  dbg_pc,
  output logic [7:0]  dbg_sp,
  output logic [6:0]  dbg_sd,
  output logic [7:0]  dbg_flags,    // the FLAGS byte {4'h0, Z, C, N, V}
  output logic [2:0]  dbg_state,    // vcpu8_types_pkg::fsm_state_t
  output logic [7:0]  dbg_ir_op,
  output logic [7:0]  dbg_ir_rb,
  output logic [7:0]  dbg_ir_tb,
  output logic [1:0]  dbg_ir_len    // bytes fetched: [op], [op, rb] or [op, rb, tb]
);
  // Decoder.
  logic [7:0]                      dec_opcode, dec_rb;
  logic                            dec_valid, dec_rb_malformed, dec_rf_we, dec_mem_read, dec_mem_write;
  logic [1:0]                      dec_len, dec_fields;
  logic [2:0]                      ra_idx, rb_idx;
  vcpu8_types_pkg::alu_op_t        dec_alu_op;
  vcpu8_types_pkg::wsel_t          dec_wsel;
  vcpu8_types_pkg::mem_addr_sel_t  dec_mem_addr_sel;
  vcpu8_types_pkg::mem_wdata_sel_t dec_mem_wdata_sel;
  logic [3:0]                      dec_flag_mask;
  vcpu8_types_pkg::stack_op_t      dec_stack_op;
  vcpu8_types_pkg::pc_sel_t        dec_pc_sel;
  vcpu8_types_pkg::cond_t          dec_cond;
  logic                            dec_is_halt, dec_is_call, dec_is_ret, dec_is_div;

  // Control.
  vcpu8_types_pkg::bus_addr_sel_t  bus_addr_sel;
  vcpu8_types_pkg::fsm_state_t     state;
  logic                            rf_we;
  logic [3:0]                      flags_mask;
  logic [7:0]                      pc, sp, ir_op, ir_rb, ir_tb;
  logic [6:0]                      sd;
  logic [1:0]                      ir_len;

  // Datapath.
  logic [7:0]                      ra_data, rb_data, rf_wd;
  logic [7:0]                      alu_r;
  logic                            alu_z, alu_c, alu_n, alu_v;
  logic [3:0]                      flags, alu_flags;
  logic [7:0]                      flags_byte;

  vcpu8_decoder u_decoder (
    .opcode        (dec_opcode),
    .rb            (dec_rb),
    .valid         (dec_valid),
    .len           (dec_len),
    .fields        (dec_fields),
    .rb_malformed  (dec_rb_malformed),
    .ra_idx        (ra_idx),
    .rb_idx        (rb_idx),
    .alu_op        (dec_alu_op),
    .rf_we         (dec_rf_we),
    .wsel          (dec_wsel),
    .mem_read      (dec_mem_read),
    .mem_write     (dec_mem_write),
    .mem_addr_sel  (dec_mem_addr_sel),
    .mem_wdata_sel (dec_mem_wdata_sel),
    .flag_mask     (dec_flag_mask),
    .stack_op      (dec_stack_op),
    .pc_sel        (dec_pc_sel),
    .cond          (dec_cond),
    .is_halt       (dec_is_halt),
    .is_call       (dec_is_call),
    .is_ret        (dec_is_ret),
    .is_div        (dec_is_div)
  );

  // The FSM needs neither: register-byte validity arrives as rb_malformed, and RET is handled
  // through stack_op and pc_sel like any other pop and transfer.
  logic unused_dec;
  assign unused_dec = &{1'b0, dec_fields, dec_is_ret};

  vcpu8_control u_control (
    .clk               (clk),
    .rst               (rst),
    .mem_rdata         (mem_rdata),
    .dec_opcode        (dec_opcode),
    .dec_rb            (dec_rb),
    .dec_valid         (dec_valid),
    .dec_len           (dec_len),
    .dec_rb_malformed  (dec_rb_malformed),
    .dec_rf_we         (dec_rf_we),
    .dec_mem_read      (dec_mem_read),
    .dec_mem_write     (dec_mem_write),
    .dec_mem_addr_sel  (dec_mem_addr_sel),
    .dec_flag_mask     (dec_flag_mask),
    .dec_stack_op      (dec_stack_op),
    .dec_pc_sel        (dec_pc_sel),
    .dec_cond          (dec_cond),
    .dec_is_halt       (dec_is_halt),
    .dec_is_call       (dec_is_call),
    .dec_is_div        (dec_is_div),
    .rb_data           (rb_data),
    .flags             (flags),
    .bus_addr_sel      (bus_addr_sel),
    .mem_we            (mem_we),
    .rf_we             (rf_we),
    .flags_mask        (flags_mask),
    .state             (state),
    .pc                (pc),
    .sp                (sp),
    .sd                (sd),
    .ir_op             (ir_op),
    .ir_rb             (ir_rb),
    .ir_tb             (ir_tb),
    .ir_len            (ir_len),
    .status            (status),
    .fault_code        (fault_code),
    .fault_pc          (fault_pc),
    .retire            (retire),
    .retire_pc         (retire_pc),
    .retire_op         (retire_op),
    .instret           (instret)
  );

  vcpu8_registers u_registers (
    .clk      (clk),
    .rst      (rst),
    .ra_addr  (ra_idx),
    .rb_addr  (rb_idx),
    .ra_data  (ra_data),
    .rb_data  (rb_data),
    .we       (rf_we),
    .wa       (ra_idx),
    .wd       (rf_wd),
    .dbg_regs (dbg_regs)
  );

  // Port A is the first operand and port B the second; INC, DEC, NOT, SHL and SHR ignore b.
  vcpu8_alu u_alu (
    .a    (ra_data),
    .b    (rb_data),
    .op   (dec_alu_op),
    .c_in (flags[vcpu8_isa_pkg::FLAG_C]),
    .r    (alu_r),
    .z    (alu_z),
    .c    (alu_c),
    .n    (alu_n),
    .v    (alu_v)
  );

  always_comb begin
    alu_flags         = 4'h0;
    alu_flags[vcpu8_isa_pkg::FLAG_Z] = alu_z;
    alu_flags[vcpu8_isa_pkg::FLAG_C] = alu_c;
    alu_flags[vcpu8_isa_pkg::FLAG_N] = alu_n;
    alu_flags[vcpu8_isa_pkg::FLAG_V] = alu_v;
  end

  vcpu8_flags u_flags (
    .clk        (clk),
    .rst        (rst),
    .mask       (flags_mask),
    .new_flags  (alu_flags),
    .flags      (flags),
    .flags_byte (flags_byte)
  );

  // RAM address mux.
  always_comb begin
    case (bus_addr_sel)
      vcpu8_types_pkg::BUS_PC1: mem_addr = pc + 8'd1;
      vcpu8_types_pkg::BUS_PC2: mem_addr = pc + 8'd2;
      vcpu8_types_pkg::BUS_TB:  mem_addr = ir_tb;
      vcpu8_types_pkg::BUS_RA:  mem_addr = ra_data;
      vcpu8_types_pkg::BUS_RB:  mem_addr = rb_data;
      vcpu8_types_pkg::BUS_SP:  mem_addr = sp;
      vcpu8_types_pkg::BUS_SP1: mem_addr = sp + 8'd1;
      default: mem_addr = pc;
    endcase
  end

  // RAM write-data mux. CALL is two bytes long, so its return address is PC + 2.
  always_comb begin
    case (dec_mem_wdata_sel)
      vcpu8_types_pkg::MEM_WDATA_RB:       mem_wdata = rb_data;
      vcpu8_types_pkg::MEM_WDATA_RET_ADDR: mem_wdata = pc + 8'd2;
      default:            mem_wdata = ra_data;
    endcase
  end

  // Register write-data mux.
  always_comb begin
    case (dec_wsel)
      vcpu8_types_pkg::WSEL_TB:  rf_wd = ir_tb;
      vcpu8_types_pkg::WSEL_MEM: rf_wd = mem_rdata;
      vcpu8_types_pkg::WSEL_RB:  rf_wd = rb_data;
      default:  rf_wd = alu_r;
    endcase
  end

  assign dbg_pc     = pc;
  assign dbg_sp     = sp;
  assign dbg_sd     = sd;
  assign dbg_flags  = flags_byte;
  assign dbg_state  = state;
  assign dbg_ir_op  = ir_op;
  assign dbg_ir_rb  = ir_rb;
  assign dbg_ir_tb  = ir_tb;
  assign dbg_ir_len = ir_len;
endmodule
