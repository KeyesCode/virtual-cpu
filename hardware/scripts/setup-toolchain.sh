#!/usr/bin/env bash
# Installs the pinned OSS CAD Suite (hardware/toolchain.env) into a shared cache outside the repo:
#
#   ${VCPU8_TOOLS_DIR:-$HOME/.cache/vcpu8}/oss-cad-suite-<version>/
#
# Every worktree reuses the same install. The script is idempotent: an installed version is
# reported and left alone, and a verified tarball already in the cache is reused, so a re-install
# works offline. It never needs sudo and never writes outside the cache directory.
#
# Usage: pnpm hardware:setup        (or: bash hardware/scripts/setup-toolchain.sh)
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../toolchain.env
source "${script_dir}/../toolchain.env"

die() {
  echo "setup-toolchain: $*" >&2
  exit 1
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin_arm64 ;;
  Darwin-x86_64) platform=darwin_x64 ;;
  Linux-x86_64) platform=linux_x64 ;;
  Linux-aarch64 | Linux-arm64) platform=linux_arm64 ;;
  *)
    die "unsupported platform $(uname -s) $(uname -m); supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64"
    ;;
esac

tarball_var="OSS_CAD_SUITE_TARBALL_${platform}"
sha_var="OSS_CAD_SUITE_SHA256_${platform}"
tarball="${!tarball_var:?missing ${tarball_var} in toolchain.env}"
expected_sha="${!sha_var:?missing ${sha_var} in toolchain.env}"

tools_dir="${VCPU8_TOOLS_DIR:-${HOME}/.cache/vcpu8}"
install_dir="${tools_dir}/oss-cad-suite-${OSS_CAD_SUITE_VERSION}"
download_dir="${tools_dir}/downloads"
stamp="${install_dir}/.vcpu8-installed"

sha256_of() {
  if command -v sha256sum > /dev/null; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

print_versions() {
  local bin="${install_dir}/bin"
  echo "OSS CAD Suite ${OSS_CAD_SUITE_VERSION} at ${install_dir}"
  "${bin}/verilator" --version
  "${bin}/yosys" -V
  "${bin}/nextpnr-ice40" --version 2>&1 | head -n 1
  echo "sby $("${bin}/sby" --version 2>&1 | head -n 1)"
}

if [[ -f "${stamp}" ]]; then
  echo "OSS CAD Suite ${OSS_CAD_SUITE_VERSION} is already installed."
  print_versions
  exit 0
fi

mkdir -p "${download_dir}"
archive="${download_dir}/${tarball}"
staging=""
cleanup() {
  rm -f "${archive}.part"
  if [[ -n "${staging}" ]]; then rm -rf "${staging}"; fi
}
trap cleanup EXIT

if [[ -f "${archive}" && "$(sha256_of "${archive}")" == "${expected_sha}" ]]; then
  echo "Reusing the verified download ${archive}"
else
  rm -f "${archive}"
  echo "Downloading ${tarball} (several hundred MB) into ${download_dir}"
  curl --fail --location --retry 3 --progress-bar \
    --output "${archive}.part" "${OSS_CAD_SUITE_BASE_URL}/${tarball}" ||
    die "download of ${OSS_CAD_SUITE_BASE_URL}/${tarball} failed"
  actual_sha="$(sha256_of "${archive}.part")"
  if [[ "${actual_sha}" != "${expected_sha}" ]]; then
    die "checksum mismatch for ${tarball}: expected ${expected_sha}, got ${actual_sha}"
  fi
  mv "${archive}.part" "${archive}"
fi

# Extract into a staging directory and move it into place only when complete, so a failed or
# interrupted run never leaves a half-extracted install behind.
staging="$(mktemp -d "${tools_dir}/.staging.XXXXXX")"
echo "Extracting into ${install_dir}"
tar -xzf "${archive}" -C "${staging}"
[[ -x "${staging}/oss-cad-suite/bin/yosys" ]] || die "${tarball} does not contain oss-cad-suite/bin/yosys"
if [[ "${platform}" == darwin_* ]] && command -v xattr > /dev/null; then
  # curl downloads are not quarantined, but a tarball fetched by a browser would be.
  xattr -dr com.apple.quarantine "${staging}/oss-cad-suite" 2> /dev/null || true
fi
rm -rf "${install_dir}"
mv "${staging}/oss-cad-suite" "${install_dir}"
echo "${OSS_CAD_SUITE_VERSION} ${tarball} ${expected_sha}" > "${stamp}"

print_versions
echo
echo "Done. make -C hardware/rtl/vcpu8 finds the tools automatically. For a shell, run:"
echo "  export PATH=\"${install_dir}/bin:\$PATH\""
