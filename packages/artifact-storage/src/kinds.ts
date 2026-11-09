import { extname } from 'node:path';
import { ARTIFACT_KINDS, ArtifactKindSchema, type ArtifactKind } from '@vcpu/research-core';

// One vocabulary for the store, the database's `artifact.kind` check constraint and the API: the
// kinds are defined once in research-core and re-exported here.
export { ARTIFACT_KINDS, ArtifactKindSchema, type ArtifactKind };

/** What the store records when neither the caller nor the file name says what the bytes are. */
export const FALLBACK_MEDIA_TYPE = 'application/octet-stream';

/** The media type of the manifest `putDirectory` writes. */
export const DIRECTORY_MANIFEST_MEDIA_TYPE = 'application/vnd.vcpu.artifact-directory+json';

const MEDIA_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.rpt': 'text/plain',
  '.csv': 'text/csv',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.patch': 'text/x-diff',
  '.diff': 'text/x-diff',
  '.v': 'text/x-verilog',
  '.vh': 'text/x-verilog',
  '.sv': 'text/x-systemverilog',
  '.svh': 'text/x-systemverilog',
  '.lib': 'text/plain',
  '.sdc': 'text/plain',
  '.tcl': 'text/x-tcl',
  '.ys': 'text/plain',
  '.hex': 'text/plain',
  '.mem': 'text/plain',
  '.vcd': 'text/x-vcd',
  '.fst': 'application/x-fst',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** The media type a file name implies, or `null` when its extension is unknown. */
export function mediaTypeForName(name: string): string | null {
  return MEDIA_TYPES_BY_EXTENSION[extname(name).toLowerCase()] ?? null;
}

/** Whether a media type names text (scanned for secrets in full) rather than opaque bytes. */
export function isTextMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    essence.startsWith('text/') ||
    essence.endsWith('+json') ||
    essence.endsWith('+xml') ||
    [
      'application/json',
      'application/x-ndjson',
      'application/yaml',
      'application/xml',
      'image/svg+xml',
    ].includes(essence)
  );
}

/**
 * Picks the media type of a new object: the caller's, then the name's extension, then a sniff of
 * the first bytes (no NUL byte means text), then `application/octet-stream`.
 */
export function resolveMediaType(
  explicit: string | undefined,
  name: string | undefined,
  head: Uint8Array,
): string {
  if (explicit !== undefined) return explicit;
  const byName = name === undefined ? null : mediaTypeForName(name);
  if (byName !== null) return byName;
  if (head.length > 0 && !looksBinary(head)) return 'text/plain';
  return FALLBACK_MEDIA_TYPE;
}

/** Git's heuristic: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(head: Uint8Array): boolean {
  return head.subarray(0, 8000).includes(0);
}
