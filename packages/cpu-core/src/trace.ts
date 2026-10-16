import type { CpuStatus, FlagName, RegisterName } from '@vcpu/shared';
import type { CpuFault, DecodedInstruction } from './state.js';

/** A register written by the instruction. SP and SD appear here when the stack moved. */
export interface RegisterChange {
  readonly register: RegisterName | 'SP' | 'SD';
  readonly before: number;
  readonly after: number;
}

export interface FlagChange {
  readonly flag: FlagName;
  readonly before: boolean;
  readonly after: boolean;
}

/** A data-memory read (instruction fetches are not listed). */
export interface MemoryRead {
  readonly address: number;
  readonly value: number;
}

/** A data-memory write, with the byte it replaced. */
export interface MemoryWrite {
  readonly address: number;
  readonly before: number;
  readonly after: number;
}

/** Everything one `step()` did. A precisely faulting step lists no changes. */
export interface TraceEntry {
  /** 0-based count of steps since reset, faulting steps included. */
  readonly sequence: number;
  /** Address of the instruction. */
  readonly pc: number;
  /** PC after the step. */
  readonly nextPc: number;
  /** The fetched bytes, opcode first (only the opcode when the fault came before operand fetch). */
  readonly bytes: readonly number[];
  /** `null` when the instruction could not be decoded. */
  readonly instruction: DecodedInstruction | null;
  readonly registerChanges: readonly RegisterChange[];
  readonly flagsBefore: number;
  readonly flagsAfter: number;
  readonly flagChanges: readonly FlagChange[];
  readonly memoryReads: readonly MemoryRead[];
  readonly memoryWrites: readonly MemoryWrite[];
  /** Conditional branches only: whether the condition held. `null` for every other instruction. */
  readonly branchTaken: boolean | null;
  /** True when control moved to a target: JMP, CALL, RET or a taken branch. */
  readonly controlTransferred: boolean;
  /** Estimated cycles charged; 0 when the step faulted precisely. */
  readonly cycles: number;
  /** Status after the step. */
  readonly status: CpuStatus;
  readonly fault: CpuFault | null;
}

/** Default number of trace entries kept. */
export const DEFAULT_TRACE_CAPACITY = 1024;

/** A bounded ring buffer of trace entries; the oldest entry is dropped when it is full. */
export class TraceBuffer {
  readonly capacity: number;
  #entries: TraceEntry[] = [];
  /** Index of the oldest entry once the buffer has wrapped. */
  #start = 0;

  /** `capacity` 0 disables tracing: `push` drops everything. */
  constructor(capacity: number = DEFAULT_TRACE_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError(`traceCapacity must be a non-negative integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  get enabled(): boolean {
    return this.capacity > 0;
  }

  get size(): number {
    return this.#entries.length;
  }

  push(entry: TraceEntry): void {
    if (this.#entries.length < this.capacity) {
      this.#entries.push(entry);
    } else if (this.enabled) {
      this.#entries[this.#start] = entry;
      this.#start = (this.#start + 1) % this.capacity;
    }
  }

  clear(): void {
    this.#entries = [];
    this.#start = 0;
  }

  /** The kept entries, oldest first. */
  toArray(): TraceEntry[] {
    return [...this.#entries.slice(this.#start), ...this.#entries.slice(0, this.#start)];
  }
}
