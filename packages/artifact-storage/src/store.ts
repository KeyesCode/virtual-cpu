import { type FailureClass, Sha256Schema } from '@vcpu/research-core';
import { z } from 'zod';
import { type ArtifactKind, ArtifactKindSchema } from './kinds.js';
import type { SecretPatternName } from './secrets.js';

/** What a caller says about the bytes it stores. The database keeps the rest of the story. */
export const ArtifactMetaSchema = z.strictObject({
  kind: ArtifactKindSchema,
  /** A human name, e.g. the file's path relative to the experiment workspace. Not a storage key. */
  name: z.string().min(1).max(1024).optional(),
  /** Overrides the media type inferred from `name` or the content. */
  mediaType: z
    .string()
    .regex(/^[\w.+-]+\/[\w.+-]+(?:\s*;.*)?$/)
    .optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

/** The answer to a successful `put`. */
export interface PutResult {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  /** True when the bytes were already stored, so nothing was written. */
  readonly deduplicated: boolean;
}

/** Everything the store knows about one object. Survives pruning; the bytes do not. */
export const ArtifactStatSchema = z.strictObject({
  sha256: Sha256Schema,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  /** Every kind the bytes were stored as; retention keeps them for the longest of them. */
  kinds: z.array(ArtifactKindSchema).min(1),
  /** The name given on the first `put`, if any. */
  name: z.string().nullable(),
  /**
   * When the bytes were stored (ISO 8601): the first put, or the put that restored them after
   * pruning. Retention measures age from here.
   */
  storedAt: z.iso.datetime(),
  pruned: z.boolean(),
  prunedAt: z.iso.datetime().nullable(),
  prunedReason: z.string().nullable(),
});
export type ArtifactStat = z.infer<typeof ArtifactStatSchema>;

/** Narrows a listing. Every field is optional and they combine with AND. */
export interface ListFilter {
  /** A prefix of the lowercase hex digest. */
  readonly prefix?: string;
  /** Objects stored as this kind (among others). */
  readonly kind?: ArtifactKind;
  /** Include objects whose bytes were pruned. Default false. */
  readonly includePruned?: boolean;
}

/**
 * A running total of the bytes one experiment has stored, owned by the caller and passed to every
 * `put` of that experiment. A deduplicated put costs nothing, because it writes nothing.
 */
export class ExperimentByteBudget {
  private usedBytes: number;

  constructor(
    readonly limitBytes: number,
    usedBytes = 0,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError(`limitBytes must be a non-negative integer, got ${String(limitBytes)}`);
    }
    this.usedBytes = usedBytes;
  }

  get used(): number {
    return this.usedBytes;
  }

  get remaining(): number {
    return Math.max(0, this.limitBytes - this.usedBytes);
  }

  /** Records bytes the store is committing. */
  consume(bytes: number): void {
    this.usedBytes += bytes;
  }

  /** Gives back bytes reserved by a put that then failed. */
  release(bytes: number): void {
    this.usedBytes = Math.max(0, this.usedBytes - bytes);
  }
}

export interface PutOptions {
  /** The experiment's byte budget: the put is refused when it would overrun it. */
  readonly budget?: ExperimentByteBudget;
}

/** Bytes to store: a buffer, a UTF-8 string, or a stream (any async iterable of chunks). */
export type ArtifactSource = Uint8Array | string | AsyncIterable<Uint8Array | string>;

/**
 * A content-addressed, write-once object store. Objects are named by the SHA-256 of their bytes;
 * nothing in the interface depends on a filesystem, so an S3-compatible backend can implement it.
 * The bytes live here; the `artifact` table holds the metadata that links them to experiments.
 */
export interface ArtifactStore {
  /**
   * Stores the bytes and returns their digest. Storing bytes that are already present writes
   * nothing and returns `deduplicated: true`. Refuses (`ArtifactRefusedError`) content that matches
   * a secret pattern, exceeds the per-artifact limit or the caller's budget, or has invalid meta.
   */
  put(source: ArtifactSource, meta: ArtifactMeta, options?: PutOptions): Promise<PutResult>;
  /** The whole object, verified against its digest. Throws `ArtifactNotFoundError` when absent or pruned. */
  get(sha256: string): Promise<Uint8Array>;
  /** A stream of the object, for downloads too large to buffer. Not verified while streaming. */
  openReadStream(sha256: string): Promise<AsyncIterable<Uint8Array>>;
  /** Whether the bytes are stored (false for unknown and for pruned objects). */
  has(sha256: string): Promise<boolean>;
  /** The object's metadata, including pruned objects; `null` when the store has never held it. */
  stat(sha256: string): Promise<ArtifactStat | null>;
  /** Removes the bytes and the metadata. Returns whether there was anything to remove. */
  delete(sha256: string): Promise<boolean>;
  /** Removes the bytes but keeps the metadata, marked pruned. Used by the retention engine. */
  prune(sha256: string, reason: string, at: Date): Promise<boolean>;
  /** Every matching object, in digest order. */
  list(filter?: ListFilter): AsyncIterable<ArtifactStat>;
}

export type RefusalReason =
  `secret:${SecretPatternName}` | 'size:artifact' | 'size:experiment' | 'invalid-meta';

/** The store would not accept the content. Nothing was written. */
export class ArtifactRefusedError extends Error {
  override readonly name = 'ArtifactRefusedError';
  readonly failureClass: FailureClass;

  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.failureClass = reason.startsWith('size:') ? 'budget-exceeded' : 'policy-violation';
  }
}

/** No stored bytes under this digest. `pruned` says whether retention removed them. */
export class ArtifactNotFoundError extends Error {
  override readonly name = 'ArtifactNotFoundError';

  constructor(
    readonly sha256: string,
    readonly pruned = false,
  ) {
    super(pruned ? `artifact ${sha256} was pruned` : `artifact ${sha256} not found`);
  }
}

/** Stored bytes do not match their digest, or two different contents claim one digest. */
export class ArtifactIntegrityError extends Error {
  override readonly name = 'ArtifactIntegrityError';
  readonly failureClass: FailureClass = 'infrastructure-failure';
}

/** The backend failed (disk full, permissions, I/O). Retryable as `infrastructure-failure`. */
export class ArtifactStorageFailure extends Error {
  override readonly name = 'ArtifactStorageFailure';
  readonly failureClass: FailureClass = 'infrastructure-failure';

  constructor(
    message: string,
    readonly code: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Throws a `TypeError` unless `sha256` is a lowercase 64-digit hex digest. */
export function assertSha256(sha256: string): void {
  if (!Sha256Schema.safeParse(sha256).success) {
    throw new TypeError(`not a sha256 digest: ${JSON.stringify(sha256)}`);
  }
}

/** Parses meta, mapping a schema failure to a refusal. */
export function parseArtifactMeta(meta: unknown): ArtifactMeta {
  const parsed = ArtifactMetaSchema.safeParse(meta);
  if (!parsed.success) {
    throw new ArtifactRefusedError(
      'invalid-meta',
      `invalid artifact meta: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
