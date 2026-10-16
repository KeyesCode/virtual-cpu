import type { SourceMapEntry } from '@vcpu/assembler';

/** The assembler's address → source map: one entry per instruction and per `.byte` value. */
export type SourceMap = ReadonlyMap<number, SourceMapEntry>;

/** True for an entry that came from an instruction rather than a `.byte` directive. */
export function isInstructionEntry(entry: SourceMapEntry): boolean {
  return !entry.text.startsWith('.');
}

/** The source map entry for the instruction that starts at `address`, if there is one. */
export function instructionAt(sourceMap: SourceMap | null, address: number): SourceMapEntry | null {
  const entry = sourceMap?.get(address);
  return entry !== undefined && isInstructionEntry(entry) ? entry : null;
}

/** The entry whose bytes cover `address` (an instruction's operand byte included). */
export function entryCovering(sourceMap: SourceMap, address: number): SourceMapEntry | null {
  for (const entry of sourceMap.values()) {
    if (address >= entry.address && address < entry.address + entry.length) {
      return entry;
    }
  }
  return null;
}

export function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}
