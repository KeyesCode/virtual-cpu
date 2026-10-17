# ISA package: core/vcpu8_isa_pkg.sv is generated from @vcpu/shared by @vcpu/rtl-tools and
# committed. check-isa proves the committed file is current and that both tools accept it.

ISA_PKG       := $(HW_DIR)/core/vcpu8_isa_pkg.sv
TYPES_PKG     := $(HW_DIR)/core/vcpu8_types_pkg.sv
ISA_PROBE     := $(HW_DIR)/tb/isa_pkg_probe.sv
ISA_BUILD_DIR := $(BUILD_DIR)/isa

.PHONY: gen-isa check-isa

gen-isa: ## Regenerate core/vcpu8_isa_pkg.sv from the TypeScript ISA
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools gen:isa --out $(ISA_PKG)

check-isa: ## Fail if vcpu8_isa_pkg.sv is stale, or Verilator or Yosys rejects the packages
	$(call need,$(VERILATOR))
	$(call need,$(YOSYS))
	@mkdir -p $(ISA_BUILD_DIR)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools gen:isa --out $(ISA_BUILD_DIR)/vcpu8_isa_pkg.sv
	@diff -u $(ISA_PKG) $(ISA_BUILD_DIR)/vcpu8_isa_pkg.sv || { \
	  echo "check-isa: core/vcpu8_isa_pkg.sv is stale; run 'pnpm hardware:gen' and commit it." >&2; \
	  exit 1; }
	$(VERILATOR) --lint-only -Wall $(ISA_PKG) $(TYPES_PKG) $(ISA_PROBE)
	$(YOSYS) -q -l $(ISA_BUILD_DIR)/yosys.log \
	  -p 'read_verilog -sv $(ISA_PKG) $(TYPES_PKG) $(ISA_PROBE); synth -top isa_pkg_probe'
	@echo "check-isa: vcpu8_isa_pkg.sv matches ISA $$(sed -n 's/^.*VCPU-8 ISA \([0-9.]*\) .*$$/\1/p' $(ISA_PKG)) and parses in Verilator and Yosys"
