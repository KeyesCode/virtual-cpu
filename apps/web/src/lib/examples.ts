// The repository's example programs, bundled as text at build time.
const files = import.meta.glob<string>('../../../../examples/*.asm', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export interface Example {
  /** File name without the extension, e.g. `14-fibonacci`. */
  readonly name: string;
  readonly source: string;
}

export const EXAMPLES: readonly Example[] = Object.entries(files)
  .map(([path, source]) => ({ name: path.replace(/^.*\/|\.asm$/g, ''), source }))
  .sort((x, y) => x.name.localeCompare(y.name));

export const DEFAULT_EXAMPLE = 'fibonacci';

/** The example whose name is `name` or ends with `-name` (so `fibonacci` finds `14-fibonacci`). */
export function findExample(name: string): Example | undefined {
  return EXAMPLES.find((example) => example.name === name || example.name.endsWith(`-${name}`));
}
