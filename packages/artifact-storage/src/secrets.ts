import { looksBinary } from './kinds.js';

/**
 * Credential patterns the store refuses to keep. Each is bounded on the left so that it does not
 * fire inside a longer identifier or hash, and needs enough characters to look like a real secret
 * rather than documentation (`Bearer <token>`, an empty `RESEARCH_API_TOKEN=`).
 */
export const SECRET_PATTERNS = [
  {
    name: 'anthropic-key',
    description: 'Anthropic API key (sk-ant-…)',
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,}/,
  },
  {
    name: 'openai-key',
    description: 'OpenAI-style secret key (sk-…, sk-proj-…)',
    pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{32,}/,
  },
  {
    name: 'github-token',
    description: 'GitHub token (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)',
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/,
  },
  {
    name: 'aws-access-key',
    description: 'AWS access key id (AKIA…, ASIA…)',
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/,
  },
  {
    name: 'private-key',
    description: 'PEM private key block',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    name: 'bearer-token',
    description: 'HTTP bearer credential with a long token',
    pattern: /(?<![A-Za-z0-9])[Bb]earer[ \t]+[A-Za-z0-9._~+/-]{20,}=*/,
  },
  {
    name: 'env-secret',
    description: '.env-style assignment of a *_TOKEN, *_SECRET, *_PASSWORD or *_API_KEY',
    pattern:
      /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*_(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY)[ \t]*=[ \t]*["']?[^\s"'#]{8,}/m,
  },
] as const;

export type SecretPatternName = (typeof SECRET_PATTERNS)[number]['name'];

/** Binary content (a NUL byte near the start) is scanned only up to this many bytes. */
export const DEFAULT_BINARY_SCAN_LIMIT_BYTES = 1024 * 1024;

/** Characters carried from one chunk to the next so that a match across a boundary is found. */
const OVERLAP_CHARS = 1024;

export interface SecretMatch {
  readonly pattern: SecretPatternName;
  readonly description: string;
}

export interface SecretScannerOptions {
  /** Treat the content as text whatever its first bytes look like (from a text media type). */
  readonly text?: boolean;
  readonly binaryScanLimitBytes?: number;
}

/**
 * Scans a stream of chunks for credentials. Feed it every chunk with `push`; it reports the first
 * match and ignores the rest. Text is scanned in full; binary content (decided from the first
 * chunk unless the caller says it is text) only up to `binaryScanLimitBytes`, so that a
 * multi-hundred-megabyte waveform is not regex-scanned end to end.
 *
 * Chunks are decoded as Latin-1: every pattern is ASCII, and Latin-1 maps each byte to one
 * character, so a multi-byte UTF-8 sequence split across chunks cannot hide or create a match.
 */
export class SecretScanner {
  private readonly binaryLimit: number;
  private binary: boolean | undefined;
  private scannedBytes = 0;
  private carry = '';
  private found: SecretMatch | null = null;

  constructor(options: SecretScannerOptions = {}) {
    this.binaryLimit = options.binaryScanLimitBytes ?? DEFAULT_BINARY_SCAN_LIMIT_BYTES;
    if (options.text === true) this.binary = false;
  }

  /** The first match so far, or `null`. */
  get match(): SecretMatch | null {
    return this.found;
  }

  /** Whether part of the content went unscanned because it is binary and over the limit. */
  get truncated(): boolean {
    return this.binary === true && this.scannedBytes >= this.binaryLimit;
  }

  /** Scans one more chunk. Returns the first match found so far, or `null`. */
  push(chunk: Uint8Array): SecretMatch | null {
    if (this.found !== null) return this.found;
    this.binary ??= looksBinary(chunk);
    let bytes = chunk;
    if (this.binary) {
      const room = this.binaryLimit - this.scannedBytes;
      if (room <= 0) return null;
      if (bytes.length > room) bytes = bytes.subarray(0, room);
    }
    this.scannedBytes += bytes.length;
    const text =
      this.carry + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
    this.found = findSecret(text);
    // Prefix a lowercase letter when the carried text starts mid-line, so that `^` in the
    // .env pattern cannot treat the cut as the start of a line.
    const tail = text.slice(-OVERLAP_CHARS);
    this.carry =
      tail.length < text.length && text[text.length - tail.length - 1] !== '\n' ? `x${tail}` : tail;
    return this.found;
  }
}

/** The first secret pattern that matches `text`, or `null`. */
export function findSecret(text: string): SecretMatch | null {
  for (const { name, description, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return { pattern: name, description };
  }
  return null;
}

/** Scans a whole buffer or string at once. */
export function scanForSecrets(
  content: Uint8Array | string,
  options: SecretScannerOptions = {},
): SecretMatch | null {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return new SecretScanner(options).push(bytes);
}
