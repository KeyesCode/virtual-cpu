import { describe, expect, it } from 'vitest';
import { EXPERIMENT_STATES, FAILURE_CLASSES, type FailureClass } from '../domain/experiment.js';
import {
  EXPERIMENT_EVENT_TYPES,
  InvalidTransition,
  STAGE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  nextState,
  stageJobId,
  stagesFor,
  transition,
  transitionEdges,
  type ExperimentEvent,
  type ExperimentEventType,
} from './machine.js';
import {
  DEFAULT_RETRY_POLICY,
  RETRYABLE_FAILURE_CLASSES,
  RetryPolicySchema,
  backoffDelayMs,
  decideFailure,
  type RetryPolicy,
} from './retry.js';

/** Every concrete event the machine can be offered, `advance` once per target state. */
function everyEvent(): ExperimentEvent[] {
  return EXPERIMENT_EVENT_TYPES.flatMap((type): ExperimentEvent[] => {
    switch (type) {
      case 'enqueue':
      case 'start':
        return [{ type }];
      case 'advance':
        return EXPERIMENT_STATES.map((to) => ({ type, to }));
      case 'reject':
        return [{ type, failureClass: 'incorrect-design', reason: 'mismatch' }];
      case 'fail':
        return [{ type, failureClass: 'tool-failure', attemptsMade: 3, reason: 'crashed' }];
      case 'cancel':
      case 'budget-exceeded':
        return [{ type, reason: 'stop' }];
    }
  });
}

function legalTargets(state: (typeof EXPERIMENT_STATES)[number], type: ExperimentEventType) {
  return TRANSITIONS[state][type] ?? [];
}

describe('the transition table', () => {
  it('has a row for each of the 14 states', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...EXPERIMENT_STATES].sort());
    expect(EXPERIMENT_STATES).toHaveLength(14);
  });

  it('reaches every state from CREATED', () => {
    const reached = new Set<string>(['CREATED']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of transitionEdges()) {
        if (reached.has(edge.from) && !reached.has(edge.to)) {
          reached.add(edge.to);
          grew = true;
        }
      }
    }
    expect([...reached].sort()).toEqual([...EXPERIMENT_STATES].sort());
  });

  it('accepts every listed edge', () => {
    for (const edge of transitionEdges()) {
      const event = everyEvent().find(
        (candidate) =>
          candidate.type === edge.event &&
          (candidate.type !== 'advance' || candidate.to === edge.to),
      );
      if (event === undefined) throw new Error(`no event for ${edge.from} ${edge.event}`);
      expect(transition(edge.from, event).to).toBe(edge.to);
    }
  });

  it('refuses every (state, event) pair the table does not list', () => {
    let refused = 0;
    for (const state of EXPERIMENT_STATES) {
      for (const event of everyEvent()) {
        const targets = legalTargets(state, event.type);
        const legal = event.type === 'advance' ? targets.includes(event.to) : targets.length > 0;
        if (legal) {
          expect(canTransition(state, event), `${state} ${JSON.stringify(event)}`).toBe(true);
        } else {
          refused += 1;
          expect(() => transition(state, event), `${state} ${JSON.stringify(event)}`).toThrow(
            InvalidTransition,
          );
        }
      }
    }
    // 14 states × (6 single events + 14 advance targets) = 280 pairs, of which 48 are edges.
    expect(transitionEdges()).toHaveLength(48);
    expect(refused).toBe(14 * (6 + 14) - 48);
  });

  it('accepts nothing from a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(isTerminal(state)).toBe(true);
      for (const event of everyEvent()) expect(canTransition(state, event)).toBe(false);
    }
  });

  it('cancels from every non-terminal state', () => {
    for (const state of EXPERIMENT_STATES.filter((s) => !isTerminal(s))) {
      expect(transition(state, { type: 'cancel', reason: 'by hand' })).toMatchObject({
        to: 'CANCELLED',
        failureClass: null,
        reason: 'by hand',
      });
    }
  });

  it('ends a budget stop as CANCELLED and keeps the class', () => {
    for (const state of EXPERIMENT_STATES.filter((s) => !isTerminal(s))) {
      expect(transition(state, { type: 'budget-exceeded', reason: 'maxTokens' })).toMatchObject({
        to: 'CANCELLED',
        failureClass: 'budget-exceeded',
        reason: 'maxTokens',
      });
    }
  });

  it('rejects VERIFYING on incorrect-design', () => {
    expect(
      transition('VERIFYING', { type: 'reject', failureClass: 'incorrect-design', reason: 'x' }),
    ).toMatchObject({ from: 'VERIFYING', to: 'REJECTED', failureClass: 'incorrect-design' });
  });

  it('only rejects with a rejection class', () => {
    for (const failureClass of FAILURE_CLASSES) {
      const event = { type: 'reject', failureClass, reason: 'x' } as ExperimentEvent;
      const allowed = ['incorrect-design', 'unsupported-design', 'policy-violation'];
      expect(canTransition('VERIFYING', event), failureClass).toBe(allowed.includes(failureClass));
    }
  });

  it('only fails with a retryable class, and only once its retries are exhausted', () => {
    for (const failureClass of FAILURE_CLASSES) {
      const cap = DEFAULT_RETRY_POLICY[failureClass].maxAttempts;
      const fail = (attemptsMade: number) =>
        ({ type: 'fail', failureClass, attemptsMade, reason: 'x' }) as ExperimentEvent;
      const retryable = (RETRYABLE_FAILURE_CLASSES as readonly FailureClass[]).includes(
        failureClass,
      );
      expect(canTransition('COMPILING', fail(cap)), failureClass).toBe(retryable);
      if (retryable) expect(canTransition('COMPILING', fail(cap - 1))).toBe(false);
    }
  });

  it('uses the given retry policy to decide a fail', () => {
    const policy: RetryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      'tool-failure': { retryable: true, maxAttempts: 5, backoff: { delayMs: 0, maxDelayMs: 0 } },
    };
    const event: ExperimentEvent = {
      type: 'fail',
      failureClass: 'tool-failure',
      attemptsMade: 3,
      reason: 'x',
    };
    expect(canTransition('COMPILING', event)).toBe(true);
    expect(canTransition('COMPILING', event, { retryPolicy: policy })).toBe(false);
  });
});

describe('stage plans', () => {
  it('runs all eight stages by default', () => {
    expect(stagesFor()).toEqual(STAGE_STATES);
  });

  it('leaves out generation and Tier 2 when asked', () => {
    expect(stagesFor({ generation: false, physicalAnalysis: false })).toEqual([
      'PREPARING',
      'STATIC_VALIDATION',
      'COMPILING',
      'VERIFYING',
      'SYNTHESIZING',
      'SCORING',
    ]);
  });

  it('is a path through the table for every combination', () => {
    for (const generation of [true, false]) {
      for (const physicalAnalysis of [true, false]) {
        const plan = stagesFor({ generation, physicalAnalysis });
        let state = transition('QUEUED', { type: 'start' }).to;
        expect(state).toBe(plan[0]);
        for (const stage of plan) {
          expect(state).toBe(stage);
          state = transition(stage, { type: 'advance', to: nextState(plan, stage) }).to;
        }
        expect(state).toBe('COMPLETED');
      }
    }
  });

  it('names one job per stage attempt', () => {
    expect(stageJobId('e1', 'COMPILING', 2)).toBe('e1:COMPILING:2');
  });
});

describe('retry policy', () => {
  it('is a valid policy, and only the three transient classes retry', () => {
    expect(RetryPolicySchema.safeParse(DEFAULT_RETRY_POLICY).success).toBe(true);
    const broken = {
      ...DEFAULT_RETRY_POLICY,
      'incorrect-design': {
        retryable: true,
        maxAttempts: 2,
        backoff: { delayMs: 1, maxDelayMs: 1 },
      },
    };
    expect(RetryPolicySchema.safeParse(broken).success).toBe(false);
  });

  it('never retries a correctness, policy or budget failure', () => {
    expect(decideFailure('incorrect-design', 1)).toEqual({
      action: 'reject',
      failureClass: 'incorrect-design',
    });
    expect(decideFailure('unsupported-design', 1).action).toBe('reject');
    expect(decideFailure('policy-violation', 1).action).toBe('reject');
    expect(decideFailure('budget-exceeded', 1).action).toBe('cancel');
  });

  it('retries tool-failure up to its cap, then fails', () => {
    const cap = DEFAULT_RETRY_POLICY['tool-failure'].maxAttempts;
    for (let attempt = 1; attempt < cap; attempt += 1) {
      expect(decideFailure('tool-failure', attempt)).toMatchObject({
        action: 'retry',
        nextAttempt: attempt + 1,
      });
    }
    expect(decideFailure('tool-failure', cap)).toEqual({
      action: 'fail',
      failureClass: 'tool-failure',
    });
  });

  it('backs off exponentially up to the maximum', () => {
    const backoff = { delayMs: 1000, maxDelayMs: 5000 };
    expect([1, 2, 3, 4].map((attempt) => backoffDelayMs(backoff, attempt))).toEqual([
      1000, 2000, 4000, 5000,
    ]);
  });
});
