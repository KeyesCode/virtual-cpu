# Research metrics

The metric library lives in `packages/research-core/src/metrics/` and is exported from `@vcpu/research-core`. It is pure TypeScript with no Node.js or React imports (the ESLint portable rule covers `packages/research-core/**`), so the worker, the API and the dashboard all compute the same numbers.

It turns the PPA numbers the EDA adapters report into tagged metrics, combines them into derived metrics, decides whether two evaluations may be compared, checks hard constraints and finds the Pareto frontier. It does not parse tool output (the adapters do) and does not round (callers do).

## The metric model

Every value is a `Metric` (the type is in `src/domain/metric.ts`):

```ts
{ value: number, unit, provenance: 'measured' | 'estimated' | 'theoretical', method?, tool?, toolVersion? }
{ provenance: 'unavailable', reason: string }
```

| Provenance    | Meaning                                                                                 | Example                                                  |
| ------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `measured`    | A tool reported it for this exact design and configuration                              | Liberty cell area from Yosys, critical path from OpenSTA |
| `estimated`   | A model or estimator produced it from assumptions                                       | Power from an assumed switching activity                 |
| `theoretical` | It follows from the architecture alone; nobody measured it                              | A peak rate of 1 MAC per cycle                           |
| `unavailable` | It does not exist for this evaluation. It has no `value` key, so it can never read as 0 | Tier 2 core area when the sandbox image has no OpenROAD  |

Rules the library enforces:

- `measured()`, `estimated()` and `theoretical()` refuse NaN, infinities, unknown units and negative values. Only signed quantities (slack, improvement) pass `{ signed: true }`.
- `unavailable(reason)` needs a non-empty reason.
- Power is never `measured`: no physical measurement exists (brief §14). `PpaSnapshotSchema` refuses a measured power field.
- A derived metric takes the provenance of its weakest input (measured > estimated > theoretical). A theoretical input makes the result `unavailable` ("… is theoretical-only") unless the caller passes `{ allowTheoretical: true }`, in which case the result is `theoretical`.
- Any unavailable input makes the result unavailable, and the reason names the input (`delay is unavailable: STA not run`).
- An input in the wrong dimension is refused, not coerced (`area must be in um^2, got count`).

## Units

Units form a closed vocabulary, `METRIC_UNITS`. Conversion happens only within a dimension:

| Dimension  | Units           | Converted to |
| ---------- | --------------- | ------------ |
| Time       | `ns`, `ps`      | `ns`         |
| Frequency  | `MHz`, `GHz`    | `MHz`        |
| Power      | `mW`, `W`, `uW` | `mW`         |
| Throughput | `MOPS`, `GOPS`  | `MOPS`       |

Everything else converts only to itself: `um^2`, `V`, `count`, `bits`, `cycles`, `ops/cycle`, `%`, and the derived units `um^2*ns`, `pJ/op`, `GOPS/W` and `GOPS/mm^2`. A `count` is never an area, and `cycles` are never `ns`.

## The PPA snapshot

`PpaSnapshot` holds every value for one evaluated design. Every field is a `Metric`, so a value nobody produced is an explicit `unavailable`; `unavailablePpaSnapshot(reason)` is the starting point a pipeline fills in. `PPA_UNITS` lists the units each field accepts, and `PpaSnapshotSchema` refuses anything else.

| Group                    | Field                         | Units                | Tier |
| ------------------------ | ----------------------------- | -------------------- | ---- |
| `performance`            | `cycles`                      | `cycles`             | —    |
|                          | `macsPerCycle`                | `ops/cycle`          | —    |
|                          | `throughput`                  | `MOPS`, `GOPS`       | —    |
|                          | `latency`                     | `cycles`, `ns`, `ps` | —    |
|                          | `clockPeriod`                 | `ns`, `ps`           | 1    |
|                          | `criticalPath`                | `ns`, `ps`           | 1    |
|                          | `worstSlack` (signed)         | `ns`, `ps`           | 1    |
|                          | `totalNegativeSlack` (signed) | `ns`, `ps`           | 1    |
|                          | `peUtilization`               | `%`                  | —    |
| `area`                   | `cellArea`                    | `um^2`               | 1    |
|                          | `logicCells`                  | `count`              | 1    |
|                          | `sequentialCells`             | `count`              | 1    |
|                          | `memoryBits`                  | `bits`               | —    |
|                          | `memoryArea`                  | `um^2`               | 1    |
|                          | `coreArea`                    | `um^2`               | 2    |
| `power` (never measured) | `dynamic`, `leakage`, `total` | `mW`, `W`, `uW`      | 2    |
|                          | `switchingActivityCoverage`   | `%`                  | 2    |
|                          | `voltage`                     | `V`                  | 2    |
|                          | `frequency`                   | `MHz`, `GHz`         | 2    |
|                          | `method`                      | text or null         | 2    |
| `technologyIndependent`  | `genericCells`                | `count`              | 0    |
|                          | `flipFlops`                   | `count`              | 0    |
|                          | `mulCells` (`$mul`)           | `count`              | 0    |
|                          | `abstractGates`               | `count`              | 0    |
|                          | `logicDepth` (`ltp -noff`)    | `count`              | 0    |

## The three tiers

From `project-4-decisions.md` §3. Tiers are always labelled and never mixed in one comparison.

- **Tier 0, technology-independent (always available).** Yosys generic synthesis of `processing_element` (`DATA_W=8, ACC_W=32`) with the steps of `synth/generic.ys`: cells, flip-flops, `$mul`, abstract gates (`abc -g AND,NAND,OR,NOR,XOR,XNOR,MUX`) and `ltp -noff` logic depth. These are counts, never area or delay.
- **Tier 1, technology-mapped (the campaign's ADP).** Yosys `synth` with `dfflibmap` and `abc -liberty` onto the SkyWater `sky130_fd_sc_hd` typical-corner liberty (`sky130_fd_sc_hd__tt_025C_1v80.lib`), then OpenSTA on the mapped netlist at the frozen clock constraint. Area is the total liberty cell area in µm²; delay is the worst reported critical path in ns, with WNS and TNS at the target period.
- **Tier 2, physical (optional).** OpenROAD floorplan, place, CTS, route, STA and power with the ORFS sky130hd platform: core area, routed WNS, estimated power. `unavailable` when the sandbox image lacks it. Tier 1 numbers never stand in for Tier 2.

## Derived metrics

Each returns `unavailable` with a reason when an input is unavailable, theoretical-only (unless allowed), in an incompatible unit, or a divisor is 0. Results are full precision.

| Function                              | Formula                                 | Unit        |
| ------------------------------------- | --------------------------------------- | ----------- |
| `areaDelayProduct(area, delay)`       | area (µm²) × delay (ns)                 | `um^2*ns`   |
| `improvementPercent(baseline, cand.)` | (baseline − candidate) / baseline × 100 | `%`         |
| `energyPerOp(power, throughput)`      | power (mW) / throughput (MOPS) × 1000   | `pJ/op`     |
| `perfPerWatt(throughput, power)`      | throughput (MOPS) / power (mW)          | `GOPS/W`    |
| `throughputPerArea(throughput, area)` | throughput (MOPS) / area (µm²) × 1000   | `GOPS/mm^2` |

`improvementPercent` is for lower-is-better metrics such as ADP: positive means the candidate is better, negative worse. A zero baseline is `unavailable` (`division by zero: baseline is 0`). The candidate is converted to the baseline's unit, so a `count` against `um^2*ns` is refused.

### The campaign's ADP

**ADP = sky130hd liberty cell area (µm²) × OpenSTA critical path (ns) at the frozen clock constraint**, both Tier 1, in µm²·ns. `evaluationAdp(evaluation)` computes it from `ppa.area.cellArea` and `ppa.performance.criticalPath`.

Worked example: a baseline of 1,000 µm² × 2.5 ns = 2,500 µm²·ns and a candidate of 850 µm² × 2.5 ns = 2,125 µm²·ns give an improvement of (2,500 − 2,125) / 2,500 × 100 = **15 %**. A candidate of 3,000 µm²·ns gives **−20 %**.

## Comparability

Two evaluations are compared only under the same evaluation configuration (brief §15). `EvaluationConfig` holds the baseline id, tool versions, sandbox image digest, target technology, liberty file and its SHA-256, the clock constraint, synthesis settings, physical-design settings (or null) and the campaign's fixed verification seeds and counts. Nothing specific to one experiment belongs in it.

`hashEvaluationConfig(config, sha256)` hashes the canonical JSON of the config (keys sorted at every level). The SHA-256 function is injected so the package stays free of `node:crypto`; the worker passes one built on it.

`comparability(baseline, candidate)` returns `{ status: 'comparable' }` only when both the hashes and the configs are equal. Otherwise it returns `{ status: 'not-comparable', differingFields }` with the sorted dotted paths that differ (`libertySha256`, `toolVersions.yosys`, `clockPeriod.value`), or `evaluationConfigHash` alone when only the hashes differ.

`scoreAdp(baseline, candidate)` combines the two: it returns both ADPs and an improvement that is `unavailable` (`not comparable: libertySha256 differ`) whenever the evaluations are not comparable, so an incomparable pair can never yield a number.

## Hard constraints

`evaluateHardConstraints({ maxAreaUm2?, requireTimingMet?, requiredVerification? }, { ppa, verification })` returns `{ satisfied, violations }` with every violated constraint:

- `maxAreaUm2`: liberty cell area above the limit.
- `requireTimingMet`: negative worst slack, or, when slack is unavailable, a critical path longer than the clock period.
- `requiredVerification`: each listed suite whose outcome is not `passed` (`failed` or `not-run`), one violation per suite.

A constraint that cannot be proven met, because its metric is unavailable or only theoretical, counts as violated.

## Pareto frontier

`paretoFrontier(points, objectives)` takes points `{ id, values }` and objectives `{ key, direction: 'minimize' | 'maximize' }`. A point dominates another when it is no worse on every objective and strictly better on at least one. The result:

- `frontier`: the non-dominated ids, ordered by each objective in turn (best first) and then by id, so the result does not depend on input order.
- `dominatedBy`: for each dominated id, every id that dominates it, in the same order.
- `duplicateOf`: for each point whose values equal an earlier point's, that first point. Identical points are both kept; two identical non-dominated points are both on the frontier.
- `excluded`: points with a missing or non-finite objective value, with the reason.

Ids and objective keys must be unique. The algorithm is O(n² × objectives), fine for the ≤ 10⁴ points of a campaign.
