#!/usr/bin/env bash
# Stub behind the research:* root scripts whose app does not exist yet: names the script and the
# ticket that lands it, then fails, so nothing mistakes a stub for a passing step.
set -euo pipefail

echo "$1: not implemented yet (lands with $2; see docs/research-engine/README.md)" >&2
exit 1
