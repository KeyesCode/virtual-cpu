import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
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

const DEFAULTS = {
  platform: 'linux/amd64',
  memory: '4g',
  cpus: 2,
  pidsLimit: 1024,
  tmpfsBytes: 1 << 30,
  maxOutputBytes: 2 * (1 << 30),
  killGraceMs: 5000,
};

/** Variables a command may pass through `RunOptions.env`; anything else is refused. */
export const DEFAULT_SANDBOX_ENV_ALLOW: readonly string[] = [];

/** Files at the root of a baseline tree that hold credentials and must never be mounted. */
const CREDENTIAL_FILE = /^\.env(\..+)?$/;
const CREDENTIAL_FILE_OK = new Set(['.env.example']);

/** The three host directories a sandboxed command sees, each at its own host path. */
export interface SandboxBinds {
  /** The frozen baseline tree (repository root with its `node_modules`), mounted read-only. */
  readonly baselineDir: string;
  /** The candidate workspace, mounted read-write. */
  readonly workspaceDir: string;
  /** The output directory of the run, mounted read-write and size-checked after every command. */
  readonly outputDir: string;
}

export interface SandboxRunnerOptions extends SandboxBinds {
  /** The image reference, such as `silicon-lab/eda-sandbox:latest`. */
  readonly image: string;
  /** `uid:gid`, never uid 0. The calling user's ids by default (the image's `eda` user if root). */
  readonly user?: string;
  /** `docker run --platform`; linux/amd64 unless set, as OpenROAD ships for nothing else. */
  readonly platform?: string;
  /** `--memory` (and `--memory-swap`, so there is no swap on top), like `4g`. */
  readonly memory?: string;
  readonly cpus?: number;
  readonly pidsLimit?: number;
  /** The size of the `/tmp` tmpfs. */
  readonly tmpfsBytes?: number;
  /** The most the output directory may hold after a command; over it is a policy violation. */
  readonly maxOutputBytes?: number;
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

function defaultUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) return FALLBACK_USER;
  return `${String(uid)}:${String(gid)}`;
}

function inside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Every regular file under `dir` with its size, without following symbolic links. */
function filesUnder(dir: string): { path: string; bytes: number }[] {
  const files: { path: string; bytes: number }[] = [];
  const walk = (path: string) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else if (stat.isFile()) {
      files.push({ path, bytes: stat.size });
    }
  };
  walk(dir);
  return files;
}

/**
 * Runs each command in a fresh container of the EDA sandbox image (docs/research-engine/sandbox.md):
 * no network, a read-only root, every capability dropped, no privilege escalation, a non-root user,
 * memory, CPU and process limits, a tmpfs `/tmp`, and exactly three binds, each at its host path so
 * that the paths adapters pass in and read back are the same on both sides: the baseline tree
 * read-only, the candidate workspace and the output directory read-write. The container gets no
 * environment from the host except `HOME=/tmp` and the allow-listed `RunOptions.env` variables.
 *
 * A timeout is enforced with `docker kill`. After each command the output directory is measured;
 * over `maxOutputBytes`, the largest files are deleted until it fits and the record carries a
 * `policyViolation`. Like the host runner it never rejects for a command's failure: a misuse (a bad
 * bind, a refused variable, a missing image or daemon) is a record with a `spawnError`.
 */
export class SandboxCommandRunner implements CommandRunner {
  private readonly options: Required<Omit<SandboxRunnerOptions, keyof SandboxBinds>> & SandboxBinds;
  private imageId: Promise<string> | null = null;

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
      envAllow: options.envAllow ?? DEFAULT_SANDBOX_ENV_ALLOW,
      killGraceMs: options.killGraceMs ?? DEFAULTS.killGraceMs,
      docker: options.docker ?? 'docker',
    };
  }

  /** The `docker run` arguments before the command, for a container named `name`. */
  dockerArgs(name: string, imageId: string, cwd: string, env: Readonly<Record<string, string>>) {
    const o = this.options;
    const bind = (dir: string, readonly: boolean) => [
      '--mount',
      `type=bind,source=${dir},target=${dir}${readonly ? ',readonly' : ''}`,
    ];
    return [
      'run',
      '--rm',
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
      '--tmpfs',
      `${SANDBOX_HOME}:rw,noexec,nosuid,nodev,size=${String(o.tmpfsBytes)}`,
      ...bind(o.baselineDir, true),
      ...bind(o.workspaceDir, false),
      ...bind(o.outputDir, false),
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
    const refused = (reason: string, imageId?: string): CommandRecord => {
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
        ...(imageId === undefined
          ? {}
          : {
              sandbox: {
                image: this.options.image,
                imageId,
                container: '-',
                user: this.options.user,
              },
            }),
      };
    };

    const problem = this.checkRun(cwd, options.env ?? {});
    if (problem !== null) return refused(problem);
    let imageId: string;
    try {
      imageId = await this.resolveImage();
    } catch (error) {
      this.imageId = null;
      return refused((error as Error).message);
    }
    return this.runContainer(command, args, options, cwd, imageId, startedAt);
  }

  /** Why this command may not run, or null. */
  private checkRun(cwd: string, env: Readonly<Record<string, string>>): string | null {
    const o = this.options;
    if (!/^\d+:\d+$/.test(o.user) || o.user.startsWith('0:')) {
      return `user must be a non-root uid:gid, not '${o.user}'`;
    }
    const home = resolve(homedir());
    for (const [what, dir] of [
      ['baseline', o.baselineDir],
      ['workspace', o.workspaceDir],
      ['output', o.outputDir],
    ] as const) {
      if (dir.includes(',')) return `the ${what} directory may not contain a comma: ${dir}`;
      if (dir === sep || inside(dir, home)) {
        return `the ${what} directory ${dir} would mount the root or the home directory`;
      }
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        return `the ${what} directory ${dir} does not exist`;
      }
    }
    for (const [what, dir] of [
      ['workspace', o.workspaceDir],
      ['output', o.outputDir],
    ] as const) {
      if (inside(dir, o.baselineDir)) {
        return `the ${what} directory ${dir} would expose the read-only baseline read-write`;
      }
    }
    const credentials = readdirSync(o.baselineDir).filter(
      (name) => CREDENTIAL_FILE.test(name) && !CREDENTIAL_FILE_OK.has(name),
    );
    if (credentials.length > 0) {
      return `the baseline ${o.baselineDir} holds credential files (${credentials.join(', ')}): mount a clean baseline snapshot`;
    }
    if (![o.baselineDir, o.workspaceDir, o.outputDir].some((dir) => inside(dir, cwd))) {
      return `the working directory ${cwd} is outside the sandbox binds`;
    }
    const allowed = new Set(this.options.envAllow);
    const refusedNames = Object.keys(env).filter((name) => !allowed.has(name));
    if (refusedNames.length > 0) {
      return `environment variables not on the sandbox allow-list: ${refusedNames.join(', ')}`;
    }
    return null;
  }

  /** The id of the image, looked up once: the exact image every command of this runner runs. */
  private resolveImage(): Promise<string> {
    this.imageId ??= new Promise((resolvePromise, reject) => {
      execFile(
        this.options.docker,
        ['image', 'inspect', '--format', '{{.Id}}', this.options.image],
        { env: dockerCliEnv(), timeout: 30_000 },
        (error, stdout, stderr) => {
          const id = stdout.trim();
          if (error === null && id.startsWith('sha256:')) {
            resolvePromise(id);
            return;
          }
          const why = stderr.trim().split('\n')[0] ?? error?.message ?? 'no image id';
          reject(
            new Error(
              `image ${this.options.image} is not available (${why}): run 'pnpm research:sandbox:build'`,
            ),
          );
        },
      );
    });
    return this.imageId;
  }

  private runContainer(
    command: string,
    args: readonly string[],
    options: RunOptions,
    cwd: string,
    imageId: string,
    startedAt: Date,
  ): Promise<CommandRecord> {
    const name = `eda-sandbox-${randomUUID()}`;
    const stdout = new CappedLog(options.stdoutPath, options.maxLogBytes);
    const stderr = new CappedLog(options.stderrPath, options.maxLogBytes);
    const docker = this.options.docker;
    const child = spawn(
      docker,
      [...this.dockerArgs(name, imageId, cwd, options.env ?? {}), command, ...args],
      { env: dockerCliEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // The Docker CLI's own failure lines, told apart from the command's output.
    let daemonError: string | null = null;

    return new Promise((resolvePromise) => {
      let spawnError: string | null = null;
      let timedOut = false;
      let finished = false;
      const timers = new Set<NodeJS.Timeout>();

      const finish = (exitCode: number | null, signal: string | null) => {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        if (timedOut) {
          // --rm removes an exited container; this catches one whose CLI was abandoned.
          execFile(docker, ['rm', '--force', name], { env: dockerCliEnv() }, () => undefined);
        }
        // Exit 125 is Docker failing to run the container; 126/127 with a daemon error is a
        // command the image cannot execute. Both mean the command never ran.
        if (
          spawnError === null &&
          daemonError !== null &&
          (exitCode === 125 || exitCode === 126 || exitCode === 127)
        ) {
          spawnError = `sandbox: ${daemonError}`;
        }
        const policyViolation = this.enforceOutputCap(options);
        const finishedAt = new Date();
        resolvePromise({
          command,
          args: [...args],
          cwd,
          pid: child.pid ?? null,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          wallTimeMs: finishedAt.getTime() - startedAt.getTime(),
          exitCode: spawnError === null ? exitCode : null,
          signal,
          timedOut,
          spawnError,
          stdout: stdout.close(),
          stderr: stderr.close(),
          sandbox: { image: this.options.image, imageId, container: name, user: this.options.user },
          policyViolation,
        });
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.write(chunk);
        const text = chunk.toString('utf8');
        const line = /^docker: (Error response from daemon: .*)$/m.exec(text)?.[1];
        if (line !== undefined && daemonError === null) daemonError = line.trim();
      });
      child.on('error', (error) => {
        if (child.pid === undefined) {
          spawnError = `${docker}: ${error.message}`;
          finish(null, null);
        }
      });
      child.on('close', (code, signal) => {
        finish(code, signal);
      });

      timers.add(
        setTimeout(() => {
          timedOut = true;
          execFile(docker, ['kill', name], { env: dockerCliEnv() }, () => undefined);
          timers.add(
            setTimeout(() => {
              // The CLI did not return after the kill: stop waiting for it.
              child.kill('SIGKILL');
              timers.add(
                setTimeout(() => {
                  finish(null, 'SIGKILL');
                }, 1000),
              );
            }, this.options.killGraceMs),
          );
        }, options.timeoutMs),
      );
    });
  }

  /** Null when the output directory is within its cap; otherwise trims it and says what went. */
  private enforceOutputCap(options: RunOptions): string | null {
    const cap = this.options.maxOutputBytes;
    const keep = new Set([resolve(options.stdoutPath), resolve(options.stderrPath)]);
    const files = filesUnder(this.options.outputDir);
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    if (total <= cap) return null;
    const held = total;
    const deleted: string[] = [];
    for (const file of files
      .filter((f) => !keep.has(f.path))
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))) {
      if (total <= cap) break;
      rmSync(file.path, { force: true });
      total -= file.bytes;
      deleted.push(relative(this.options.outputDir, file.path));
    }
    return `the output directory held ${String(held)} bytes, over the cap of ${String(cap)}; deleted ${deleted.join(', ') || 'nothing'}`;
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
