import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runArtifactStoreContractTests, sha256Of } from './contract-tests.js';
import { putDirectory, putFile } from './files.js';
import { DEFAULT_ARTIFACT_ROOT, LocalDiskArtifactStore } from './local-disk.js';
import { ArtifactIntegrityError, ArtifactStorageFailure, ExperimentByteBudget } from './store.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vcpu-artifacts-'));
}

/** Every file under `dir`, as POSIX paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

runArtifactStoreContractTests('LocalDiskArtifactStore', async ({ maxArtifactBytes, clock }) => {
  const root = await tempRoot();
  const store = await LocalDiskArtifactStore.open({ root, maxArtifactBytes, clock });
  return { store, cleanup: () => rm(root, { recursive: true, force: true }) };
});

describe('LocalDiskArtifactStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await tempRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lays objects out as objects/<aa>/<bb>/<sha256>, read-only, with a sidecar', async () => {
    const store = await LocalDiskArtifactStore.open({ root });
    const { sha256 } = await store.put('layout', { kind: 'tool-log', name: 'x.log' });
    const prefix = `objects/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    expect(await filesUnder(root)).toEqual([prefix, `${prefix}.meta.json`]);
    expect(store.objectPath(sha256)).toBe(join(root, prefix));
    expect((await lstat(join(root, prefix))).mode & 0o777).toBe(0o444);
    const sidecar = JSON.parse(
      await readFile(join(root, `${prefix}.meta.json`), 'utf8'),
    ) as unknown;
    expect(sidecar).toMatchObject({ format: 1, sha256, kinds: ['tool-log'], name: 'x.log' });
  });

  describe('atomicity', () => {
    it('leaves no object when the commit rename fails, and cleans tmp/', async () => {
      const store = await LocalDiskArtifactStore.open({
        root,
        renameObject: () => Promise.reject(new Error('injected rename fault')),
      });
      await expect(store.put('never lands', { kind: 'tool-log' })).rejects.toBeInstanceOf(
        ArtifactStorageFailure,
      );
      expect(await filesUnder(join(root, 'objects'))).toEqual([]);
      expect(await filesUnder(join(root, 'tmp'))).toEqual([]);
      expect(await store.has(sha256Of('never lands'))).toBe(false);
    });

    it('survives a crash before the rename: nothing under objects/, tmp/ emptied on the next open', async () => {
      let reachedRename!: () => void;
      const atRename = new Promise<void>((resolve) => (reachedRename = resolve));
      const crashing = await LocalDiskArtifactStore.open({
        root,
        // The process "dies" here: the put never settles and its cleanup never runs.
        renameObject: () => {
          reachedRename();
          return new Promise(() => undefined);
        },
      });
      void crashing.put('interrupted', { kind: 'waveform' });
      await atRename;

      const sha256 = sha256Of('interrupted');
      expect((await filesUnder(join(root, 'tmp'))).length).toBeGreaterThan(0);
      expect((await filesUnder(join(root, 'objects'))).some((path) => path.includes(sha256))).toBe(
        false,
      );

      const restarted = await LocalDiskArtifactStore.open({ root });
      expect(await filesUnder(join(root, 'tmp'))).toEqual([]);
      expect(await filesUnder(join(root, 'objects'))).toEqual([]);
      expect(await restarted.has(sha256)).toBe(false);
      expect((await restarted.put('interrupted', { kind: 'waveform' })).deduplicated).toBe(false);
    });

    it('rolls a crash between the object and sidecar renames forward on the next open', async () => {
      let reachedRename!: () => void;
      const afterRename = new Promise<void>((resolve) => (reachedRename = resolve));
      const crashing = await LocalDiskArtifactStore.open({
        root,
        renameObject: async (from, to) => {
          await rename(from, to);
          reachedRename();
          return new Promise(() => undefined);
        },
      });
      void crashing.put('half committed', { kind: 'timing-report', name: 'sta.rpt' });
      await afterRename;

      const sha256 = sha256Of('half committed');
      expect(await crashing.stat(sha256)).toBeNull();

      const restarted = await LocalDiskArtifactStore.open({ root });
      expect(await filesUnder(join(root, 'tmp'))).toEqual([]);
      expect(await restarted.has(sha256)).toBe(true);
      expect(await restarted.stat(sha256)).toMatchObject({
        kinds: ['timing-report'],
        name: 'sta.rpt',
      });
    });

    it('surfaces a full disk as an infrastructure failure and refunds the budget', async () => {
      const store = await LocalDiskArtifactStore.open({
        root,
        renameObject: () =>
          Promise.reject(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })),
      });
      const budget = new ExperimentByteBudget(100);
      const error: unknown = await store
        .put('disk full', { kind: 'tool-log' }, { budget })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ArtifactStorageFailure);
      expect(error).toMatchObject({ code: 'ENOSPC', failureClass: 'infrastructure-failure' });
      expect(budget.used).toBe(0);
    });
  });

  it('detects a corrupted object on get', async () => {
    const store = await LocalDiskArtifactStore.open({ root });
    const { sha256 } = await store.put('original', { kind: 'tool-log' });
    const path = store.objectPath(sha256);
    await chmod(path, 0o644);
    await writeFile(path, 'tampered');
    await expect(store.get(sha256)).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it('refuses new bytes whose size disagrees with the object already under their digest', async () => {
    const store = await LocalDiskArtifactStore.open({ root });
    const { sha256 } = await store.put('original', { kind: 'tool-log' });
    const path = store.objectPath(sha256);
    await chmod(path, 0o644);
    await writeFile(path, 'a different length');
    await expect(store.put('original', { kind: 'tool-log' })).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  describe('fromEnv', () => {
    it('resolves RESEARCH_ARTIFACT_ROOT against the base directory', async () => {
      const store = await LocalDiskArtifactStore.fromEnv({
        env: { RESEARCH_ARTIFACT_ROOT: 'custom/store' },
        baseDir: root,
      });
      expect(store.root).toBe(join(root, 'custom/store'));
      expect((await lstat(join(root, 'custom/store/objects'))).isDirectory()).toBe(true);
    });

    it('defaults to .research/artifacts', async () => {
      const store = await LocalDiskArtifactStore.fromEnv({ env: {}, baseDir: root });
      expect(store.root).toBe(join(root, DEFAULT_ARTIFACT_ROOT));
    });
  });

  describe('putFile and putDirectory', () => {
    it('streams a real Project 3 report and RTL file with their media types', async () => {
      const store = await LocalDiskArtifactStore.open({ root });
      const report = await putFile(
        store,
        join(REPO_ROOT, 'packages/eda-adapters/test/fixtures/verify-pass.json'),
        { kind: 'verification-report' },
      );
      expect(report.mediaType).toBe('application/json');
      expect((await store.stat(report.sha256))?.name).toBe('verify-pass.json');
      const rtl = join(REPO_ROOT, 'hardware/accelerators/matmul/rtl/processing_element.sv');
      const source = await putFile(store, rtl, { kind: 'candidate-source' });
      expect(source.mediaType).toBe('text/x-systemverilog');
      expect(source.sha256).toBe(sha256Of(await readFile(rtl)));
    });

    it('stores each file and a sorted manifest of them', async () => {
      const store = await LocalDiskArtifactStore.open({ root: join(root, 'store') });
      const dir = join(root, 'vectors');
      await mkdir(join(dir, 'nested'), { recursive: true });
      await writeFile(join(dir, 'b.hex'), '00\n01\n');
      await writeFile(join(dir, 'a.json'), '{"count":2}\n');
      await writeFile(join(dir, 'nested', 'c.txt'), 'deep\n');
      // Same bytes as a.json: one object, two manifest entries.
      await writeFile(join(dir, 'nested', 'a-copy.json'), '{"count":2}\n');

      const result = await putDirectory(store, dir, { kind: 'test-vectors' });
      expect(result.entries.map((entry) => entry.path)).toEqual([
        'a.json',
        'b.hex',
        'nested/a-copy.json',
        'nested/c.txt',
      ]);
      expect(result.entries[0]?.sha256).toBe(result.entries[2]?.sha256);
      expect(result.manifest.mediaType).toBe('application/vnd.vcpu.artifact-directory+json');
      const manifest = JSON.parse(
        Buffer.from(await store.get(result.manifest.sha256)).toString('utf8'),
      ) as unknown;
      expect(manifest).toEqual({ format: 'vcpu.artifact-directory/1', entries: result.entries });
      expect((await store.stat(result.manifest.sha256))?.kinds).toEqual(['test-vectors']);
    });

    it('refuses a symbolic link instead of following it out of the directory', async () => {
      const store = await LocalDiskArtifactStore.open({ root: join(root, 'store') });
      const dir = join(root, 'with-link');
      await mkdir(dir);
      await symlink('/etc/hosts', join(dir, 'hosts'));
      await expect(putDirectory(store, dir, { kind: 'tool-log' })).rejects.toThrow(
        /not a regular file/,
      );
    });
  });
});
