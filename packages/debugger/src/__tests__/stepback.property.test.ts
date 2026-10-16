import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DebugSession } from '../index.js';
import { PROGRAMS, sessionFor } from './fixtures.js';

function snapshot(session: DebugSession) {
  return {
    state: session.getState(),
    metrics: session.getMetrics(),
    trace: session.getExecutionTrace(),
  };
}

describe('step then step back restores the identical state', () => {
  it.each(PROGRAMS)(
    '$name',
    ({ source }) => {
      fc.assert(
        fc.property(fc.nat({ max: 60 }), fc.nat({ max: 300 }), (prefix, steps) => {
          const session = sessionFor(source);
          for (let i = 0; i < prefix; i += 1) session.step();
          const history = session.getHistoryStats().entries;

          const states = [snapshot(session)];
          let executed = 0;
          for (let i = 0; i < steps; i += 1) {
            executed += session.step().executed;
            states.push(snapshot(session));
          }
          for (let i = executed; i > 0; i -= 1) {
            expect(session.stepBack().ok).toBe(true);
            expect(snapshot(session)).toEqual(states[i - 1]);
          }
          expect(session.getHistoryStats().entries).toBe(history);
          expect(snapshot(session)).toEqual(states[0]);
        }),
        { numRuns: 40 },
      );
    },
    30_000,
  );
});
