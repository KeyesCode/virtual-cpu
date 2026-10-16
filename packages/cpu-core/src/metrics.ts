import { estimatedCycles, OPCODES, type OpcodeId, type OpcodeInfo } from '@vcpu/shared';

/**
 * Execution metrics, counted for retired instructions only (a precisely faulting instruction
 * changes nothing). Cycles are estimates from the instructional timing model, not measurements.
 */
export interface CpuMetrics {
  /** Retired instructions, HLT and a post-commit PC_OVERFLOW instruction included. */
  readonly instructions: number;
  /** Sum of `estimatedCycles(info, transferred)` over retired instructions. */
  readonly estimatedCycles: number;
  /** Retired instructions per opcode id (every id present, zero when unused). */
  readonly opcodeCounts: Readonly<Record<OpcodeId, number>>;
  /** Data-memory reads: LOAD, POP and RET. Instruction fetches are excluded. */
  readonly memoryReads: number;
  /** Data-memory writes: STORE, PUSH and CALL. */
  readonly memoryWrites: number;
  /** Instruction bytes fetched by retired instructions, counted apart from data accesses. */
  readonly fetchedBytes: number;
  /** Conditional branches (JZ, JNZ, JC, JNC) whose condition held. */
  readonly branchesTaken: number;
  /** Conditional branches whose condition did not hold. */
  readonly branchesNotTaken: number;
}

function zeroCounts(): Record<OpcodeId, number> {
  return Object.fromEntries(OPCODES.map((info) => [info.id, 0])) as Record<OpcodeId, number>;
}

/** Accumulates metrics without allocating per instruction. */
export class MetricsCounter {
  #instructions = 0;
  #cycles = 0;
  #reads = 0;
  #writes = 0;
  #fetchedBytes = 0;
  #taken = 0;
  #notTaken = 0;
  readonly #byOpcode = zeroCounts();

  /**
   * Records one retired instruction. `branchTaken` is `null` for anything but a conditional
   * branch; `transferred` is true when control moved to a target (jump, call, return, taken branch).
   */
  retire(
    info: OpcodeInfo,
    transferred: boolean,
    branchTaken: boolean | null,
    reads: number,
    writes: number,
  ): number {
    const cycles = estimatedCycles(info, transferred);
    this.#instructions += 1;
    this.#cycles += cycles;
    this.#reads += reads;
    this.#writes += writes;
    this.#fetchedBytes += info.length;
    this.#byOpcode[info.id] += 1;
    if (branchTaken === true) {
      this.#taken += 1;
    } else if (branchTaken === false) {
      this.#notTaken += 1;
    }
    return cycles;
  }

  /** Exactly reverses one `retire()` with the same arguments (the debugger's step-back). */
  unretire(
    info: OpcodeInfo,
    transferred: boolean,
    branchTaken: boolean | null,
    reads: number,
    writes: number,
  ): void {
    this.#instructions -= 1;
    this.#cycles -= estimatedCycles(info, transferred);
    this.#reads -= reads;
    this.#writes -= writes;
    this.#fetchedBytes -= info.length;
    this.#byOpcode[info.id] -= 1;
    if (branchTaken === true) {
      this.#taken -= 1;
    } else if (branchTaken === false) {
      this.#notTaken -= 1;
    }
  }

  reset(): void {
    this.#instructions = 0;
    this.#cycles = 0;
    this.#reads = 0;
    this.#writes = 0;
    this.#fetchedBytes = 0;
    this.#taken = 0;
    this.#notTaken = 0;
    Object.assign(this.#byOpcode, zeroCounts());
  }

  snapshot(): CpuMetrics {
    return Object.freeze({
      instructions: this.#instructions,
      estimatedCycles: this.#cycles,
      opcodeCounts: Object.freeze({ ...this.#byOpcode }),
      memoryReads: this.#reads,
      memoryWrites: this.#writes,
      fetchedBytes: this.#fetchedBytes,
      branchesTaken: this.#taken,
      branchesNotTaken: this.#notTaken,
    });
  }
}
