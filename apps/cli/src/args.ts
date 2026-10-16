import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { MAX_ADDRESS } from '@vcpu/shared';
import { parseNumber } from './format/hex.js';
import { UsageError } from './io.js';

/** Every command takes `-h, --help`. */
export const HELP_OPTION = { help: { type: 'boolean', short: 'h' } } as const;

/** Strict `node:util` parsing: an unknown flag or a missing flag value is a `UsageError`. */
export function parseCommandLine<const O extends ParseArgsOptionsConfig>(
  args: readonly string[],
  options: O,
) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** The single `<file>` positional. */
export function singleFile(positionals: readonly string[], what: string): string {
  const [file, ...extra] = positionals;
  if (file === undefined) throw new UsageError(`missing ${what}`);
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra.join(' ')}"`);
  return file;
}

/** An address 0x00–0xFF in decimal, `0x` hex or `0b` binary. */
export function parseAddress(text: string, what: string): number {
  const value = parseNumber(text);
  if (value === null || value > MAX_ADDRESS) {
    throw new UsageError(`${what} must be an address from 0x00 to 0xFF, got "${text}"`);
  }
  return value;
}

/** A non-negative integer, in decimal, `0x` hex or `0b` binary. */
export function parseCount(text: string, what: string): number {
  const value = parseNumber(text.replaceAll('_', ''));
  if (value === null || !Number.isSafeInteger(value)) {
    throw new UsageError(`${what} must be a non-negative integer, got "${text}"`);
  }
  return value;
}
