// vcpu8_sim: run a 256-byte VCPU-8 image on the Verilated RTL until HALTED, FAULTED or a limit.
//
//   vcpu8_sim --image <file.mem.hex> [--max-steps N] [--max-cycles N]
//             [--state <out.json>] [--trace <out.jsonl>] [--quiet]
//
// The image ($readmemh format: 256 lines of two hex digits) is written into the RAM array through
// the wrapper's DPI functions while reset is held, then reset is released and the clock runs.
//
// A step is one retire pulse, or the entry into FAULTED by a precise fault (which does not
// retire), exactly as the emulator counts steps. --max-steps (default 1,000,000) limits steps and
// --max-cycles (default: no limit) limits clock cycles after reset.
//
// --state writes the end state as JSON, format vcpu8-rtl-state/1. --trace writes one JSON line per
// step with the fields of the fixture trace (fixtures/README.md) plus `cycle`, the clock count when
// the step completed. Without --quiet a readable summary goes to stdout.
//
// Exit status: 0 when the run completed (whatever the stop reason), 2 for a malformed argument,
// an unreadable or malformed image, or an output file that cannot be written.

#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "Vvcpu8_sim_top.h"
#include "Vvcpu8_sim_top__Dpi.h"
#include "svdpi.h"
#include "verilated.h"

namespace {

constexpr int kMemorySize = 256;

// Status and fault names for the JSON outputs, indexed by their 3-bit hardware numbers
// (CPU_STATUS_NUMBERS and FAULT_CODE_NUMBERS in @vcpu/shared, vcpu8_isa_pkg in the RTL). The
// fixture check compares these names with the emulator's, and the fixtures end in every status
// and every fault code, so a wrong entry here fails `make test`.
constexpr int kStatusReady = 0;
constexpr int kStatusHalted = 3;
constexpr int kStatusFaulted = 4;
const char* const kStatusNames[8] = {"READY",   "RUNNING", "PAUSED",  "HALTED",
                                     "FAULTED", "UNKNOWN5", "UNKNOWN6", "UNKNOWN7"};
const char* const kFaultNames[8] = {"NONE",
                                    "INVALID_OPCODE",
                                    "MALFORMED_OPERAND",
                                    "INSTRUCTION_OVERRUN",
                                    "PC_OVERFLOW",
                                    "DIVIDE_BY_ZERO",
                                    "STACK_OVERFLOW",
                                    "STACK_UNDERFLOW"};

struct Options {
  std::string image;
  std::string state;
  std::string trace;
  uint64_t max_steps = 1000000;
  uint64_t max_cycles = 0;  // 0: no limit
  bool quiet = false;
};

struct MemWrite {
  int address;
  int value;
};

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "vcpu8_sim: " << message << "\n"
            << "usage: vcpu8_sim --image <file.mem.hex> [--max-steps N] [--max-cycles N]"
               " [--state <out.json>] [--trace <out.jsonl>] [--quiet]\n";
  std::exit(2);
}

uint64_t parse_count(const std::string& flag, const char* text) {
  if (text == nullptr || *text == '\0') fail(flag + " needs a value");
  for (const char* p = text; *p != '\0'; ++p) {
    if (*p < '0' || *p > '9') fail(flag + ": not a non-negative integer: " + text);
  }
  errno = 0;
  const unsigned long long value = std::strtoull(text, nullptr, 10);
  if (errno != 0) fail(flag + ": out of range: " + text);
  return value;
}

Options parse_args(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    const char* value = i + 1 < argc ? argv[i + 1] : nullptr;
    if (arg == "--image" || arg == "--state" || arg == "--trace") {
      if (value == nullptr) fail(arg + " needs a value");
      (arg == "--image" ? options.image : arg == "--state" ? options.state : options.trace) = value;
      ++i;
    } else if (arg == "--max-steps") {
      options.max_steps = parse_count(arg, value);
      if (options.max_steps == 0) fail("--max-steps must be at least 1");
      ++i;
    } else if (arg == "--max-cycles") {
      options.max_cycles = parse_count(arg, value);
      ++i;
    } else if (arg == "--quiet") {
      options.quiet = true;
    } else if (arg.rfind("+verilator", 0) == 0) {
      // Verilator runtime options pass through.
    } else {
      fail("unexpected argument " + arg);
    }
  }
  if (options.image.empty()) fail("--image is required");
  return options;
}

int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

// Exactly 256 lines, each one byte as two hex digits; a final newline is optional.
std::vector<int> read_image(const std::string& path) {
  std::ifstream in(path);
  if (!in) fail("cannot read image " + path + ": " + std::strerror(errno));
  std::vector<int> bytes;
  std::string line;
  int number = 0;
  while (std::getline(in, line)) {
    ++number;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    const int hi = line.size() == 2 ? hex_digit(line[0]) : -1;
    const int lo = line.size() == 2 ? hex_digit(line[1]) : -1;
    if (hi < 0 || lo < 0) {
      fail(path + ":" + std::to_string(number) + ": expected one byte as two hex digits, got \"" +
           line + "\"");
    }
    bytes.push_back(hi * 16 + lo);
  }
  if (bytes.size() != kMemorySize) {
    fail(path + ": expected " + std::to_string(kMemorySize) + " lines, got " +
         std::to_string(bytes.size()));
  }
  return bytes;
}

std::string json_string(const std::string& text) { return "\"" + text + "\""; }

std::string json_bytes(const std::vector<int>& values) {
  std::string out = "[";
  for (size_t i = 0; i < values.size(); ++i) {
    if (i > 0) out += ",";
    out += std::to_string(values[i]);
  }
  return out + "]";
}

class Sim {
 public:
  explicit Sim(const Options& options) : options_(options) {
    context_->commandArgs(0, static_cast<const char**>(nullptr));
    top_ = std::make_unique<Vvcpu8_sim_top>(context_.get(), "TOP");
  }

  ~Sim() { top_->final(); }

  void load(const std::vector<int>& image) {
    top_->clk = 0;
    top_->rst = 1;
    top_->eval();
    svSetScope(svGetScopeFromName("TOP.vcpu8_sim_top"));
    for (int a = 0; a < kMemorySize; ++a) vcpu8_mem_write(a, static_cast<char>(image[a]));
    // Hold reset for two clock edges, then release it while the clock is low.
    for (int i = 0; i < 2; ++i) tick();
    top_->rst = 0;
    top_->eval();
  }

  // Runs to a stop and returns its reason.
  std::string run(std::ostream* trace) {
    int previous_status = top_->status;
    while (true) {
      // The clock is low and the inputs have settled: a write on the bus happens at the next edge.
      if (top_->mem_we) writes_.push_back({top_->mem_addr, top_->mem_wdata});
      tick_high();
      ++cycles_;

      const bool precise_fault = top_->status == kStatusFaulted &&
                                 previous_status != kStatusFaulted && !top_->retire;
      if (top_->retire || precise_fault) {
        const int pc = top_->retire ? top_->retire_pc : top_->fault_pc;
        if (trace != nullptr) *trace << trace_line(pc) << "\n";
        writes_.clear();
        ++steps_;
      }
      previous_status = top_->status;
      tick_low();

      if (top_->status == kStatusHalted) return "halted";
      if (top_->status == kStatusFaulted) return "faulted";
      if (steps_ >= options_.max_steps) return "max_steps";
      if (options_.max_cycles != 0 && cycles_ >= options_.max_cycles) return "max_cycles";
    }
  }

  std::vector<int> registers() const {
    std::vector<int> regs(8);
    for (int i = 0; i < 8; ++i) regs[i] = static_cast<int>((top_->dbg_regs >> (8 * i)) & 0xFF);
    return regs;
  }

  std::vector<int> memory() const {
    std::vector<int> bytes(kMemorySize);
    for (int a = 0; a < kMemorySize; ++a) bytes[a] = static_cast<uint8_t>(vcpu8_mem_read(a));
    return bytes;
  }

  std::string state_json(const std::string& stop_reason) const {
    std::ostringstream out;
    out << "{\n"
        << "  \"format\": \"vcpu8-rtl-state/1\",\n"
        << "  \"status\": " << json_string(status_name()) << ",\n"
        << "  \"fault\": " << fault_json() << ",\n"
        << "  \"instructions\": " << top_->instret << ",\n"
        << "  \"steps\": " << steps_ << ",\n"
        << "  \"cycles\": " << cycles_ << ",\n"
        << "  \"registers\": " << json_bytes(registers()) << ",\n"
        << "  \"pc\": " << static_cast<int>(top_->dbg_pc) << ",\n"
        << "  \"sp\": " << static_cast<int>(top_->dbg_sp) << ",\n"
        << "  \"sd\": " << static_cast<int>(top_->dbg_sd) << ",\n"
        << "  \"flags\": " << static_cast<int>(top_->dbg_flags) << ",\n"
        << "  \"memory\": " << json_bytes(memory()) << ",\n"
        << "  \"stopReason\": " << json_string(stop_reason) << "\n"
        << "}\n";
    return out.str();
  }

  void print_summary(std::ostream& out, const std::string& stop_reason) const {
    char line[160];
    const int flags = top_->dbg_flags;
    out << "image         " << options_.image << "\n"
        << "status        " << status_name() << "\n";
    if (top_->status == kStatusFaulted) {
      std::snprintf(line, sizeof line, "fault         %s (%d) at 0x%02X\n",
                    kFaultNames[top_->fault_code & 7], top_->fault_code, top_->fault_pc);
      out << line;
    } else {
      out << "fault         none\n";
    }
    out << "stop reason   " << stop_reason << "\n"
        << "instructions  " << top_->instret << "\n"
        << "steps         " << steps_ << "\n"
        << "cycles        " << cycles_ << "\n";
    const std::vector<int> regs = registers();
    out << "registers    ";
    for (int i = 0; i < 8; ++i) {
      std::snprintf(line, sizeof line, " R%d=0x%02X", i, regs[i]);
      out << line;
    }
    std::snprintf(line, sizeof line,
                  "\nPC=0x%02X  SP=0x%02X  SD=%d  FLAGS=0x%02X (Z=%d C=%d N=%d V=%d)\n",
                  top_->dbg_pc, top_->dbg_sp, top_->dbg_sd, flags, (flags >> 3) & 1,
                  (flags >> 2) & 1, (flags >> 1) & 1, flags & 1);
    out << line << "memory\n     ";
    for (int c = 0; c < 16; ++c) {
      std::snprintf(line, sizeof line, " %2X", c);
      out << line;
    }
    const std::vector<int> bytes = memory();
    for (int row = 0; row < 16; ++row) {
      std::snprintf(line, sizeof line, "\n  %X0 ", row);
      out << line;
      for (int c = 0; c < 16; ++c) {
        std::snprintf(line, sizeof line, " %02X", bytes[row * 16 + c]);
        out << line;
      }
    }
    out << "\n";
  }

 private:
  void tick_high() {
    top_->clk = 1;
    top_->eval();
  }
  void tick_low() {
    top_->clk = 0;
    top_->eval();
  }
  void tick() {
    tick_high();
    tick_low();
  }

  std::string status_name() const { return kStatusNames[top_->status & 7]; }

  std::string fault_json() const {
    if (top_->status != kStatusFaulted) return "null";
    std::ostringstream out;
    out << "{\"code\": " << json_string(kFaultNames[top_->fault_code & 7])
        << ", \"number\": " << static_cast<int>(top_->fault_code)
        << ", \"pc\": " << static_cast<int>(top_->fault_pc) << "}";
    return out.str();
  }

  // The state after the step that just completed, in the fixture trace's field order.
  std::string trace_line(int pc) const {
    std::vector<int> ir = {top_->dbg_ir_op};
    if (top_->dbg_ir_len >= 2) ir.push_back(top_->dbg_ir_rb);
    if (top_->dbg_ir_len >= 3) ir.push_back(top_->dbg_ir_tb);
    std::ostringstream out;
    out << "{\"step\":" << steps_ << ",\"pc\":" << pc << ",\"ir\":" << json_bytes(ir)
        << ",\"status\":" << json_string(status_name()) << ",\"fault\":"
        << (top_->status == kStatusFaulted ? json_string(kFaultNames[top_->fault_code & 7])
                                           : "null")
        << ",\"regs\":" << json_bytes(registers())
        << ",\"flags\":" << static_cast<int>(top_->dbg_flags)
        << ",\"sp\":" << static_cast<int>(top_->dbg_sp)
        << ",\"sd\":" << static_cast<int>(top_->dbg_sd)
        << ",\"nextPc\":" << static_cast<int>(top_->dbg_pc) << ",\"memWrites\":[";
    for (size_t i = 0; i < writes_.size(); ++i) {
      if (i > 0) out << ",";
      out << "{\"address\":" << writes_[i].address << ",\"value\":" << writes_[i].value << "}";
    }
    out << "],\"cycle\":" << cycles_ << "}";
    return out.str();
  }

  const Options& options_;
  std::unique_ptr<VerilatedContext> context_ = std::make_unique<VerilatedContext>();
  std::unique_ptr<Vvcpu8_sim_top> top_;
  std::vector<MemWrite> writes_;
  uint64_t steps_ = 0;
  uint64_t cycles_ = 0;
};

void write_file(const std::string& path, const std::string& text) {
  std::ofstream out(path);
  out << text;
  if (!out) fail("cannot write " + path);
}

}  // namespace

int main(int argc, char** argv) {
  const Options options = parse_args(argc, argv);
  const std::vector<int> image = read_image(options.image);

  Sim sim(options);
  sim.load(image);

  std::ofstream trace_file;
  if (!options.trace.empty()) {
    trace_file.open(options.trace);
    if (!trace_file) fail("cannot write " + options.trace);
  }
  const std::string stop_reason = sim.run(options.trace.empty() ? nullptr : &trace_file);
  trace_file.close();
  if (!options.trace.empty() && !trace_file) fail("cannot write " + options.trace);

  if (!options.state.empty()) write_file(options.state, sim.state_json(stop_reason));
  if (!options.quiet) sim.print_summary(std::cout, stop_reason);
  return 0;
}
