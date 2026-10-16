import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { BenchmarkEnvironment } from '@vcpu/benchmarks';

function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Name → version of every workspace package under `apps/` and `packages/`. */
function workspaceVersions(root: string): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const group of ['apps', 'packages']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const manifest = join(dir, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (json.name !== undefined) versions[json.name] = json.version ?? 'unknown';
    }
  }
  return versions;
}

/** The machine, runtime and checkout a benchmark runs on, for the report's `environment`. */
export function collectEnvironment(root: string): BenchmarkEnvironment {
  const sha = git(root, ['rev-parse', '--short', 'HEAD']);
  const status = sha === null ? null : git(root, ['status', '--porcelain']);
  return {
    runtime: `node ${process.version}`,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: cpus()[0]?.model.trim() ?? 'unknown',
    cpuCount: availableParallelism(),
    totalMemoryBytes: totalmem(),
    gitSha: sha,
    gitDirty: status === null ? null : status.length > 0,
    packages: workspaceVersions(root),
  };
}
