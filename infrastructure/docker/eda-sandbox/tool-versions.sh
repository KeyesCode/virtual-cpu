#!/usr/bin/env bash
# Prints the versions of every tool in the EDA sandbox image as JSON, and writes them to $1 too
# when given. The image build runs it once into /opt/sandbox/tool-versions.json, and
# `pnpm research:sandbox:build` runs it again on the finished image for image-digest.json:
#
#   docker run --rm silicon-lab/eda-sandbox /opt/sandbox/tool-versions.sh
#
# A tool that fails to report is recorded as null and the script exits 1 after printing, so a
# broken tool fails the image build instead of shipping.
set -uo pipefail

# shellcheck source=/dev/null
. /opt/sandbox/toolchain.env
# shellcheck source=/dev/null
. /opt/sandbox/asic-toolchain.env
suite="/opt/vcpu8/oss-cad-suite-${OSS_CAD_SUITE_VERSION}/bin"
scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

# First line of a command's output, or nothing when it fails.
first_line() { "$@" 2> /dev/null | head -n 1; }

printf 'puts [sta::version]\n' > "${scratch}/sta-version.tcl"

VERILATOR_VERSION="$(first_line "${suite}/verilator" --version)" \
YOSYS_VERSION="$(first_line "${suite}/yosys" -V)" \
OPENROAD_VERSION="$(first_line openroad -version)" \
STA_VERSION="$(first_line openroad -no_init -no_splash -exit "${scratch}/sta-version.tcl")" \
NODE_VERSION="$(first_line node --version)" \
PNPM_VERSION="$(first_line pnpm --version)" \
ESBUILD_VERSION="$(first_line "${ESBUILD_BINARY_PATH}" --version)" \
PYTHON_VERSION="$(first_line python3 --version)" \
MAKE_VERSION="$(first_line make --version)" \
GXX_VERSION="$(first_line g++ --version)" \
UBUNTU_VERSION="$(. /etc/os-release && echo "${PRETTY_NAME}")" \
OSS_CAD_SUITE_VERSION="${OSS_CAD_SUITE_VERSION}" \
ORFS_TAG="${ORFS_TAG}" ORFS_COMMIT="${ORFS_COMMIT}" \
ORFS_IMAGE="${ORFS_IMAGE}@${ORFS_IMAGE_DIGEST}" \
OPENROAD_COMMIT="${OPENROAD_COMMIT}" OPENSTA_COMMIT="${OPENSTA_COMMIT}" \
SKY130HD_LIBERTY_SHA256="${SKY130HD_LIBERTY_SHA256}" \
  python3 - "${1:-}" << 'EOF'
import json, os, sys

def value(name):
    text = os.environ.get(name, "").strip()
    return text or None

tools = {
    "verilator": value("VERILATOR_VERSION"),
    "yosys": value("YOSYS_VERSION"),
    "openroad": value("OPENROAD_VERSION"),
    "sta": value("STA_VERSION"),
    "node": value("NODE_VERSION"),
    "pnpm": value("PNPM_VERSION"),
    "esbuild": value("ESBUILD_VERSION"),
    "python3": value("PYTHON_VERSION"),
    "make": value("MAKE_VERSION"),
    "g++": value("GXX_VERSION"),
}
report = {
    "os": value("UBUNTU_VERSION"),
    "pins": {
        "ossCadSuite": value("OSS_CAD_SUITE_VERSION"),
        "orfsTag": value("ORFS_TAG"),
        "orfsCommit": value("ORFS_COMMIT"),
        "orfsImage": value("ORFS_IMAGE"),
        "openroadCommit": value("OPENROAD_COMMIT"),
        "openstaCommit": value("OPENSTA_COMMIT"),
        "sky130hdLibertySha256": value("SKY130HD_LIBERTY_SHA256"),
    },
    "notes": {
        "openroad": "The ORFS image is built without git metadata, so `openroad -version` prints "
        "'unknown'; pins.openroadCommit is its version of record.",
        "sta": "OpenSTA's version as built into openroad (`sta::version`); there is no separate "
        "sta binary, pins.openstaCommit is its commit.",
    },
    "tools": tools,
}
text = json.dumps(report, indent=2) + "\n"
sys.stdout.write(text)
if sys.argv[1]:
    with open(sys.argv[1], "w") as out:
        out.write(text)
missing = [name for name, version in tools.items() if version is None]
if missing:
    sys.stderr.write("no version from: " + ", ".join(missing) + "\n")
    sys.exit(1)
EOF
