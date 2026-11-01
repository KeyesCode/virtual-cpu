import { z } from 'zod';

/** A lowercase hexadecimal SHA-256 digest. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

/** A full lowercase git commit id. */
export const GitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export type GitCommit = z.infer<typeof GitCommitSchema>;

/**
 * A path relative to the repository root that stays inside it. Rejects the root itself, so that a
 * caller cannot name "everything".
 */
export const RepoPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) => {
      if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
      const segments = path.replace(/\/$/, '').split('/');
      return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
    },
    { message: 'must be a relative path inside the repository' },
  );
