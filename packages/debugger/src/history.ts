import type { StepUndo, TraceEntry } from '@vcpu/cpu-core';

/**
 * One step's reversible delta: its trace entry (register, SP, SD, flag and PC changes and the
 * bytes it wrote, each with the value before) plus the IR and status before the step. The core's
 * `undoStep()` applies it in reverse.
 */
export type HistoryDelta = StepUndo;

export interface HistoryStats {
  /** Deltas held now: how many steps `stepBack()` can undo. */
  readonly entries: number;
  /** The most deltas kept; the oldest is dropped beyond it. 0 disables step-back. */
  readonly capacity: number;
  /** Estimated bytes the held deltas use (see `estimateDeltaBytes`). */
  readonly approxBytes: number;
  /** The estimate when the buffer is full of the largest possible deltas: the memory bound. */
  readonly maxApproxBytes: number;
}

/** Default number of steps `stepBack()` can undo. */
export const DEFAULT_HISTORY_CAPACITY = 1024;

// Rough per-object costs on a 64-bit JavaScript engine, for the estimate only.
const DELTA_BYTES = 32;
const ENTRY_BYTES = 160;
const INSTRUCTION_BYTES = 96;
const RECORD_BYTES = 40;
const NUMBER_SLOT_BYTES = 8;

/** The largest step: a 3-byte instruction, 8 register changes plus SP and SD, 4 flags, 1 read, 1 write. */
const MAX_DELTA_BYTES =
  DELTA_BYTES +
  ENTRY_BYTES +
  INSTRUCTION_BYTES +
  2 * 3 * NUMBER_SLOT_BYTES +
  (10 + 4 + 1 + 1) * RECORD_BYTES;

/**
 * Estimated memory of one delta: the entry and its decoded instruction, the bytes arrays and one
 * record per register change, flag change and memory access. Real engines differ; the bound that is
 * enforced is the entry count, and each entry is bounded in size, so the total is too.
 */
export function estimateDeltaBytes(entry: TraceEntry): number {
  const records =
    entry.registerChanges.length +
    entry.flagChanges.length +
    entry.memoryReads.length +
    entry.memoryWrites.length;
  const instruction =
    entry.instruction === null
      ? 0
      : INSTRUCTION_BYTES + entry.instruction.bytes.length * NUMBER_SLOT_BYTES;
  return (
    DELTA_BYTES +
    ENTRY_BYTES +
    instruction +
    entry.bytes.length * NUMBER_SLOT_BYTES +
    records * RECORD_BYTES
  );
}

/** A bounded ring buffer of step deltas, newest last. Pushing onto a full buffer drops the oldest. */
export class HistoryBuffer {
  readonly capacity: number;
  #deltas: (HistoryDelta | undefined)[];
  /** Index of the oldest delta. */
  #start = 0;
  #size = 0;
  #bytes = 0;

  constructor(capacity: number = DEFAULT_HISTORY_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError(
        `historyCapacity must be a non-negative integer, got ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    this.#deltas = new Array<HistoryDelta | undefined>(capacity).fill(undefined);
  }

  get size(): number {
    return this.#size;
  }

  push(delta: HistoryDelta): void {
    if (this.capacity === 0) {
      return;
    }
    if (this.#size === this.capacity) {
      this.#release(this.#start);
      this.#start = (this.#start + 1) % this.capacity;
      this.#size -= 1;
    }
    const slot = (this.#start + this.#size) % this.capacity;
    this.#deltas[slot] = delta;
    this.#bytes += estimateDeltaBytes(delta.entry);
    this.#size += 1;
  }

  /** Removes and returns the newest delta, or `null` when there is none. */
  pop(): HistoryDelta | null {
    if (this.#size === 0) {
      return null;
    }
    const slot = (this.#start + this.#size - 1) % this.capacity;
    const delta = this.#release(slot);
    this.#size -= 1;
    return delta;
  }

  clear(): void {
    this.#deltas.fill(undefined);
    this.#start = 0;
    this.#size = 0;
    this.#bytes = 0;
  }

  stats(): HistoryStats {
    return Object.freeze({
      entries: this.#size,
      capacity: this.capacity,
      approxBytes: this.#bytes,
      maxApproxBytes: this.capacity * MAX_DELTA_BYTES,
    });
  }

  #release(slot: number): HistoryDelta {
    const delta = this.#deltas[slot];
    if (delta === undefined) {
      throw new Error(`History slot ${String(slot)} is empty`);
    }
    this.#deltas[slot] = undefined;
    this.#bytes -= estimateDeltaBytes(delta.entry);
    return delta;
  }
}
