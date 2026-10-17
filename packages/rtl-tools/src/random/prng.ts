/**
 * A small seeded PRNG, so a random program is a function of its seed alone: mulberry32 on a
 * 32-bit state that splitmix32 derives from the seed (neighbouring seeds give unrelated streams).
 * Never `Math.random`.
 */
export class Prng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new RangeError(`A seed is a non-negative integer, got ${String(seed)}`);
    }
    // splitmix32 over the low and high halves, so seeds above 2^32 still differ.
    let z = (seed >>> 0) ^ Math.floor(seed / 0x1_0000_0000) ^ 0x9e3779b9;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    this.#state = (z ^ (z >>> 16)) >>> 0;
  }

  /** A uniform 32-bit unsigned integer (mulberry32). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor((this.next() / 0x1_0000_0000) * (max - min + 1));
  }

  byte(): number {
    return this.int(0, 0xff);
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() / 0x1_0000_0000 < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) {
      throw new RangeError('Cannot pick from an empty list');
    }
    return item;
  }

  /** A shuffled copy of `items` (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }

  /** One key of `weights`, chosen with probability proportional to its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = (this.next() / 0x1_0000_0000) * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) {
        return key;
      }
    }
    const last = entries.at(-1);
    if (last === undefined) {
      throw new RangeError('Cannot pick from empty weights');
    }
    return last[0];
  }
}
