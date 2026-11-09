import type { Metric } from '../domain/metric.js';
import { areaDelayProduct, type DeriveOptions, improvementPercent } from './derived.js';
import { canonicalJson, type Evaluation, type EvaluationConfig } from './evaluation.js';
import { unavailable } from './metric.js';

/** The part of an evaluation that decides whether it can be compared with another. */
export interface ComparableEvaluation {
  evaluationConfig: EvaluationConfig;
  evaluationConfigHash: string;
}

export type Comparability =
  | { status: 'comparable' }
  /** `differingFields` are dotted config paths, sorted, e.g. `toolVersions.yosys`. */
  | { status: 'not-comparable'; differingFields: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function differingPaths(a: unknown, b: unknown, path: string, out: string[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      differingPaths(a[key], b[key], path === '' ? key : `${path}.${key}`, out);
    }
    return;
  }
  const same = a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
  if (!same) out.push(path);
}

/**
 * Whether two evaluations may be compared (brief §15): only when their `evaluationConfigHash`
 * values and their configs are both equal. Otherwise lists the config fields that differ, or
 * `evaluationConfigHash` alone when only the hashes do.
 */
export function comparability(
  baseline: ComparableEvaluation,
  candidate: ComparableEvaluation,
): Comparability {
  const fields: string[] = [];
  differingPaths(baseline.evaluationConfig, candidate.evaluationConfig, '', fields);
  if (fields.length === 0 && baseline.evaluationConfigHash !== candidate.evaluationConfigHash) {
    fields.push('evaluationConfigHash');
  }
  if (fields.length === 0) return { status: 'comparable' };
  return { status: 'not-comparable', differingFields: fields.sort() };
}

export interface AdpScore {
  comparability: Comparability;
  baselineAdp: Metric;
  candidateAdp: Metric;
  /** `unavailable` whenever the evaluations are not comparable or an ADP is unavailable. */
  improvement: Metric;
}

/** The ADP of an evaluation: liberty cell area × STA critical path. */
export function evaluationAdp(evaluation: Pick<Evaluation, 'ppa'>, options: DeriveOptions = {}) {
  return areaDelayProduct(
    evaluation.ppa.area.cellArea,
    evaluation.ppa.performance.criticalPath,
    options,
  );
}

/**
 * Scores a candidate against the baseline on ADP. The improvement is computed only from
 * comparable evaluations, so an incomparable pair can never produce a number.
 */
export function scoreAdp(
  baseline: Evaluation,
  candidate: Evaluation,
  options: DeriveOptions = {},
): AdpScore {
  const result = comparability(baseline, candidate);
  const baselineAdp = evaluationAdp(baseline, options);
  const candidateAdp = evaluationAdp(candidate, options);
  const improvement =
    result.status === 'comparable'
      ? improvementPercent(baselineAdp, candidateAdp, options)
      : unavailable(`not comparable: ${result.differingFields.join(', ')} differ`);
  return { comparability: result, baselineAdp, candidateAdp, improvement };
}
