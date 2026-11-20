/**
 * What a dub is expected to get, and what that means in dollars.
 *
 * Two sources, and the answer says which it used:
 *   - LEARNED: this creator's own earlier posts, already measured. Best.
 *   - ESTIMATE: a funnel from public figures, for a creator Parrot knows
 *     nothing about yet:
 *
 *       views on the original
 *       x  share of X's audience that speaks the language   (DataReportal)
 *       x  how well an English post reaches that market      (assumption)
 *       x  how many of them watch the dub                    (assumption)
 *
 *     1.2M views x 8.1% (Spanish) x 35% x 2% is about 680 Spanish views.
 *
 * Always a range, because it is a guess. The creator pays for views that
 * happen, never for a forecast, so a wrong forecast costs them nothing.
 */

import { DUB_UPTAKE, MARKET_REACH, X_AD_REACH_MILLIONS, languageByCode, type FunnelRange } from './constants.js';
import { breakEvenViews, viewCharge, viewValue } from './pnl.js';
import { micros, type Micros } from './units.js';

/** Dub views expected in one language. */
export type ViewForecast = FunnelRange;

/** The funnel estimate for one language, from the original's view count. */
export function forecastViews(originalViews: number, lang: string): ViewForecast {
  const spec = languageByCode(lang);
  const share = spec ? spec.xAudienceMillions / X_AD_REACH_MILLIONS : 0;
  const views = Math.max(0, originalViews);
  const at = (reach: number, uptake: number): number => Math.round(views * share * reach * uptake);
  return {
    low: at(MARKET_REACH.low, DUB_UPTAKE.low),
    likely: at(MARKET_REACH.likely, DUB_UPTAKE.likely),
    high: at(MARKET_REACH.high, DUB_UPTAKE.high),
  };
}

/** A creator's learned average for a language, as a (narrow) forecast. */
export function learnedForecast(avgViews: number): ViewForecast {
  const likely = Math.max(0, Math.round(avgViews));
  return { low: Math.round(likely * 0.6), likely, high: Math.round(likely * 1.6) };
}

/** What a number of views costs the creator, never more than the post's budget. */
export function expectedCharge(views: number, budget: Micros): Micros {
  const charge = viewCharge(views) as bigint;
  return micros(charge > (budget as bigint) ? (budget as bigint) : charge);
}

export interface LanguageEconomics {
  /** What the creator is expected to pay at each end of the range. */
  readonly youPay: { readonly low: Micros; readonly likely: Micros; readonly high: Micros };
  /** What the likely views are worth at the creator's own rate. */
  readonly worthLikely: Micros;
  /** Views this dub needs for the creator's payments to cover its cost. */
  readonly breakEven: number;
}

export function languageEconomics(input: {
  readonly forecast: ViewForecast;
  readonly dubCost: Micros;
  readonly valuePerThousand: Micros;
  /** What is left of the post's budget. */
  readonly budget: Micros;
}): LanguageEconomics {
  const { forecast, budget } = input;
  return {
    youPay: {
      low: expectedCharge(forecast.low, budget),
      likely: expectedCharge(forecast.likely, budget),
      high: expectedCharge(forecast.high, budget),
    },
    worthLikely: viewValue(forecast.likely, input.valuePerThousand),
    breakEven: breakEvenViews(input.dubCost),
  };
}
