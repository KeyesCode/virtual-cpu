# The synthesis baseline of the host platform. Yosys (ABC) and nextpnr builds for another OS or CPU
# map some logic differently from the same pinned OSS CAD Suite release
# (docs/hardware/accelerators/synthesis-guide.md), so synth-compare can only be exact against a
# baseline made on the same platform: research/accelerators/matmul/synth/baseline.* is macOS arm64,
# baseline-linux-x64.* the GitHub Actions runner (.github/workflows/accelerator.yml). Fragments are
# included in sorted order, so this is read before mk/synth.mk, whose `SYNTH_BASELINE ?=` then keeps
# it; `make synth-compare SYNTH_BASELINE=<path without .json>` still overrides both.

SYNTH_PLATFORM := $(shell uname -s | tr '[:upper:]' '[:lower:]')-$(shell uname -m | sed -e 's/^x86_64$$/x64/' -e 's/^aarch64$$/arm64/')

ifeq ($(SYNTH_PLATFORM),linux-x64)
  SYNTH_BASELINE ?= $(REPO_ROOT)/research/accelerators/matmul/synth/baseline-linux-x64
endif
