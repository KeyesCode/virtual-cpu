import { createHash, randomUUID } from 'node:crypto';
import {
  type FileHandle,
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { isTextMediaType, mediaTypeForName, resolveMediaType } from './kinds.js';
import { SecretScanner } from './secrets.js';
import {
  type ArtifactMeta,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  ArtifactRefusedError,
  type ArtifactSource,
  type ArtifactStat,
  ArtifactStatSchema,
  ArtifactStorageFailure,
  type ArtifactStore,
  type ListFilter,
  type PutOptions,
  type PutResult,
  assertSha256,
  parseArtifactMeta,
} from './store.js';

/** Where the store lives when `RESEARCH_ARTIFACT_ROOT` is unset, relative to the repository root. */
export const DEFAULT_ARTIFACT_ROOT = '.research/artifacts';

/** The largest single object the store accepts unless configured otherwise: 1 GiB. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

const SIDECAR_SUFFIX = '.meta.json';
const PART_SUFFIX = '.part';
const SIDECAR_NAME = /^([0-9a-f]{64})\.meta\.json$/;

/** The on-disk sidecar: the stat plus a format version. */
const SidecarSchema = ArtifactStatSchema.extend({ format: z.literal(1) });
type Sidecar = z.infer<typeof SidecarSchema>;

export interface LocalDiskArtifactStoreOptions {
  /** The store's root directory; created if missing. */
  readonly root: string;
  /** The largest object `put` accepts. Default `DEFAULT_MAX_ARTIFACT_BYTES`. */
  readonly maxArtifactBytes?: number;
  /** Binary content is scanned for secrets only up to this many bytes. */
  readonly binaryScanLimitBytes?: number;
  /** The time recorded as `storedAt`. Default `() => new Date()`. */
  readonly clock?: () => Date;
  /** Replaces `fs.rename` for the commit of an object. A fault-injection hook for tests. */
  readonly renameObject?: (from: string, to: string) => Promise<void>;
}

/**
 * The artifact store on a local disk:
 *
 *     <root>/objects/<aa>/<bb>/<sha256>             the bytes, read-only, written once
 *     <root>/objects/<aa>/<bb>/<sha256>.meta.json   the sidecar: kinds, media type, storedAt, pruned
 *     <root>/tmp/                                   staging; emptied when the store is opened
 *
 * A put streams into `tmp/<id>.part`, hashing and scanning as it goes, fsyncs, stages the sidecar
 * as `tmp/<id>.meta.json`, then renames the object into place (the commit point) and the sidecar
 * after it. A crash before the object rename leaves nothing under `objects/`; a crash between the
 * two renames is rolled forward the next time the store is opened.
 */
export class LocalDiskArtifactStore implements ArtifactStore {
  readonly root: string;
  private readonly objectsDir: string;
  private readonly tmpDir: string;
  private readonly maxArtifactBytes: number;
  private readonly binaryScanLimitBytes: number | undefined;
  private readonly clock: () => Date;
  private readonly renameObject: (from: string, to: string) => Promise<void>;
  private readonly locks = new Map<string, Promise<void>>();

  private constructor(options: LocalDiskArtifactStoreOptions) {
    this.root = resolve(options.root);
    this.objectsDir = join(this.root, 'objects');
    this.tmpDir = join(this.root, 'tmp');
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.binaryScanLimitBytes = options.binaryScanLimitBytes;
    this.clock = options.clock ?? (() => new Date());
    this.renameObject = options.renameObject ?? rename;
  }

  /** Opens (creating if needed) the store at `options.root` and recovers from an interrupted put. */
  static async open(options: LocalDiskArtifactStoreOptions): Promise<LocalDiskArtifactStore> {
    const store = new LocalDiskArtifactStore(options);
    try {
      await mkdir(store.objectsDir, { recursive: true });
      await mkdir(store.tmpDir, { recursive: true });
      await store.recover();
    } catch (error) {
      throw storageFailure(error, `cannot open artifact store at ${store.root}`);
    }
    return store;
  }

  /**
   * Opens the store at `RESEARCH_ARTIFACT_ROOT` (default `.research/artifacts`), resolved against
   * `baseDir` (the repository root; default the working directory).
   */
  static fromEnv(
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly baseDir?: string;
    } & Omit<LocalDiskArtifactStoreOptions, 'root'> = {},
  ): Promise<LocalDiskArtifactStore> {
    const { env = process.env, baseDir = process.cwd(), ...rest } = options;
    const configured = env['RESEARCH_ARTIFACT_ROOT']?.trim();
    const root = resolve(
      baseDir,
      configured === undefined || configured === '' ? DEFAULT_ARTIFACT_ROOT : configured,
    );
    return LocalDiskArtifactStore.open({ ...rest, root });
  }

  /** The path of an object's bytes. Exposed for tests and diagnostics, not for consumers. */
  objectPath(sha256: string): string {
    assertSha256(sha256);
    return join(this.objectsDir, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(
    source: ArtifactSource,
    meta: ArtifactMeta,
    options: PutOptions = {},
  ): Promise<PutResult> {
    const parsed = parseArtifactMeta(meta);
    const declared =
      parsed.mediaType ?? (parsed.name === undefined ? null : mediaTypeForName(parsed.name));
    const scanner = new SecretScanner({
      ...(declared !== null && isTextMediaType(declared) ? { text: true } : {}),
      ...(this.binaryScanLimitBytes === undefined
        ? {}
        : { binaryScanLimitBytes: this.binaryScanLimitBytes }),
    });

    const id = randomUUID();
    const partPath = join(this.tmpDir, `${id}${PART_SUFFIX}`);
    const stagedSidecarPath = join(this.tmpDir, `${id}${SIDECAR_SUFFIX}`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(partPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      let head: Uint8Array | undefined;
      for await (const chunk of chunksOf(source)) {
        size += chunk.length;
        if (size > this.maxArtifactBytes) {
          throw new ArtifactRefusedError(
            'size:artifact',
            `artifact exceeds the per-artifact limit of ${String(this.maxArtifactBytes)} bytes`,
          );
        }
        const secret = scanner.push(chunk);
        if (secret !== null) {
          throw new ArtifactRefusedError(
            `secret:${secret.pattern}`,
            `refused: content matches the ${secret.description} pattern`,
          );
        }
        hash.update(chunk);
        head ??= chunk.subarray(0, 8000);
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(partPath, 0o444);

      const sha256 = hash.digest('hex');
      const mediaType = resolveMediaType(parsed.mediaType, parsed.name, head ?? new Uint8Array());
      const result = await this.withLock(sha256, () =>
        this.commit(
          { partPath, stagedSidecarPath, sha256, size, mediaType, meta: parsed },
          options,
        ),
      );
      return result;
    } catch (error) {
      throw storageFailure(error, 'cannot store artifact');
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(partPath, { force: true }).catch(() => undefined);
      await rm(stagedSidecarPath, { force: true }).catch(() => undefined);
    }
  }

  private async commit(
    staged: {
      readonly partPath: string;
      readonly stagedSidecarPath: string;
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
      readonly meta: ArtifactMeta;
    },
    options: PutOptions,
  ): Promise<PutResult> {
    const { sha256, size, meta } = staged;
    const objectPath = this.objectPath(sha256);
    const existing = await this.readSidecar(sha256);
    const storedSize = await fileSize(objectPath);

    if (storedSize !== null) {
      // Write-once: identical bytes are a hit, and a different size under the same digest would
      // mean a SHA-256 collision or a corrupted object, never a legitimate second version.
      if (storedSize !== size) {
        throw new ArtifactIntegrityError(
          `object ${sha256} holds ${String(storedSize)} bytes but new content of ${String(size)} bytes hashes to it`,
        );
      }
      if (existing === null) {
        await this.writeSidecar(sha256, this.newSidecar(staged));
      } else if (existing.pruned || !existing.kinds.includes(meta.kind)) {
        // `pruned` with the bytes still present is an interrupted prune: the put restores it.
        await this.writeSidecar(sha256, {
          ...existing,
          kinds: mergeKinds(existing.kinds, meta.kind),
          ...(existing.pruned ? notPruned(this.clock()) : {}),
        });
      }
      return {
        sha256,
        size,
        mediaType: existing?.mediaType ?? staged.mediaType,
        deduplicated: true,
      };
    }

    // The experiment budget is checked only here: a deduplicated put writes nothing and costs nothing.
    if (options.budget !== undefined && size > options.budget.remaining) {
      throw new ArtifactRefusedError(
        'size:experiment',
        `artifact of ${String(size)} bytes exceeds the experiment's remaining budget of ${String(options.budget.remaining)} bytes`,
      );
    }
    // Reserved before the first await, so concurrent puts of one experiment cannot both fit.
    options.budget?.consume(size);

    // New bytes, or bytes that retention pruned: restored with a fresh `storedAt`, so that the next
    // retention run measures their age from now.
    const sidecar: Sidecar =
      existing === null
        ? this.newSidecar(staged)
        : {
            ...existing,
            size,
            mediaType: staged.mediaType,
            kinds: mergeKinds(existing.kinds, meta.kind),
            ...notPruned(this.clock()),
          };
    const objectDir = dirname(objectPath);
    try {
      await writeJsonDurably(staged.stagedSidecarPath, sidecar);
      await mkdir(objectDir, { recursive: true });
      await this.renameObject(staged.partPath, objectPath);
    } catch (error) {
      options.budget?.release(size);
      throw error;
    }
    await rename(staged.stagedSidecarPath, this.sidecarPath(sha256));
    await syncDirectory(objectDir);
    return { sha256, size, mediaType: staged.mediaType, deduplicated: false };
  }

  async get(sha256: string): Promise<Uint8Array> {
    if (!(await this.has(sha256))) throw await this.notFound(sha256);
    let bytes: Buffer;
    try {
      bytes = await readFile(this.objectPath(sha256));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw await this.notFound(sha256);
      throw storageFailure(error, `cannot read artifact ${sha256}`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw new ArtifactIntegrityError(`object ${sha256} is corrupt: its bytes hash to ${actual}`);
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  }

  async openReadStream(sha256: string): Promise<AsyncIterable<Uint8Array>> {
    if (!(await this.has(sha256))) throw await this.notFound(sha256);
    let handle: FileHandle;
    try {
      handle = await open(this.objectPath(sha256), 'r');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') throw await this.notFound(sha256);
      throw storageFailure(error, `cannot read artifact ${sha256}`);
    }
    return handle.createReadStream();
  }

  async has(sha256: string): Promise<boolean> {
    return (await this.stat(sha256))?.pruned === false;
  }

  async stat(sha256: string): Promise<ArtifactStat | null> {
    const sidecar = await this.readSidecar(sha256);
    if (sidecar === null) return null;
    if (!sidecar.pruned && (await fileSize(this.objectPath(sha256))) === null) return null;
    return toStat(sidecar);
  }

  async delete(sha256: string): Promise<boolean> {
    const objectPath = this.objectPath(sha256);
    return this.withLock(sha256, async () => {
      const existed =
        (await this.readSidecar(sha256)) !== null || (await fileSize(objectPath)) !== null;
      try {
        // Bytes first: a crash in between leaves a sidecar with no object, which reads as absent.
        await rm(objectPath, { force: true });
        await rm(this.sidecarPath(sha256), { force: true });
      } catch (error) {
        throw storageFailure(error, `cannot delete artifact ${sha256}`);
      }
      return existed;
    });
  }

  async prune(sha256: string, reason: string, at: Date): Promise<boolean> {
    const objectPath = this.objectPath(sha256);
    return this.withLock(sha256, async () => {
      const sidecar = await this.readSidecar(sha256);
      if (sidecar === null) return false;
      try {
        // Mark first: a crash in between keeps the metadata and the pruned mark; the leftover
        // bytes are removed by the next prune or restored by the next put of the same content.
        if (!sidecar.pruned) {
          await this.writeSidecar(sha256, {
            ...sidecar,
            pruned: true,
            prunedAt: at.toISOString(),
            prunedReason: reason,
          });
        }
        await rm(objectPath, { force: true });
      } catch (error) {
        throw storageFailure(error, `cannot prune artifact ${sha256}`);
      }
      return !sidecar.pruned;
    });
  }

  async *list(filter: ListFilter = {}): AsyncIterable<ArtifactStat> {
    const prefix = filter.prefix ?? '';
    if (!/^[0-9a-f]{0,64}$/.test(prefix)) throw new TypeError(`not a hex digest prefix: ${prefix}`);
    for (const first of await sortedEntries(this.objectsDir)) {
      if (!matchesPrefix(first, prefix, 0)) continue;
      const firstDir = join(this.objectsDir, first);
      for (const second of await sortedEntries(firstDir)) {
        if (!matchesPrefix(second, prefix, 2)) continue;
        for (const entry of await sortedEntries(join(firstDir, second))) {
          const sha256 = SIDECAR_NAME.exec(entry)?.[1];
          if (sha256 === undefined || !sha256.startsWith(prefix)) continue;
          const stat = await this.stat(sha256);
          if (stat === null) continue;
          if (stat.pruned && filter.includePruned !== true) continue;
          if (filter.kind !== undefined && !stat.kinds.includes(filter.kind)) continue;
          yield stat;
        }
      }
    }
  }

  private sidecarPath(sha256: string): string {
    return `${this.objectPath(sha256)}${SIDECAR_SUFFIX}`;
  }

  private newSidecar(staged: {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly meta: ArtifactMeta;
  }): Sidecar {
    return {
      format: 1,
      sha256: staged.sha256,
      size: staged.size,
      mediaType: staged.mediaType,
      kinds: [staged.meta.kind],
      name: staged.meta.name ?? null,
      ...notPruned(this.clock()),
    };
  }

  private async readSidecar(sha256: string): Promise<Sidecar | null> {
    let text: string;
    try {
      text = await readFile(this.sidecarPath(sha256), 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw storageFailure(error, `cannot read metadata of artifact ${sha256}`);
    }
    const parsed = SidecarSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.sha256 !== sha256) {
      throw new ArtifactIntegrityError(`metadata of artifact ${sha256} is malformed`);
    }
    return parsed.data;
  }

  /** Replaces a sidecar atomically: write a staged copy, fsync, rename over the old one. */
  private async writeSidecar(sha256: string, sidecar: Sidecar): Promise<void> {
    const staged = join(this.tmpDir, `${randomUUID()}${SIDECAR_SUFFIX}`);
    try {
      await writeJsonDurably(staged, sidecar);
      await rename(staged, this.sidecarPath(sha256));
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
  }

  private async notFound(sha256: string): Promise<ArtifactNotFoundError> {
    const sidecar = await this.readSidecar(sha256).catch(() => null);
    return new ArtifactNotFoundError(sha256, sidecar?.pruned === true);
  }

  /**
   * Finishes or discards what an interrupted put left in `tmp/`. A staged sidecar whose object was
   * committed is moved into place (the crash fell between the two renames); everything else in
   * `tmp/` belongs to a put that never committed, and is removed.
   */
  private async recover(): Promise<void> {
    for (const entry of await sortedEntries(this.tmpDir)) {
      const path = join(this.tmpDir, entry);
      if (entry.endsWith(SIDECAR_SUFFIX)) {
        const sidecar = await readFile(path, 'utf8')
          .then((text) => SidecarSchema.safeParse(JSON.parse(text)))
          .catch(() => null);
        if (sidecar?.success === true && !sidecar.data.pruned) {
          const { sha256 } = sidecar.data;
          const committed = (await fileSize(this.objectPath(sha256))) !== null;
          const current = await this.readSidecar(sha256).catch(() => null);
          if (committed && (current === null || current.pruned)) {
            await rename(path, this.sidecarPath(sha256));
            continue;
          }
        }
      }
      await rm(path, { recursive: true, force: true });
    }
  }

  /** Serialises work on one digest within this process, so concurrent puts see each other. */
  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }
}

function notPruned(at: Date): Pick<Sidecar, 'storedAt' | 'pruned' | 'prunedAt' | 'prunedReason'> {
  return { storedAt: at.toISOString(), pruned: false, prunedAt: null, prunedReason: null };
}

function mergeKinds(kinds: readonly Sidecar['kinds'][number][], kind: Sidecar['kinds'][number]) {
  return kinds.includes(kind) ? [...kinds] : [...kinds, kind];
}

function toStat(sidecar: Sidecar): ArtifactStat {
  return ArtifactStatSchema.parse(
    Object.fromEntries(Object.entries(sidecar).filter(([key]) => key !== 'format')),
  );
}

async function* chunksOf(source: ArtifactSource): AsyncIterable<Uint8Array> {
  if (typeof source === 'string') {
    yield Buffer.from(source, 'utf8');
  } else if (source instanceof Uint8Array) {
    yield source;
  } else {
    for await (const chunk of source) {
      yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    }
  }
}

async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

async function writeJsonDurably(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'w', 0o644);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best effort: makes a rename durable where the platform allows fsync on a directory. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms refuse fsync on a directory; the rename itself is still atomic.
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    const handle = await open(path, 'r');
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw storageFailure(error, `cannot stat ${path}`);
  }
}

async function sortedEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return [];
    throw storageFailure(error, `cannot list ${dir}`);
  }
}

function matchesPrefix(segment: string, prefix: string, offset: number): boolean {
  if (!/^[0-9a-f]{2}$/.test(segment)) return false;
  const wanted = prefix.slice(offset, offset + 2);
  return segment.startsWith(wanted);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Passes the store's own errors through and wraps anything else (ENOSPC, EACCES, …). */
function storageFailure(error: unknown, message: string): Error {
  if (
    error instanceof ArtifactRefusedError ||
    error instanceof ArtifactNotFoundError ||
    error instanceof ArtifactIntegrityError ||
    error instanceof ArtifactStorageFailure ||
    error instanceof TypeError
  ) {
    return error;
  }
  const code = errorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  return new ArtifactStorageFailure(`${message}: ${detail}`, code, { cause: error });
}
