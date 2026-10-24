import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { INT8_MAX, INT8_MIN } from '../model/matmul.js';
import { PE_RESET_STATE, type PeInputs, type PeState, stepPe } from '../model/pe.js';
import { Prng } from '../model/prng.js';

/**
 * The processing-element unit-test vectors `tb/unit/tb_processing_element.sv` reads: one line per
 * clock, every expected value computed by {@link stepPe}. Plain text, LF line endings:
 *
 * - line 1: `pe-vectors 1 <clocks> <random clocks> <seed>` (format version 1);
 * - `# <description>` starts a segment (ASCII text); the testbench names it in its summary and
 *   its failures;
 * - every other line is one clock, 11 decimal integers separated by single spaces:
 *   `rst clear a a_valid b b_valid acc a_out a_valid_out b_out b_valid_out`, the first six the
 *   inputs applied before the rising edge, the last five the outputs expected just after it.
 *
 * The directed segments come first, then one random segment of `<random clocks>` clocks drawn from
 * the seed. The model state carries across segments, as the RTL's does: the file is one run.
 */

export const PE_VECTORS_FORMAT_VERSION = 1;

export interface PeClock {
  readonly inputs: PeInputs;
  readonly expected: PeState;
}

export interface PeSegment {
  readonly description: string;
  readonly random: boolean;
  readonly clocks: readonly PeClock[];
}

export interface PeVectors {
  readonly seed: number;
  readonly segments: readonly PeSegment[];
  /** Every clock, directed and random. */
  readonly clocks: number;
  readonly randomClocks: number;
}

interface SegmentPlan {
  readonly description: string;
  readonly inputs: readonly PeInputs[];
}

const IDLE: PeInputs = { rst: false, clear: false, a: 0, aValid: false, b: 0, bValid: false };

function mac(a: number, b: number): PeInputs {
  return { ...IDLE, a, aValid: true, b, bValid: true };
}

function repeat(count: number, inputs: PeInputs): PeInputs[] {
  return Array.from({ length: count }, () => inputs);
}

/** A deterministic INT8 sequence for the directed segments: i · step + offset, wrapped to INT8. */
function int8At(i: number, step: number, offset: number): number {
  const byte = (((i * step + offset) % 256) + 256) % 256;
  return byte > INT8_MAX ? byte - 256 : byte;
}

/**
 * A segment that clears, then repeats one MAC `extra` times past the first whose exact sum leaves
 * INT32, then idles for two clocks so the wrapped value is seen to hold.
 */
function overflowSegment(direction: string, a: number, b: number, extra: number): SegmentPlan {
  const product = a * b;
  // The first n with n · product > INT32_MAX (product > 0) or < INT32_MIN (product < 0).
  const first =
    product > 0 ? Math.ceil(2 ** 31 / product) : Math.floor(2 ** 31 / -product) + 1;
  const count = first + extra;
  const exact = count * product;
  const wrapped = exact | 0;
  return {
    description: `overflow ${direction}: ${String(a)} x ${String(b)} = ${String(product)}, ${String(count)} MACs after a clear (MAC ${String(first)} is the first to leave INT32): exact ${String(exact)} wraps to ${String(wrapped)} (| 0), then held`,
    inputs: [{ ...IDLE, clear: true }, ...repeat(count, mac(a, b)), ...repeat(2, IDLE)],
  };
}

/** The directed segments, in order: every behaviour the ticket requires by name. */
function directedPlans(): SegmentPlan[] {
  const validLow: PeInputs[] = [];
  for (let i = 0; i < 99; i += 1) {
    // a_valid only, b_valid only, neither, in turn.
    validLow.push({
      ...IDLE,
      a: int8At(i, 37, 11),
      aValid: i % 3 === 0,
      b: int8At(i, 91, 3),
      bValid: i % 3 === 1,
    });
  }
  const many: PeInputs[] = [];
  for (let i = 0; i < 1000; i += 1) {
    many.push(mac(int8At(i, 29, 0), int8At(i, 53, 7)));
  }
  return [
    {
      description: 'reset: rst for 2 clocks with valid operands; acc 0, valid bits 0, data forwarded',
      inputs: repeat(2, { ...mac(5, 7), rst: true }),
    },
    {
      description: 'positive: small products, then 127 x 127 = 16129',
      inputs: [mac(3, 5), mac(7, 11), mac(1, 1), mac(127, 127), mac(127, 1), mac(100, 100)],
    },
    {
      description: 'negative: negative x positive, positive x negative, negative x negative',
      inputs: [
        { ...IDLE, clear: true },
        mac(-3, 5),
        mac(5, -3),
        mac(-7, -11),
        mac(-1, -1),
        mac(-128, 1),
        mac(1, -128),
        mac(-100, 50),
      ],
    },
    {
      description: 'zero: a zero operand leaves acc unchanged',
      inputs: [mac(0, 0), mac(0, 127), mac(-128, 0), mac(0, -128), mac(127, 0)],
    },
    {
      description: 'max INT8: 127 x 127 = 16129 three times, then 127 x -1',
      inputs: [{ ...IDLE, clear: true }, ...repeat(3, mac(127, 127)), mac(127, -1)],
    },
    {
      description: 'min INT8: -128 x -128 = +16384 three times, then -128 x 1, -128 x -1, -1 x -128',
      inputs: [
        { ...IDLE, clear: true },
        ...repeat(3, mac(-128, -128)),
        mac(-128, 1),
        mac(-128, -1),
        mac(-1, -128),
      ],
    },
    {
      description: 'mixed sign: 127 x -128 = -16256 and -128 x 127, then back across zero',
      inputs: [
        { ...IDLE, clear: true },
        ...repeat(2, mac(127, -128)),
        mac(-128, 127),
        ...repeat(4, mac(127, 127)),
      ],
    },
    {
      description:
        'valid low: a_valid only, b_valid only, both low, 99 clocks; acc holds while the operands forward',
      inputs: [mac(9, 9), ...validLow, mac(2, 2)],
    },
    {
      description:
        'clear: alone, with both operands valid (clear wins), with rst, then accumulating again',
      inputs: [
        mac(50, 50),
        { ...mac(99, 99), clear: true },
        mac(2, 3),
        { ...IDLE, clear: true },
        mac(-2, 3),
        { ...mac(4, 4), clear: true, rst: true },
        mac(4, 4),
      ],
    },
    {
      description: 'many accumulations: 1000 MACs after a clear, no clear between them',
      inputs: [{ ...IDLE, clear: true }, ...many],
    },
    {
      description:
        'reset mid-run: rst with valid operands between accumulations, once and three times in a row',
      inputs: [
        { ...IDLE, clear: true },
        ...repeat(5, mac(-77, 33)),
        { ...mac(12, 12), rst: true },
        ...repeat(3, mac(21, -5)),
        ...repeat(3, { ...mac(-9, -9), rst: true }),
        ...repeat(2, mac(6, 7)),
      ],
    },
    overflowSegment('up', -128, -128, 4),
    overflowSegment('down', 127, -128, 3),
  ];
}

const EDGE_OPERANDS = [INT8_MIN, -1, 0, 1, INT8_MAX] as const;

function randomOperand(prng: Prng): number {
  if (prng.int(0, 7) === 0) {
    return EDGE_OPERANDS[prng.int(0, EDGE_OPERANDS.length - 1)] ?? 0;
  }
  return prng.int(INT8_MIN, INT8_MAX);
}

/**
 * `count` random clocks from `seed`: each operand valid 3 clocks in 4, operands uniform with an
 * extreme value (−128, −1, 0, 1, 127) one time in 8, a clear one clock in 300 and a reset one in
 * 5000.
 */
export function randomPeInputs(seed: number, count: number): PeInputs[] {
  const prng = new Prng(seed);
  const out: PeInputs[] = [];
  for (let i = 0; i < count; i += 1) {
    const rst = prng.int(0, 4999) === 0;
    const clear = prng.int(0, 299) === 0;
    const aValid = prng.int(0, 3) !== 0;
    const bValid = prng.int(0, 3) !== 0;
    out.push({ rst, clear, a: randomOperand(prng), aValid, b: randomOperand(prng), bValid });
  }
  return out;
}

/** The directed segments, then `count` random clocks from `seed`, with every expected output. */
export function buildPeVectors(seed: number, count: number): PeVectors {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`The random clock count must be a positive integer, got ${String(count)}`);
  }
  const plans: (SegmentPlan & { random: boolean })[] = [
    ...directedPlans().map((plan) => ({ ...plan, random: false })),
    {
      description: `random: seed ${String(seed)}, ${String(count)} clocks`,
      inputs: randomPeInputs(seed, count),
      random: true,
    },
  ];
  let state = PE_RESET_STATE;
  let clocks = 0;
  const segments = plans.map((plan) => ({
    description: plan.description,
    random: plan.random,
    clocks: plan.inputs.map((inputs) => {
      state = stepPe(state, inputs);
      clocks += 1;
      return { inputs, expected: state };
    }),
  }));
  return { seed, segments, clocks, randomClocks: count };
}

const bit = (value: boolean): string => (value ? '1' : '0');

/** One clock line: the six inputs, then the five expected outputs. */
export function formatPeClock(clock: PeClock): string {
  const { inputs: i, expected: e } = clock;
  return [
    bit(i.rst),
    bit(i.clear),
    String(i.a),
    bit(i.aValid),
    String(i.b),
    bit(i.bValid),
    String(e.acc),
    String(e.aOut),
    bit(e.aValidOut),
    String(e.bOut),
    bit(e.bValidOut),
  ].join(' ');
}

/** The vector file text. */
export function formatPeVectors(vectors: PeVectors): string {
  const lines = [
    `pe-vectors ${String(PE_VECTORS_FORMAT_VERSION)} ${String(vectors.clocks)} ${String(vectors.randomClocks)} ${String(vectors.seed)}`,
  ];
  for (const segment of vectors.segments) {
    lines.push(`# ${segment.description}`);
    for (const clock of segment.clocks) {
      lines.push(formatPeClock(clock));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Builds the vectors and writes them to `file` (its directory is created if missing). */
export function writePeVectors(file: string, seed: number, count: number): PeVectors {
  const vectors = buildPeVectors(seed, count);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatPeVectors(vectors));
  return vectors;
}
