#!/usr/bin/env bash
# `make formal`, `make formal-selftest` and `make formal-mutant`: run SymbiYosys tasks and print one
# result line per task, with its proof kind, depth and engine. The run of <task>.sby goes to
# <out>/<task>/ (sby's own directory, with engine_*/trace*.vcd on a failure) and its log to
# <out>/<task>.log.
#
# Usage: formal.sh <out> <task.sby>...                          every task must PASS
#        formal.sh --expect-fail <label> <out> <task.sby>...    every task must FAIL on the
#                                                               assertion <label>, with a trace
# Exits non-zero when any task ends otherwise (FAIL, ERROR, UNKNOWN or TIMEOUT).
set -euo pipefail

expect_fail=""
if [[ "${1:-}" == "--expect-fail" ]]; then
  expect_fail="${2:?usage: formal.sh --expect-fail <label> <out> <task.sby>...}"
  shift 2
fi
out="${1:?usage: formal.sh [--expect-fail <label>] <out> <task.sby>...}"
shift
mkdir -p "${out}"
out="$(cd "${out}" && pwd)"

# `option <file> <name>`: a value from the [options] section of an .sby file.
option() {
  awk -v key="$2" '/^\[/ { s = $0 } s == "[options]" && $1 == key { print $2; exit }' "$1"
}
engine() {
  awk '/^\[/ { s = $0; next } s == "[engines]" && NF { $1 = $1; print; exit }' "$1"
}

bad=0
for sby_file in "$@"; do
  task="$(basename "${sby_file}" .sby)"
  mode="$(option "${sby_file}" mode)"
  depth="$(option "${sby_file}" depth)"
  case "${mode}" in
    prove) kind="k-induction" ;;
    bmc)   kind="BMC" ;;
    *)     kind="${mode}" ;;
  esac
  start="$(date +%s)"
  # sby resolves the [files] paths from the working directory, so run it beside the .sby file.
  (cd "$(dirname "${sby_file}")" && sby -f -d "${out}/${task}" "$(basename "${sby_file}")") \
    > "${out}/${task}.log" 2>&1 || true
  secs="$(( $(date +%s) - start ))"
  status="$(sed -n 's/.*DONE (\([A-Z]*\),.*/\1/p' "${out}/${task}.log" | tail -n 1)"
  status="${status:-ERROR}"

  detail="${kind}, depth ${depth}, $(engine "${sby_file}")"
  # A k-induction proof reports the k it closed at: smtbmc tries steps depth, depth-1, … down.
  induction_log="${out}/${task}/engine_0/logfile_induction.txt"
  if [[ "${mode}" == "prove" && "${status}" == "PASS" && -f "${induction_log}" ]]; then
    detail="${detail}; induction closed at k = $(grep -c 'Trying induction in step' "${induction_log}")"
  fi
  printf '%-7s %-26s %s (%ss)\n' "${status}" "${task}" "${detail}" "${secs}"

  failed="$(sed -n 's/.*failed assertion \([^ ]*\) at .*/\1/p' "${out}/${task}.log" | sort -u)"
  trace="$(sed -n 's/.*counterexample trace[^:]*: \(.*\)$/\1/p' "${out}/${task}.log" | head -n 1)"
  if [[ -n "${failed}" ]]; then
    sed 's/^/          failed: /' <<< "${failed}"
    echo "          trace:  ${trace}"
  fi

  if [[ -z "${expect_fail}" ]]; then
    if [[ "${status}" != "PASS" ]]; then
      bad=1
      [[ -n "${failed}" ]] || echo "          see ${out}/${task}.log"
    fi
  elif [[ "${status}" != "FAIL" || -z "${trace}" ]] || ! grep -q "\.${expect_fail}\$" <<< "${failed}"; then
    echo "          expected FAIL on ${expect_fail} with a counterexample trace; see ${out}/${task}.log" >&2
    bad=1
  fi
done
exit "${bad}"
