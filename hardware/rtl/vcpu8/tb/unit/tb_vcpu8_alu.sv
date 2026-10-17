// Exhaustive ALU test: vcpu8_alu against vectors generated from the TypeScript ALU.
//
// `pnpm --filter @vcpu/rtl-tools gen:alu-vectors` writes build/vectors/alu.hex by calling
// ALU_OPERATIONS in @vcpu/cpu-core, so every expected value here came from executing the
// reference. Each 36-bit record is {op[3:0], a, b, flags_in[3:0], r, flags[3:0]}, flags as ZCNV;
// op is the alu_op_t value, or VEC_OP_CMP for CMP, which drives ALU_SUB. alu.meta beside the
// vectors holds the record count.
//
// Plusargs: +vectors=<alu.hex> (required); +meta=<file> (default: the vectors path with .meta).
//
// The test also runs named directed checks (looked up in the vectors, so their expected values
// still come from TypeScript) and sweeps DIV with b = 0 for X/Z outputs; TypeScript faults on
// b = 0, so those outputs are never compared. It prints the totals and the first MAX_REPORTED
// mismatches, and exits non-zero ($fatal) if anything failed.

module tb_vcpu8_alu;
  localparam int         MAX_VECTORS  = 1 << 20;
  localparam int         MAX_REPORTED = 20;
  localparam logic [3:0] VEC_OP_CMP   = 4'hF;  // VEC_OP_CMP in packages/rtl-tools/src/gen/alu-vectors.ts
  // Fills the array before $readmemh, so a short or long alu.hex is caught. No real record has it:
  // CMP vectors are generated with flags_in = 0.
  localparam logic [35:0] NO_RECORD   = '1;

  logic [35:0] vectors [MAX_VECTORS];

  logic [7:0]               a;
  logic [7:0]               b;
  vcpu8_types_pkg::alu_op_t op;
  logic                     c_in;
  logic [7:0]               r;
  logic                     z;
  logic                     c;
  logic                     n;
  logic                     v;

  // The default ALU (DIV_ITER = 0), with its combinational divider; it ignores div_q.
  vcpu8_alu dut (.a(a), .b(b), .op(op), .c_in(c_in), .div_q(8'h00), .r(r), .z(z), .c(c), .n(n), .v(v));

  // The ALU's flags packed as a FLAGS nibble, positions from the generated ISA package.
  function automatic logic [3:0] flags_of(input logic fz, input logic fc, input logic fn,
                                          input logic fv);
    logic [3:0] f;
    f = 4'h0;
    f[vcpu8_isa_pkg::FLAG_Z] = fz;
    f[vcpu8_isa_pkg::FLAG_C] = fc;
    f[vcpu8_isa_pkg::FLAG_N] = fn;
    f[vcpu8_isa_pkg::FLAG_V] = fv;
    return f;
  endfunction

  function automatic string op_name(input logic [3:0] vop);
    vcpu8_types_pkg::alu_op_t sel;
    if (vop == VEC_OP_CMP) return "CMP";
    sel = vcpu8_types_pkg::alu_op_t'(vop);
    return sel.name().substr(4, sel.name().len() - 1);  // drop "ALU_"
  endfunction

  function automatic string zcnv(input logic [3:0] f);
    return $sformatf("%s%s%s%s", f[vcpu8_isa_pkg::FLAG_Z] ? "Z" : "-",
                     f[vcpu8_isa_pkg::FLAG_C] ? "C" : "-", f[vcpu8_isa_pkg::FLAG_N] ? "N" : "-",
                     f[vcpu8_isa_pkg::FLAG_V] ? "V" : "-");
  endfunction

  // Drives one record and returns 1 if r and ZCNV match its expected values.
  task automatic apply(input logic [35:0] rec, output logic ok, output string detail);
    logic [3:0] vop;
    logic [3:0] flags_in;
    logic [7:0] exp_r;
    logic [3:0] exp_f;
    logic [3:0] act_f;
    {vop, a, b, flags_in, exp_r, exp_f} = rec;
    op   = (vop == VEC_OP_CMP) ? vcpu8_types_pkg::ALU_SUB : vcpu8_types_pkg::alu_op_t'(vop);
    c_in = flags_in[vcpu8_isa_pkg::FLAG_C];
    #1;
    act_f  = flags_of(z, c, n, v);
    ok     = (r === exp_r) && (act_f === exp_f);
    detail = $sformatf("op=%s a=%02h b=%02h flags_in=%s: expected r=%02h %s, got r=%02h %s",
                       op_name(vop), a, b, zcnv(flags_in), exp_r, zcnv(exp_f), r, zcnv(act_f));
  endtask

  // Index of the record with these inputs, or -1.
  function automatic int find(input int count, input logic [3:0] vop, input logic [7:0] fa,
                              input logic [7:0] fb, input logic [3:0] flags_in);
    for (int i = 0; i < count; i++) begin
      if (vectors[i][35:12] == {vop, fa, fb, flags_in}) return i;
    end
    return -1;
  endfunction

  typedef struct {
    string      name;
    logic [3:0] vop;
    logic [7:0] a;
    logic [7:0] b;
    logic [3:0] flags_in;
  } directed_t;

  localparam logic [3:0] FLAGS_C = 4'(1 << vcpu8_isa_pkg::FLAG_C);

  // The documented edge cases, by name, so a failure among them reads plainly.
  directed_t directed [] = '{
    '{"ADD 7F+01 sets V",            4'(vcpu8_types_pkg::ALU_ADD), 8'h7F, 8'h01, 4'h0},
    '{"ADD FF+01 sets C and Z",      4'(vcpu8_types_pkg::ALU_ADD), 8'hFF, 8'h01, 4'h0},
    '{"SUB 00-01 borrows",           4'(vcpu8_types_pkg::ALU_SUB), 8'h00, 8'h01, 4'h0},
    '{"SUB 80-01 sets V",            4'(vcpu8_types_pkg::ALU_SUB), 8'h80, 8'h01, 4'h0},
    '{"CMP 05-05 sets Z",            VEC_OP_CMP,                   8'h05, 8'h05, 4'h0},
    '{"MUL 10*10 sets C, V and Z",   4'(vcpu8_types_pkg::ALU_MUL), 8'h10, 8'h10, 4'h0},
    '{"INC FF sets Z, C unchanged",  4'(vcpu8_types_pkg::ALU_INC), 8'hFF, 8'h00, FLAGS_C},
    '{"DEC 00 sets N, C unchanged",  4'(vcpu8_types_pkg::ALU_DEC), 8'h00, 8'h00, FLAGS_C},
    '{"SHR 01 sets C and Z",         4'(vcpu8_types_pkg::ALU_SHR), 8'h01, 8'h00, 4'h0}
  };

  initial begin
    string vectors_path;
    string meta_path;
    int    meta_fd;
    int    count;
    int    mismatches;
    int    directed_failures;
    int    unknown_outputs;
    logic  ok;
    string detail;

    if (!$value$plusargs("vectors=%s", vectors_path)) begin
      $fatal(1, "tb_vcpu8_alu: pass +vectors=<path to alu.hex>");
    end
    if (!$value$plusargs("meta=%s", meta_path)) begin
      meta_path = {vectors_path.substr(0, vectors_path.len() - 5), ".meta"};
    end
    meta_fd = $fopen(meta_path, "r");
    if (meta_fd == 0) $fatal(1, "tb_vcpu8_alu: cannot open %s", meta_path);
    if ($fscanf(meta_fd, "%d", count) != 1 || count <= 0 || count >= MAX_VECTORS) begin
      $fatal(1, "tb_vcpu8_alu: %s must hold a record count in 1..%0d", meta_path, MAX_VECTORS - 1);
    end
    $fclose(meta_fd);
    foreach (vectors[i]) vectors[i] = NO_RECORD;
    $readmemh(vectors_path, vectors);
    for (int i = 0; i < count; i++) begin
      if (vectors[i] == NO_RECORD) begin
        $fatal(1, "tb_vcpu8_alu: %s has only %0d of the %0d records %s promises", vectors_path, i,
               count, meta_path);
      end
    end
    if (vectors[count] != NO_RECORD) begin
      $fatal(1, "tb_vcpu8_alu: %s has more than the %0d records %s promises", vectors_path, count, meta_path);
    end

    // Exhaustive sweep.
    mismatches = 0;
    for (int i = 0; i < count; i++) begin
      apply(vectors[i], ok, detail);
      if (!ok) begin
        mismatches++;
        if (mismatches <= MAX_REPORTED) $display("MISMATCH vector %0d: %s", i, detail);
      end
    end
    if (mismatches > MAX_REPORTED) $display("... %0d more mismatches", mismatches - MAX_REPORTED);

    // Directed edge cases.
    directed_failures = 0;
    foreach (directed[k]) begin
      automatic int idx = find(count, directed[k].vop, directed[k].a, directed[k].b,
                               directed[k].flags_in);
      if (idx < 0) begin
        directed_failures++;
        $display("FAIL %s: no such vector", directed[k].name);
      end else begin
        apply(vectors[idx], ok, detail);
        if (!ok) directed_failures++;
        $display("%s %s: %s", ok ? "ok  " : "FAIL", directed[k].name, detail);
      end
    end

    // DIV with b = 0: the result is unused (the control unit faults first) but must be X-free.
    unknown_outputs = 0;
    op   = vcpu8_types_pkg::ALU_DIV;
    b    = 8'h00;
    c_in = 1'b0;
    for (int i = 0; i < 256; i++) begin
      a = 8'(i);
      #1;
      if ($isunknown({r, z, c, n, v})) begin
        unknown_outputs++;
        $display("X/Z: DIV a=%02h b=00 gives r=%02h ZCNV=%b%b%b%b", a, r, z, c, n, v);
      end
    end

    $display("alu: %0d vectors, %0d mismatches; %0d directed checks, %0d failed; DIV b=0 sweep: 256 values, %0d with X/Z outputs",
             count, mismatches, $size(directed), directed_failures, unknown_outputs);
    if (mismatches != 0 || directed_failures != 0 || unknown_outputs != 0) begin
      $fatal(1, "tb_vcpu8_alu: FAILED");
    end
    $display("tb_vcpu8_alu: PASSED");
    $finish;
  end

endmodule
