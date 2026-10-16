// Vite/Vitest `import.meta.glob`, used by the tests to pick up `examples/*.asm` without Node's fs.
interface ImportMeta {
  glob(
    pattern: string,
    options: { readonly query: '?raw'; readonly import: 'default'; readonly eager: true },
  ): Record<string, string>;
}
