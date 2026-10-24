// matmul_sim: run one matmul case on the Verilated matmul_top (through matmul_sim_top.sv) the way
// a host would, and write C and the clock counts.
//
//   matmul_sim --case <file.in> [--out <file.out>] [--cycles <file.json>] [--repeat N]
//              [--reset-between] [--abort-first] [--max-cycles N] [--wave <file.vcd>] [--quiet]
//   matmul_sim --info
//
// The case is the vector format of docs/hardware/accelerators/architecture.md: `M N K` on line 1,
// then the M·K values of A and the K·N values of B, row-major, one decimal integer per line. The
// array size is the build's (make sim ROWS=…: build/sim-<R>x<C>/matmul_sim); --info prints it as
// JSON. One run is, clock by clock (every count below is rising clock edges):
//
//   1. transfer in: A and B through the host port, both write ports in parallel, one element per
//      port per clock: max(M·K, K·N) clocks;
//   2. start: one clock with start high and cfg_m/n/k;
//   3. busy: the clocks busy is high, until the one-clock done pulse (or until error rises, or
//      until --max-cycles clocks after start, default 1,000,000: a timeout). The controller's
//      cycles_compute and cycles_store counters are read at done; busy = compute + store + the
//      LOAD clock and one NEXT_TILE clock per tile;
//   4. transfer out: C through the registered host read port, M·N + 1 clocks, the first of them
//      the done clock.
//
// total = transferIn + 1 + busy + transferOut. The outputs:
//
//   --out     C of the last run, M·N decimal INT32s row-major (the `.expected` format); empty when
//             a run did not reach done.
//   --cycles  JSON, schemaVersion 1: the array (rows, cols, maxDim), m, n, k, macs (M·N·K, one MAC
//             = one multiply plus one accumulate), tiles, transferIn, compute, store, busy,
//             transferOut, total (of the last run), stop ("done", "error" or "timeout", of the
//             first run that did not reach done), error (null or the error_code name), repeat,
//             resetBetween, abortFirst and runsDiffering (how many runs after the first produced a
//             different C or different clock counts than the first).
//
// --repeat N (default 1) runs the case N times in this one process, rewriting A and B each time;
// without --reset-between there is no reset between runs (the second start comes after the first
// run's C was read), with it reset is held for two clocks before every run after the first.
// --abort-first first starts the case once and asserts reset in the first STORE clock (part of C
// is stored), then runs it --repeat times: reset in the middle of a run, then a clean restart.
//
// Dimensions are 0 … 65535 (cfg_* are 16 bits) so an invalid one reaches the controller's error
// path; A and B elements outside the MAX_DIM × MAX_DIM buffers are not written.
//
// --wave writes a VCD of every signal of every run. Only a tracing build (Verilator --trace) has
// it; this build rejects the flag, so verify never pays for tracing. Time is in ns, the clock
// period 10 ns, a rising edge at every multiple of 10 ns.
//
// Exit status: 0 when every run completed (whatever its stop reason: the cycles JSON records it),
// 2 for a malformed argument, an unreadable or malformed case file, or an output that cannot be
// written.

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "Vmatmul_sim_top.h"
#include "verilated.h"
#if VM_TRACE
#include "verilated_vcd_c.h"
#endif

namespace {

constexpr uint64_t kHalfPeriodNs = 5;
constexpr uint64_t kMaxCfg = 0xFFFF;
// matmul_pkg::ctrl_state_t STORE and error_code_t names, by their hardware numbers.
constexpr int kStateStore = 5;
const char* const kErrorNames[4] = {"ERR_NONE", "ERR_DIM_ZERO", "ERR_DIM_TOO_LARGE", "ERR_3"};

const char* const kUsage =
    "usage: matmul_sim --case <file.in> [--out <file.out>] [--cycles <file.json>] [--repeat N]"
    " [--reset-between] [--abort-first] [--max-cycles N] [--wave <file.vcd>] [--quiet]\n"
    "       matmul_sim --info\n";

struct Options {
  std::string case_file;
  std::string out;
  std::string cycles;
  std::string wave;
  uint64_t repeat = 1;
  uint64_t max_cycles = 1000000;
  bool reset_between = false;
  bool abort_first = false;
  bool quiet = false;
  bool info = false;
};

struct Case {
  uint64_t m = 0, n = 0, k = 0;
  std::vector<int> a;  // M × K, row-major
  std::vector<int> b;  // K × N, row-major
};

// One run's clock counts and result.
struct Run {
  std::string stop = "done";
  int error_code = 0;
  uint64_t transfer_in = 0, compute = 0, store = 0, busy = 0, transfer_out = 0;
  std::vector<int32_t> c;

  uint64_t total() const { return transfer_in + 1 + busy + transfer_out; }
  bool same_as(const Run& other) const {
    return stop == other.stop && error_code == other.error_code &&
           transfer_in == other.transfer_in && compute == other.compute &&
           store == other.store && busy == other.busy && transfer_out == other.transfer_out &&
           c == other.c;
  }
};

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "matmul_sim: " << message << "\n" << kUsage;
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
    if (arg == "--case" || arg == "--out" || arg == "--cycles") {
      if (value == nullptr) fail(arg + " needs a value");
      (arg == "--case" ? options.case_file : arg == "--out" ? options.out : options.cycles) = value;
      ++i;
    } else if (arg == "--wave") {
      if (value == nullptr) fail(arg + " needs a value");
#if !VM_TRACE
      fail("--wave needs a tracing build of the runner (Verilator --trace)");
#endif
      options.wave = value;
      ++i;
    } else if (arg == "--repeat") {
      options.repeat = parse_count(arg, value);
      if (options.repeat == 0) fail("--repeat must be at least 1");
      ++i;
    } else if (arg == "--max-cycles") {
      options.max_cycles = parse_count(arg, value);
      if (options.max_cycles == 0) fail("--max-cycles must be at least 1");
      ++i;
    } else if (arg == "--reset-between") {
      options.reset_between = true;
    } else if (arg == "--abort-first") {
      options.abort_first = true;
    } else if (arg == "--quiet") {
      options.quiet = true;
    } else if (arg == "--info") {
      options.info = true;
    } else if (arg.rfind("+verilator", 0) == 0) {
      // Verilator runtime options pass through.
    } else {
      fail("unexpected argument " + arg);
    }
  }
  if (!options.info && options.case_file.empty()) fail("--case is required");
  return options;
}

// A decimal integer filling the whole of `text`, or false.
bool parse_int(const std::string& text, long long* value) {
  if (text.empty()) return false;
  size_t i = text[0] == '-' ? 1 : 0;
  if (i == text.size() || text.size() - i > 12) return false;
  for (size_t j = i; j < text.size(); ++j) {
    if (text[j] < '0' || text[j] > '9') return false;
  }
  *value = std::strtoll(text.c_str(), nullptr, 10);
  return true;
}

Case read_case(const std::string& path) {
  std::ifstream in(path);
  if (!in) fail("cannot read case " + path + ": " + std::strerror(errno));
  Case c;
  std::string line;
  if (!std::getline(in, line)) fail(path + ":1: expected 'M N K', got an empty file");
  if (!line.empty() && line.back() == '\r') line.pop_back();
  {
    std::istringstream header(line);
    std::string fields[3], extra;
    long long dims[3] = {0, 0, 0};
    header >> fields[0] >> fields[1] >> fields[2];
    bool ok = !(header >> extra);
    for (int d = 0; d < 3 && ok; ++d) {
      ok = parse_int(fields[d], &dims[d]) && dims[d] >= 0 &&
           dims[d] <= static_cast<long long>(kMaxCfg);
    }
    if (!ok) fail(path + ":1: expected 'M N K' (each 0 … 65535), got \"" + line + "\"");
    c.m = static_cast<uint64_t>(dims[0]);
    c.n = static_cast<uint64_t>(dims[1]);
    c.k = static_cast<uint64_t>(dims[2]);
  }
  const uint64_t a_count = c.m * c.k;
  const uint64_t b_count = c.k * c.n;
  std::vector<int> values;
  int number = 1;
  while (std::getline(in, line)) {
    ++number;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    long long value = 0;
    if (!parse_int(line, &value) || value < -128 || value > 127) {
      fail(path + ":" + std::to_string(number) + ": expected one INT8 (-128 … 127), got \"" +
           line + "\"");
    }
    if (values.size() >= a_count + b_count) {
      fail(path + ": more than the " + std::to_string(a_count) + " values of A and " +
           std::to_string(b_count) + " of B");
    }
    values.push_back(static_cast<int>(value));
  }
  if (values.size() != a_count + b_count) {
    fail(path + ": expected " + std::to_string(a_count) + " values of A and " +
         std::to_string(b_count) + " of B, got " + std::to_string(values.size()) + " values");
  }
  c.a.assign(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(a_count));
  c.b.assign(values.begin() + static_cast<std::ptrdiff_t>(a_count), values.end());
  return c;
}

class Sim {
 public:
  explicit Sim(const Options& options) : options_(options) {
    context_->commandArgs(0, static_cast<const char**>(nullptr));
#if VM_TRACE
    context_->traceEverOn(true);
#endif
    top_ = std::make_unique<Vmatmul_sim_top>(context_.get(), "TOP");
#if VM_TRACE
    if (!options_.wave.empty()) {
      wave_ = std::make_unique<VerilatedVcdC>();
      top_->trace(wave_.get(), 99);
      wave_->open(options_.wave.c_str());
      if (!wave_->isOpen()) fail("cannot write " + options_.wave);
    }
#endif
    top_->clk = 0;
    top_->rst = 1;
    top_->start = 0;
    top_->host_a_we = 0;
    top_->host_b_we = 0;
    top_->eval();
    dump();
  }

  ~Sim() {
    top_->final();
#if VM_TRACE
    if (wave_) wave_->close();
#endif
  }

  int rows() const { return top_->array_rows; }
  int cols() const { return top_->array_cols; }
  uint64_t max_dim() const { return top_->max_dim; }

  // Holds reset for two clock edges and releases it after the second.
  void reset() {
    top_->rst = 1;
    top_->start = 0;
    top_->host_a_we = 0;
    top_->host_b_we = 0;
    tick();
    tick();
    top_->rst = 0;
  }

  // One run: transfer in, start, busy until done, error or the limit, transfer out. With
  // `abort_in_store`, asserts reset in the first STORE clock instead and returns early.
  Run run(const Case& c, bool abort_in_store) {
    Run r;
    r.transfer_in = load(c);

    top_->cfg_m = static_cast<uint16_t>(c.m);
    top_->cfg_n = static_cast<uint16_t>(c.n);
    top_->cfg_k = static_cast<uint16_t>(c.k);
    top_->start = 1;
    tick();
    top_->start = 0;

    // `waited` also counts clocks with busy low, so a start that never raises busy times out too.
    for (uint64_t waited = 0; !top_->done; ++waited) {
      if (top_->error && !top_->busy) {
        r.stop = "error";
        r.error_code = top_->error_code;
        return r;
      }
      if (abort_in_store && top_->dbg_state == kStateStore) {
        reset();
        r.stop = "aborted";
        return r;
      }
      if (waited >= options_.max_cycles) {
        r.stop = "timeout";
        return r;
      }
      if (top_->busy) ++r.busy;
      tick();
    }
    r.compute = top_->cycles_compute;
    r.store = top_->cycles_store;

    // The done clock presents the first read address; every later clock returns one element.
    const uint64_t count = c.m * c.n;
    r.c.reserve(count);
    for (uint64_t idx = 0; idx < count; ++idx) {
      top_->host_c_addr = address(idx / c.n, idx % c.n);
      tick();
      r.c.push_back(static_cast<int32_t>(top_->host_c_rdata));
    }
    r.transfer_out = count + 1;
    // The clock that consumes the last element, so the next run's first write is a clock later.
    tick();
    return r;
  }

 private:
  uint32_t address(uint64_t row, uint64_t col) const {
    return static_cast<uint32_t>(row * max_dim() + col);
  }

  // Writes A and B through both host write ports in parallel; returns the clocks it took.
  uint64_t load(const Case& c) {
    const uint64_t a_count = c.m * c.k;
    const uint64_t b_count = c.k * c.n;
    const uint64_t clocks = a_count > b_count ? a_count : b_count;
    for (uint64_t t = 0; t < clocks; ++t) {
      top_->host_a_we = 0;
      top_->host_b_we = 0;
      if (t < a_count && t / c.k < max_dim() && t % c.k < max_dim()) {
        top_->host_a_we = 1;
        top_->host_a_addr = address(t / c.k, t % c.k);
        top_->host_a_wdata = static_cast<uint8_t>(c.a[t]);
      }
      if (t < b_count && t / c.n < max_dim() && t % c.n < max_dim()) {
        top_->host_b_we = 1;
        top_->host_b_addr = address(t / c.n, t % c.n);
        top_->host_b_wdata = static_cast<uint8_t>(c.b[t]);
      }
      tick();
    }
    top_->host_a_we = 0;
    top_->host_b_we = 0;
    return clocks;
  }

  // Inputs change while the clock is low; a rising edge at every multiple of 10 ns.
  void tick() {
    time_ += kHalfPeriodNs;
    top_->clk = 1;
    top_->eval();
    dump();
    time_ += kHalfPeriodNs;
    top_->clk = 0;
    top_->eval();
    dump();
  }
  void dump() {
#if VM_TRACE
    if (wave_) wave_->dump(time_);
#endif
  }

  const Options& options_;
  std::unique_ptr<VerilatedContext> context_ = std::make_unique<VerilatedContext>();
  std::unique_ptr<Vmatmul_sim_top> top_;
#if VM_TRACE
  std::unique_ptr<VerilatedVcdC> wave_;
#endif
  uint64_t time_ = 0;
};

std::string json_bool(bool value) { return value ? "true" : "false"; }

void write_file(const std::string& path, const std::string& text) {
  std::ofstream out(path);
  out << text;
  out.close();
  if (!out) fail("cannot write " + path);
}

}  // namespace

int main(int argc, char** argv) {
  const Options options = parse_args(argc, argv);
  Sim sim(options);
  if (options.info) {
    sim.reset();
    std::cout << "{\"rows\": " << sim.rows() << ", \"cols\": " << sim.cols()
              << ", \"maxDim\": " << sim.max_dim() << "}\n";
    return 0;
  }
  const Case c = read_case(options.case_file);

  sim.reset();
  if (options.abort_first) sim.run(c, true);
  Run first;
  Run last;
  uint64_t runs_differing = 0;
  std::string stop = "done";
  int error_code = 0;
  for (uint64_t index = 0; index < options.repeat; ++index) {
    if (index > 0 && options.reset_between) sim.reset();
    last = sim.run(c, false);
    if (index == 0) {
      first = last;
    } else if (!last.same_as(first)) {
      ++runs_differing;
    }
    if (last.stop != "done") {
      stop = last.stop;
      error_code = last.error_code;
      break;
    }
  }

  if (!options.out.empty()) {
    std::string text;
    if (stop == "done") {
      for (const int32_t value : last.c) text += std::to_string(value) + "\n";
    }
    write_file(options.out, text);
  }

  const uint64_t rows = static_cast<uint64_t>(sim.rows());
  const uint64_t cols = static_cast<uint64_t>(sim.cols());
  const uint64_t tiles = ((c.m + rows - 1) / rows) * ((c.n + cols - 1) / cols);
  if (!options.cycles.empty()) {
    std::ostringstream json;
    json << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"rows\": " << rows << ",\n"
         << "  \"cols\": " << cols << ",\n"
         << "  \"maxDim\": " << sim.max_dim() << ",\n"
         << "  \"m\": " << c.m << ",\n"
         << "  \"n\": " << c.n << ",\n"
         << "  \"k\": " << c.k << ",\n"
         << "  \"macs\": " << c.m * c.n * c.k << ",\n"
         << "  \"tiles\": " << tiles << ",\n"
         << "  \"transferIn\": " << last.transfer_in << ",\n"
         << "  \"compute\": " << last.compute << ",\n"
         << "  \"store\": " << last.store << ",\n"
         << "  \"busy\": " << last.busy << ",\n"
         << "  \"transferOut\": " << last.transfer_out << ",\n"
         << "  \"total\": " << last.total() << ",\n"
         << "  \"stop\": \"" << stop << "\",\n"
         << "  \"error\": "
         << (stop == "error" ? "\"" + std::string(kErrorNames[error_code & 3]) + "\"" : "null")
         << ",\n"
         << "  \"repeat\": " << options.repeat << ",\n"
         << "  \"resetBetween\": " << json_bool(options.reset_between) << ",\n"
         << "  \"abortFirst\": " << json_bool(options.abort_first) << ",\n"
         << "  \"runsDiffering\": " << runs_differing << "\n"
         << "}\n";
    write_file(options.cycles, json.str());
  }

  if (!options.quiet) {
    std::cout << "case          " << options.case_file << "\n"
              << "array         " << rows << "x" << cols << " (MAX_DIM " << sim.max_dim() << ")\n"
              << "dims          M " << c.m << ", N " << c.n << ", K " << c.k << " (" << c.m * c.n * c.k
              << " MACs, " << tiles << " tiles)\n"
              << "runs          " << options.repeat
              << (options.reset_between ? ", reset between" : "")
              << (options.abort_first ? ", after a run reset in STORE" : "") << "; "
              << runs_differing << " differ from the first\n"
              << "stop          " << stop;
    if (stop == "error") std::cout << " (" << kErrorNames[error_code & 3] << ")";
    std::cout << "\n"
              << "transferIn    " << last.transfer_in << "\n"
              << "compute       " << last.compute << "\n"
              << "store         " << last.store << "\n"
              << "busy          " << last.busy << " (compute + store + "
              << last.busy - last.compute - last.store << " control)\n"
              << "transferOut   " << last.transfer_out << "\n"
              << "total         " << last.total() << "\n";
  }
  return 0;
}
