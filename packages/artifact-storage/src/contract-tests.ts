import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  ArtifactRefusedError,
  type ArtifactStat,
  type ArtifactStore,
  ExperimentByteBudget,
  type ListFilter,
} from './store.js';

/** What the suite asks of a store under test. */
export interface ContractStoreOptions {
  /** The per-artifact limit the store must enforce. */
  readonly maxArtifactBytes: number;
  /** The clock the store must use for `storedAt`. */
  readonly clock: () => Date;
}

export interface ContractStoreHandle {
  readonly store: ArtifactStore;
  /** Removes whatever the factory created (a temp directory, a test bucket). */
  readonly cleanup?: () => Promise<void>;
}

/** Makes a fresh, empty store for one test. */
export type ArtifactStoreFactory = (options: ContractStoreOptions) => Promise<ContractStoreHandle>;

/** The per-artifact limit every store under contract test is configured with. */
export const CONTRACT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

const FIXED_TIME = new Date('2026-11-01T12:00:00.000Z');

/** A fake Anthropic key, assembled at runtime so that this file itself holds no match. */
export const FAKE_ANTHROPIC_KEY = ['sk', 'ant', 'api03', 'Zx9vQ2mP7kLr4TfW1bYc8NdHs3Ue6Ga5'].join(
  '-',
);

export function sha256Of(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function concat(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    await Promise.resolve();
    yield bytes.subarray(offset, offset + size);
  }
}

async function listed(store: ArtifactStore, filter?: ListFilter): Promise<string[]> {
  return (await collect(store.list(filter))).map((stat: ArtifactStat) => stat.sha256);
}

/**
 * The behaviour every `ArtifactStore` must have, as a Vitest suite. A backend's test file calls it
 * with a factory that returns a fresh, empty store; the local-disk store runs it in a temp
 * directory, and an S3-compatible store can run it against a test bucket.
 */
export function runArtifactStoreContractTests(name: string, factory: ArtifactStoreFactory): void {
  describe(`ArtifactStore contract: ${name}`, () => {
    let store: ArtifactStore;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const handle = await factory({
        maxArtifactBytes: CONTRACT_MAX_ARTIFACT_BYTES,
        clock: () => FIXED_TIME,
      });
      store = handle.store;
      cleanup = handle.cleanup;
    });

    afterEach(async () => {
      await cleanup?.();
    });

    describe('put and get', () => {
      it('round-trips a buffer under its sha256', async () => {
        const bytes = Buffer.from('module pe; endmodule\n');
        const result = await store.put(bytes, { kind: 'candidate-source', name: 'pe.sv' });
        expect(result).toEqual({
          sha256: sha256Of(bytes),
          size: bytes.length,
          mediaType: 'text/x-systemverilog',
          deduplicated: false,
        });
        expect(Buffer.from(await store.get(result.sha256))).toEqual(bytes);
      });

      it('round-trips a stream of mixed string and byte chunks', async () => {
        async function* source(): AsyncIterable<Uint8Array | string> {
          await Promise.resolve();
          yield '{"passed":';
          yield Buffer.from('42,"failed":0}');
        }
        const result = await store.put(source(), {
          kind: 'verification-report',
          name: 'verify.json',
        });
        expect(result.sha256).toBe(sha256Of('{"passed":42,"failed":0}'));
        expect(result.mediaType).toBe('application/json');
        expect(Buffer.from(await store.get(result.sha256)).toString()).toBe(
          '{"passed":42,"failed":0}',
        );
      });

      it('streams a multi-megabyte object in and out', async () => {
        const bytes = Buffer.alloc(5 * 1024 * 1024 + 123);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) % 251;
        const result = await store.put(chunked(bytes, 64 * 1024), { kind: 'waveform' });
        expect(result.size).toBe(bytes.length);
        expect(result.sha256).toBe(sha256Of(bytes));
        expect((await concat(await store.openReadStream(result.sha256))).equals(bytes)).toBe(true);
      });

      it('stores the empty artifact', async () => {
        const result = await store.put('', { kind: 'tool-log' });
        expect(result.sha256).toBe(sha256Of(''));
        expect(result.size).toBe(0);
        expect((await store.get(result.sha256)).length).toBe(0);
      });

      it('infers the media type from the name, then the content, unless one is given', async () => {
        const named = await store.put('a,b\n', { kind: 'tool-log', name: 'cells.csv' });
        expect(named.mediaType).toBe('text/csv');
        const text = await store.put('plain words\n', { kind: 'tool-log' });
        expect(text.mediaType).toBe('text/plain');
        const binary = await store.put(Buffer.from([0, 1, 2, 3, 255]), { kind: 'waveform' });
        expect(binary.mediaType).toBe('application/octet-stream');
        const explicit = await store.put('{}', {
          kind: 'agent-output',
          name: 'out.txt',
          mediaType: 'application/json',
        });
        expect(explicit.mediaType).toBe('application/json');
      });
    });

    describe('deduplication', () => {
      it('reports a second put of the same bytes as deduplicated', async () => {
        const first = await store.put('same bytes', { kind: 'tool-log', name: 'a.log' });
        const second = await store.put(Buffer.from('same bytes'), {
          kind: 'tool-log',
          name: 'b.log',
        });
        expect(first.deduplicated).toBe(false);
        expect(second).toEqual({ ...first, deduplicated: true });
        expect(await listed(store)).toEqual([first.sha256]);
        // The first put's metadata stands: write-once covers the name too.
        expect((await store.stat(first.sha256))?.name).toBe('a.log');
      });

      it('records every kind the same bytes were stored as', async () => {
        const result = await store.put('shared', { kind: 'waveform' });
        await store.put('shared', { kind: 'reproducibility-manifest' });
        expect((await store.stat(result.sha256))?.kinds).toEqual([
          'waveform',
          'reproducibility-manifest',
        ]);
      });

      it('lets exactly one of two concurrent puts of the same bytes write', async () => {
        const results = await Promise.all([
          store.put('race', { kind: 'tool-log' }),
          store.put('race', { kind: 'tool-log' }),
        ]);
        expect(results.map((result) => result.sha256)).toEqual([
          sha256Of('race'),
          sha256Of('race'),
        ]);
        expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
      });
    });

    describe('has, stat and list', () => {
      it('knows nothing about bytes it never stored', async () => {
        const absent = sha256Of('never stored');
        expect(await store.has(absent)).toBe(false);
        expect(await store.stat(absent)).toBeNull();
        await expect(store.get(absent)).rejects.toBeInstanceOf(ArtifactNotFoundError);
        await expect(store.openReadStream(absent)).rejects.toBeInstanceOf(ArtifactNotFoundError);
      });

      it('returns the metadata of a stored object', async () => {
        const result = await store.put('report', { kind: 'synthesis-report', name: 'stat.txt' });
        expect(await store.has(result.sha256)).toBe(true);
        expect(await store.stat(result.sha256)).toEqual({
          sha256: result.sha256,
          size: 6,
          mediaType: 'text/plain',
          kinds: ['synthesis-report'],
          name: 'stat.txt',
          storedAt: FIXED_TIME.toISOString(),
          pruned: false,
          prunedAt: null,
          prunedReason: null,
        });
      });

      it('lists in digest order and filters by kind and digest prefix', async () => {
        const digests = [];
        for (let index = 0; index < 6; index += 1) {
          const kind = index % 2 === 0 ? 'tool-log' : 'timing-report';
          digests.push({
            kind,
            sha256: (await store.put(`object ${String(index)}`, { kind })).sha256,
          });
        }
        const all = digests.map((entry) => entry.sha256).sort();
        expect(await listed(store)).toEqual(all);
        expect(await listed(store, { kind: 'timing-report' })).toEqual(
          digests
            .filter((entry) => entry.kind === 'timing-report')
            .map((entry) => entry.sha256)
            .sort(),
        );
        const target = all[3] ?? '';
        for (const length of [1, 2, 3, 5, 64]) {
          const prefix = target.slice(0, length);
          expect(await listed(store, { prefix })).toEqual(
            all.filter((sha) => sha.startsWith(prefix)),
          );
        }
      });

      it('rejects a digest that is not 64 lowercase hex characters', async () => {
        for (const bad of ['../../etc/passwd', 'ABC', sha256Of('x').toUpperCase(), '']) {
          await expect(store.has(bad)).rejects.toBeInstanceOf(TypeError);
          await expect(store.get(bad)).rejects.toBeInstanceOf(TypeError);
        }
      });
    });

    describe('delete and prune', () => {
      it('deletes bytes and metadata', async () => {
        const { sha256 } = await store.put('to delete', { kind: 'tool-log' });
        expect(await store.delete(sha256)).toBe(true);
        expect(await store.has(sha256)).toBe(false);
        expect(await store.stat(sha256)).toBeNull();
        expect(await listed(store, { includePruned: true })).toEqual([]);
        expect(await store.delete(sha256)).toBe(false);
        // Deleted bytes can be stored again as new.
        expect((await store.put('to delete', { kind: 'tool-log' })).deduplicated).toBe(false);
      });

      it('prunes the bytes but keeps the metadata', async () => {
        const { sha256 } = await store.put('old waveform', { kind: 'waveform' });
        const at = new Date('2026-11-20T00:00:00.000Z');
        expect(await store.prune(sha256, 'retention test', at)).toBe(true);
        expect(await store.has(sha256)).toBe(false);
        expect(await store.stat(sha256)).toMatchObject({
          sha256,
          kinds: ['waveform'],
          pruned: true,
          prunedAt: at.toISOString(),
          prunedReason: 'retention test',
        });
        await expect(store.get(sha256)).rejects.toMatchObject({ pruned: true });
        expect(await listed(store)).toEqual([]);
        expect(await listed(store, { includePruned: true })).toEqual([sha256]);
        expect(await store.prune(sha256, 'again', at)).toBe(false);
      });

      it('restores pruned bytes on a later put', async () => {
        const { sha256 } = await store.put('comes back', { kind: 'tool-log' });
        await store.prune(sha256, 'retention test', FIXED_TIME);
        expect((await store.put('comes back', { kind: 'tool-log' })).deduplicated).toBe(false);
        expect(await store.has(sha256)).toBe(true);
        expect(await store.stat(sha256)).toMatchObject({ pruned: false, prunedAt: null });
      });
    });

    describe('refusals', () => {
      it('refuses an artifact over the per-artifact limit and stores nothing', async () => {
        const bytes = Buffer.alloc(CONTRACT_MAX_ARTIFACT_BYTES + 1, 7);
        await expect(
          store.put(chunked(bytes, 1024 * 1024), { kind: 'waveform' }),
        ).rejects.toMatchObject({
          reason: 'size:artifact',
          failureClass: 'budget-exceeded',
        });
        expect(await store.has(sha256Of(bytes))).toBe(false);
        expect(await listed(store, { includePruned: true })).toEqual([]);
      });

      it('enforces the experiment budget on new bytes only', async () => {
        const budget = new ExperimentByteBudget(10);
        await store.put('12345678', { kind: 'tool-log' }, { budget });
        expect(budget.used).toBe(8);
        await expect(store.put('abcde', { kind: 'tool-log' }, { budget })).rejects.toMatchObject({
          reason: 'size:experiment',
        });
        expect(await store.has(sha256Of('abcde'))).toBe(false);
        expect(budget.used).toBe(8);
        // A deduplicated put writes nothing, so it fits whatever the budget has left.
        expect((await store.put('12345678', { kind: 'tool-log' }, { budget })).deduplicated).toBe(
          true,
        );
        expect(budget.used).toBe(8);
      });

      it('refuses an unknown kind', async () => {
        const error: unknown = await store
          .put('x', { kind: 'not-a-kind' } as never)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ArtifactRefusedError);
        expect(error).toMatchObject({ reason: 'invalid-meta' });
        expect(await store.has(sha256Of('x'))).toBe(false);
      });

      it('refuses content holding a credential, naming the pattern, and writes nothing', async () => {
        const content = `ANTHROPIC usage note\nkey: ${FAKE_ANTHROPIC_KEY}\n`;
        await expect(store.put(content, { kind: 'agent-output' })).rejects.toMatchObject({
          reason: 'secret:anthropic-key',
          failureClass: 'policy-violation',
        });
        expect(await store.has(sha256Of(content))).toBe(false);
        expect(await store.stat(sha256Of(content))).toBeNull();
        expect(await listed(store, { includePruned: true })).toEqual([]);
      });
    });
  });
}
