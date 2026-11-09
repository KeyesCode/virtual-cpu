export type ObjectiveDirection = 'minimize' | 'maximize';

export interface Objective {
  key: string;
  direction: ObjectiveDirection;
}

export interface ParetoPoint {
  /** Unique within one call. */
  id: string;
  /** One value per objective key; a missing or non-finite value excludes the point. */
  values: Readonly<Record<string, number | undefined>>;
}

export interface ParetoResult {
  /**
   * The non-dominated points, ordered by the objectives in turn (each in its own direction, best
   * first) and then by id, so the order does not depend on the input order.
   */
  frontier: string[];
  /** For each dominated point, every point that dominates it, in frontier order. */
  dominatedBy: Record<string, string[]>;
  /**
   * For each point whose objective values equal an earlier point's (in frontier order), the first
   * such point. Duplicates are kept: two identical non-dominated points are both on the frontier.
   */
  duplicateOf: Record<string, string>;
  /** Points left out because an objective value is missing or not finite, with the reason. */
  excluded: Record<string, string>;
}

/**
 * The Pareto frontier of `points` over `objectives`. A point dominates another when it is no worse
 * on every objective and strictly better on at least one. O(n² × objectives).
 */
export function paretoFrontier(
  points: readonly ParetoPoint[],
  objectives: readonly Objective[],
): ParetoResult {
  if (objectives.length === 0) throw new RangeError('paretoFrontier needs at least one objective');
  const keys = new Set(objectives.map((objective) => objective.key));
  if (keys.size !== objectives.length) throw new RangeError('objective keys must be unique');
  const ids = new Set(points.map((point) => point.id));
  if (ids.size !== points.length) throw new RangeError('point ids must be unique');

  const excluded: [string, string][] = [];
  const valid: { id: string; scores: number[] }[] = [];
  for (const point of points) {
    // Scores are oriented so that lower is always better.
    const scores: number[] = [];
    let missing: string | undefined;
    for (const objective of objectives) {
      const value = point.values[objective.key];
      if (value === undefined || !Number.isFinite(value)) {
        missing = `${objective.key} is ${value === undefined ? 'missing' : String(value)}`;
        break;
      }
      scores.push(objective.direction === 'minimize' ? value : -value);
    }
    if (missing === undefined) valid.push({ id: point.id, scores });
    else excluded.push([point.id, missing]);
  }

  valid.sort((a, b) => {
    for (const [index, score] of a.scores.entries()) {
      const other = b.scores[index] ?? 0;
      if (score !== other) return score - other;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const dominates = (a: number[], b: number[]) => {
    let strictlyBetter = false;
    for (const [index, score] of a.entries()) {
      const other = b[index] ?? 0;
      if (score > other) return false;
      if (score < other) strictlyBetter = true;
    }
    return strictlyBetter;
  };
  const same = (a: number[], b: number[]) => a.every((score, index) => score === b[index]);

  const frontier: string[] = [];
  const dominatedBy: [string, string[]][] = [];
  const duplicateOf: [string, string][] = [];
  for (const [index, point] of valid.entries()) {
    const dominators = valid.filter((other) => dominates(other.scores, point.scores));
    if (dominators.length === 0) frontier.push(point.id);
    else dominatedBy.push([point.id, dominators.map((other) => other.id)]);
    const original = valid.slice(0, index).find((other) => same(other.scores, point.scores));
    if (original) duplicateOf.push([point.id, original.id]);
  }

  return {
    frontier,
    dominatedBy: Object.fromEntries(dominatedBy),
    duplicateOf: Object.fromEntries(duplicateOf),
    excluded: Object.fromEntries(excluded),
  };
}
