import { describe, it, expect } from 'vitest';
import {
  transition,
  canTransition,
  allowedEvents,
  isTerminal,
  isPublished,
  InvalidTransitionError,
  JOB_STATES,
  JOB_EVENT_TYPES,
  type JobState,
} from '../src/state-machine.js';

describe('the happy path', () => {
  it('walks a job from request to settlement', () => {
    let state: JobState = 'REQUESTED';
    state = transition(state, 'PARSED');
    expect(state).toBe('PARSED');
    state = transition(state, 'EVALUATION_STARTED');
    expect(state).toBe('EVALUATING');
    state = transition(state, 'APPROVED');
    expect(state).toBe('APPROVED');
    state = transition(state, 'DUBBING_STARTED');
    expect(state).toBe('DUBBING');
    state = transition(state, 'DUB_RENDERED');
    expect(state).toBe('QC');
    state = transition(state, 'QC_PASSED');
    expect(state).toBe('PUBLISHED');
    state = transition(state, 'FIRST_UNLOCK');
    expect(state).toBe('EARNING');
    state = transition(state, 'SETTLED');
    expect(state).toBe('SETTLED');
  });

  it('lets a settled job start earning again when someone else unlocks it', () => {
    // SETTLED means "everything owed so far has been paid out", not "finished".
    expect(transition('SETTLED', 'UNLOCKED_AFTER_SETTLEMENT')).toBe('EARNING');
    expect(transition(transition('SETTLED', 'UNLOCKED_AFTER_SETTLEMENT'), 'SETTLED')).toBe(
      'SETTLED',
    );
  });
});

describe('the decline path', () => {
  it('declines during evaluation', () => {
    expect(transition('EVALUATING', 'DECLINED')).toBe('DECLINED');
  });

  it('cannot decline a job that was already approved', () => {
    expect(() => transition('APPROVED', 'DECLINED')).toThrow(InvalidTransitionError);
  });
});

describe('the QC loss path', () => {
  it('rejects a bad dub instead of publishing it', () => {
    expect(transition('QC', 'QC_FAILED')).toBe('REJECTED_BY_QC');
  });

  it('cannot publish after QC rejection, so a bad dub can never be served', () => {
    expect(() => transition('REJECTED_BY_QC', 'QC_PASSED')).toThrow(InvalidTransitionError);
    expect(isPublished('REJECTED_BY_QC')).toBe(false);
  });

  it('cannot skip QC: a rendered dub always lands in QC first', () => {
    expect(transition('DUBBING', 'DUB_RENDERED')).toBe('QC');
    expect(canTransition('DUBBING', 'QC_PASSED')).toBe(false);
    expect(canTransition('APPROVED', 'DUB_RENDERED')).toBe(false);
  });
});

describe('failure', () => {
  const nonTerminal = JOB_STATES.filter((s) => !isTerminal(s));

  it('can fail from any non-terminal state', () => {
    for (const state of nonTerminal) {
      expect(transition(state, 'FAILED'), state).toBe('FAILED');
    }
  });

  it('cannot move out of a terminal state at all', () => {
    for (const state of JOB_STATES.filter(isTerminal)) {
      expect(allowedEvents(state), state).toEqual([]);
      for (const event of JOB_EVENT_TYPES) {
        expect(() => transition(state, event), `${state}/${event}`).toThrow(
          InvalidTransitionError,
        );
      }
    }
  });

  it('explains itself when a transition is refused', () => {
    expect(() => transition('REQUESTED', 'QC_PASSED')).toThrow(
      /cannot apply QC_PASSED to a job in state REQUESTED/,
    );
    expect(() => transition('DECLINED', 'APPROVED')).toThrow(/already in terminal state DECLINED/);
  });
});

describe('transition table integrity', () => {
  it('rejects every undeclared (state, event) pair rather than falling through', () => {
    for (const state of JOB_STATES) {
      const allowed = new Set(allowedEvents(state));
      for (const event of JOB_EVENT_TYPES) {
        if (allowed.has(event)) {
          expect(() => transition(state, event)).not.toThrow();
        } else {
          expect(() => transition(state, event), `${state}/${event}`).toThrow();
        }
      }
    }
  });

  it('only ever produces a known state', () => {
    for (const state of JOB_STATES) {
      for (const event of allowedEvents(state)) {
        expect(JOB_STATES).toContain(transition(state, event));
      }
    }
  });

  it('every state is reachable from REQUESTED', () => {
    const seen = new Set<JobState>(['REQUESTED']);
    const queue: JobState[] = ['REQUESTED'];
    while (queue.length > 0) {
      const state = queue.shift() as JobState;
      for (const event of allowedEvents(state)) {
        const next = transition(state, event);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...JOB_STATES].sort());
  });
});

describe('isPublished', () => {
  it('serves media only once a dub has passed QC', () => {
    expect(isPublished('PUBLISHED')).toBe(true);
    expect(isPublished('EARNING')).toBe(true);
    expect(isPublished('SETTLED')).toBe(true);
    for (const state of ['REQUESTED', 'PARSED', 'EVALUATING', 'APPROVED', 'DUBBING', 'QC'] as const) {
      expect(isPublished(state), state).toBe(false);
    }
  });
});
