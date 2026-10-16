// Vite/Vitest `?raw` imports: the file's text as a string. Used by tests to read the docs
// without Node's fs, which this package may not import.
declare module '*.md?raw' {
  const content: string;
  export default content;
}
