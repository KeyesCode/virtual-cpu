# syntax=docker/dockerfile:1
#
# silicon-lab/eda-sandbox: the one image every EDA command on candidate code runs in
# (docs/research-engine/sandbox.md). Build it with `pnpm research:sandbox:build`, which passes the
# pins below from hardware/toolchain.env, hardware/asic/toolchain.env and pnpm-lock.yaml, tags the
# image and records its id. The build context is the repository root, narrowed by
# Dockerfile.dockerignore to the files this image needs.
#
# What is in it, all pinned:
#   - Ubuntu 24.04 (by digest)
#   - the OSS CAD Suite release of hardware/toolchain.env (sha256 verified), under
#     /opt/vcpu8/oss-cad-suite-<version>, where the Project 3 Makefile looks with VCPU8_TOOLS_DIR
#   - OpenROAD with its built-in OpenSTA, copied from the ORFS image of hardware/asic/toolchain.env
#   - the vendored sky130hd platform files, under /opt/sky130hd
#   - Node and pnpm, only to run the @vcpu/accelerator-reference harness (the golden model) from the
#     read-only baseline tree, and the esbuild binary its tsx loader needs on Linux
#   - make, g++ (for Verilator's C++ output), perl and Python 3
# and a non-root user, eda (uid 10001). There is no compiler cache, no git, no curl and no ssh.
#
# ORFS ships OpenROAD for linux/amd64 only, so this image is linux/amd64 everywhere; Apple Silicon
# runs it under emulation.

ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ARG ORFS_IMAGE=openroad/orfs:26Q3-705-gecb3cfdeb@sha256:6da005d1c3447799f7401215174196c75ba9ec7e28417624d0c20225f85d594c

FROM ${ORFS_IMAGE} AS orfs

# ---------------------------------------------------------------------------------------------
# Downloads, each verified against a pinned digest, in a stage the final image does not inherit.
FROM ${UBUNTU_IMAGE} AS fetch
ARG TARGETARCH
ARG NODE_VERSION=24.15.0
ARG NODE_SHA256_amd64=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
ARG NODE_SHA256_arm64=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0
ARG PNPM_VERSION=10.34.7
ARG ESBUILD_VERSION=0.28.2

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*

COPY hardware/toolchain.env /tmp/toolchain.env
RUN set -eu; \
    . /tmp/toolchain.env; \
    case "${TARGETARCH}" in amd64) key=linux_x64 ;; arm64) key=linux_arm64 ;; \
      *) echo "no OSS CAD Suite build for ${TARGETARCH}" >&2; exit 1 ;; esac; \
    eval "tarball=\${OSS_CAD_SUITE_TARBALL_${key}} sha256=\${OSS_CAD_SUITE_SHA256_${key}}"; \
    curl -fsSL --retry 3 -o /tmp/suite.tgz "${OSS_CAD_SUITE_BASE_URL}/${tarball}"; \
    echo "${sha256}  /tmp/suite.tgz" | sha256sum -c -; \
    mkdir -p /opt/vcpu8; \
    tar -xzf /tmp/suite.tgz -C /opt/vcpu8; \
    rm /tmp/suite.tgz; \
    test -x /opt/vcpu8/oss-cad-suite/bin/yosys; \
    mv /opt/vcpu8/oss-cad-suite "/opt/vcpu8/oss-cad-suite-${OSS_CAD_SUITE_VERSION}"; \
    ln -s "oss-cad-suite-${OSS_CAD_SUITE_VERSION}" /opt/vcpu8/oss-cad-suite

RUN set -eu; \
    case "${TARGETARCH}" in amd64) node=x64 sha256="${NODE_SHA256_amd64}" ;; \
      arm64) node=arm64 sha256="${NODE_SHA256_arm64}" ;; esac; \
    file="node-v${NODE_VERSION}-linux-${node}.tar.xz"; \
    curl -fsSL --retry 3 -o "/tmp/${file}" "https://nodejs.org/dist/v${NODE_VERSION}/${file}"; \
    echo "${sha256}  /tmp/${file}" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf "/tmp/${file}" -C /opt/node --strip-components 1; \
    rm "/tmp/${file}"; \
    export PATH="/opt/node/bin:${PATH}"; \
    npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}"; \
    cd /tmp; \
    npm pack --silent "@esbuild/linux-${node}@${ESBUILD_VERSION}"; \
    mkdir -p /opt/esbuild; \
    tar -xzf esbuild-linux-*.tgz -C /opt/esbuild --strip-components 1; \
    rm -rf /tmp/esbuild-linux-*.tgz /root/.npm; \
    test "$(/opt/esbuild/bin/esbuild --version)" = "${ESBUILD_VERSION}"

# ---------------------------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE}
ARG TARGETARCH

RUN test "${TARGETARCH}" = amd64 || { \
      echo "OpenROAD is published for linux/amd64 only: build with --platform linux/amd64" >&2; \
      exit 1; }

# Build tools for Verilator's C++, and the shared libraries OpenROAD links (its GUI's X11 and
# fontconfig stack: OpenROAD links them even when run headless).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      make g++ libc6-dev zlib1g-dev perl python3 \
      libx11-6 libx11-xcb1 libsm6 libice6 libdbus-1-3 libfontconfig1 libfreetype6 \
      libxkbcommon0 libxkbcommon-x11-0 libxcb1 libxcb-cursor0 libxcb-icccm4 libxcb-image0 \
      libxcb-keysyms1 libxcb-randr0 libxcb-render0 libxcb-render-util0 libxcb-shape0 libxcb-shm0 \
      libxcb-sync1 libxcb-util1 libxcb-xfixes0 libxcb-xkb1 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /opt/vcpu8 /opt/vcpu8
COPY --from=fetch /opt/node /opt/node
COPY --from=fetch /opt/esbuild /opt/esbuild
COPY --from=orfs /OpenROAD-flow-scripts/tools/install/OpenROAD /opt/openroad
COPY --from=orfs /OpenROAD-flow-scripts/tools/install/licenses/OpenROAD /opt/openroad/licenses
RUN missing="$(ldd /opt/openroad/bin/openroad | grep 'not found' || true)"; \
    test -z "${missing}" || { echo "openroad is missing libraries:" >&2; echo "${missing}" >&2; exit 1; }

COPY hardware/asic/sky130hd /opt/sky130hd
COPY hardware/toolchain.env /opt/sandbox/toolchain.env
COPY hardware/asic/toolchain.env /opt/sandbox/asic-toolchain.env
COPY infrastructure/docker/eda-sandbox/tool-versions.sh /opt/sandbox/tool-versions.sh
RUN cd /opt/sky130hd && sha256sum -c --quiet MANIFEST.sha256

# The OSS CAD Suite comes last on PATH: it bundles its own python3 and other helpers, which must
# not shadow the system's. The Project 3 Makefile puts it first itself, as on the host.
ENV PATH=/opt/openroad/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/vcpu8/oss-cad-suite/bin \
    VCPU8_TOOLS_DIR=/opt/vcpu8 \
    SKY130HD_DIR=/opt/sky130hd \
    ESBUILD_BINARY_PATH=/opt/esbuild/bin/esbuild \
    HOME=/tmp \
    LANG=C.UTF-8

RUN chmod 0755 /opt/sandbox/tool-versions.sh \
 && /opt/sandbox/tool-versions.sh /opt/sandbox/tool-versions.json \
 && chmod -R a+rX,go-w /opt \
 && groupadd --gid 10001 eda \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin eda

LABEL org.opencontainers.image.title="silicon-lab/eda-sandbox" \
      org.opencontainers.image.description="Pinned EDA sandbox for the Silicon Lab research engine" \
      org.opencontainers.image.source="https://github.com/KeyesCode/virtual-cpu"

USER 10001:10001
WORKDIR /tmp
CMD ["/opt/sandbox/tool-versions.sh"]
