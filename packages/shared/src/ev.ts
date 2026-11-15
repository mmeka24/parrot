/**
 * The decision loop's expected-value model. This is the heart of the agent:
 * it is what makes Parrot an economic actor rather than a dubbing button.
 *
 *     EV = p_success * (predicted_views * r) - dub_cost
 *
 * where `r` is the expected revenue to the AGENT per international view, and is
 * DERIVED, never hardcoded:
 *
 *     r = unlock_conversion_rate * unlock_price * agent_share
 *
 * With a $0.02 unlock and a 40% agent share the agent takes $0.008 per unlock,
 * so the worked example's r = $0.001/view implies a 12.5% view-to-unlock
 * conversion. That identity is enforced by test/economics.test.ts — if someone
 * changes the price or the split without changing the conversion assumption,
 * the test fails rather than the agent quietly making bad bets.
 *
 * All arithmetic is integer bigint. Probabilities and rates are ppm integers.
 * Money never touches a float on this path.
 */

import { micros, type Micros } from './units.js';
import { PPM_ONE_BIG, type Ppm } from './ppm.js';
import { BPS_DENOMINATOR } from './split.js';

export interface EvInputs {
  /** Point estimate of international views for this language. */
  readonly predictedViews: number;
  /** Learned view-to-unlock conversion for this (category, language) bucket. */
  readonly conversionPpm: Ppm;
  /** Price a viewer pays per unlock. */
  readonly unlockPrice: Micros;
  /** The agent's cut of each unlock, in basis points. */
  readonly agentBps: number;
  /** Probability the dub renders AND passes QC, from the agent's own history. */
  readonly pSuccessPpm: Ppm;
  /** What this dub will cost the agent to produce. */
  readonly dubCost: Micros;
}

export interface EvResult {
  /** Expected revenue to the agent, before cost and before p_success. */
  readonly grossRevenue: Micros;
  /** Expected revenue after applying p_success. */
  readonly expectedRevenue: Micros;
  /** expectedRevenue - dubCost. May be negative. */
  readonly ev: Micros;
  /** Revenue to the agent per predicted view, rounded for display only. */
  readonly rPerView: Micros;
  /** The agent's take from a single unlock. */
  readonly agentTakePerUnlock: Micros;
  /** Expected number of unlocks (predictedViews * conversion), for the dashboard. */
  readonly expectedUnlocks: number;
}

function assertNonNegativeInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

/**
 * The agent's revenue per international VIEW.
 *
 * Exact value = conversion * price * agentBps/10000, which can be a fraction of
 * a micro-dollar. This returns it rounded to the nearest micro FOR DISPLAY. The
 * EV computation below never uses this rounded figure; it keeps full precision.
 */
export function deriveRPerView(
  unlockPrice: Micros,
  agentBps: number,
  conversionPpm: Ppm,
): Micros {
  assertNonNegativeInt('agentBps', agentBps);
  const numerator =
    (unlockPrice as bigint) * BigInt(agentBps) * BigInt(conversionPpm);
  const denominator = BPS_DENOMINATOR * PPM_ONE_BIG;
  return micros(roundDiv(numerator, denominator));
}

/** The agent's take from one unlock. Floor, matching splitRevenue(). */
export function agentTakePerUnlock(unlockPrice: Micros, agentBps: number): Micros {
  assertNonNegativeInt('agentBps', agentBps);
  return micros(((unlockPrice as bigint) * BigInt(agentBps)) / BPS_DENOMINATOR);
}

/** Round-half-up integer division for non-negative denominators. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  if (numerator >= 0n) return (numerator * 2n + denominator) / (denominator * 2n);
  return -((-numerator * 2n + denominator) / (denominator * 2n));
}

/**
 * Compute expected value. Kept in one expression's worth of exact integer math:
 *
 *   expectedRevenue = views * price * agentBps * conv * pSuccess
 *                     ---------------------------------------
 *                              10000 * 1e6 * 1e6
 */
export function computeEv(inputs: EvInputs): EvResult {
  const { predictedViews, conversionPpm, unlockPrice, agentBps, pSuccessPpm, dubCost } = inputs;

  assertNonNegativeInt('predictedViews', predictedViews);
  assertNonNegativeInt('agentBps', agentBps);
  if (agentBps > Number(BPS_DENOMINATOR)) {
    throw new RangeError(`agentBps must not exceed ${BPS_DENOMINATOR}, got ${agentBps}`);
  }
  if ((unlockPrice as bigint) < 0n) throw new RangeError('unlockPrice must not be negative');
  if ((dubCost as bigint) < 0n) throw new RangeError('dubCost must not be negative');

  const views = BigInt(predictedViews);
  const price = unlockPrice as bigint;
  const bps = BigInt(agentBps);
  const conv = BigInt(conversionPpm);
  const pSuccess = BigInt(pSuccessPpm);

  // gross = views * price * (bps/10000) * (conv/1e6)
  const grossNumerator = views * price * bps * conv;
  const grossDenominator = BPS_DENOMINATOR * PPM_ONE_BIG;
  const grossRevenue = roundDiv(grossNumerator, grossDenominator);

  // expected = gross * pSuccess, computed from the full-precision numerator so
  // the two roundings cannot compound.
  const expectedRevenue = roundDiv(grossNumerator * pSuccess, grossDenominator * PPM_ONE_BIG);

  const ev = expectedRevenue - (dubCost as bigint);

  const expectedUnlocks = (predictedViews * conversionPpm) / Number(PPM_ONE_BIG);

  return {
    grossRevenue: micros(grossRevenue),
    expectedRevenue: micros(expectedRevenue),
    ev: micros(ev),
    rPerView: deriveRPerView(unlockPrice, agentBps, conversionPpm),
    agentTakePerUnlock: agentTakePerUnlock(unlockPrice, agentBps),
    expectedUnlocks,
  };
}

/**
 * Budget rules that run BEFORE the EV test. These are hard limits: an agent that
 * would otherwise take a positive-EV bet still declines if the bet would push it
 * below its floor, past its per-job exposure cap, or over its daily spend cap.
 */
export interface BudgetInputs {
  readonly balance: Micros;
  readonly dubCost: Micros;
  readonly floor: Micros;
  readonly maxExposurePerJob: Micros;
  readonly spentToday: Micros;
  readonly dailyCap: Micros;
}

export type BudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'BUDGET_FLOOR' | 'MAX_EXPOSURE' | 'DAILY_CAP' };

export function checkBudget(inputs: BudgetInputs): BudgetVerdict {
  const { balance, dubCost, floor, maxExposurePerJob, spentToday, dailyCap } = inputs;

  if ((dubCost as bigint) > (maxExposurePerJob as bigint)) {
    return { ok: false, reason: 'MAX_EXPOSURE' };
  }
  if ((spentToday as bigint) + (dubCost as bigint) > (dailyCap as bigint)) {
    return { ok: false, reason: 'DAILY_CAP' };
  }
  if ((balance as bigint) - (dubCost as bigint) < (floor as bigint)) {
    return { ok: false, reason: 'BUDGET_FLOOR' };
  }
  return { ok: true };
}

/** Return on investment as ppm of cost, for the leaderboard. Null when cost is 0. */
export function roiPpm(revenue: Micros, cost: Micros): number | null {
  if ((cost as bigint) === 0n) return null;
  const profit = (revenue as bigint) - (cost as bigint);
  return Number((profit * PPM_ONE_BIG) / (cost as bigint));
}
