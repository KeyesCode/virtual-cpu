import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS, SecretScanner, scanForSecrets } from './secrets.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');

// Fake credentials, assembled at runtime so that no file in the repository holds one verbatim.
const alnum = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY';
const FAKE = {
  anthropic: ['sk', 'ant', 'api03', `${alnum}_-${alnum}`].join('-'),
  openai: `${['sk', 'proj'].join('-')}-${alnum}${alnum}`,
  openaiLegacy: `sk-${alnum}${alnum.slice(0, 16)}`,
  github: `ghp_${alnum}ZZZZ`,
  githubPat: `github_pat_${alnum}_${alnum}`,
  aws: `AKIAIOSFODNN7EXAMPLE`,
  privateKey: ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
  privateKeyPlain: ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
  bearer: `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.${alnum}.${alnum}`,
  env: `RESEARCH_API_TOKEN=${alnum}`,
  envExport: `export DB_PASSWORD="${alnum}"`,
};

describe('secret patterns', () => {
  it.each([
    ['anthropic-key', FAKE.anthropic],
    ['openai-key', FAKE.openai],
    ['openai-key', FAKE.openaiLegacy],
    ['github-token', FAKE.github],
    ['github-token', FAKE.githubPat],
    ['aws-access-key', FAKE.aws],
    ['private-key', FAKE.privateKey],
    ['private-key', FAKE.privateKeyPlain],
    ['bearer-token', FAKE.bearer],
    ['env-secret', FAKE.env],
    ['env-secret', FAKE.envExport],
  ])('finds %s', (pattern, secret) => {
    expect(scanForSecrets(`some context before\n${secret}\nand after\n`)?.pattern).toBe(pattern);
  });

  it('covers every pattern in the table', () => {
    const tested = new Set([
      'anthropic-key',
      'openai-key',
      'github-token',
      'aws-access-key',
      'private-key',
      'bearer-token',
      'env-secret',
    ]);
    expect(SECRET_PATTERNS.map((entry) => entry.name).sort()).toEqual([...tested].sort());
  });

  it.each([
    ['a placeholder bearer token', 'Authorization: Bearer <token>'],
    ['an empty env token', 'RESEARCH_API_TOKEN=\n'],
    ['a short env value', 'SOME_TOKEN=abc\n'],
    ['an env reference', 'GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}\n'],
    ['AKIA inside a longer identifier', `wire XAKIAIOSFODNN7EXAMPLEX;`],
    ['an uppercase hex hash', 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4'],
    ['sk- inside an identifier', `assign task-${alnum}${alnum} = 1'b0;`],
    ['a public key block', '-----BEGIN PUBLIC KEY-----'],
    ['a lowercase env name', `my_token=${alnum}`],
  ])('ignores %s', (_label, text) => {
    expect(scanForSecrets(text)).toBeNull();
  });

  it('finds a secret split across two chunks', () => {
    const text = `${'x'.repeat(5000)}\n${FAKE.anthropic}\n`;
    const bytes = Buffer.from(text);
    const cut = text.indexOf('sk-ant') + 9;
    const scanner = new SecretScanner();
    expect(scanner.push(bytes.subarray(0, cut))).toBeNull();
    expect(scanner.push(bytes.subarray(cut))?.pattern).toBe('anthropic-key');
  });

  it('does not treat a chunk boundary as the start of a line', () => {
    const scanner = new SecretScanner();
    // The cut falls after "MY", so the second chunk alone would look like a line-leading assignment.
    const text = `${'y'.repeat(3000)} MY_TOKEN=${alnum}`;
    const cut = text.indexOf('_TOKEN');
    expect(scanner.push(Buffer.from(text.slice(0, cut)))).toBeNull();
    expect(scanner.push(Buffer.from(text.slice(cut)))).toBeNull();
  });

  it('scans binary content only up to the limit', () => {
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(2048, 7)]);
    const early = new SecretScanner({ binaryScanLimitBytes: 4096 });
    early.push(binary);
    expect(early.push(Buffer.from(FAKE.aws))?.pattern).toBe('aws-access-key');

    const late = new SecretScanner({ binaryScanLimitBytes: 1024 });
    late.push(binary);
    expect(late.truncated).toBe(true);
    expect(late.push(Buffer.from(FAKE.aws))).toBeNull();
  });

  it('scans text in full whatever its size', () => {
    const scanner = new SecretScanner({ text: true, binaryScanLimitBytes: 16 });
    scanner.push(Buffer.from('z'.repeat(4096)));
    expect(scanner.push(Buffer.from(`\n${FAKE.env}\n`))?.pattern).toBe('env-secret');
  });
});

describe('no false positives on real repository content', () => {
  async function filesIn(dir: string, extensions: readonly string[]): Promise<string[]> {
    const entries = await readdir(join(REPO_ROOT, dir), { recursive: true });
    return entries
      .filter((entry) => extensions.some((extension) => entry.endsWith(extension)))
      .map((entry) => join(REPO_ROOT, dir, entry));
  }

  it('passes the Project 3 RTL', async () => {
    const files = await filesIn('hardware/accelerators/matmul/rtl', ['.sv', '.svh', '.v']);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect([file, scanForSecrets(await readFile(file))]).toEqual([file, null]);
  });

  it('passes the JSON reports and Yosys stats used as fixtures', async () => {
    const files = [
      ...(await filesIn('packages/eda-adapters/test/fixtures', ['.json', '.txt'])),
      join(REPO_ROOT, 'research/accelerators/matmul/synth/baseline.json'),
    ];
    for (const file of files)
      expect([file, scanForSecrets(await readFile(file))]).toEqual([file, null]);
  });

  it('flags .env.example for its development database password, not its empty token', async () => {
    const text = await readFile(join(REPO_ROOT, '.env.example'), 'utf8');
    expect(scanForSecrets(text)?.pattern).toBe('env-secret');
    const withoutPassword = text
      .split('\n')
      .filter((line) => !line.startsWith('POSTGRES_PASSWORD='))
      .join('\n');
    expect(scanForSecrets(withoutPassword)).toBeNull();
  });
});
