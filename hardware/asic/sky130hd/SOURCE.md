# sky130hd technology files: source

These files are vendored, unmodified, from the SkyWater SKY130 high-density standard-cell platform of
[OpenROAD-flow-scripts](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts) (ORFS). They
are what the research engine's Tier 1 (liberty-mapped synthesis + OpenSTA) and Tier 2 (OpenROAD
physical flow) evaluations read; see `docs/research-engine/sandbox.md`.

- **Upstream tag:** ORFS release `26Q4`, commit `ecb3cfdeb1cafd5c096dc4b3700f97a50329509c`
  (2026-09-30). The sandbox image's OpenROAD comes from the image built at the same commit,
  `openroad/orfs:26Q3-705-gecb3cfdeb` (see `hardware/asic/toolchain.env`).
- **Upstream directory:**
  <https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/tree/ecb3cfdeb1cafd5c096dc4b3700f97a50329509c/flow/platforms/sky130hd>
- **Raw URL of each file:**
  `https://raw.githubusercontent.com/The-OpenROAD-Project/OpenROAD-flow-scripts/ecb3cfdeb1cafd5c096dc4b3700f97a50329509c/flow/platforms/sky130hd/<path>`,
  where `<path>` is the path in the table below.

| Path                                                                               | What it is                                                                  | Licence                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| `lib/sky130_fd_sc_hd__tt_025C_1v80.lib`                                            | Typical corner (tt, 25 °C, 1.80 V) liberty of `sky130_fd_sc_hd`             | Apache-2.0 (`LICENSE`)                |
| `lef/sky130_fd_sc_hd.tlef`                                                         | Technology LEF: layers, vias, design rules                                  | Apache-2.0 (`LICENSE`)                |
| `lef/sky130_fd_sc_hd_merged.lef`                                                   | Cell LEF: the abstract of every standard cell                               | Apache-2.0 (`LICENSE`)                |
| `config.mk`                                                                        | ORFS platform constants: dont-use cells, fill, tie, tap cells, site, layers | BSD-3-Clause (`LICENSE-ORFS-scripts`) |
| `setRC.tcl`                                                                        | Per-layer RC for parasitic estimation                                       | BSD-3-Clause                          |
| `make_tracks.tcl`, `pdn.tcl`, `tapcell.tcl`, `fastroute.tcl`, `rcx_patterns.rules` | Floorplan tracks, power grid, tap cells, global-route layers                | BSD-3-Clause                          |
| `cells_adders_hd.v`, `cells_clkgate_hd.v`, `cells_latch_hd.v`                      | Yosys techmap cells used by the ORFS synthesis step                         | BSD-3-Clause                          |

The liberty and LEF files are SkyWater PDK content released by SkyWater and Google under the
Apache License 2.0; each carries that header, and `LICENSE` is the licence text taken from
<https://github.com/google/skywater-pdk/blob/7198cf647113f56041e02abf3eb623692820c5e1/LICENSE>. The
ORFS flow scripts are under the BSD 3-Clause licence in `LICENSE-ORFS-scripts`, which is ORFS's
`LICENSE_BUILD_RUN_SCRIPTS` at the same commit.

**Not vendored**, because nothing here reads it: the GDS (`gds/`), CDL, KLayout DRC/LVS decks and
layer properties, the dummy IO liberty and the IO fill LEF. No restricted or NDA PDK content is
included. Everything here is public and redistributable.

## Integrity

`MANIFEST.sha256` lists the sha256 of every vendored file (`shasum -a 256 -c MANIFEST.sha256` from
this directory checks it; `packages/eda-adapters/src/runner/sky130hd.test.ts` runs the same check in
`pnpm test`). The liberty's digest,
`ec0e1067a35c8bf20b11e58d1e8ac53326067e4dac84a125cc1b917a3518d0d9`, is the same as at ORFS `v3.0`,
which the Yosys adapter's integration test pins. These files are a protected path: a candidate that
touches them is rejected.

## Updating

Pick a new ORFS tag, re-download the files above from it, update the tag, commit and image in this
file and in `hardware/asic/toolchain.env`, regenerate `MANIFEST.sha256`
(from this directory:
`find . -type f ! -name MANIFEST.sha256 ! -name 'LICENSE*' ! -name SOURCE.md | sed 's|^\./||' | LC_ALL=C sort | xargs shasum -a 256 > MANIFEST.sha256`), rebuild the sandbox image, and re-freeze any baseline measured with the old
files: a baseline and a candidate are comparable only on the same library.
