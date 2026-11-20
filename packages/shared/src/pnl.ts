/**
 * The money maths, in whole micro-dollars. No floats touch an amount.
 *
 * The deal, in one place:
 *   - Parrot pays for every dub up front (the dub cost).
 *   - The creator pays PRICE_PER_VIEW for each view a dub actually gets, up to
 *     their own per-post budget. Viewers pay nothing.
 *   - A view is worth whatever the creator says it is worth to them (their
 *     rate per 1,000 views). That is the only "revenue" figure, and it is
 *     always labelled as their rate, never as money received.
 *
 * So for the creator, a language's net is `value - paid`, and for Parrot a dub
 * pays for itself once `paid >= dub cost`, which is `breakEvenViews` views.
 */

import { DUBBING_TIER, ELEVENLABS_PRICE_PER_MINUTE, PRICE_PER_VIEW } from './constants.js';
import { micros, type Micros } from './units.js';

/**
 * What a dub of this length costs to make, per target language. Rounded up to
 * the micro: never under-state a cost.
 */
export function estimateDubCost(durationS: number, perMinute: Micros = ELEVENLABS_PRICE_PER_MINUTE[DUBBING_TIER]): Micros {
  const cost = (BigInt(Math.ceil(durationS * 1_000)) * (perMinute as bigint) + 59_999n) / 60_000n;
  return micros(cost);
}

/** What `views` views cost the creator. */
export function viewCharge(views: number, pricePerView: Micros = PRICE_PER_VIEW): Micros {
  return micros(BigInt(Math.max(0, Math.floor(views))) * (pricePerView as bigint));
}

/** What `views` views are worth at the creator's own rate per 1,000 views. */
export function viewValue(views: number, valuePerThousand: Micros): Micros {
  return micros((BigInt(Math.max(0, Math.floor(views))) * (valuePerThousand as bigint)) / 1_000n);
}

/** Views a dub needs before what the creator paid covers what it cost to make. */
export function breakEvenViews(dubCost: Micros, pricePerView: Micros = PRICE_PER_VIEW): number {
  const price = pricePerView as bigint;
  if (price <= 0n) return Number.POSITIVE_INFINITY;
  return Number(((dubCost as bigint) + price - 1n) / price);
}

/**
 * How many of a dub's not-yet-charged views can be charged now.
 *
 * Bounded by what is left of the post's budget and by what the creator can
 * actually pay. Whole views only: a view is never part-charged.
 */
export function billableViews(input: {
  readonly totalViews: number;
  readonly billedViews: number;
  /** What is left of this post's budget. */
  readonly budgetLeft: Micros;
  /** What the creator has available to spend. */
  readonly available: Micros;
  readonly pricePerView?: Micros;
}): number {
  const price = (input.pricePerView ?? PRICE_PER_VIEW) as bigint;
  if (price <= 0n) return 0;
  const unbilled = Math.max(0, Math.floor(input.totalViews) - Math.floor(input.billedViews));
  const cap = (a: Micros) => ((a as bigint) > 0n ? Number((a as bigint) / price) : 0);
  return Math.min(unbilled, cap(input.budgetLeft), cap(input.available));
}

export interface PnlLine {
  /** What the views are worth at the creator's rate. */
  readonly value: Micros;
  /** What the creator has been charged. */
  readonly paid: Micros;
  /** value - paid: the creator's side. */
  readonly net: Micros;
  /** What the dub cost Parrot to make. */
  readonly dubCost: Micros;
  /** paid - dubCost: Parrot's side. Negative means Parrot took the loss. */
  readonly parrotNet: Micros;
}

export function pnlLine(input: {
  readonly views: number;
  readonly paid: Micros;
  readonly valuePerThousand: Micros;
  readonly dubCost: Micros;
}): PnlLine {
  const value = viewValue(input.views, input.valuePerThousand);
  return {
    value,
    paid: input.paid,
    net: micros((value as bigint) - (input.paid as bigint)),
    dubCost: input.dubCost,
    parrotNet: micros((input.paid as bigint) - (input.dubCost as bigint)),
  };
}

export function addPnl(lines: readonly PnlLine[]): PnlLine {
  let value = 0n;
  let paid = 0n;
  let dubCost = 0n;
  for (const l of lines) {
    value += l.value as bigint;
    paid += l.paid as bigint;
    dubCost += l.dubCost as bigint;
  }
  return {
    value: micros(value),
    paid: micros(paid),
    net: micros(value - paid),
    dubCost: micros(dubCost),
    parrotNet: micros(paid - dubCost),
  };
}

/**
 * True when the creator values a view at less than it costs them. Then every
 * dubbed view loses them money, and the app says so instead of hiding it.
 */
export function viewsCostMoreThanTheyAreWorth(valuePerThousand: Micros, pricePerView: Micros = PRICE_PER_VIEW): boolean {
  return (valuePerThousand as bigint) < (pricePerView as bigint) * 1_000n;
}
