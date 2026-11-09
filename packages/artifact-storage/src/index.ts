// The content-addressed artifact store: a backend-neutral interface, its local-disk implementation,
// retention and the secret scanner. The bytes live here; the `artifact` table holds the metadata.
// The reusable contract suite is at `@vcpu/artifact-storage/contract-tests` (it imports Vitest).
export const packageName = '@vcpu/artifact-storage';

export * from './files.js';
export * from './kinds.js';
export * from './local-disk.js';
export * from './retention.js';
export * from './secrets.js';
export * from './store.js';
