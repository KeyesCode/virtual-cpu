import { isU8 } from '@vcpu/shared';
import {
  entryCovering,
  hex,
  instructionAt,
  isInstructionEntry,
  type SourceMap,
} from './source-map.js';

/** Where to put a breakpoint: an instruction address, or a source line (needs a source map). */
export type BreakpointTarget = { readonly address: number } | { readonly line: number };

export interface Breakpoint {
  readonly id: number;
  /** The instruction address the breakpoint stops before. */
  readonly address: number;
  /** The source line it was set on; `null` for a breakpoint set by address. */
  readonly line: number | null;
  readonly enabled: boolean;
  /**
   * Set when the source map says no instruction starts at `address` (data, or the middle of an
   * instruction): the breakpoint never hits unless execution reaches that address anyway.
   */
  readonly warning: string | null;
}

/** Thrown for a breakpoint that cannot be placed, such as one on a line with no code. */
export class BreakpointError extends Error {
  override readonly name = 'BreakpointError';
}

/**
 * The session's breakpoints. A breakpoint is checked against PC before each instruction, so it
 * stops `run()` before the instruction at its address executes.
 */
export class BreakpointTable {
  readonly #sourceMap: SourceMap | null;
  readonly #byId = new Map<number, Breakpoint>();
  #nextId = 1;

  constructor(sourceMap: SourceMap | null) {
    this.#sourceMap = sourceMap;
  }

  /**
   * Adds a breakpoint. A line resolves to the first instruction on it; a line with no instruction,
   * or a line without a source map, throws `BreakpointError`. Adding one at an address that already
   * has a breakpoint returns the existing breakpoint.
   */
  add(target: BreakpointTarget): Breakpoint {
    const { address, line } =
      'line' in target ? this.#resolveLine(target.line) : this.#checkAddress(target.address);
    const existing = this.at(address, false);
    if (existing !== undefined) {
      return existing;
    }
    const breakpoint: Breakpoint = Object.freeze({
      id: this.#nextId,
      address,
      line,
      enabled: true,
      warning: this.#warningFor(address),
    });
    this.#nextId += 1;
    this.#byId.set(breakpoint.id, breakpoint);
    return breakpoint;
  }

  /** Removes a breakpoint; returns false if there was none with that id. */
  remove(id: number): boolean {
    return this.#byId.delete(id);
  }

  /** Enables or disables a breakpoint (flips it when `enabled` is omitted). */
  toggle(id: number, enabled?: boolean): Breakpoint {
    const breakpoint = this.#byId.get(id);
    if (breakpoint === undefined) {
      throw new BreakpointError(`There is no breakpoint ${String(id)}`);
    }
    const updated = Object.freeze({ ...breakpoint, enabled: enabled ?? !breakpoint.enabled });
    this.#byId.set(id, updated);
    return updated;
  }

  /** Every breakpoint, in address order. */
  list(): readonly Breakpoint[] {
    return Object.freeze([...this.#byId.values()].sort((x, y) => x.address - y.address));
  }

  /** The breakpoint at `address` (only an enabled one when `enabledOnly`). */
  at(address: number, enabledOnly = true): Breakpoint | undefined {
    for (const breakpoint of this.#byId.values()) {
      if (breakpoint.address === address && (breakpoint.enabled || !enabledOnly)) {
        return breakpoint;
      }
    }
    return undefined;
  }

  #checkAddress(address: number): { address: number; line: number | null } {
    if (!isU8(address)) {
      throw new BreakpointError(`A breakpoint address must be 0x00–0xFF, got ${String(address)}`);
    }
    return { address, line: instructionAt(this.#sourceMap, address)?.line ?? null };
  }

  #resolveLine(line: number): { address: number; line: number } {
    if (this.#sourceMap === null) {
      throw new BreakpointError('Breakpoints by line need a source map');
    }
    let address: number | null = null;
    for (const entry of this.#sourceMap.values()) {
      if (
        entry.line === line &&
        isInstructionEntry(entry) &&
        (address === null || entry.address < address)
      ) {
        address = entry.address;
      }
    }
    if (address === null) {
      throw new BreakpointError(`Line ${String(line)} has no instruction to break on`);
    }
    return { address, line };
  }

  #warningFor(address: number): string | null {
    if (this.#sourceMap === null || instructionAt(this.#sourceMap, address) !== null) {
      return null;
    }
    const covering = entryCovering(this.#sourceMap, address);
    const what =
      covering === null
        ? 'outside the assembled code'
        : isInstructionEntry(covering)
          ? `inside \`${covering.text}\` (line ${String(covering.line)})`
          : `data (\`${covering.text}\`, line ${String(covering.line)})`;
    return `${hex(address)} is ${what}, not the start of an instruction: this breakpoint never hits unless execution reaches it`;
  }
}
