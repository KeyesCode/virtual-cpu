import { toSigned8 } from '@vcpu/shared';

/** Two upper-case hex digits, no prefix: `0C`. */
export function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

/** `0x0C`. */
export function hex(value: number): string {
  return `0x${hexByte(value)}`;
}

/** Eight bits as two nibbles: `0000 1101`. */
export function binaryNibbles(value: number): string {
  const bits = value.toString(2).padStart(8, '0');
  return `${bits.slice(0, 4)} ${bits.slice(4)}`;
}

/** Two's-complement reading with an explicit sign, using a real minus sign: `+13`, `−122`. */
export function signed(value: number): string {
  const n = toSigned8(value);
  return n < 0 ? `−${String(-n)}` : `+${String(n)}`;
}

/** Space-separated hex bytes: `22 20`. */
export function hexBytes(bytes: readonly number[]): string {
  return bytes.map(hexByte).join(' ');
}

/** Parses `85`, `0x85` or `$85` as a hex address 0x00–0xFF; `null` otherwise. */
export function parseHexAddress(text: string): number | null {
  const digits = text.trim().replace(/^(0x|\$)/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(digits)) return null;
  return Number.parseInt(digits, 16);
}
