#!/usr/bin/env bash
# `pnpm research:sandbox:build`: builds the EDA sandbox image silicon-lab/eda-sandbox from
# infrastructure/docker/eda-sandbox/Dockerfile (docs/research-engine/sandbox.md), tags it
# <OSS CAD Suite version>-<ORFS tag> and latest, then records what was built in two git-ignored
# files beside the Dockerfile:
#
#   image-digest.json   the image id (its content digest), tags, platform, pins and tool versions
#   tool-versions.json  the image's own /opt/sandbox/tool-versions.sh output
#
# Environment:
#   SANDBOX_PLATFORM  the platform to build (default linux/amd64, the only one OpenROAD ships for;
#                     Apple Silicon builds and runs it under emulation)
#   SANDBOX_IMAGE     the repository name (default silicon-lab/eda-sandbox)
#   SANDBOX_NO_CACHE  set to 1 to build without the layer cache
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
sandbox_dir="${repo_root}/infrastructure/docker/eda-sandbox"
cd "${repo_root}"

die() {
  echo "sandbox-build: $*" >&2
  exit 1
}

command -v docker > /dev/null 2>&1 || die "docker is not installed"
docker info > /dev/null 2>&1 || die "the Docker daemon is not reachable (is Docker running?)"

# shellcheck source=/dev/null
. hardware/toolchain.env
# shellcheck source=/dev/null
. hardware/asic/toolchain.env

platform="${SANDBOX_PLATFORM:-linux/amd64}"
image="${SANDBOX_IMAGE:-silicon-lab/eda-sandbox}"
tag="${image}:${OSS_CAD_SUITE_VERSION}-${ORFS_TAG}"

case ",${ORFS_PLATFORMS}," in
  *",${platform},"*) ;;
  *) die "OpenROAD from ${ORFS_IMAGE} exists for ${ORFS_PLATFORMS} only, not ${platform}" ;;
esac
host_arch="$(uname -m)"
if [[ "${platform}" == linux/amd64 && "${host_arch}" != x86_64 ]]; then
  echo "sandbox-build: building and running linux/amd64 under emulation on ${host_arch}:" \
    "expect EDA runs several times slower than native" >&2
fi

# The esbuild binary must match the esbuild package tsx loads, or esbuild refuses it: read the
# version from tsx's entry in the lockfile's snapshots, which names the esbuild it depends on.
tsx_version="$(sed -n 's/^  tsx@\([0-9][0-9.]*\):$/\1/p' pnpm-lock.yaml | head -n 1)"
[[ -n "${tsx_version}" ]] || die "no tsx in pnpm-lock.yaml"
esbuild_version="$(awk -v entry="  tsx@${tsx_version}:" '
  $0 == entry { n++; next }
  n == 2 && /^  [^ ]/ { exit }
  n == 2 && $1 == "esbuild:" { print $2; exit }
' pnpm-lock.yaml)"
[[ -n "${esbuild_version}" ]] || die "no esbuild dependency of tsx@${tsx_version} in pnpm-lock.yaml"
pnpm_version="$(sed -n 's/.*"packageManager": "pnpm@\([0-9][0-9.]*\)[^"]*".*/\1/p' package.json)"
[[ -n "${pnpm_version}" ]] || die "no pnpm version in package.json packageManager"

build_args=(
  --platform "${platform}"
  --file "${sandbox_dir}/Dockerfile"
  --build-arg "ORFS_IMAGE=${ORFS_IMAGE}@${ORFS_IMAGE_DIGEST}"
  --build-arg "ESBUILD_VERSION=${esbuild_version}"
  --build-arg "PNPM_VERSION=${pnpm_version}"
  --label "org.siliconlab.oss-cad-suite=${OSS_CAD_SUITE_VERSION}"
  --label "org.siliconlab.orfs-tag=${ORFS_TAG}"
  --label "org.siliconlab.orfs-commit=${ORFS_COMMIT}"
  --label "org.siliconlab.openroad-commit=${OPENROAD_COMMIT}"
  --label "org.siliconlab.opensta-commit=${OPENSTA_COMMIT}"
  --tag "${tag}"
  --tag "${image}:latest"
)
[[ "${SANDBOX_NO_CACHE:-0}" == 1 ]] && build_args+=(--no-cache)

echo "sandbox-build: building ${tag} for ${platform}" >&2
started="$(date +%s)"
docker build "${build_args[@]}" "${repo_root}"
build_seconds="$(($(date +%s) - started))"

image_id="$(docker image inspect --format '{{.Id}}' "${tag}")"
docker run --rm --platform "${platform}" --network none "${tag}" /opt/sandbox/tool-versions.sh \
  > "${sandbox_dir}/tool-versions.json"

IMAGE="${image}" TAG="${tag}" IMAGE_ID="${image_id}" PLATFORM="${platform}" \
  HOST="$(uname -s)-${host_arch}" BUILD_SECONDS="${build_seconds}" \
  TOOL_VERSIONS="${sandbox_dir}/tool-versions.json" \
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const env = process.env;
    const record = {
      image: env.IMAGE,
      tags: [env.TAG, `${env.IMAGE}:latest`],
      imageId: env.IMAGE_ID,
      platform: env.PLATFORM,
      builtOn: env.HOST,
      builtAt: new Date().toISOString(),
      buildSeconds: Number(env.BUILD_SECONDS),
      toolVersions: JSON.parse(readFileSync(env.TOOL_VERSIONS, "utf8")),
    };
    writeFileSync(process.argv[1], `${JSON.stringify(record, null, 2)}\n`);
  ' "${sandbox_dir}/image-digest.json"

echo "sandbox-build: ${tag} is ${image_id}" >&2
echo "sandbox-build: wrote infrastructure/docker/eda-sandbox/image-digest.json and tool-versions.json" >&2
