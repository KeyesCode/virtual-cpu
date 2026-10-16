/** `0x1E`: two digits minimum, upper case. */
export function hex(value: number): string {
  return `0x${byteHex(value)}`;
}

/** `1E`: a byte as two upper-case hex digits. */
export function byteHex(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

/** `11 00 0A`: bytes as space-separated hex. */
export function bytesHex(bytes: readonly number[]): string {
  return bytes.map(byteHex).join(' ');
}

/** `30`, or `255, -1` when the byte reads as negative in two's complement. */
export function byteValue(value: number): string {
  return value >= 0x80 ? `${String(value)}, ${String(value - 0x100)}` : String(value);
}

/**
 * Parses a number as the assembler writes them: decimal `26`, hex `0x1A` or binary `0b11010`.
 * Returns `null` for anything else.
 */
export function parseNumber(text: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^0b[01]+$/i.test(text)) return Number.parseInt(text.slice(2), 2);
  if (/^[0-9]+$/.test(text)) return Number.parseInt(text, 10);
  return null;
}
