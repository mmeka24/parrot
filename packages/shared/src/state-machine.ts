/**
 * The job state machine. One typed reducer is the ONLY way a job changes state.
 *
 *   REQUESTED -> PARSED -> EVALUATING -> DECLINED
 *                                     -> APPROVED -> DUBBING -> QC -> REJECTED_BY_QC
 *                                                                  -> PUBLISHED -> EARNING <-> SETTLED
 *   ...and FAILED from any non-terminal state, always with a reason.
 *
 * EARNING <-> SETTLED is deliberately two-way: SETTLED means "everything ledgered
 * so far has been paid out on-chain", and a new unlock legitimately moves the job
 * back to EARNING. Modelling it as a one-way terminal state would have forced us
 * to lie about jobs that keep earning after their first settlement.
 *
 * Every accepted transition produces an append-only event row, which is what
 * powers the dashboard timeline and decides what the bot says.
 */

export const JOB_STATES = [
  'REQUESTED',
  'PARSED',
  'EVALUATING',
  'DECLINED',
  'APPROVED',
  'DUBBING',
  'QC',
  'REJECTED_BY_QC',
  'PUBLISHED',
  'EARNING',
  'SETTLED',
  'FAILED',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** States from which no further progress is possible. */
export const TERMINAL_STATES = ['DECLINED', 'REJECTED_BY_QC', 'FAILED'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminal(state: JobState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export const JOB_EVENT_TYPES = [
  'PARSED',
  'EVALUATION_STARTED',
  'DECLINED',
  'APPROVED',
  'DUBBING_STARTED',
  'DUB_RENDERED',
  'QC_PASSED',
  'QC_FAILED',
  'FIRST_UNLOCK',
  'SETTLED',
  'UNLOCKED_AFTER_SETTLEMENT',
  'FAILED',
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

/**
 * The transition table. `from` states map to the events they accept and the
 * state each event produces. Anything not listed here is rejected.
 */
const TRANSITIONS: Readonly<Record<JobState, Partial<Record<JobEventType, JobState>>>> = {
  REQUESTED: { PARSED: 'PARSED', FAILED: 'FAILED' },
  PARSED: { EVALUATION_STARTED: 'EVALUATING', FAILED: 'FAILED' },
  EVALUATING: { DECLINED: 'DECLINED', APPROVED: 'APPROVED', FAILED: 'FAILED' },
  APPROVED: { DUBBING_STARTED: 'DUBBING', FAILED: 'FAILED' },
  DUBBING: { DUB_RENDERED: 'QC', FAILED: 'FAILED' },
  QC: { QC_PASSED: 'PUBLISHED', QC_FAILED: 'REJECTED_BY_QC', FAILED: 'FAILED' },
  PUBLISHED: { FIRST_UNLOCK: 'EARNING', FAILED: 'FAILED' },
  EARNING: { SETTLED: 'SETTLED', FAILED: 'FAILED' },
  SETTLED: { UNLOCKED_AFTER_SETTLEMENT: 'EARNING', FAILED: 'FAILED' },
  // terminal
  DECLINED: {},
  REJECTED_BY_QC: {},
  FAILED: {},
};

export class InvalidTransitionError extends Error {
  readonly from: JobState;
  readonly event: JobEventType;

  constructor(from: JobState, event: JobEventType) {
    super(
      isTerminal(from)
        ? `job is already in terminal state ${from}; cannot apply ${event}`
        : `cannot apply ${event} to a job in state ${from}`,
    );
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.event = event;
  }
}

/** The reducer. Throws rather than silently ignoring an illegal transition. */
export function transition(from: JobState, event: JobEventType): JobState {
  const next = TRANSITIONS[from][event];
  if (next === undefined) throw new InvalidTransitionError(from, event);
  return next;
}

/** Non-throwing variant for places that want to branch instead of catch. */
export function canTransition(from: JobState, event: JobEventType): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function allowedEvents(from: JobState): JobEventType[] {
  return Object.keys(TRANSITIONS[from]) as JobEventType[];
}

/** A job is publicly viewable (the dub page serves media) only in these states. */
export function isPublished(state: JobState): boolean {
  return state === 'PUBLISHED' || state === 'EARNING' || state === 'SETTLED';
}

/** Reasons a job can be declined, used verbatim to pick bot copy. */
export const DECLINE_REASONS = [
  'LOW_EV',
  'BUDGET_FLOOR',
  'DAILY_CAP',
  'MAX_EXPOSURE',
  'TOO_LONG',
  'UNSUPPORTED_LANGUAGE',
  'NO_VIDEO',
  'NOT_AUTHOR',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Reasons a job can hard-fail. */
export const FAILURE_REASONS = [
  'PARSE_FAILED',
  'SOURCE_UNAVAILABLE',
  'DUBBING_PROVIDER_ERROR',
  'DUBBING_TIMEOUT',
  'STORAGE_ERROR',
  'PAYOUT_ERROR',
  'INTERNAL_ERROR',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
