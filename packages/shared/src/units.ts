/**
 * THE ONE PLACE WHERE MONEY UNITS ARE CONVERTED.
 *
 * Arc has a trap: USDC is both the gas token and an ERC-20.
 *   - As the NATIVE gas token it has 18 decimals (like ether's wei).
 *   - On the ERC-20 interface at the USDC precompile it has 6 decimals.
 * Mixing them is a 10^12 error. Every conversion in Parrot goes through this
 * file, and every function here is unit-tested in test/units.test.ts.
 *
 * Internal accounting unit: `Micros` — integer micro-dollars (1e-6 USD).
 * This is deliberately identical to USDC's 6-decimal ERC-20 base unit, so
 * ledger math and on-chain transfer amounts are the same integer with no
 * conversion at all. Money is ALWAYS bigint. Never float, never Number.
 */

declare const microsBrand: unique symbol;
/** Integer micro-dollars (1e-6 USD). Identical to a USDC ERC-20 base unit. */
export type Micros = bigint & { readonly [microsBrand]?: 'Micros' };

declare const nativeWeiBrand: unique symbol;
/** Integer 18-decimal native Arc USDC (gas) base units. */
export type NativeWei = bigint & { readonly [nativeWeiBrand]?: 'NativeWei' };

/** USDC ERC-20 decimals on Arc. */
export const USDC_ERC20_DECIMALS = 6 as const;
/** Native (gas) USDC decimals on Arc. */
export const USDC_NATIVE_DECIMALS = 18 as const;

export const MICROS_PER_USD = 1_000_000n;
/** 10^(18-6) — the factor between native gas units and ERC-20 base units. */
export const NATIVE_PER_MICRO = 1_000_000_000_000n;

export function micros(value: bigint): Micros {
  return value as Micros;
}

export function nativeWei(value: bigint): NativeWei {
  return value as NativeWei;
}

/** USDC ERC-20 base units are micros, by construction. Named for call-site clarity. */
export function erc20UnitsToMicros(units: bigint): Micros {
  return units as Micros;
}

/** Micros are USDC ERC-20 base units, by construction. Use when building a transfer. */
export function microsToErc20Units(amount: Micros): bigint {
  return amount as bigint;
}

/** Native 18-decimal gas units -> micros. Truncates sub-micro dust (gas is finer-grained). */
export function nativeWeiToMicros(wei: NativeWei): Micros {
  return ((wei as bigint) / NATIVE_PER_MICRO) as Micros;
}

/** Micros -> native 18-decimal gas units. Exact. */
export function microsToNativeWei(amount: Micros): NativeWei {
  return ((amount as bigint) * NATIVE_PER_MICRO) as NativeWei;
}

/**
 * Parse a human dollar string ("0.02", "12", "1.234567") into micros.
 * Rejects anything that is not a plain decimal number, and rejects more than
 * 6 decimal places rather than silently rounding money away.
 */
export function parseUsd(input: string): Micros {
  const trimmed = input.trim().replace(/^\$/, '');
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) throw new RangeError(`not a dollar amount: ${JSON.stringify(input)}`);
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fracRaw = match[3] ?? '';
  if (fracRaw.length > USDC_ERC20_DECIMALS) {
    throw new RangeError(
      `${input} has more than ${USDC_ERC20_DECIMALS} decimal places; sub-micro amounts are not representable`,
    );
  }
  const frac = BigInt(fracRaw.padEnd(USDC_ERC20_DECIMALS, '0') || '0');
  return (sign * (whole * MICROS_PER_USD + frac)) as Micros;
}

/** Whole cents -> micros. */
export function centsToMicros(cents: number): Micros {
  if (!Number.isInteger(cents)) throw new RangeError(`cents must be an integer: ${cents}`);
  return (BigInt(cents) * 10_000n) as Micros;
}

/**
 * Format micros as a plain dollar string for display, e.g. "$0.02", "$12.00".
 * `maxDecimals` lets sub-cent agent economics show as "$0.008".
 */
export function formatUsd(
  amount: Micros,
  opts: { maxDecimals?: 2 | 3 | 4 | 5 | 6; sign?: boolean } = {},
): string {
  const maxDecimals = opts.maxDecimals ?? 2;
  const raw = amount as bigint;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;

  const whole = abs / MICROS_PER_USD;
  const frac = abs % MICROS_PER_USD;
  let fracStr = frac.toString().padStart(USDC_ERC20_DECIMALS, '0').slice(0, maxDecimals);
  // keep at least 2 decimals, trim trailing zeros beyond that
  while (fracStr.length > 2 && fracStr.endsWith('0')) fracStr = fracStr.slice(0, -1);

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `$${groupedWhole}.${fracStr}`;
  if (negative) return `-${body}`;
  if (opts.sign && raw > 0n) return `+${body}`;
  return body;
}

export function absMicros(amount: Micros): Micros {
  return ((amount as bigint) < 0n ? -(amount as bigint) : (amount as bigint)) as Micros;
}

export function sumMicros(amounts: readonly Micros[]): Micros {
  let total = 0n;
  for (const a of amounts) total += a as bigint;
  return total as Micros;
}
