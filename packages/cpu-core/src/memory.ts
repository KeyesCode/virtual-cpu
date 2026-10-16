import { MEMORY_SIZE, u8 } from '@vcpu/shared';

/**
 * Reads byte `address` of a memory-sized byte array. Throws a RangeError for an address that is
 * not a byte or an array shorter than the address, so a missing byte never reads as 0 silently.
 */
export function byteAt(bytes: ArrayLike<number>, address: number): number {
  const value = bytes[u8(address)];
  if (value === undefined) {
    throw new RangeError(
      `Address ${String(address)} is outside the ${String(bytes.length)}-byte memory`,
    );
  }
  return value;
}

/**
 * The 256-byte unified code + data memory. Every address and value is validated as an unsigned
 * byte, so a host-language bug can never write 256 or −1. The memory itself has no side effects:
 * the CPU routes data accesses through its observer and metrics, and instruction fetches read the
 * bytes directly.
 */
export class Memory {
  readonly #bytes = new Uint8Array(MEMORY_SIZE);

  /** Reads the byte at `address`. */
  read(address: number): number {
    return byteAt(this.#bytes, address);
  }

  /** Writes `value` at `address`. */
  write(address: number, value: number): void {
    this.#bytes[u8(address)] = u8(value);
  }

  /** Replaces the whole memory with `image`, which must be exactly `MEMORY_SIZE` bytes. */
  restore(image: Uint8Array): void {
    if (image.length !== MEMORY_SIZE) {
      throw new RangeError(
        `A memory image must be ${String(MEMORY_SIZE)} bytes, got ${String(image.length)}`,
      );
    }
    this.#bytes.set(image);
  }

  /** A read-only view of the bytes, for instruction fetch and decode. Do not write through it. */
  view(): ArrayLike<number> {
    return this.#bytes;
  }

  /** A copy of all 256 bytes as plain numbers. */
  toArray(): number[] {
    return Array.from(this.#bytes);
  }
}
