/**
 * Probabilities and rates as integer parts-per-million (ppm).
 *
 * The EV model multiplies several probabilities by a money amount. Doing that
 * in floating point would put floats on a path that decides how much the agent
 * spends, so rates are integers here and the EV arithmetic stays in bigint.
 *   1_000_000 ppm = 100%   125_000 ppm = 12.5%   700_000 ppm = 70%
 */

declare const ppmBrand: unique symbol;
export type Ppm = number & { readonly [ppmBrand]?: 'Ppm' };

export const PPM_ONE = 1_000_000;
export const PPM_ONE_BIG = 1_000_000n;

export function ppm(value: number): Ppm {
  if (!Number.isInteger(value)) throw new RangeError(`ppm must be an integer: ${value}`);
  if (value < 0) throw new RangeError(`ppm must not be negative: ${value}`);
  return value as Ppm;
}

/** 0.125 -> 125000 ppm. Rounds half away from zero. */
export function rateToPpm(rate: number): Ppm {
  if (!Number.isFinite(rate)) throw new RangeError(`rate must be finite: ${rate}`);
  if (rate < 0) throw new RangeError(`rate must not be negative: ${rate}`);
  return ppm(Math.round(rate * PPM_ONE));
}

/** 125000 ppm -> 0.125. For display and charts only, never for money. */
export function ppmToRate(value: Ppm): number {
  return value / PPM_ONE;
}

/** 125000 ppm -> "12.5%" */
export function formatPpmPercent(value: Ppm, maxDecimals = 1): string {
  const pct = (value / PPM_ONE) * 100;
  const rounded = Number(pct.toFixed(maxDecimals));
  return `${rounded}%`;
}

export function clampPpm(value: number, min = 0, max = PPM_ONE): Ppm {
  return ppm(Math.min(max, Math.max(min, Math.round(value))));
}

/**
 * Exponential smoothing on a ppm value: next = (1-alpha)*current + alpha*observed.
 * Integer-exact, used by the learning loop to update bucket conversion rates.
 */
export function smoothPpm(current: Ppm, observed: Ppm, alphaPpm: Ppm): Ppm {
  const keep = BigInt(PPM_ONE - alphaPpm) * BigInt(current);
  const take = BigInt(alphaPpm) * BigInt(observed);
  return ppm(Number((keep + take) / PPM_ONE_BIG));
}

/** Exponential smoothing on a plain non-negative quantity (e.g. average views). */
export function smoothCount(current: number, observed: number, alphaPpm: Ppm): number {
  const alpha = alphaPpm / PPM_ONE;
  return (1 - alpha) * current + alpha * observed;
}
