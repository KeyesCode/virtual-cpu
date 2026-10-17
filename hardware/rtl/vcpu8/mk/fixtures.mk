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

.PHONY: fixtures

fixtures: $(SIM_BIN) ## Run every fixture on the RTL: end state + lock-step trace (FILTER=<glob>)
	cd $(REPO_ROOT) && pnpm --silent --filter @vcpu/rtl-tools fixtures --dir $(FIXTURES_DIR) \
	  --sim $(SIM_BIN) --work $(BUILD_DIR)/fixtures --report $(FIXTURES_REPORT) $(if $(FILTER),--filter '$(FILTER)')
