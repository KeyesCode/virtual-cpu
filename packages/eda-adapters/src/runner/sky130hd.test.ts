import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The vendored sky130hd files (hardware/asic/sky130hd/SOURCE.md) are exactly what was pinned. */

const DIR = fileURLToPath(new URL('../../../../hardware/asic/sky130hd/', import.meta.url));
const NOT_VENDORED = new Set(['MANIFEST.sha256', 'SOURCE.md', 'LICENSE', 'LICENSE-ORFS-scripts']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [relative(DIR, path)];
  });
}

const manifest = new Map(
  readFileSync(join(DIR, 'MANIFEST.sha256'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [sha256 = '', path = ''] = line.split(/ {2}/);
      return [path, sha256] as const;
    }),
);

describe('the vendored sky130hd platform', () => {
  it('lists every vendored file in MANIFEST.sha256, and nothing else', () => {
    const vendored = files(DIR)
      .filter((path) => !NOT_VENDORED.has(path))
      .sort();
    expect([...manifest.keys()].sort()).toEqual(vendored);
  });

  it.each([...manifest])('%s has its manifest sha256', (path, sha256) => {
    const digest = createHash('sha256')
      .update(readFileSync(join(DIR, path)))
      .digest('hex');
    expect(digest).toBe(sha256);
  });

  it('pins the liberty that hardware/asic/toolchain.env names', () => {
    const env = readFileSync(join(DIR, '..', 'toolchain.env'), 'utf8');
    const liberty = /^SKY130HD_LIBERTY=(.+)$/m.exec(env)?.[1];
    const sha256 = /^SKY130HD_LIBERTY_SHA256=(.+)$/m.exec(env)?.[1];
    expect(liberty).toBeDefined();
    expect(manifest.get(liberty ?? '')).toBe(sha256);
  });

  it('names its upstream tag and licences', () => {
    const source = readFileSync(join(DIR, 'SOURCE.md'), 'utf8');
    expect(source).toContain('`26Q4`');
    expect(source).toContain('ecb3cfdeb1cafd5c096dc4b3700f97a50329509c');
    expect(source).toContain('Apache-2.0');
    expect(readFileSync(join(DIR, 'LICENSE'), 'utf8')).toMatch(/Apache License\s+Version 2\.0/);
    expect(readFileSync(join(DIR, 'LICENSE-ORFS-scripts'), 'utf8')).toContain(
      'BSD 3-Clause License',
    );
  });
});
