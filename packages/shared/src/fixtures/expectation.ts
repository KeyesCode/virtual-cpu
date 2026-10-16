import { z } from 'zod';
import { MEMORY_SIZE } from '../isa/constants.js';
import { CpuStatus } from '../isa/types.js';
import { U8Schema } from '../schemas.js';

/** A byte written as a number (0..255) or as a hex string such as `"0x2A"`, read as a number. */
export const ByteValueSchema = z.union([
  U8Schema,
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{1,2}$/, 'Expected a hex byte such as "0x2A"')
    .transform((text) => Number.parseInt(text.slice(2), 16)),
]);

const byte = ByteValueSchema.optional();
const bit = z.literal([0, 1]).optional();

/** Registers an expectation may check. Unlisted registers are not checked. */
export const ExpectedRegistersSchema = z.strictObject({
  R0: byte,
  R1: byte,
  R2: byte,
  R3: byte,
  R4: byte,
  R5: byte,
  R6: byte,
  R7: byte,
  PC: byte,
  SP: byte,
});

/** Flags an expectation may check, each 0 or 1. Unlisted flags are not checked. */
export const ExpectedFlagsSchema = z.strictObject({ Z: bit, C: bit, N: bit, V: bit });

/** `bytes` expected at consecutive addresses from `address`; the range must not run past 0xFF. */
export const ExpectedMemorySchema = z
  .strictObject({
    address: ByteValueSchema,
    bytes: z.array(ByteValueSchema).min(1),
  })
  .refine((range) => range.address + range.bytes.length <= MEMORY_SIZE, {
    message: `Memory range runs past the end of the ${String(MEMORY_SIZE)}-byte memory`,
    path: ['bytes'],
  });

/**
 * The expected outcome of running a program (an example's `<name>.expect.json`): run it with
 * `maxInstructions` as the limit, then the final status and every listed register, flag and
 * memory range must match. Reaching the limit without halting or faulting fails it.
 */
export const ExpectationSchema = z.strictObject({
  maxInstructions: z.number().int().positive(),
  status: z.enum([CpuStatus.HALTED, CpuStatus.FAULTED]),
  registers: ExpectedRegistersSchema.optional(),
  flags: ExpectedFlagsSchema.optional(),
  memory: z.array(ExpectedMemorySchema).optional(),
});

export type Expectation = z.output<typeof ExpectationSchema>;
