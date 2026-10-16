import { u8 } from '../bits.js';
import { FLAG_MASKS, FLAGS_USED_MASK } from './constants.js';
import { FLAG_NAMES, type FlagName } from './types.js';

export type FlagValues = Readonly<Record<FlagName, boolean>>;

/** Packs flag values into a FLAGS byte (Z = bit 3, C = bit 2, N = bit 1, V = bit 0). */
export function packFlags(flags: FlagValues): number {
  return FLAG_NAMES.reduce((byte, name) => (flags[name] ? byte | FLAG_MASKS[name] : byte), 0);
}

/** Unpacks a FLAGS byte. Throws a RangeError if any of bits 7–4 is set, since they always read 0. */
export function unpackFlags(byte: number): FlagValues {
  if ((u8(byte) & ~FLAGS_USED_MASK) !== 0) {
    throw new RangeError(`FLAGS bits 7-4 must be 0, got ${String(byte)}`);
  }
  return {
    Z: (byte & FLAG_MASKS.Z) !== 0,
    C: (byte & FLAG_MASKS.C) !== 0,
    N: (byte & FLAG_MASKS.N) !== 0,
    V: (byte & FLAG_MASKS.V) !== 0,
  };
}
