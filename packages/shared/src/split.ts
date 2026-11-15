/**
 * Revenue split math. Basis points, integer-exact, no lost cents.
 *
 * Rule: the agent's share is floored; the creator receives the remainder.
 * That guarantees agent + creator === total for every input, so the ledger
 * can never leak or mint a micro-dollar on a split. The creator absorbing the
 * rounding dust is deliberate (it favours the human, and it is at most 1e-6 USD).
 */

import { micros, type Micros } from './units.js';

export const BPS_DENOMINATOR = 10_000n;

export interface SplitBps {
  readonly agentBps: number;
  readonly creatorBps: number;
}

export interface SplitResult {
  readonly agent: Micros;
  readonly creator: Micros;
}

export function assertValidSplit(split: SplitBps): void {
  const { agentBps, creatorBps } = split;
  for (const [name, value] of [
    ['agentBps', agentBps],
    ['creatorBps', creatorBps],
  ] as const) {
    if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer: ${value}`);
    if (value < 0) throw new RangeError(`${name} must not be negative: ${value}`);
  }
  if (agentBps + creatorBps !== Number(BPS_DENOMINATOR)) {
    throw new RangeError(
      `split must sum to ${BPS_DENOMINATOR} bps, got ${agentBps} + ${creatorBps} = ${agentBps + creatorBps}`,
    );
  }
}

/** Split an amount by basis points. Total is always conserved exactly. */
export function splitRevenue(total: Micros, split: SplitBps): SplitResult {
  assertValidSplit(split);
  if ((total as bigint) < 0n) throw new RangeError(`cannot split a negative amount: ${total}`);
  const agent = ((total as bigint) * BigInt(split.agentBps)) / BPS_DENOMINATOR;
  const creator = (total as bigint) - agent;
  return { agent: micros(agent), creator: micros(creator) };
}

/** The agent's take from a single unlock, used by the EV model's `r`. */
export function agentShareOf(amount: Micros, agentBps: number): Micros {
  return splitRevenue(amount, {
    agentBps,
    creatorBps: Number(BPS_DENOMINATOR) - agentBps,
  }).agent;
}
