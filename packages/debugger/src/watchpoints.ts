import type { DecodedInstruction } from '@vcpu/cpu-core';
import { isU8 } from '@vcpu/shared';

/** Which data accesses a watchpoint reacts to; `access` means reads and writes. */
export type WatchpointKind = 'read' | 'write' | 'access';

/** An inclusive address range. */
export interface WatchRange {
  readonly start: number;
  readonly end: number;
}

/** A single address, or an inclusive range. */
export type WatchpointTarget =
  | { readonly address: number; readonly kind: WatchpointKind }
  | { readonly range: WatchRange; readonly kind: WatchpointKind };

export interface Watchpoint {
  readonly id: number;
  readonly range: WatchRange;
  readonly kind: WatchpointKind;
  readonly enabled: boolean;
}

/**
 * One access that matched a watchpoint. Only data accesses (LOAD, STORE, PUSH, POP, CALL, RET)
 * count; instruction fetches never do.
 */
export interface WatchpointHit {
  readonly watchpoint: Watchpoint;
  /** The access that happened: always `read` or `write`, even for an `access` watchpoint. */
  readonly access: 'read' | 'write';
  /** Address of the instruction that made the access. */
  readonly pc: number;
  readonly instruction: DecodedInstruction | null;
  /** That instruction as assembly, e.g. `STORE [0x85], R2`. */
  readonly text: string;
  readonly address: number;
  /** The byte before the access; equal to `newValue` for a read. */
  readonly oldValue: number;
  /** The byte after the access (the value read, or the value written). */
  readonly newValue: number;
}

/** A hit recorded during the access, before the instruction (and so its text) is complete. */
export type PendingHit = Omit<WatchpointHit, 'instruction' | 'text'>;

/** Thrown for a watchpoint that cannot be placed or does not exist. */
export class WatchpointError extends Error {
  override readonly name = 'WatchpointError';
}

const KINDS: readonly WatchpointKind[] = ['read', 'write', 'access'];

/**
 * The session's watchpoints. Accesses are matched while the instruction runs; `run()` stops after
 * that instruction completes, because an access happens partway through executing it.
 */
export class WatchpointTable {
  readonly #byId = new Map<number, Watchpoint>();
  #nextId = 1;

  add(target: WatchpointTarget): Watchpoint {
    const range = 'range' in target ? target.range : { start: target.address, end: target.address };
    if (!isU8(range.start) || !isU8(range.end) || range.start > range.end) {
      throw new WatchpointError(
        `A watchpoint range must be 0x00–0xFF with start ≤ end, got ${String(range.start)}–${String(range.end)}`,
      );
    }
    if (!KINDS.includes(target.kind)) {
      throw new WatchpointError(`A watchpoint kind is read, write or access, got ${target.kind}`);
    }
    const watchpoint: Watchpoint = Object.freeze({
      id: this.#nextId,
      range: Object.freeze({ start: range.start, end: range.end }),
      kind: target.kind,
      enabled: true,
    });
    this.#nextId += 1;
    this.#byId.set(watchpoint.id, watchpoint);
    return watchpoint;
  }

  /** Removes a watchpoint; returns false if there was none with that id. */
  remove(id: number): boolean {
    return this.#byId.delete(id);
  }

  /** Enables or disables a watchpoint (flips it when `enabled` is omitted). */
  toggle(id: number, enabled?: boolean): Watchpoint {
    const watchpoint = this.#byId.get(id);
    if (watchpoint === undefined) {
      throw new WatchpointError(`There is no watchpoint ${String(id)}`);
    }
    const updated = Object.freeze({ ...watchpoint, enabled: enabled ?? !watchpoint.enabled });
    this.#byId.set(id, updated);
    return updated;
  }

  /** Every watchpoint, in the order they were added. */
  list(): readonly Watchpoint[] {
    return Object.freeze([...this.#byId.values()]);
  }

  /** Appends a pending hit to `hits` for every enabled watchpoint this access matches. */
  match(
    access: 'read' | 'write',
    pc: number,
    address: number,
    oldValue: number,
    newValue: number,
    hits: PendingHit[],
  ): void {
    for (const watchpoint of this.#byId.values()) {
      if (
        watchpoint.enabled &&
        (watchpoint.kind === 'access' || watchpoint.kind === access) &&
        address >= watchpoint.range.start &&
        address <= watchpoint.range.end
      ) {
        hits.push({ watchpoint, access, pc, address, oldValue, newValue });
      }
    }
  }
}
