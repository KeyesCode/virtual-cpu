import { z } from 'zod';
import { MEMORY_SIZE } from './isa/constants.js';

/** An unsigned 8-bit integer (0..255). */
export const U8Schema = z.number().int().min(0).max(0xff);

/**
 * A program image loaded from outside the code (a file, a fixture, the dashboard): bytes to write
 * starting at `origin` (default 0x00). The image must fit in memory without wrapping.
 */
export const ProgramImageSchema = z
  .object({
    origin: U8Schema.optional(),
    bytes: z.array(U8Schema).max(MEMORY_SIZE),
  })
  .refine((image) => (image.origin ?? 0) + image.bytes.length <= MEMORY_SIZE, {
    message: `Program image runs past the end of the ${String(MEMORY_SIZE)}-byte memory`,
    path: ['bytes'],
  });

export type ProgramImage = z.infer<typeof ProgramImageSchema>;
