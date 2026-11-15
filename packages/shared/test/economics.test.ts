/**
 * The economics consistency tests.
 *
 * The brief's worked example is encoded here as an executable test, and the
 * `r` identity is enforced so nobody can hardcode a revenue-per-view that does
 * not follow from the price, the split and the conversion rate.
 */

import { describe, it, expect } from 'vitest';
import {
  computeEv,
  deriveRPerView,
  agentTakePerUnlock,
  checkBudget,
  roiPpm,
} from '../src/ev.js';
import { splitRevenue, agentShareOf, assertValidSplit } from '../src/split.js';
import { parseUsd, formatUsd, micros } from '../src/units.js';
import { ppm, PPM_ONE } from '../src/ppm.js';
import {
  UNLOCK_PRICE,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
  COLD_START_CONVERSION,
  COLD_START_P_SUCCESS,
} from '../src/constants.js';

describe('r is derived, never hardcoded', () => {
  it('r = conversion * price * agent_share', () => {
    // $0.02 unlock, 40% agent share -> agent takes $0.008 per unlock.
    expect(agentTakePerUnlock(UNLOCK_PRICE, DEFAULT_SPLIT_AGENT_BPS)).toBe(parseUsd('0.008'));

    // At 12.5% view-to-unlock conversion that is $0.001 per international view,
    // which is exactly the r the brief's worked example uses.
    const r = deriveRPerView(UNLOCK_PRICE, DEFAULT_SPLIT_AGENT_BPS, COLD_START_CONVERSION);
    expect(r).toBe(parseUsd('0.001'));
    expect(formatUsd(r, { maxDecimals: 3 })).toBe('$0.001');
  });

  it('the cold-start conversion is the rate implied by r = $0.001', () => {
    // Solving r = conv * price * share for conv must give back 12.5%.
    const agentTake = agentTakePerUnlock(UNLOCK_PRICE, DEFAULT_SPLIT_AGENT_BPS);
    const impliedConversionPpm = Number((parseUsd('0.001') * BigInt(PPM_ONE)) / agentTake);
    expect(impliedConversionPpm).toBe(125_000);
    expect(COLD_START_CONVERSION).toBe(impliedConversionPpm);
  });

  it('r tracks a change in price', () => {
    const doubled = deriveRPerView(parseUsd('0.04'), DEFAULT_SPLIT_AGENT_BPS, COLD_START_CONVERSION);
    expect(doubled).toBe(parseUsd('0.002'));
  });

  it('r tracks a change in the split', () => {
    // 80% to the agent doubles r.
    const r = deriveRPerView(UNLOCK_PRICE, 8_000, COLD_START_CONVERSION);
    expect(r).toBe(parseUsd('0.002'));
  });

  it('r tracks a change in the learned conversion rate', () => {
    const r = deriveRPerView(UNLOCK_PRICE, DEFAULT_SPLIT_AGENT_BPS, ppm(250_000));
    expect(r).toBe(parseUsd('0.002'));
  });

  it('r is zero when nobody converts', () => {
    expect(deriveRPerView(UNLOCK_PRICE, DEFAULT_SPLIT_AGENT_BPS, ppm(0))).toBe(0n);
  });
});

describe("the brief's worked example", () => {
  // [4] DECISION LOOP:
  //   budget check -> wallet $12.00 > floor $1.00                        OK
  //   predict intl views -> 2,000
  //   EV = 0.7 * (2000 * $0.001) - $0.40 = +$1.00                        DUB IT
  const scenario = {
    predictedViews: 2_000,
    conversionPpm: COLD_START_CONVERSION, // 12.5%
    unlockPrice: UNLOCK_PRICE, // $0.02
    agentBps: DEFAULT_SPLIT_AGENT_BPS, // 40%
    pSuccessPpm: COLD_START_P_SUCCESS, // 70%
    dubCost: parseUsd('0.40'),
  };

  it('passes the budget check with $12.00 against a $1.00 floor', () => {
    expect(
      checkBudget({
        balance: parseUsd('12.00'),
        dubCost: scenario.dubCost,
        floor: parseUsd('1.00'),
        maxExposurePerJob: parseUsd('2.00'),
        spentToday: parseUsd('0'),
        dailyCap: parseUsd('10.00'),
      }),
    ).toEqual({ ok: true });
  });

  it('computes EV = +$1.00 exactly', () => {
    const result = computeEv(scenario);

    expect(result.rPerView).toBe(parseUsd('0.001'));
    expect(result.agentTakePerUnlock).toBe(parseUsd('0.008'));
    expect(result.expectedUnlocks).toBe(250); // 2000 * 12.5%

    // 2,000 views * $0.001 = $2.00 gross
    expect(result.grossRevenue).toBe(parseUsd('2.00'));
    // 70% chance of getting there = $1.40
    expect(result.expectedRevenue).toBe(parseUsd('1.40'));
    // minus the $0.40 cost = +$1.00
    expect(result.ev).toBe(parseUsd('1.00'));
    expect(formatUsd(result.ev)).toBe('$1.00');
  });

  it('splits each $0.02 unlock into $0.008 agent / $0.012 creator', () => {
    const split = splitRevenue(UNLOCK_PRICE, {
      agentBps: DEFAULT_SPLIT_AGENT_BPS,
      creatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    });
    expect(split.agent).toBe(parseUsd('0.008'));
    expect(split.creator).toBe(parseUsd('0.012'));
  });

  it('decides to dub, because EV clears the minimum margin', () => {
    const { ev } = computeEv(scenario);
    expect(ev > parseUsd('0.10')).toBe(true);
  });
});

describe('computeEv', () => {
  const base = {
    predictedViews: 2_000,
    conversionPpm: COLD_START_CONVERSION,
    unlockPrice: UNLOCK_PRICE,
    agentBps: DEFAULT_SPLIT_AGENT_BPS,
    pSuccessPpm: COLD_START_P_SUCCESS,
    dubCost: parseUsd('0.40'),
  };

  it('goes negative when the audience is too small to cover the cost', () => {
    const result = computeEv({ ...base, predictedViews: 100 });
    // 100 * $0.001 * 0.7 = $0.07 against a $0.40 cost
    expect(result.ev).toBe(parseUsd('-0.33'));
    expect(result.ev < 0n).toBe(true);
  });

  it('goes negative when the dub is expensive (v2 pricing on a long clip)', () => {
    const result = computeEv({ ...base, dubCost: parseUsd('2.20') });
    expect(result.ev).toBe(parseUsd('-0.80'));
  });

  it('scales linearly with predicted views', () => {
    const single = computeEv({ ...base, predictedViews: 1_000 });
    const double = computeEv({ ...base, predictedViews: 2_000 });
    expect(double.expectedRevenue).toBe(single.expectedRevenue * 2n);
  });

  it('is zero revenue when p_success is zero', () => {
    const result = computeEv({ ...base, pSuccessPpm: ppm(0) });
    expect(result.expectedRevenue).toBe(0n);
    expect(result.ev).toBe(-base.dubCost);
  });

  it('does not compound rounding between the two probability multiplications', () => {
    // An awkward combination that would drift if gross were rounded first.
    const result = computeEv({
      ...base,
      predictedViews: 7,
      conversionPpm: ppm(333_333),
      pSuccessPpm: ppm(666_667),
    });
    // Exact: 7 * 20000 * 4000 * 333333 * 666667 / (10000 * 1e6 * 1e6) = 12444.4...
    // Rounding gross first would give 18667 * 0.666667 = 12444.7 -> 12445.
    expect(result.expectedRevenue).toBe(12_444n);
  });

  it('rejects nonsense inputs rather than making a bet on them', () => {
    expect(() => computeEv({ ...base, predictedViews: -1 })).toThrow();
    expect(() => computeEv({ ...base, predictedViews: 1.5 })).toThrow();
    expect(() => computeEv({ ...base, agentBps: 10_001 })).toThrow();
    expect(() => computeEv({ ...base, dubCost: micros(-1n) })).toThrow();
  });
});

describe('split math: no lost cents', () => {
  it('always conserves the total, for every split and every amount', () => {
    for (let agentBps = 0; agentBps <= 10_000; agentBps += 137) {
      for (const amount of ['0.000001', '0.000003', '0.02', '0.07', '1.00', '123.45']) {
        const total = parseUsd(amount);
        const { agent, creator } = splitRevenue(total, {
          agentBps,
          creatorBps: 10_000 - agentBps,
        });
        expect(agent + creator, `${amount} @ ${agentBps}bps`).toBe(total);
        expect(agent >= 0n && creator >= 0n).toBe(true);
      }
    }
  });

  it('gives the rounding dust to the creator, never to the agent', () => {
    // 1 micro at a 40/60 split: agent floors to 0, creator gets the micro.
    const { agent, creator } = splitRevenue(micros(1n), {
      agentBps: DEFAULT_SPLIT_AGENT_BPS,
      creatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    });
    expect(agent).toBe(0n);
    expect(creator).toBe(1n);
  });

  it('accumulates 1,000 unlocks with no drift', () => {
    let agentTotal = 0n;
    let creatorTotal = 0n;
    for (let i = 0; i < 1_000; i++) {
      const { agent, creator } = splitRevenue(UNLOCK_PRICE, {
        agentBps: DEFAULT_SPLIT_AGENT_BPS,
        creatorBps: DEFAULT_SPLIT_CREATOR_BPS,
      });
      agentTotal += agent;
      creatorTotal += creator;
    }
    expect(agentTotal).toBe(parseUsd('8.00'));
    expect(creatorTotal).toBe(parseUsd('12.00'));
    expect(agentTotal + creatorTotal).toBe(parseUsd('20.00'));
  });

  it('rejects splits that do not sum to 10,000 bps', () => {
    expect(() => assertValidSplit({ agentBps: 4_000, creatorBps: 5_000 })).toThrow(/10000 bps/);
    expect(() => assertValidSplit({ agentBps: -1, creatorBps: 10_001 })).toThrow();
  });

  it('refuses to split a negative amount', () => {
    expect(() =>
      splitRevenue(micros(-1n), { agentBps: 4_000, creatorBps: 6_000 }),
    ).toThrow(/negative/);
  });

  it('agentShareOf matches splitRevenue', () => {
    expect(agentShareOf(UNLOCK_PRICE, DEFAULT_SPLIT_AGENT_BPS)).toBe(parseUsd('0.008'));
  });
});

describe('budget rules', () => {
  const base = {
    balance: parseUsd('12.00'),
    dubCost: parseUsd('0.40'),
    floor: parseUsd('1.00'),
    maxExposurePerJob: parseUsd('2.00'),
    spentToday: parseUsd('0'),
    dailyCap: parseUsd('10.00'),
  };

  it('declines when the bet would breach the floor', () => {
    expect(checkBudget({ ...base, balance: parseUsd('1.30') })).toEqual({
      ok: false,
      reason: 'BUDGET_FLOOR',
    });
  });

  it('allows a bet that lands exactly on the floor', () => {
    expect(checkBudget({ ...base, balance: parseUsd('1.40') })).toEqual({ ok: true });
  });

  it('declines a single dub that exceeds per-job exposure', () => {
    expect(checkBudget({ ...base, dubCost: parseUsd('2.50') })).toEqual({
      ok: false,
      reason: 'MAX_EXPOSURE',
    });
  });

  it('declines once the daily cap is reached', () => {
    expect(checkBudget({ ...base, spentToday: parseUsd('9.80') })).toEqual({
      ok: false,
      reason: 'DAILY_CAP',
    });
  });

  it('checks exposure and the daily cap before the floor', () => {
    // A broke agent asked for an oversized job hears about the size first.
    expect(
      checkBudget({ ...base, balance: parseUsd('0.10'), dubCost: parseUsd('5.00') }),
    ).toEqual({ ok: false, reason: 'MAX_EXPOSURE' });
  });
});

describe('roi', () => {
  it('reports profit as a fraction of cost', () => {
    expect(roiPpm(parseUsd('1.40'), parseUsd('0.40'))).toBe(2_500_000); // +250%
    expect(roiPpm(parseUsd('0.40'), parseUsd('0.40'))).toBe(0);
    expect(roiPpm(parseUsd('0.20'), parseUsd('0.40'))).toBe(-500_000); // -50%
  });

  it('is undefined rather than infinite when nothing was spent', () => {
    expect(roiPpm(parseUsd('1.00'), parseUsd('0'))).toBeNull();
  });
});
