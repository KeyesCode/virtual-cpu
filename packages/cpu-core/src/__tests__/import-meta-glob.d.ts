// Vite/Vitest `import.meta.glob`: files matched at transform time. The examples suite uses it to
// read `examples/` without Node's fs, which this package may not import.
interface ImportMetaGlobOptions {
  readonly eager: true;
  readonly query?: string;
  readonly import?: string;
}

interface ImportMeta {
  glob<T>(pattern: string, options: ImportMetaGlobOptions): Record<string, T>;
}
