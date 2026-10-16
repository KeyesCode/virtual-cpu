# Benchmarks

The benchmark suite measures how fast the emulator runs real VCPU-8 programs on your machine, and reports what the simulated CPU did while running them. These are two different kinds of numbers, and every report keeps them in separate, labelled sections:

| Section       | What it is                                                              | Varies between runs?                        |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| **Host**      | Wall-clock time the TypeScript emulator takes on this computer          | Yes: CPU model, Node version, load, heat    |
| **Simulated** | Instructions, estimated cycles, memory accesses and branches of the CPU | No: the same program gives the same numbers |

Estimated cycles come from the instructional [timing model](#timing-model). They are never measured clock cycles, and nothing here relates them to host time.

The code lives in `packages/benchmarks` (`@vcpu/benchmarks`). It touches no Node or browser API: the caller injects the clock, and the CLI passes `performance.now`.

## Running it

```sh
pnpm cpu benchmark examples/14-fibonacci.asm                  # one program, printed as a table
pnpm cpu benchmark examples/14-fibonacci.asm --samples 20 --json fib.json
pnpm bench                                                    # every example → benchmarks/results/<date>-<gitsha>.json
pnpm bench:compare                                            # newest result vs benchmarks/baseline.json
pnpm bench:compare path/to/report.json --threshold 10
```

| Option                   | Default   | Meaning                                                            |
| ------------------------ | --------- | ------------------------------------------------------------------ |
| `--warmup <N>`           | 3         | Untimed warm-up samples per mode before measuring                  |
| `--samples <N>`          | 10        | Timed samples per mode                                             |
| `--max-instructions <N>` | 1,000,000 | Instruction limit for one program run                              |
| `--min-sample-ms <N>`    | 50        | Each sample repeats the program until it lasts at least this long  |
| `--no-trace`             |           | Skip the trace-on timing, so no trace overhead is reported         |
| `--json <file>`          |           | Write the JSON report there (`--suite` writes one even without it) |
| `--baseline <file>`      | baseline  | `--compare` only: the report to compare against                    |
| `--threshold <PCT>`      | 5         | `--compare` only: an IPS drop larger than this is flagged          |

`pnpm bench` is `pnpm cpu benchmark --suite` and `pnpm bench:compare` is `pnpm cpu benchmark --compare`, so both accept these options. `benchmarks/results/` is git-ignored; only the baseline is committed. A whole-suite run with the defaults takes about a minute.

Exit codes: 0 ok, 1 the source did not assemble, 2 a program faulted or did not halt (the suite still benchmarks the rest and writes its report), 64 usage error.

## Method

One **run** is `cpu.reset()` followed by `cpu.run()` until `HLT`. `reset()` restores the 256-byte memory image and clears the registers, so every run does identical work. For each program:

1. **Reference run.** One run on a fresh CPU records the simulated metrics. A program that does not load, faults or reaches the instruction limit is reported as an error with that reason and is not timed. The suite carries on with the next program.
2. **Calibration.** A VCPU-8 program finishes in microseconds, far below the clock's useful resolution. The runner finds how many back-to-back runs make one sample last at least `--min-sample-ms` (50 ms by default), growing the count by at most 10× per attempt. Every sample then repeats that many runs, recorded in the report as `runsPerSample`.
3. **Warm-up.** `--warmup` untimed samples per mode give V8's JIT a chance to compile the hot paths before anything is measured.
4. **Sampling.** `--samples` timed samples per mode. One sample's value is its elapsed time divided by `runsPerSample`: host nanoseconds per run. Every run's instruction count is checked against the reference run, so a non-deterministic run would stop the benchmark instead of skewing it.
5. **Trace overhead.** Unless `--no-trace` is given, a second CPU with the execution trace on (1,024 entries, the CPU's default) is timed the same way. Trace-off and trace-on samples alternate, and alternate which goes first, so slow drift on the host (thermal throttling, a background job) affects both modes alike.

### Statistics

From the per-sample nanoseconds per run, the report gives `n`, `min`, `max`, `mean`, `median`, `stddev` (sample standard deviation, n − 1 denominator), and the 5th and 95th percentiles (linear interpolation between closest ranks, the definition NumPy and spreadsheets use). Every raw sample is kept as `samplesNs`.

Derived figures use the **median**, which a single slow sample cannot move:

- **Instructions per second** = simulated instructions per run ÷ median seconds per run.
- **ns per instruction** = median nanoseconds per run ÷ simulated instructions per run.
- **Trace overhead** = (median with trace − median without) ÷ median without × 100.

The per-run time includes `reset()`. That fixed cost dominates very short programs: `01-addition` retires 4 instructions, so its ns per instruction is about three times that of `14-fibonacci`, which retires 85. Compare a program with itself across runs, not short programs with long ones.

## Timing model

Simulated cycles are estimated, per retired instruction, from the constants in `TIMING_MODEL` (`@vcpu/shared`). [instruction-set.md](instruction-set.md#timing-model) defines the model and lists every opcode's cost.

| `TIMING_MODEL` constant | Cycles | Charged for                                                            |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| `fetchCyclesPerByte`    | 1      | Each instruction byte fetched (1–3 per instruction)                    |
| `executeCycles`         | 1      | Every instruction                                                      |
| `dataAccessCycles`      | 1      | Each data-memory access: LOAD, STORE, PUSH, POP, CALL, RET             |
| `mulExtraCycles`        | 3      | MUL                                                                    |
| `divExtraCycles`        | 7      | DIV                                                                    |
| `branchTakenPenalty`    | 1      | A control transfer: JMP, CALL and RET always; JZ/JNZ/JC/JNC when taken |

For example, `JNZ addr8` costs 2 (fetch) + 1 (execute) = 3 cycles when it falls through and 4 when it jumps. A precisely faulting instruction is not retired and costs nothing.

## The report

`pnpm bench`, `--json` and the baseline all write the same JSON document, defined by the Zod schema `BenchmarkReportSchema` that `@vcpu/benchmarks` exports. Every report is validated against it before it is written, and `bench:compare` validates both files it reads. Fields are only ever added; a change that removes or redefines one bumps `schemaVersion`.

| Field                         | Meaning                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`               | `1`                                                                                                                                                                                                                  |
| `createdAt`                   | ISO 8601 time the report was written                                                                                                                                                                                 |
| `isaVersion`                  | `ISA_VERSION` the programs ran on                                                                                                                                                                                    |
| `environment`                 | `runtime` (`node v24.15.0`), `platform`, `arch`, `osRelease`, `cpuModel`, `cpuCount`, `totalMemoryBytes`, `gitSha`, `gitDirty` and every workspace package's version                                                 |
| `settings`                    | `warmupIterations`, `samples`, `maxInstructions`, `minSampleMs`, `trace`                                                                                                                                             |
| `programs[]`                  | One entry per program, in the order they ran                                                                                                                                                                         |
| `programs[].status`           | `ok`, or `error` with an `error` message and the failed run's `simulated` metrics (`null` if it never loaded)                                                                                                        |
| `programs[].host`             | `runsPerSample`, `timePerRunNs` (the statistics above), `samplesNs`, `instructionsPerSecond`, `nsPerInstruction`, and `traced` (`timePerRunNs` and `samplesNs` with the trace on, or `null`)                         |
| `programs[].simulated`        | `stopReason`, `instructions`, `estimatedCycles`, `memoryReads`, `memoryWrites`, `fetchedBytes`, `branchesTaken`, `branchesNotTaken`, and `opcodeCounts` (opcode id → retired count; ids that never ran are left out) |
| `programs[].traceOverheadPct` | Trace overhead in percent, or `null` with `--no-trace`                                                                                                                                                               |

Memory reads and writes count data accesses only. Instruction fetches are counted separately, as `fetchedBytes`.

## Comparing runs

`benchmarks/baseline.json` is a real `pnpm bench` run, committed so later runs have something to compare against. Its `environment` records the machine it came from. `pnpm bench:compare [report.json]` compares a report (by default the newest file in `benchmarks/results/`) with it, program by program:

```
$ pnpm bench:compare        # the results/ run before the baseline, against the baseline
  Program                Baseline IPS  Current IPS  Δ IPS  Baseline/run  Current/run        Status
  14-fibonacci               4.57 M/s     4.57 M/s  +0.2%      18.62 µs     18.59 µs  within noise
```

- **Δ IPS** is the change in instructions per second; positive is faster.
- **Status** is `REGRESSION` when IPS fell by more than `--threshold` percent (5 by default), `faster` when it rose by more, and `within noise` otherwise. Programs only in one report show as `new` or `missing`, and a program that errored in either report shows `error`.
- **(simulated work changed)** is added when the instruction count or estimated cycles differ. The program or the CPU's behavior changed, so the host times measure different work.
- When the reports differ in ISA version, runtime, platform, architecture, CPU model or settings, the differences are listed under the table. Host numbers from different machines are not comparable, so on another machine, compare two of your own reports (`pnpm bench:compare mine.json --baseline earlier.json`) rather than against the committed baseline.

`bench:compare` only reports; it exits 0 whatever the deltas, because host timing is too noisy to fail a build on by default.

To refresh the baseline after an intentional performance change, commit the change first (so `gitSha` names it and `gitDirty` is `false`), then run `pnpm bench --json benchmarks/baseline.json` and commit the file. Never edit its numbers by hand.

## Caveats

- **Noise.** Host time moves with CPU frequency scaling, thermal state, background processes and power settings. Close other heavy programs, keep a laptop on mains power, and look at each program's CV (stddev ÷ mean, shown in the suite table) before trusting a delta: a change smaller than the CV is noise. In the committed baseline most programs show a CV of 1–3%, and a few reach about 12%.
- **Sample counts.** The default 10 samples of ≥ 50 ms suit a quick check. For a decision, use `--samples 30` or more, and keep the settings identical between the two reports you compare (`bench:compare` lists any that differ).
- **JIT.** V8 optimizes the run loop as it warms up and can deoptimize it later. Warm-up samples absorb the first effect. Interleaving trace-off and trace-on samples, and reporting medians, limit the second.
- **What is measured.** The emulator's speed in this Node process, including `reset()`. It says nothing about how fast a hardware VCPU-8 would run. That would depend on the clock rate and the circuit, and the timing model's cycle estimates are teaching aids, not predictions.
- **Browser.** Only Node is benchmarked. The dashboard's performance panel reports the simulated metrics, which are the same everywhere.
