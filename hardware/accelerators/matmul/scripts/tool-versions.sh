#!/usr/bin/env bash
# `make -C hardware/accelerators/matmul tools-check`: prints the version of every tool the matmul
# accelerator uses and writes them to a JSON file that its research reports read. Exits non-zero
# when a required tool is missing, or Verilator is older than 5. The same format as VCPU-8's
# hardware/rtl/vcpu8/scripts/tool-versions.sh, with Project 3's tools: no formal tools, and both
# nextpnr flows (iCE40 and ECP5) for the Fmax estimates.
#
# Usage: tool-versions.sh <out.json>   (TOOLCHAIN and OSS_CAD_SUITE_VERSION come from the Makefile)
set -euo pipefail

out="${1:?usage: tool-versions.sh <out.json>}"
toolchain="${TOOLCHAIN:-PATH}"
pinned="${OSS_CAD_SUITE_VERSION:-unknown}"

# name|version command|required (yes or no)
tools=(
  "verilator|verilator --version|yes"
  "yosys|yosys -V|yes"
  "nextpnr-ice40|nextpnr-ice40 --version|yes"
  "nextpnr-ecp5|nextpnr-ecp5 --version|yes"
  "gtkwave|gtkwave --version|no"
)

json_escape() {
  local s="${1//\\/\\\\}"
  printf '%s' "${s//\"/\\\"}"
}

missing=()
entries=()
if [[ "${toolchain}" == "PATH" ]]; then
  echo "Toolchain: tools from PATH (pinned OSS CAD Suite ${pinned} not installed; run 'pnpm hardware:setup')"
else
  echo "Toolchain: OSS CAD Suite ${pinned} at ${toolchain}"
fi
for spec in "${tools[@]}"; do
  IFS='|' read -r name command required <<< "${spec}"
  if path="$(command -v "${name}")"; then
    version="$(${command} 2>&1 | head -n 1 | tr -d '\r')"
    printf '  %-14s %s\n' "${name}" "${version}"
    entries+=("    \"${name}\": { \"path\": \"$(json_escape "${path}")\", \"version\": \"$(json_escape "${version}")\" }")
  else
    printf '  %-14s %s\n' "${name}" "MISSING"
    entries+=("    \"${name}\": null")
    if [[ "${required}" == "yes" ]]; then missing+=("${name}"); fi
  fi
done

if command -v verilator > /dev/null; then
  major="$(verilator --version | sed -n 's/^Verilator \([0-9]*\)\..*/\1/p')"
  if [[ -z "${major}" || "${major}" -lt 5 ]]; then missing+=("Verilator >= 5 (found $(verilator --version))"); fi
fi

if [[ "${toolchain}" == "PATH" ]]; then toolchain_path="null"; else toolchain_path="\"$(json_escape "${toolchain}")\""; fi
{
  echo "{"
  echo "  \"toolchain\": { \"name\": \"oss-cad-suite\", \"pinnedVersion\": \"${pinned}\", \"path\": ${toolchain_path} },"
  echo "  \"tools\": {"
  for i in "${!entries[@]}"; do
    if [[ "${i}" -lt $((${#entries[@]} - 1)) ]]; then echo "${entries[${i}]},"; else echo "${entries[${i}]}"; fi
  done
  echo "  }"
  echo "}"
} > "${out}"
echo "Wrote ${out}"

if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "tools-check: missing required tools:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Run 'pnpm hardware:setup' to install the pinned OSS CAD Suite." >&2
  exit 1
fi
