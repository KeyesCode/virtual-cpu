import type { VerificationSuite } from '../domain/experiment.js';
import { requireUnit } from './metric.js';
import type { PpaSnapshot } from './ppa.js';

/** The hard constraints of a campaign (brief §15). A candidate that violates one is rejected. */
export interface HardConstraints {
  /** The largest allowed liberty cell area, in µm². */
  maxAreaUm2?: number;
  /** Requires non-negative slack at the frozen clock constraint. */
  requireTimingMet?: boolean;
  /** Suites that must all have passed. */
  requiredVerification?: readonly VerificationSuite[];
}

export type VerificationOutcome = 'passed' | 'failed' | 'not-run';

export interface ConstraintSubject {
  ppa: PpaSnapshot;
  verification: Partial<Record<VerificationSuite, VerificationOutcome>>;
}

export type ConstraintViolation =
  | { constraint: 'maxAreaUm2'; reason: string }
  | { constraint: 'requireTimingMet'; reason: string }
  | { constraint: 'requiredVerification'; suite: VerificationSuite; reason: string };

export interface ConstraintEvaluation {
  satisfied: boolean;
  violations: ConstraintViolation[];
}

/**
 * Checks every constraint and returns all the violated ones. A constraint that cannot be proven
 * met (its metric unavailable or only theoretical) counts as violated.
 */
export function evaluateHardConstraints(
  constraints: HardConstraints,
  subject: ConstraintSubject,
): ConstraintEvaluation {
  const violations: ConstraintViolation[] = [];

  if (constraints.maxAreaUm2 !== undefined) {
    const area = requireUnit(subject.ppa.area.cellArea, 'um^2', 'cell area');
    if (!area.ok) {
      violations.push({ constraint: 'maxAreaUm2', reason: area.reason });
    } else if (area.provenance === 'theoretical') {
      violations.push({ constraint: 'maxAreaUm2', reason: 'cell area is theoretical-only' });
    } else if (area.value > constraints.maxAreaUm2) {
      violations.push({
        constraint: 'maxAreaUm2',
        reason: `cell area ${String(area.value)} um^2 exceeds the maximum ${String(constraints.maxAreaUm2)} um^2`,
      });
    }
  }

  if (constraints.requireTimingMet === true) {
    const reason = timingViolation(subject.ppa);
    if (reason !== undefined) violations.push({ constraint: 'requireTimingMet', reason });
  }

  for (const suite of constraints.requiredVerification ?? []) {
    const outcome = subject.verification[suite] ?? 'not-run';
    if (outcome !== 'passed') {
      violations.push({ constraint: 'requiredVerification', suite, reason: `${suite} ${outcome}` });
    }
  }

  return { satisfied: violations.length === 0, violations };
}

/** Why timing is not proven met, or undefined when it is. Worst slack first, then path vs period. */
function timingViolation(ppa: PpaSnapshot): string | undefined {
  const slack = requireUnit(ppa.performance.worstSlack, 'ns', 'worst slack');
  if (slack.ok && slack.provenance !== 'theoretical') {
    return slack.value < 0 ? `worst slack ${String(slack.value)} ns is negative` : undefined;
  }
  const path = requireUnit(ppa.performance.criticalPath, 'ns', 'critical path');
  const period = requireUnit(ppa.performance.clockPeriod, 'ns', 'clock period');
  if (!path.ok || !period.ok || path.provenance === 'theoretical') {
    const why = [slack, path, period].flatMap((r) => (r.ok ? [] : [r.reason]));
    return `timing cannot be proven met: ${why.length > 0 ? why.join('; ') : 'only theoretical values'}`;
  }
  return path.value > period.value
    ? `critical path ${String(path.value)} ns exceeds the clock period ${String(period.value)} ns`
    : undefined;
}
