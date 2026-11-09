import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { DIRECTORY_MANIFEST_MEDIA_TYPE } from './kinds.js';
import type { ArtifactMeta, ArtifactStore, PutOptions, PutResult } from './store.js';

/** One file of a stored directory. */
export interface DirectoryManifestEntry {
  /** POSIX path relative to the directory. */
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

/** The manifest `putDirectory` stores, as JSON, alongside the files. */
export interface DirectoryManifest {
  readonly format: 'vcpu.artifact-directory/1';
  readonly entries: readonly DirectoryManifestEntry[];
}

export interface PutDirectoryResult {
  /** The manifest object. */
  readonly manifest: PutResult;
  readonly entries: readonly DirectoryManifestEntry[];
}

/** Streams a local file into the store. `meta.name` defaults to the file's base name. */
export function putFile(
  store: ArtifactStore,
  path: string,
  meta: ArtifactMeta,
  options: PutOptions = {},
): Promise<PutResult> {
  return store.put(createReadStream(path), { name: basename(path), ...meta }, options);
}

/**
 * Stores every regular file under `dir` as its own object (all with `meta.kind`), then a JSON
 * manifest of `{path, sha256, size, mediaType}` entries, sorted by path, as one more object of the
 * same kind. Symbolic links and other special files are refused rather than followed, so nothing
 * outside `dir` can be stored by accident.
 */
export async function putDirectory(
  store: ArtifactStore,
  dir: string,
  meta: ArtifactMeta,
  options: PutOptions = {},
): Promise<PutDirectoryResult> {
  const entries: DirectoryManifestEntry[] = [];
  for (const path of await walk(dir)) {
    const relativePath = relative(dir, path).split(sep).join('/');
    const result = await store.put(
      createReadStream(path),
      { kind: meta.kind, name: relativePath },
      options,
    );
    entries.push({
      path: relativePath,
      sha256: result.sha256,
      size: result.size,
      mediaType: result.mediaType,
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: DirectoryManifest = { format: 'vcpu.artifact-directory/1', entries };
  const manifestResult = await store.put(
    `${JSON.stringify(manifest, null, 2)}\n`,
    { name: basename(dir), ...meta, mediaType: DIRECTORY_MANIFEST_MEDIA_TYPE },
    options,
  );
  return { manifest: manifestResult, entries };
}

/** Every regular file under `dir`, sorted by path. */
async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (info.isFile()) {
      files.push(path);
    } else {
      throw new Error(`refusing to store ${path}: not a regular file or directory`);
    }
  }
  return files;
}
