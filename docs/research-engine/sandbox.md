# EDA sandbox

Every EDA command the research engine runs on candidate code runs in a fresh container of one pinned image, `silicon-lab/eda-sandbox`, through `SandboxCommandRunner` in `@vcpu/eda-adapters`. This page covers what the image holds, how a command is confined, what is and is not mounted, and how to build and test it. [architecture.md](architecture.md#sandbox-boundary) gives the boundary in brief; [eda-adapters.md](eda-adapters.md) covers the adapters that run inside it.

## Threat model

A candidate is untrusted: an AI agent wrote it, and the pipeline runs it. Verilator compiles the candidate into C++ and runs it, and SystemVerilog can call `$system`, open and write files with `$fopen`/`$fwrite`, and read any file with `$readmemh`. So a candidate in effect runs arbitrary code, and Yosys and OpenROAD parse whatever it contains.

What the sandbox defends:

| Asset                                                                        | Attack                                               | Defence                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials: the API token, database and Redis URLs, Claude and Codex logins | Read them from the environment, files or the network | No host environment, no home directory, no credential file (the runner refuses a baseline holding `.env`), no network                 |
| The baseline: golden model, testbenches, scripts, liberty, Makefiles         | Rewrite them so a wrong design passes                | The baseline tree is a read-only bind; everything outside the three binds is a read-only root filesystem                              |
| The host                                                                     | Escape, escalate, or persist                         | Non-root user, every capability dropped, `no-new-privileges`, Docker's default seccomp profile, no Docker socket, `--rm`              |
| Host resources                                                               | Exhaust CPU, memory, processes or disk; run forever  | `--cpus`, `--memory` with no swap, `--pids-limit`, a size-limited `/tmp`, an output size cap, a wall-clock timeout with `docker kill` |
| Other experiments                                                            | Read or overwrite their outputs                      | Each command sees only its own workspace and output directory read-write                                                              |

Not defended here (residual risks):

- **Results the candidate can reach.** The candidate's simulation runs in the same container as the harness and can write to the output directory, and it controls its own console output. The harness writes `verify.json` last and the adapters read structured files where they can, but the integrity of a gate against a hostile candidate also depends on the pipeline's static validation, which rejects system tasks such as `$system`, file I/O and DPI in candidate source before anything runs. That validation belongs to the pipeline (VIRT-ZIH4RS), not this runner.
- **The read-only baseline is readable.** A candidate can read any file in the baseline tree, so the baseline must hold nothing secret. The runner refuses a baseline with `.env` or `.env.*` files at its root (`.env.example` is allowed); anything else secret must simply not be there. The baseline should be a clean snapshot, not a developer checkout.
- **Kernel and runtime bugs.** A container shares the host kernel (on macOS, Docker Desktop's VM kernel). This is defence in depth, not a VM boundary.
- **Side channels and timing.** Not in scope.

## The image

Built from `infrastructure/docker/eda-sandbox/Dockerfile` with the repository root as context, narrowed by `Dockerfile.dockerignore` to the toolchain pins, the vendored sky130hd files and the in-image scripts.

| Component                 | Where in the image                          | Pinned by                                                                                                                     |
| ------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 24.04              | base                                        | image digest in the Dockerfile                                                                                                |
| OSS CAD Suite 2026-10-16  | `/opt/vcpu8/oss-cad-suite-<version>`        | `hardware/toolchain.env`, tarball sha256 checked in the build                                                                 |
| OpenROAD with OpenSTA     | `/opt/openroad`                             | `hardware/asic/toolchain.env`: ORFS `26Q4`, image `openroad/orfs:26Q3-705-gecb3cfdeb` by digest, OpenROAD and OpenSTA commits |
| sky130hd platform files   | `/opt/sky130hd` (also in the baseline tree) | `hardware/asic/sky130hd/MANIFEST.sha256`, checked in the build                                                                |
| Node 24.15.0 and pnpm     | `/opt/node`                                 | Node tarball sha256 in the Dockerfile; pnpm from `package.json` `packageManager`                                              |
| esbuild binary            | `/opt/esbuild` (`ESBUILD_BINARY_PATH`)      | the `esbuild` version in `pnpm-lock.yaml`                                                                                     |
| make, g++, perl, Python 3 | system                                      | the Ubuntu base                                                                                                               |

Node and pnpm are there only to run the `@vcpu/accelerator-reference` harness, the golden model, which `make test-pe` and `verify` call. They run it from the read-only baseline tree, so the candidate cannot change it. The baseline's `node_modules` may come from a macOS install, whose esbuild binary cannot run on Linux, so the image carries the Linux binary of the same version and points `ESBUILD_BINARY_PATH` at it.

`VCPU8_TOOLS_DIR=/opt/vcpu8` lets the Project 3 Makefile find the pinned suite exactly as it does on a host after `pnpm hardware:setup`. The suite's `bin/` comes last on `PATH`, so its bundled `python3` never shadows the system one. Pass the Yosys adapter `yosys: SANDBOX_TOOL_BIN + '/yosys'`, as `selectRunner` does.

There is no `curl`, `git`, `ssh` or compiler cache in the final image, and it runs as `eda` (uid 10001) unless the runner says otherwise. The image is about 6.3 GB, 2.5 GB of it the OSS CAD Suite.

### Versions

`/opt/sandbox/tool-versions.sh` prints the version of every tool as JSON (and writes it to a path given as its argument). The build runs it into `/opt/sandbox/tool-versions.json` and fails if any tool does not answer:

```sh
docker run --rm silicon-lab/eda-sandbox /opt/sandbox/tool-versions.sh
```

| Tool      | Reported as                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------ |
| verilator | `Verilator 5.053 devel rev v5.052-448-g1272f7355 (mod)`                                                |
| yosys     | `Yosys 0.70+145 (git sha1 a31d95ea0, …)`                                                               |
| openroad  | `unknown`: ORFS images are built without git metadata. `pins.openroadCommit` is the version of record. |
| sta       | `3.1.0`, from `sta::version` inside `openroad`. There is no separate `sta` binary.                     |

The `pins` block repeats the ORFS tag and commit, the OpenROAD and OpenSTA commits and the liberty's sha256.

### Building

```sh
pnpm research:sandbox:build
```

`infrastructure/scripts/sandbox-build.sh` builds the image, tags it `silicon-lab/eda-sandbox:<OSS CAD Suite version>-<ORFS tag>` (now `2026-10-16-26Q4`) and `:latest`, and writes two git-ignored files beside the Dockerfile:

- `image-digest.json`: the image id (`sha256:…`, the digest of exactly what was built), its tags, platform, build host and time, and the tool versions;
- `tool-versions.json`: the image's own `tool-versions.sh` output.

The image is not pushed anywhere, so it has no registry digest: its local id is what every `CommandRecord.sandbox.imageId` and reproducibility manifest records. `SANDBOX_PLATFORM` overrides the platform (only `linux/amd64` builds), `SANDBOX_IMAGE` the repository name, and `SANDBOX_NO_CACHE=1` disables the layer cache.

## How a command runs

`SandboxCommandRunner` implements the same `CommandRunner` interface as `HostCommandRunner`, so the adapters do not change. Each `run(command, args, options)` is one `docker run`:

| Flag                                                                    | Why                                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--rm`, `--name eda-sandbox-<uuid>`, `--label org.siliconlab.sandbox=1` | Nothing is left behind, and anything that is can be found                                          |
| `--platform linux/amd64`                                                | The only platform with OpenROAD                                                                    |
| `--network none`                                                        | Loopback only: no DNS, no route                                                                    |
| `--read-only`                                                           | The image's filesystem cannot be written                                                           |
| `--cap-drop ALL`, `--security-opt no-new-privileges`                    | No capabilities, and no setuid escalation to regain them                                           |
| `--user <uid:gid>`                                                      | The caller's own ids, so outputs belong to them; `10001:10001` if the caller is root. Never uid 0. |
| `--memory <m> --memory-swap <m>`                                        | A memory limit with no swap on top (default `4g`)                                                  |
| `--cpus <c>`                                                            | Default 2                                                                                          |
| `--pids-limit <p>`                                                      | Stops fork bombs (default 1024: a Verilator build runs many compiler processes)                    |
| `--ulimit core=0`                                                       | No core dumps filling the output directory                                                         |
| `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=<n>`                          | The only writable scratch outside the binds (default 1 GiB); `HOME` points here                    |
| three `--mount type=bind` (below)                                       | Exactly what the command may see                                                                   |
| `--workdir <cwd>`                                                       | The adapter's working directory, which must be inside a bind                                       |
| `--env HOME=/tmp`, plus allow-listed variables                          | Nothing else of the host's environment                                                             |
| the image **id**                                                        | The command runs on the exact image recorded, even if the tag moves                                |

The Docker CLI itself is started with only `PATH`, `HOME` and the `DOCKER_*` variables that say how to reach the daemon. A variable in `RunOptions.env` that is not on the runner's `envAllow` list (empty by default) is refused, not dropped silently.

**Timeout.** At `timeoutMs` the runner runs `docker kill <name>`; `--rm` then removes the container. If the CLI has not returned `killGraceMs` later (default 5 s), the runner kills the CLI, force-removes the container and records the command as ended by `SIGKILL`. Either way the record has `timedOut: true`.

**Logs.** stdout and stderr are capped at `maxLogBytes` each, exactly as on the host.

**Output cap.** After every command the runner sums the output directory. Over `maxOutputBytes` (default 2 GiB), it deletes the largest files (never the command's own logs) until it fits, and sets `policyViolation` on the record. `classifyCommand` turns that into `policy-violation`, and both adapters stop the stage on it as they do on a timeout.

**Refusals.** A missing image, an unreachable daemon, a bad bind, a root user, a refused variable or a working directory outside the binds never starts a container. It is a record with a `spawnError` and no `pid`, so the stage is an `infrastructure-failure`. Docker's own failures (exit 125, or 126/127 with a daemon error) are recorded the same way.

**Record.** Every record of a command that started has `sandbox: { image, imageId, container, user }`.

## What is mounted

Each bind is mounted at its own host path, so every path an adapter puts in an argument (`REPO_ROOT=…`, `BUILD_DIR=…`, `PE_VECTORS=…`) or reads back from a file the tools wrote (the saved-case directories in `verify.json`) means the same thing on both sides.

| Bind           | Mode       | Holds                                                                                                     |
| -------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `baselineDir`  | read-only  | The frozen baseline tree: the repository with its `node_modules`, the golden model, testbenches, sky130hd |
| `workspaceDir` | read-write | The candidate copy of `hardware/accelerators/matmul/`                                                     |
| `outputDir`    | read-write | Everything the run writes: `build/`, `logs/`, `unit/`, the Yosys flow directories                         |

The workspace and output directory may sit inside the baseline tree (for example under `.research/`); a read-write bind of a subdirectory is mounted over the read-only one. The runner refuses a workspace or output directory that contains the baseline, which would expose it read-write, and any bind that is `/` or contains the home directory. It creates a missing output directory.

**Never mounted:** the Docker socket, the home directory, `~/.claude`, `~/.codex`, `~/.ssh`, `~/.npmrc`, `~/.docker`, cloud credentials, `.env`, `/var/run`, or any other host path. There is no `--privileged`, no `--device`, no `--cap-add`, and no host network, PID or IPC namespace.

## Choosing the runner

`selectRunner({ binds, env })` picks by configuration:

| `EDA_SANDBOX_IMAGE` | `EDA_ALLOW_HOST_RUNNER` | Runner                                                                          |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| set                 | unset                   | `SandboxCommandRunner` on that image                                            |
| set                 | `1`                     | The sandbox if Docker answers, else `HostCommandRunner`                         |
| unset               | `1`                     | `HostCommandRunner`, for development without Docker                             |
| unset               | unset                   | `UnavailableRunner`: every command is an `infrastructure-failure`, nothing runs |

It returns `{ kind, runner, yosys, reason }`; pass `yosys` to `YosysAdapter`. A runner is made per candidate, since its binds name that candidate's workspace and output directory. The host runner is for developing the tools themselves: production research runs use the sandbox.

## Generation workspace versus EDA sandbox

These are two different boundaries, and they hold different things:

|               | Generation workspace                                                                   | EDA sandbox                                                             |
| ------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Runs          | Claude Code or Codex, on the host, as the person's own logged-in CLI                   | Verilator, Yosys, OpenROAD, the harness, on candidate code              |
| Trust         | The agent is semi-trusted; its output is not                                           | Everything inside is untrusted                                          |
| Sees          | The baseline PE source and docs, the campaign brief, prior findings, one writable file | The read-only baseline, the candidate copy, its output directory        |
| Credentials   | Only what the agent CLI itself reads; never the API token, database or Redis URL       | None at all                                                             |
| Network       | The agent CLI talks to its provider                                                    | None                                                                    |
| Checked after | A diff against the allowlist: any other change discards the candidate                  | The output size; results come from the adapters' parsers, not the agent |

A candidate crosses from the first to the second only as a file in a fresh workspace copy. The agent never runs inside the EDA sandbox, and EDA tools never run in the generation workspace.

## macOS and Ubuntu

**macOS (Apple Silicon).** ORFS publishes OpenROAD for `linux/amd64` only, so the image is `linux/amd64` and Docker Desktop runs it under emulation (Rosetta when enabled, which is much faster than QEMU). The build warns about this. On an M2 Pro the build takes about 4 minutes with a warm network, and the sandbox is 3 to 5 times slower than native:

| Stage (unmodified PE)              | Host (macOS arm64) | Sandbox (emulated amd64) |
| ---------------------------------- | ------------------ | ------------------------ |
| `lint`                             | 0.9 s              | 3.8 s                    |
| `unit` (two seeds, 532,710 checks) | 7.8 s              | 21.5 s                   |
| `differential` (32 cases)          | 2.7 s              | 13.6 s                   |
| Yosys generic synthesis of the PE  | 0.4 s              | 1.7 s                    |

Bind sources must be in Docker Desktop's shared paths (by default `/Users`, `/Volumes`, `/private`, `/tmp` and `/var/folders`, which covers `os.tmpdir()`). Files the container writes appear owned by you whatever uid it ran as.

**Ubuntu 24.04 (CI).** The image runs natively. The runner passes the calling user's uid and gid (`runner`, 1001, on GitHub Actions), so the container can write to the binds and the files belong to that user; a root caller gets `10001:10001`, and its binds must then be writable by that uid. The Yosys and nextpnr results of a Linux x64 run match `baseline-linux-x64.*`, not the macOS `baseline.*`; for the PE alone the two baselines agree.

The image is not built in CI yet: that is the CI ticket (VIRT-5LP8M4), which should cache the layers (the OSS CAD Suite layer alone is 2.5 GB).

## Tests

All skip, with a message, when Docker or the image is missing (`EDA_SANDBOX_IMAGE` names another image).

- `src/runner/sandbox.integration.test.ts`: the isolation suite. DNS and TCP fail and there is no route; the user is not root, has no capabilities and has `NoNewPrivs`; writing to the baseline fails; writing outside the binds fails while the workspace, output directory and `/tmp` work, and there is no Docker socket; a bounded fork bomb stops below `--pids-limit`; a `sleep 60` with a 2 s timeout is a `timeout` within 5 s and leaves no container; a host `DATABASE_URL` does not reach the container and an off-list variable is refused; an output over the cap is a `policy-violation` and is deleted; a baseline with `.env` and a missing image are refused.
- `src/verilator/verilator.integration.test.ts` and `src/yosys/yosys.integration.test.ts` run their green paths in the sandbox too, on an unmodified RTL copy, and compare with the host run when the pinned toolchain is installed: the same unit check counts and differential totals, and the same generic cell, flip-flop, gate and depth counts and mapped area.
- `src/runner/sky130hd.test.ts` checks the vendored files against `MANIFEST.sha256`.
