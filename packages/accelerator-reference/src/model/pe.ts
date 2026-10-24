import { INT8_MAX, INT8_MIN } from './matmul.js';

/**
 * The processing element, one clock at a time: the reference `rtl/processing_element.sv` is
 * compared against (docs/hardware/accelerators/processing-element.md).
 *
 * At each rising edge the operands and their valid bits are registered and forwarded (one clock of
 * latency, valid or not; `rst` clears the two valid bits), and the accumulator is zeroed by `rst`
 * or `clear` (clear wins over a MAC), else takes `acc + a · b` wrapped to INT32 with `| 0` when
 * both operands are valid, else holds. It is the same wrap rule as {@link matmulInt8}.
 */

/** The PE's inputs in one clock. */
export interface PeInputs {
  readonly rst: boolean;
  readonly clear: boolean;
  readonly a: number;
  readonly aValid: boolean;
  readonly b: number;
  readonly bValid: boolean;
}

/** The PE's registers, which are also its outputs. */
export interface PeState {
  /** The signed INT32 accumulator. */
  readonly acc: number;
  readonly aOut: number;
  readonly aValidOut: boolean;
  readonly bOut: number;
  readonly bValidOut: boolean;
}

/** The state after reset. The forwarded operands are not reset in the RTL; they read 0 here. */
export const PE_RESET_STATE: PeState = {
  acc: 0,
  aOut: 0,
  aValidOut: false,
  bOut: 0,
  bValidOut: false,
};

function checkInt8(name: string, value: number): void {
  if (!Number.isInteger(value) || value < INT8_MIN || value > INT8_MAX) {
    throw new RangeError(
      `${name} must be a signed INT8 (${String(INT8_MIN)} … ${String(INT8_MAX)}), got ${String(value)}`,
    );
  }
}

/** The state after one rising edge with `inputs` applied to a PE in `state`. */
export function stepPe(state: PeState, inputs: PeInputs): PeState {
  checkInt8('a', inputs.a);
  checkInt8('b', inputs.b);
  let acc = state.acc;
  if (inputs.rst || inputs.clear) {
    acc = 0;
  } else if (inputs.aValid && inputs.bValid) {
    acc = (acc + inputs.a * inputs.b) | 0;
  }
  return {
    acc,
    aOut: inputs.a,
    aValidOut: !inputs.rst && inputs.aValid,
    bOut: inputs.b,
    bValidOut: !inputs.rst && inputs.bValid,
  };
}
