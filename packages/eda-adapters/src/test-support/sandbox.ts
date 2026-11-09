import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

/** Test helpers for the suites that run on the real EDA sandbox image; not part of the package API. */

/** The image the sandbox suites use: EDA_SANDBOX_IMAGE, or what `pnpm research:sandbox:build` tags. */
export const SANDBOX_IMAGE = process.env['EDA_SANDBOX_IMAGE'] ?? 'silicon-lab/eda-sandbox:latest';

/** Why the sandbox suites cannot run here, or null. */
export function sandboxMissing(baselineDir?: string): string | null {
  const run = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  if (run.status !== 0) {
    return `no Docker image ${SANDBOX_IMAGE}: run 'pnpm research:sandbox:build'`;
  }
  const credentials =
    baselineDir === undefined
      ? []
      : readdirSync(baselineDir).filter(
          (name) => /^\.env(\..+)?$/.test(name) && name !== '.env.example',
        );
  return credentials.length === 0
    ? null
    : `${baselineDir ?? ''} holds ${credentials.join(', ')}, which the sandbox refuses to mount`;
}
