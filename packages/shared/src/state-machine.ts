/**
 * The life of one dub (one post, in one language).
 *
 *   QUEUED -> DUBBING -> QC -> PUBLISHED
 *                           -> REJECTED_BY_QC
 *   ...and FAILED from any state before PUBLISHED, always with a reason.
 *
 * `transition` is the only way a dub changes state, so a dub can never be
 * published without having been through the quality check.
 */

export const DUB_STATES = ['QUEUED', 'DUBBING', 'QC', 'PUBLISHED', 'REJECTED_BY_QC', 'FAILED'] as const;
export type DubState = (typeof DUB_STATES)[number];

/** States from which nothing more happens to the dub itself. */
export const FINAL_STATES = ['PUBLISHED', 'REJECTED_BY_QC', 'FAILED'] as const;

export function isFinal(state: DubState): boolean {
  return (FINAL_STATES as readonly string[]).includes(state);
}

export function isPublished(state: DubState): boolean {
  return state === 'PUBLISHED';
}

const NEXT: Readonly<Record<DubState, readonly DubState[]>> = {
  QUEUED: ['DUBBING', 'FAILED'],
  DUBBING: ['QC', 'FAILED'],
  QC: ['PUBLISHED', 'REJECTED_BY_QC', 'FAILED'],
  PUBLISHED: [],
  REJECTED_BY_QC: [],
  FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DubState,
    readonly to: DubState,
  ) {
    super(`a dub cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: DubState, to: DubState): boolean {
  return NEXT[from].includes(to);
}

/** Returns `to`, or throws if the move is not allowed. */
export function transition(from: DubState, to: DubState): DubState {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

/** Why Parrot will not dub a post at all. */
export const DECLINE_REASONS = [
  'TOO_LONG',
  'TOO_SHORT',
  'UNSUPPORTED_LANGUAGE',
  'NO_VIDEO',
  'NOT_AUTHOR',
  /** The creator's balance cannot cover any views. */
  'NO_BALANCE',
  /** Every language in the plan is already dubbed for this post. */
  'ALREADY_DUBBED',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Why a dub that was started did not finish. */
export const FAILURE_REASONS = ['DUBBING_FAILED', 'DUBBING_TIMEOUT', 'QC_ERROR', 'PUBLISH_FAILED', 'INTERNAL'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
