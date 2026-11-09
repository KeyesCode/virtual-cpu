import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommandRecord } from '@vcpu/research-core';
import { CappedLog } from './capped-log.js';
import type { CommandRunner, RunOptions } from './command-runner.js';
import { HostCommandRunner } from './host-runner.js';

/** The label on every sandbox container, so a test or an operator can find any left behind. */
export const SANDBOX_LABEL = 'org.siliconlab.sandbox';
/** The OSS CAD Suite's binaries inside the image; the Yosys adapter takes `yosys` from here. */
export const SANDBOX_TOOL_BIN = '/opt/vcpu8/oss-cad-suite/bin';
/** The image's own home and scratch directory, a size-limited tmpfs. */
const SANDBOX_HOME = '/tmp';
/** The uid:gid used when this process runs as root: the image's `eda` user. */
const FALLBACK_USER = '10001:10001';
/** How long a Docker CLI call other than the command itself may take. */
const DOCKER_CALL_MS = 60_000;
/** More files than this in the read-write binds is a policy violation, however small they are. */
const MAX_WRITTEN_FILES = 100_000;

const DEFAULTS = {
  platform: 'linux/amd64',
  memory: '4g',
  cpus: 2,
  pidsLimit: 1024,
  tmpfsBytes: 1 << 30,
  maxOutputBytes: 2 * (1 << 30),
  killGraceMs: 5000,
  watchIntervalMs: 2000,
};

/** Variables a command may pass through `RunOptions.env`; anything else is refused. */
export const DEFAULT_SANDBOX_ENV_ALLOW: readonly string[] = [];

/** Credential files that must never be mounted, anywhere in the baseline tree. */
const CREDENTIAL_FILE = /^\.env(\..+)?$/;
const CREDENTIAL_FILE_OK = new Set(['.env.example']);
/** Directories the credential search does not enter: dependencies and git internals. */
const CREDENTIAL_SEARCH_SKIP = new Set(['node_modules', '.git']);

/**
 * Host paths no bind may be, sit under, or contain: the kernel's and Docker's own state, the
 * Docker socket's directories and system configuration (with macOS's /private spellings).
 */
const DENIED_BIND_PATHS = [
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/var/run',
  '/var/lib/docker',
  '/etc',
  '/private/etc',
  '/private/var/run',
];

/** The three host directories a sandboxed command sees, each at its own host path. */
export interface SandboxBinds {
  /** The frozen baseline tree (repository root with its `node_modules`), mounted read-only. */
  readonly baselineDir: string;
  /** The candidate workspace, mounted read-write. Outside the baseline tree. */
  readonly workspaceDir: string;
  /** The output directory of the run, mounted read-write and size-checked. Outside the baseline. */
  readonly outputDir: string;
}

export interface SandboxRunnerOptions extends SandboxBinds {
  /** The image reference, such as `silicon-lab/eda-sandbox:latest`. */
  readonly image: string;
  /** `uid:gid`, neither 0. The calling user's ids by default (the image's `eda` user if root). */
  readonly user?: string;
  /** `--platform`; linux/amd64 unless set, as OpenROAD ships for nothing else. */
  readonly platform?: string;
  /** `--memory` (and `--memory-swap`, so there is no swap on top), like `4g`. */
  readonly memory?: string;
  readonly cpus?: number;
  readonly pidsLimit?: number;
  /** The size of the `/tmp` tmpfs. */
  readonly tmpfsBytes?: number;
  /**
   * The most the two read-write binds may hold together, checked while a command runs and after
   * it. Over it is a policy violation: the container is killed and the output directory trimmed.
   */
  readonly maxOutputBytes?: number;
  /** How often the read-write binds are measured while a command runs. */
  readonly watchIntervalMs?: number;
  /** Names of `RunOptions.env` variables that may reach the container. */
  readonly envAllow?: readonly string[];
  /** After `docker kill`, how long to wait for the Docker CLI before abandoning it. */
  readonly killGraceMs?: number;
  /** The Docker CLI; `docker` on PATH unless set. */
  readonly docker?: string;
}

/** The Docker CLI's own environment: how to reach the daemon, nothing else of the host's. */
function dockerCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'HOME',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** One Docker CLI call that is not the command: its output, or why it failed. */
function docker(
  cli: string,
  args: readonly string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; why: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      cli,
      [...args],
      { env: dockerCliEnv(), timeout: DOCKER_CALL_MS, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => {
        const why =
          stderr
            .trim()
            .split('\n')
            .find((line) => line.trim() !== '') ||
          error?.message ||
          '';
        resolvePromise({ ok: error === null, stdout, stderr, why });
      },
    );
  });
}

function defaultUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) return FALLBACK_USER;
  return `${String(uid)}:${String(gid)}`;
}

/** Whether `path` is `dir` or inside it. */
function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Every regular file under `dir` with its size, without following symbolic links. */
function filesUnder(dir: string, limit = Infinity): { path: string; bytes: number }[] {
  const files: { path: string; bytes: number }[] = [];
  const walk = (path: string) => {
    if (files.length > limit) return;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries: string[];
      try {
        entries = readdirSync(path);
      } catch {
        return;
      }
      for (const entry of entries) walk(join(path, entry));
    } else if (stat.isFile()) {
      files.push({ path, bytes: stat.size });
    }
  };
  walk(dir);
  return files;
}

/** Credential files anywhere in `dir`, outside dependencies and git internals, as relative paths. */
function credentialFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (path: string) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!CREDENTIAL_SEARCH_SKIP.has(entry.name)) walk(full);
      } else if (CREDENTIAL_FILE.test(entry.name) && !CREDENTIAL_FILE_OK.has(entry.name)) {
        found.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return found;
}

/** The real path of an existing directory, or null. */
function realDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** The binds as mounted: `source` is the host's real path, `target` the path adapters use. */
interface ResolvedBinds {
  readonly baseline: { readonly source: string; readonly target: string };
  readonly workspace: { readonly source: string; readonly target: string };
  readonly output: { readonly source: string; readonly target: string };
}

/**
 * Runs each command in a fresh container of the EDA sandbox image (docs/research-engine/sandbox.md):
 * no network, a read-only root, every capability dropped, no privilege escalation, a non-root user,
 * memory, CPU and process limits, a tmpfs `/tmp`, and exactly three binds, each at its host path so
 * that the paths adapters pass in and read back are the same on both sides: the baseline tree
 * read-only, the candidate workspace and the output directory read-write. The container gets no
 * environment from the host except `HOME=/tmp` and the allow-listed `RunOptions.env` variables.
 *
 * Each command is `docker create`, `docker start --attach`, `docker inspect` and `docker rm`, so a
 * failure of Docker itself is told apart from the command's own exit, whatever the command prints.
 * A timeout is enforced with `docker kill`. The read-write binds are measured while the command runs
 * and after it; over `maxOutputBytes` the container is killed, the largest output files are deleted
 * until it fits, and the record carries a `policyViolation`. Like the host runner it never rejects
 * for a command's failure: a misuse (a bad bind, a refused variable, a missing image or daemon) is a
 * record with a `spawnError`.
 */
export class SandboxCommandRunner implements CommandRunner {
  private readonly options: Required<Omit<SandboxRunnerOptions, keyof SandboxBinds>> & SandboxBinds;
  private imageId: Promise<string> | null = null;
  /** The credential search of the baseline, done once: the baseline is frozen. */
  private baselineCredentials: string[] | null = null;

  constructor(options: SandboxRunnerOptions) {
    this.options = {
      baselineDir: resolve(options.baselineDir),
      workspaceDir: resolve(options.workspaceDir),
      outputDir: resolve(options.outputDir),
      image: options.image,
      user: options.user ?? defaultUser(),
      platform: options.platform ?? DEFAULTS.platform,
      memory: options.memory ?? DEFAULTS.memory,
      cpus: options.cpus ?? DEFAULTS.cpus,
      pidsLimit: options.pidsLimit ?? DEFAULTS.pidsLimit,
      tmpfsBytes: options.tmpfsBytes ?? DEFAULTS.tmpfsBytes,
      maxOutputBytes: options.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
      watchIntervalMs: options.watchIntervalMs ?? DEFAULTS.watchIntervalMs,
      envAllow: options.envAllow ?? DEFAULT_SANDBOX_ENV_ALLOW,
      killGraceMs: options.killGraceMs ?? DEFAULTS.killGraceMs,
      docker: options.docker ?? 'docker',
    };
  }

  /** The `docker create` arguments before the command, for a container named `name`. */
  dockerArgs(
    name: string,
    imageId: string,
    binds: ResolvedBinds,
    cwd: string,
    env: Readonly<Record<string, string>>,
  ): string[] {
    const o = this.options;
    const bind = ({ source, target }: { source: string; target: string }, readonly: boolean) => [
      '--mount',
      `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`,
    ];
    return [
      'create',
      '--name',
      name,
      '--label',
      `${SANDBOX_LABEL}=1`,
      '--platform',
      o.platform,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      o.user,
      '--memory',
      o.memory,
      '--memory-swap',
      o.memory,
      '--cpus',
      String(o.cpus),
      '--pids-limit',
      String(o.pidsLimit),
      '--ulimit',
      'core=0',
      // The daemon keeps no copy of the output: the runner's capped logs are the only record.
      '--log-driver',
      'none',
      '--tmpfs',
      `${SANDBOX_HOME}:rw,noexec,nosuid,nodev,size=${String(o.tmpfsBytes)}`,
      ...bind(binds.baseline, true),
      ...bind(binds.workspace, false),
      ...bind(binds.output, false),
      '--workdir',
      cwd,
      '--env',
      `HOME=${SANDBOX_HOME}`,
      ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      imageId,
    ];
  }

  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandRecord> {
    const startedAt = new Date();
    const cwd = resolve(options.cwd);
    const refused = (reason: string): CommandRecord => {
      const finishedAt = new Date();
      const stdout = new CappedLog(options.stdoutPath, options.maxLogBytes);
      const stderr = new CappedLog(options.stderrPath, options.maxLogBytes);
      stderr.write(Buffer.from(`sandbox: ${reason}\n`));
      return {
        command,
        args: [...args],
        cwd,
        pid: null,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: `sandbox: ${reason}`,
        stdout: stdout.close(),
        stderr: stderr.close(),
      };
    };

    const settings = this.checkSettings(options.env ?? {});
    if (settings !== null) return refused(settings);
    const binds = this.resolveBinds(cwd);
    if (typeof binds === 'string') return refused(binds);
    let imageId: string;
    try {
      imageId = await this.resolveImage();
    } catch (error) {
      this.imageId = null;
      return refused((error as Error).message);
    }
    return this.runContainer(command, args, options, cwd, binds, imageId, startedAt);
  }

  /** Why the runner's own settings or this command's variables are refused, or null. */
  private checkSettings(env: Readonly<Record<string, string>>): string | null {
    const o = this.options;
    const ids = /^(\d+):(\d+)$/.exec(o.user);
    if (ids === null || Number(ids[1]) === 0 || Number(ids[2]) === 0) {
      return `user must be a non-root uid:gid with neither 0, not '${o.user}'`;
    }
    if (!/^\d+[bkmg]?$/i.test(o.memory)) return `memory must be like 4g, not '${o.memory}'`;
    if (!Number.isFinite(o.cpus) || o.cpus <= 0)
      return `cpus must be positive, not ${String(o.cpus)}`;
    for (const [name, value] of [
      ['pidsLimit', o.pidsLimit],
      ['tmpfsBytes', o.tmpfsBytes],
      ['maxOutputBytes', o.maxOutputBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        return `${name} must be a positive integer, not ${String(value)}`;
      }
    }
    const allowed = new Set(o.envAllow);
    const refusedNames = Object.keys(env).filter((name) => !allowed.has(name));
    if (refusedNames.length > 0) {
      return `environment variables not on the sandbox allow-list: ${refusedNames.join(', ')}`;
    }
    return null;
  }

  /** The binds with their real host paths, or why they are refused. */
  private resolveBinds(cwd: string): ResolvedBinds | string {
    const o = this.options;
    const home = realDir(homedir()) ?? resolve(homedir());
    const named = [
      ['baseline', o.baselineDir],
      ['workspace', o.workspaceDir],
      ['output', o.outputDir],
    ] as const;
    for (const [what, dir] of named) {
      if (dir.includes(',')) return `the ${what} directory may not contain a comma: ${dir}`;
    }
    // Adapters create their output directories as they go; the bind needs it before the first run.
    if (!existsSync(o.outputDir)) {
      try {
        mkdirSync(o.outputDir, { recursive: true });
      } catch (error) {
        return `cannot create the output directory ${o.outputDir}: ${(error as Error).message}`;
      }
    }

    const real: Record<string, string> = {};
    for (const [what, dir] of named) {
      const source = realDir(dir);
      if (source === null) return `the ${what} directory ${dir} does not exist`;
      if (source.includes(',')) return `the ${what} directory may not contain a comma: ${source}`;
      // Checked on the real path: a symbolic link must not smuggle in what its name hides.
      if (source === sep || inside(source, home)) {
        return `the ${what} directory ${dir} (${source}) would mount the root or the home directory`;
      }
      const denied = DENIED_BIND_PATHS.find((p) => inside(p, source) || inside(source, p));
      if (denied !== undefined) {
        return `the ${what} directory ${dir} (${source}) would mount ${denied}`;
      }
      real[what] = source;
    }
    const baseline = real['baseline'] ?? '';
    for (const what of ['workspace', 'output'] as const) {
      const source = real[what] ?? '';
      if (inside(source, baseline)) {
        return `the ${what} directory ${source} would expose the read-only baseline read-write`;
      }
      if (inside(baseline, source)) {
        // The whole baseline is visible: another experiment's directories there would be too.
        return `the ${what} directory ${source} is inside the baseline: keep runs outside it`;
      }
    }

    this.baselineCredentials ??= credentialFiles(baseline);
    if (this.baselineCredentials.length > 0) {
      return `the baseline ${o.baselineDir} holds credential files (${this.baselineCredentials.join(', ')}): mount a clean baseline snapshot`;
    }
    if (![o.baselineDir, o.workspaceDir, o.outputDir].some((dir) => inside(dir, cwd))) {
      return `the working directory ${cwd} is outside the sandbox binds`;
    }
    return {
      baseline: { source: baseline, target: o.baselineDir },
      workspace: { source: real['workspace'] ?? '', target: o.workspaceDir },
      output: { source: real['output'] ?? '', target: o.outputDir },
    };
  }

  /** The id of the image, looked up once: the exact image every command of this runner runs. */
  private resolveImage(): Promise<string> {
    this.imageId ??= docker(this.options.docker, [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      this.options.image,
    ]).then(({ ok, stdout, why }) => {
      const id = stdout.trim();
      if (ok && id.startsWith('sha256:')) return id;
      throw new Error(
        `image ${this.options.image} is not available (${why || 'no image id'}): run 'pnpm research:sandbox:build'`,
      );
    });
    return this.imageId;
  }

  private async runContainer(
    command: string,
    args: readonly string[],
    options: RunOptions,
    cwd: string,
    binds: ResolvedBinds,
    imageId: string,
    startedAt: Date,
  ): Promise<CommandRecord> {
    const name = `eda-sandbox-${randomUUID()}`;
    const cli = this.options.docker;
    const sandbox = {
      image: this.options.image,
      imageId,
      container: name,
      user: this.options.user,
    };
    const stdout = new CappedLog(options.stdoutPath, options.maxLogBytes);
    const stderr = new CappedLog(options.stderrPath, options.maxLogBytes);
    const record = (
      fields: Pick<CommandRecord, 'pid' | 'exitCode' | 'signal' | 'timedOut' | 'spawnError'> & {
        policyViolation: string | null;
      },
    ): CommandRecord => {
      const finishedAt = new Date();
      return {
        command,
        args: [...args],
        cwd,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
        ...fields,
        stdout: stdout.close(),
        stderr: stderr.close(),
        sandbox,
      };
    };

    const created = await docker(cli, [
      ...this.dockerArgs(name, imageId, binds, cwd, options.env ?? {}),
      command,
      ...args,
    ]);
    if (!created.ok) {
      await docker(cli, ['rm', '--force', name]);
      stderr.write(Buffer.from(`sandbox: docker create failed: ${created.why}\n`));
      return record({
        pid: null,
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: `sandbox: docker create failed: ${created.why}`,
        policyViolation: null,
      });
    }

    const child = spawn(cli, ['start', '--attach', name], {
      env: dockerCliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolvePromise) => {
      let spawnError: string | null = null;
      let timedOut = false;
      let policyViolation: string | null = null;
      let finished = false;
      const timers = new Set<NodeJS.Timeout>();

      const kill = () => {
        void docker(cli, ['kill', name]);
        timers.add(
          setTimeout(() => {
            // The CLI did not return after the kill: stop waiting for it.
            child.kill('SIGKILL');
            timers.add(
              setTimeout(() => {
                void finish(null, 'SIGKILL');
              }, 1000),
            );
          }, this.options.killGraceMs),
        );
      };

      const finish = async (cliExitCode: number | null, signal: string | null) => {
        if (finished) return;
        finished = true;
        for (const timer of timers) {
          clearTimeout(timer);
          clearInterval(timer);
        }
        // The container's own state, not the CLI's exit, says how the command ended.
        const state = await docker(cli, [
          'inspect',
          '--format',
          '{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}',
          name,
        ]);
        await docker(cli, ['rm', '--force', name]);
        let exitCode = cliExitCode;
        if (spawnError === null && state.ok) {
          const [code = '', oomKilled = '', error = ''] = state.stdout.trim().split('|');
          if (error.trim() !== '') {
            spawnError = `sandbox: ${error.trim()}`;
          } else if (/^-?\d+$/.test(code)) {
            exitCode = Number(code);
          }
          if (oomKilled === 'true') {
            stderr.write(Buffer.from('\nsandbox: killed by the memory limit\n'));
          }
        } else if (spawnError === null) {
          spawnError = `sandbox: cannot read the container's state: ${state.why}`;
        }
        const trimmed = this.enforceOutputCap(binds, options);
        if (trimmed !== null) {
          policyViolation =
            policyViolation === null ? trimmed : `${policyViolation}. After it: ${trimmed}`;
        }
        resolvePromise(
          record({
            pid: child.pid ?? null,
            exitCode: spawnError === null ? exitCode : null,
            signal,
            timedOut,
            spawnError,
            policyViolation,
          }),
        );
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.write(chunk);
      });
      child.on('error', (error) => {
        if (child.pid === undefined) {
          spawnError = `${cli}: ${error.message}`;
          void finish(null, null);
        }
      });
      child.on('close', (code, signal) => {
        void finish(code, signal);
      });

      timers.add(
        setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs),
      );
      // A command may not fill the disk before it ends: measure the read-write binds as it runs.
      timers.add(
        setInterval(() => {
          if (policyViolation !== null || timedOut) return;
          const over = this.overCap(binds);
          if (over !== null) {
            policyViolation = `${over}; the command was killed`;
            kill();
          }
        }, this.options.watchIntervalMs),
      );
    });
  }

  /** Why the read-write binds are over their caps, or null. */
  private overCap(binds: ResolvedBinds): string | null {
    const files = [
      ...filesUnder(binds.workspace.source, MAX_WRITTEN_FILES),
      ...filesUnder(binds.output.source, MAX_WRITTEN_FILES),
    ];
    if (files.length > MAX_WRITTEN_FILES) {
      return `the read-write binds held over ${String(MAX_WRITTEN_FILES)} files`;
    }
    const total = files.reduce((sum, file) => sum + file.bytes, 0);
    return total > this.options.maxOutputBytes
      ? `the read-write binds held ${String(total)} bytes, over the cap of ${String(this.options.maxOutputBytes)}`
      : null;
  }

  /**
   * Null when the read-write binds are within their caps; otherwise deletes the largest output
   * files (never this command's logs, never the workspace) until they fit, and says what went.
   */
  private enforceOutputCap(binds: ResolvedBinds, options: RunOptions): string | null {
    const over = this.overCap(binds);
    if (over === null) return null;
    const cap = this.options.maxOutputBytes;
    const keep = new Set([resolve(options.stdoutPath), resolve(options.stderrPath)]);
    const workspaceBytes = filesUnder(binds.workspace.source).reduce((s, f) => s + f.bytes, 0);
    const output = filesUnder(binds.output.source);
    let total = workspaceBytes + output.reduce((sum, file) => sum + file.bytes, 0);
    const deleted: string[] = [];
    for (const file of output
      .filter((f) => !keep.has(join(binds.output.target, relative(binds.output.source, f.path))))
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))) {
      if (total <= cap) break;
      rmSync(file.path, { force: true });
      total -= file.bytes;
      deleted.push(relative(binds.output.source, file.path));
    }
    const shown = deleted.length > 20 ? [...deleted.slice(0, 20), '…'] : deleted;
    return `${over}; deleted ${shown.join(', ') || 'nothing'}`;
  }
}

/** Whether the Docker daemon answers, within ten seconds. */
export function dockerAvailable(docker = 'docker'): boolean {
  const run = spawnSync(docker, ['info', '--format', '{{.ServerVersion}}'], {
    env: dockerCliEnv(),
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return run.status === 0;
}

/** A runner that runs nothing and says why, so a misconfiguration is an infrastructure failure. */
export class UnavailableRunner implements CommandRunner {
  constructor(private readonly reason: string) {}

  run(command: string, args: readonly string[], options: RunOptions): Promise<CommandRecord> {
    const now = new Date().toISOString();
    const stdout = new CappedLog(options.stdoutPath, options.maxLogBytes);
    const stderr = new CappedLog(options.stderrPath, options.maxLogBytes);
    stderr.write(Buffer.from(`${this.reason}\n`));
    return Promise.resolve({
      command,
      args: [...args],
      cwd: resolve(options.cwd),
      pid: null,
      startedAt: now,
      finishedAt: now,
      wallTimeMs: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      spawnError: this.reason,
      stdout: stdout.close(),
      stderr: stderr.close(),
    });
  }
}

export interface RunnerSelection {
  readonly kind: 'sandbox' | 'host' | 'unavailable';
  readonly runner: CommandRunner;
  /** The Yosys binary to give `YosysAdapter`: the image's in the sandbox, the default on the host. */
  readonly yosys: string | undefined;
  readonly reason: string;
}

/**
 * Host or sandbox, by configuration: `EDA_SANDBOX_IMAGE` set runs every command in that image.
 * The host runner is used only when `EDA_ALLOW_HOST_RUNNER=1` says so, for development without
 * Docker; otherwise a missing image setting gives a runner whose every command is an
 * infrastructure failure, so nothing runs candidate code on the host by accident.
 */
export function selectRunner(config: {
  readonly binds: SandboxBinds;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly sandbox?: Omit<SandboxRunnerOptions, keyof SandboxBinds | 'image'>;
  /** Overridable for tests; checks the daemon only when the host runner is the fallback. */
  readonly dockerAvailable?: () => boolean;
}): RunnerSelection {
  const env = config.env ?? process.env;
  const image = env['EDA_SANDBOX_IMAGE']?.trim() ?? '';
  const allowHost = env['EDA_ALLOW_HOST_RUNNER'] === '1';
  const host = (reason: string): RunnerSelection => ({
    kind: 'host',
    runner: new HostCommandRunner(),
    yosys: undefined,
    reason,
  });

  if (image !== '') {
    const reachable = allowHost ? (config.dockerAvailable ?? dockerAvailable)() : true;
    if (!reachable) return host('EDA_SANDBOX_IMAGE is set but Docker is unreachable');
    return {
      kind: 'sandbox',
      runner: new SandboxCommandRunner({ ...config.sandbox, ...config.binds, image }),
      yosys: `${SANDBOX_TOOL_BIN}/yosys`,
      reason: `EDA_SANDBOX_IMAGE=${image}`,
    };
  }
  if (allowHost) return host('EDA_ALLOW_HOST_RUNNER=1 and no EDA_SANDBOX_IMAGE');
  const reason =
    'no EDA sandbox configured: set EDA_SANDBOX_IMAGE (pnpm research:sandbox:build), or EDA_ALLOW_HOST_RUNNER=1 to run on the host';
  return { kind: 'unavailable', runner: new UnavailableRunner(reason), yosys: undefined, reason };
}
