import { deepFreeze } from './freeze.js';
import {
  CPU_NAME,
  FLAG_BITS,
  FLAG_MASKS,
  ISA_VERSION,
  MEMORY_MAP,
  MEMORY_SIZE,
  REGISTER_NAMES,
  STACK_CAPACITY,
  TIMING_MODEL,
} from './isa/constants.js';
import { INSTRUCTION_FORMATS } from './isa/formats.js';
import { OPCODES } from './isa/opcodes.js';

/** Workspace package name. */
export const PACKAGE_NAME = '@vcpu/shared';

export * from './bits.js';
export * from './isa/constants.js';
export * from './isa/flags.js';
export * from './isa/formats.js';
export * from './isa/opcodes.js';
export * from './isa/types.js';
export * from './schemas.js';

/** The whole ISA v1.0 definition in one frozen object. */
export const ISA = deepFreeze({
  name: CPU_NAME,
  version: ISA_VERSION,
  memorySize: MEMORY_SIZE,
  memoryMap: MEMORY_MAP,
  registers: REGISTER_NAMES,
  stackCapacity: STACK_CAPACITY,
  flagBits: FLAG_BITS,
  flagMasks: FLAG_MASKS,
  formats: INSTRUCTION_FORMATS,
  opcodes: OPCODES,
  timing: TIMING_MODEL,
});
