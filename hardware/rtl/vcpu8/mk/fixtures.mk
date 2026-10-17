# Fixture check: every fixtures/v1/*.json on the RTL runner, end state and lock-step trace compared
# with the emulator's by `@vcpu/rtl-tools fixtures` (packages/rtl-tools/src/verify/compare.ts).
# `make test` runs it after the unit tests. The runner's outputs go to build/fixtures/ and the
# report to build/reports/fixtures.json.
#
#   make fixtures                       all 98 fixtures
#   make fixtures FILTER='op-push-*'    a subset, by glob on the fixture name

SYSTEM_TESTS += fixtures

FIXTURES_DIR    := $(REPO_ROOT)/fixtures/v1
FIXTURES_REPORT := $(BUILD_DIR)/reports/fixtures.json

FIXTURES_TAMPER_DIR := $(BUILD_DIR)/fixtures-tamper

# `$(call fixtures_run,<dir>,<work>,<report>)`: the fixture check on one directory.
fixtures_run = cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools fixtures --dir $(1) \
  --sim $(SIM_BIN) --work $(2) --report $(3)

.PHONY: fixtures fixtures-tamper

fixtures: $(SIM_BIN) ## Run every fixture on the RTL: end state + lock-step trace (FILTER=<glob>)
	$(call fixtures_run,$(FIXTURES_DIR),$(BUILD_DIR)/fixtures,$(FIXTURES_REPORT)) $(if $(FILTER),--filter '$(FILTER)')

# The check must fail, precisely, on tampered copies: op-add with expected R0 changed must exit
# non-zero naming registers[0], and op-push-full-stack with a trace memWrites value changed must
# exit non-zero naming the step and memWrites[0].value. fixtures/v1/ is never touched.
fixtures-tamper: $(SIM_BIN) ## Prove the fixture check fails, with a precise report, on tampered fixtures
	@rm -rf $(FIXTURES_TAMPER_DIR)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools cli tamper-fixtures --dir $(FIXTURES_DIR) --out $(FIXTURES_TAMPER_DIR)
	@for kind in register memwrite; do \
	  if ( $(call fixtures_run,$(FIXTURES_TAMPER_DIR)/$$kind,$(FIXTURES_TAMPER_DIR)/out-$$kind,$(FIXTURES_TAMPER_DIR)/$$kind.json) ) \
	       > $(FIXTURES_TAMPER_DIR)/$$kind.log 2>&1; then \
	    cat $(FIXTURES_TAMPER_DIR)/$$kind.log; \
	    echo "fixtures-tamper: the check passed a tampered fixture ($$kind)" >&2; exit 1; fi; \
	done
	@grep -E '^FAIL op-add: end state' $(FIXTURES_TAMPER_DIR)/register.log && \
	  grep -E '^ +registers\[0\] +0x1F \(31\) → 0x1E \(30\)' $(FIXTURES_TAMPER_DIR)/register.log || { \
	  cat $(FIXTURES_TAMPER_DIR)/register.log; \
	  echo "fixtures-tamper: the report did not name op-add's registers[0]" >&2; exit 1; }
	@grep -E '^FAIL op-push-full-stack: lock-step trace, step [0-9]+' $(FIXTURES_TAMPER_DIR)/memwrite.log && \
	  grep -E '^ +memWrites\[0\]\.value ' $(FIXTURES_TAMPER_DIR)/memwrite.log || { \
	  cat $(FIXTURES_TAMPER_DIR)/memwrite.log; \
	  echo "fixtures-tamper: the report did not name the step and memWrites[0].value" >&2; exit 1; }
	@echo "fixtures-tamper: both tampered fixtures fail with a precise report, as they should"
