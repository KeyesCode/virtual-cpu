import { describe, expect, it } from 'vitest';
import { type Objective, paretoFrontier, type ParetoPoint } from './pareto.js';

const MIN_AREA_DELAY: Objective[] = [
  { key: 'area', direction: 'minimize' },
  { key: 'delay', direction: 'minimize' },
];

function point(id: string, area: number, delay: number): ParetoPoint {
  return { id, values: { area, delay } };
}

describe('paretoFrontier', () => {
  // Hand-checked: G, B, A, D and C trade area for delay; D duplicates A; E, F and H are dominated.
  const EIGHT = [
    point('A', 1000, 2.5),
    point('B', 900, 3.0),
    point('C', 1100, 2.0),
    point('D', 1000, 2.5),
    point('E', 1000, 3.0),
    point('F', 1200, 2.0),
    point('G', 800, 4.0),
    point('H', 1150, 2.6),
  ];

  it('returns the hand-computed frontier, dominators and duplicates', () => {
    expect(paretoFrontier(EIGHT, MIN_AREA_DELAY)).toEqual({
      frontier: ['G', 'B', 'A', 'D', 'C'],
      dominatedBy: { E: ['B', 'A', 'D'], H: ['A', 'D', 'C'], F: ['C'] },
      duplicateOf: { D: 'A' },
      excluded: {},
    });
  });

  it('does not depend on input order', () => {
    const reversed = paretoFrontier([...EIGHT].reverse(), MIN_AREA_DELAY);
    expect(reversed).toEqual(paretoFrontier(EIGHT, MIN_AREA_DELAY));
  });

  it('honours maximise objectives', () => {
    const result = paretoFrontier(
      [
        { id: 'slow', values: { throughput: 100, area: 900 } },
        { id: 'fast', values: { throughput: 200, area: 1000 } },
        { id: 'worse', values: { throughput: 150, area: 1100 } },
      ],
      [
        { key: 'throughput', direction: 'maximize' },
        { key: 'area', direction: 'minimize' },
      ],
    );
    expect(result.frontier).toEqual(['fast', 'slow']);
    expect(result.dominatedBy).toEqual({ worse: ['fast'] });
  });

  it('excludes points with missing or non-finite values, and handles the empty set', () => {
    const result = paretoFrontier(
      [point('ok', 1, 1), { id: 'missing', values: { area: 1 } }, point('nan', Number.NaN, 1)],
      MIN_AREA_DELAY,
    );
    expect(result.frontier).toEqual(['ok']);
    expect(result.excluded).toEqual({ missing: 'delay is missing', nan: 'area is NaN' });
    expect(paretoFrontier([], MIN_AREA_DELAY)).toEqual({
      frontier: [],
      dominatedBy: {},
      duplicateOf: {},
      excluded: {},
    });
  });

  it('refuses duplicate ids, duplicate objectives and no objectives', () => {
    expect(() => paretoFrontier([point('A', 1, 1), point('A', 2, 2)], MIN_AREA_DELAY)).toThrow(
      /ids/,
    );
    const area: Objective = { key: 'area', direction: 'minimize' };
    expect(() => paretoFrontier([], [area, area])).toThrow(/keys/);
    expect(() => paretoFrontier([], [])).toThrow(/objective/);
  });

  it('never puts a dominated point on the frontier (seeded random sets)', () => {
    let seed = 0x2545f491;
    const random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const objectives: Objective[] = [
      { key: 'x', direction: 'minimize' },
      { key: 'y', direction: 'maximize' },
      { key: 'z', direction: 'minimize' },
    ];
    const oriented = (p: ParetoPoint) => [p.values.x ?? 0, -(p.values.y ?? 0), p.values.z ?? 0];
    const dominates = (a: number[], b: number[]) =>
      a.every((v, i) => v <= (b[i] ?? 0)) && a.some((v, i) => v < (b[i] ?? 0));

    for (let trial = 0; trial < 50; trial += 1) {
      const points: ParetoPoint[] = Array.from({ length: 40 }, (_, i) => ({
        id: `p${String(i)}`,
        // Few distinct values, so ties and duplicates are common.
        values: {
          x: Math.floor(random() * 6),
          y: Math.floor(random() * 6),
          z: Math.floor(random() * 6),
        },
      }));
      const byId = new Map(points.map((p) => [p.id, oriented(p)]));
      const result = paretoFrontier(points, objectives);

      for (const id of result.frontier) {
        for (const other of points) {
          expect(dominates(oriented(other), byId.get(id) ?? [])).toBe(false);
        }
      }
      for (const [id, dominators] of Object.entries(result.dominatedBy)) {
        expect(dominators.length).toBeGreaterThan(0);
        for (const dominator of dominators) {
          expect(dominates(byId.get(dominator) ?? [], byId.get(id) ?? [])).toBe(true);
        }
      }
      expect(result.frontier.length + Object.keys(result.dominatedBy).length).toBe(points.length);
    }
  });
});
