/**
 * The decision loop - what makes Parrot an agent rather than a dubbing button.
 *
 * For each job, every active agent independently:
 *   1. checks its budget rules (floor, per-job exposure, daily cap),
 *   2. predicts international views for the target language,
 *   3. computes EV = p_success * (views * r) - dub_cost, and
 *   4. bids if EV clears its own minimum margin.
 *
 * The first agent to approve claims the job via an atomic compare-and-set, so
 * the personas visibly compete and the leaderboard has real content. Agents
 * evaluate in a deliberately shuffled order so the same persona does not win
 * every race purely by being first in the list.
 *
 * `p_success` is each agent's OWN realised QC pass rate, so an agent that keeps
 * shipping bad dubs becomes correctly pessimistic about itself.
 */

import {
  checkBudget,
  computeEv,
  predictViews,
  engagementScore,
  formatUsd,
  formatPpmPercent,
  languageName,
  clampPpm,
  ppm,
  micros,
  COLD_START_P_SUCCESS,
  DEFAULT_SPLIT_AGENT_BPS,
  ELEVENLABS_PRICE_PER_MINUTE,
  DUBBING_TIER,
  UNLOCK_PRICE,
  type Decision,
  type Micros,
  type Ppm,
  type DeclineReason,
  type Scenario,
} from '@parrot/shared';
import { getConfig } from '../config.js';
import type { Store } from '../store/store.js';
import type { Agent, Job } from '../store/types.js';

/**
 * Which end of the predicted range an agent plans on. `optimismPpm` is the
 * persona's dial: below 1.0 plans on the low case, above 1.0 on the high case,
 * exactly 1.0 on the likely case.
 */
export function scenarioFor(agent: Pick<Agent, 'optimismPpm'>): Scenario {
  if (agent.optimismPpm < 1_000_000) return 'low';
  if (agent.optimismPpm > 1_000_000) return 'high';
  return 'likely';
}

const viewers = (v: number) => `${v.toLocaleString()} ${v === 1 ? 'viewer' : 'viewers'}`;

const SCENARIO_SENTENCE: Record<Scenario, (views: number) => string> = {
  low: (v) => `I plan on the cautious end: ${viewers(v)}.`,
  likely: (v) => `I plan on the likely case: ${viewers(v)}.`,
  high: (v) => `I plan on the optimistic end: ${viewers(v)}.`,
};

/**
 * Learning rate for an agent's forecast calibration. Each resolved job moves
 * the correction 30% of the way (in log space) toward what that job showed.
 */
export const CALIBRATION_ALPHA = 0.3;

/**
 * Fold one resolved job into an agent's calibration. Log-space smoothing, so
 * a 2x over-forecast and a 2x under-forecast pull equally hard, and clamped
 * so a single freak outcome cannot zero an agent out.
 */
export function updateCalibration(currentPpm: number, plannedViews: number, actualViews: number): number {
  if (plannedViews <= 0) return currentPpm;
  const observed = Math.max(actualViews, 1) / plannedViews;
  const next = (currentPpm / 1_000_000) * observed ** CALIBRATION_ALPHA;
  return Math.round(Math.min(3, Math.max(0.1, next)) * 1_000_000);
}

function calibrationSentence(calibration: number, adjusted: number): string {
  if (Math.abs(calibration - 1) < 0.05) return '';
  const dir = calibration < 1 ? 'high' : 'low';
  const pct = Math.round(Math.abs(1 / calibration - 1) * 100);
  return ` My past forecasts ran about ${pct}% ${dir}, so I correct that to ${viewers(adjusted)}.`;
}

/** What a dub of this length costs at our chosen ElevenLabs tier. */
export function estimateDubCost(durationS: number): Micros {
  const perMinute = ELEVENLABS_PRICE_PER_MINUTE[DUBBING_TIER] as bigint;
  // Round up to the nearest micro: never under-state a cost we must pay.
  const cost = (BigInt(Math.ceil(durationS * 1_000)) * perMinute + 59_999n) / 60_000n;
  return micros(cost);
}

export interface Bid {
  readonly agent: Agent;
  readonly decision: Decision;
  readonly approved: boolean;
}

export interface DecisionOutcome {
  /** The agent that claimed the job, if any. */
  readonly winner: Agent | null;
  readonly winningDecision: Decision | null;
  /** Every agent's reasoning, including the losers. */
  readonly bids: readonly Bid[];
  /** Why the job was declined, when nobody took it. */
  readonly declineReason: DeclineReason | null;
  /** The sealed-bid auction, when at least one agent bid. */
  readonly auction: AuctionResult | null;
}

export interface AuctionResult {
  /** The agent share the winner is paid: the runner-up's bid, or the reserve. */
  readonly clearingBps: number;
  readonly reserveBps: number;
  /** Every sealed bid, lowest (winning) first. */
  readonly bids: readonly { agentName: string; bidBps: number }[];
}

const pctBps = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

export class DecisionService {
  constructor(private readonly store: Store) {}

  /**
   * An agent's realised probability of getting from "approved" to "published".
   * Falls back to the cold-start prior until it has a track record.
   */
  pSuccessFor(agent: Agent): Ppm {
    const jobs = this.store.jobsForAgent(agent.id);
    const finished = jobs.filter((j) =>
      ['PUBLISHED', 'EARNING', 'SETTLED', 'REJECTED_BY_QC', 'FAILED'].includes(j.state),
    );
    if (finished.length < 3) return COLD_START_P_SUCCESS;

    const published = finished.filter((j) =>
      ['PUBLISHED', 'EARNING', 'SETTLED'].includes(j.state),
    ).length;
    return clampPpm(Math.round((published / finished.length) * 1_000_000));
  }

  /** One agent's evaluation of one job. Pure apart from reading the store. */
  evaluate(agent: Agent, job: Job): Bid {
    const signals = job.signals ?? {
      likes: 0,
      replies: 0,
      reposts: 0,
      quotes: 0,
      sourceViews: 0,
      authorFollowers: 0,
      ageHours: 0,
    };

    const dubCost = estimateDubCost(job.durationS);
    const balance = this.store.balanceOf(agent.accountId);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const spentToday = this.store.spentSince(agent.accountId, startOfDay);

    const bucket = this.store.getBucket(job.category, job.targetLang);
    const prediction = predictViews(signals, job.targetLang, bucket);

    // Every agent sees the same low / likely / high range; its persona decides
    // which end it plans on. This is how the bold agent takes bets the cautious
    // one passes on, without either of them using a different formula.
    const scenario = scenarioFor(agent);
    const plannedViews = prediction.range[scenario];
    // Scaled by this agent's own track record (see updateCalibration).
    const calibration = (agent.calibrationPpm ?? 1_000_000) / 1_000_000;
    const predictedViews = Math.round(plannedViews * calibration);

    const pSuccessPpm = this.pSuccessFor(agent);
    const ev = computeEv({
      predictedViews,
      conversionPpm: prediction.conversionPpm,
      unlockPrice: UNLOCK_PRICE,
      agentBps: job.splitAgentBps,
      pSuccessPpm,
      dubCost,
    });

    const mkDecision = (
      approved: boolean,
      declineReason: DeclineReason | null,
      rationale: string,
    ): Decision => ({
      agentId: agent.id,
      agentName: agent.name,
      decision: approved ? 'APPROVE' : 'DECLINE',
      declineReason,
      inputs: {
        predictedViews,
        conversionPpm: prediction.conversionPpm,
        pSuccessPpm,
        unlockPriceMicros: (UNLOCK_PRICE as bigint).toString(),
        agentBps: job.splitAgentBps,
        dubCostMicros: (dubCost as bigint).toString(),
        balanceMicros: (balance as bigint).toString(),
        floorMicros: (agent.floor as bigint).toString(),
        minMarginMicros: (agent.minMargin as bigint).toString(),
      },
      result: {
        rPerViewMicros: (ev.rPerView as bigint).toString(),
        expectedRevenueMicros: (ev.expectedRevenue as bigint).toString(),
        evMicros: (ev.ev as bigint).toString(),
        confidencePpm: prediction.confidencePpm,
        basis: prediction.basis,
      },
      rationale,
      decidedAt: new Date(),
    });

    // A specialist only bids on its language.
    if (agent.languageFocus && agent.languageFocus !== job.targetLang) {
      return {
        agent,
        approved: false,
        decision: mkDecision(
          false,
          'UNSUPPORTED_LANGUAGE',
          `I only take ${languageName(agent.languageFocus)} work, so I am leaving this one to the others.`,
        ),
      };
    }

    const budget = checkBudget({
      balance,
      dubCost,
      floor: agent.floor,
      maxExposurePerJob: agent.maxExposurePerJob,
      spentToday,
      dailyCap: agent.dailyCap,
    });

    if (!budget.ok) {
      const explanation: Record<typeof budget.reason, string> = {
        BUDGET_FLOOR: `Dubbing this would cost ${formatUsd(dubCost)} and leave me under my ${formatUsd(agent.floor)} reserve, so I am sitting this one out.`,
        MAX_EXPOSURE: `At ${formatUsd(dubCost)} this is more than the ${formatUsd(agent.maxExposurePerJob)} I will risk on any single video.`,
        DAILY_CAP: `I have already spent ${formatUsd(spentToday)} today and I cap myself at ${formatUsd(agent.dailyCap)}.`,
      };
      return {
        agent,
        approved: false,
        decision: mkDecision(false, budget.reason, explanation[budget.reason]),
      };
    }

    // FORCE_DUB skips ONLY this margin test. The budget checks above have
    // already run and still bind.
    const forced = getConfig().env.FORCE_DUB;
    const clears = forced || (ev.ev as bigint) > (agent.minMargin as bigint);
    const lang = languageName(job.targetLang);

    const mathSentence =
      `${prediction.rationale} ${SCENARIO_SENTENCE[scenario](plannedViews)}${calibrationSentence(calibration, predictedViews)} At a ${formatPpmPercent(prediction.conversionPpm)} unlock rate that is ` +
      `${Math.round(ev.expectedUnlocks).toLocaleString()} unlocks, worth ${formatUsd(ev.expectedRevenue)} to me ` +
      `after allowing for a ${formatPpmPercent(pSuccessPpm)} chance the dub comes out well. ` +
      `It costs ${formatUsd(dubCost)} to make.`;

    if (!clears) {
      return {
        agent,
        approved: false,
        decision: mkDecision(
          false,
          'LOW_EV',
          `${mathSentence} That is an expected ${formatUsd(ev.ev, { sign: true })}, which does not clear my ${formatUsd(agent.minMargin)} margin. Passing.`,
        ),
      };
    }

    return {
      agent,
      approved: true,
      decision: mkDecision(
        true,
        null,
        forced && (ev.ev as bigint) <= (agent.minMargin as bigint)
          ? `${mathSentence} That is an expected ${formatUsd(ev.ev, { sign: true })}, below my ${formatUsd(agent.minMargin)} margin, but the override is on. Dubbing it into ${lang} anyway.`
          : `${mathSentence} Expected profit ${formatUsd(ev.ev, { sign: true })}. Dubbing it into ${lang}.`,
      ),
    };
  }

  /**
   * Run the auction. Every agent reasons about the job; the first approver to
   * win the atomic claim gets it.
   */
  runAuction(job: Job, externalBids: ReadonlyMap<string, number | null> = new Map()): DecisionOutcome {
    // Shuffled so ties between equal bids do not always go to the same persona.
    const agents = shuffle(this.store.activeAgents());
    const bids: Bid[] = agents.map((agent) => {
      const bid = this.evaluate(agent, job);
      return agent.bidUrl ? this.withExternalBid(bid, externalBids.get(agent.id) ?? null) : bid;
    });

    // SEALED-BID REVERSE AUCTION (second-price) on the agent's revenue share.
    // Each approving agent bids the smallest share it needs to clear its own
    // margin. The lowest bid wins and is paid the SECOND-lowest bid (or the
    // reserve, job.splitAgentBps, if it bid alone). Under second-price rules
    // bidding your true minimum is the best strategy, and competition hands
    // the surplus to the creator instead of to whichever agent ran first.
    const reserveBps = job.splitAgentBps;
    const priced = bids
      .filter((b) => b.approved)
      .map((b) => ({
        bid: b,
        bidBps: externalBids.get(b.agent.id) ?? this.requiredBps(b.decision, reserveBps),
      }))
      .sort((a, b) => a.bidBps - b.bidBps);

    const best = priced[0];
    if (best && this.store.claimJob(job.id, best.bid.agent.id)) {
      const clearingBps = Math.min(priced[1]?.bidBps ?? reserveBps, reserveBps);
      this.store.updateJob(job.id, {
        splitAgentBps: clearingBps,
        splitCreatorBps: 10_000 - clearingBps,
      });
      const auction: AuctionResult = {
        clearingBps,
        reserveBps,
        bids: priced.map((p) => ({ agentName: p.bid.agent.name, bidBps: p.bidBps })),
      };
      const others = priced.length - 1;
      const winningDecision: Decision = {
        ...best.bid.decision,
        inputs: { ...best.bid.decision.inputs, agentBps: clearingBps },
        rationale:
          `${best.bid.decision.rationale} Auction: I bid a ${pctBps(best.bidBps)} share` +
          (others > 0
            ? ` and beat ${others} other bid${others === 1 ? '' : 's'}; I am paid the runner-up's ${pctBps(clearingBps)}, so the creator keeps ${pctBps(10_000 - clearingBps)}.`
            : `, the only bid, so I take the ${pctBps(reserveBps)} reserve.`),
      };
      return { winner: best.bid.agent, winningDecision, bids, declineReason: null, auction };
    }

    // Nobody took it. Report the most informative reason rather than whichever
    // agent happened to be last: a budget problem is ours, low EV is the
    // creator's, and the creator's version is the more useful reply.
    const reasons = bids
      .map((b) => b.decision.declineReason)
      .filter((r): r is DeclineReason => r !== null);
    const declineReason =
      reasons.find((r) => r === 'LOW_EV') ??
      reasons.find((r) => r !== 'UNSUPPORTED_LANGUAGE') ??
      reasons[0] ??
      'LOW_EV';

    return { winner: null, winningDecision: null, bids, declineReason, auction: null };
  }

  /**
   * A third-party agent bids from its own endpoint. Its language focus and
   * budget rules were already checked by evaluate() and still bind; past those,
   * whether it bids is its own call, not our formula's.
   */
  private withExternalBid(bid: Bid, externalBps: number | null): Bid {
    const gated = bid.decision.declineReason !== null && bid.decision.declineReason !== 'LOW_EV';
    if (gated) return bid;
    const approved = externalBps !== null;
    return {
      ...bid,
      approved,
      decision: {
        ...bid.decision,
        decision: approved ? 'APPROVE' : 'DECLINE',
        declineReason: approved ? null : 'LOW_EV',
        rationale: approved
          ? `My own model bid a ${pctBps(externalBps)} share.`
          : 'My own model passed on this one (or did not answer in time).',
      },
    };
  }

  /**
   * The smallest agent share (bps) at which this decision's EV clears the
   * agent's margin. EV is linear in the share, so this is exact. Capped at the
   * reserve: an agent never bids above what the job offers. A forced bid
   * (FORCE_DUB) that cannot clear its margin bids the reserve.
   */
  requiredBps(decision: Decision, reserveBps: number): number {
    const { predictedViews, conversionPpm, pSuccessPpm, unlockPriceMicros, dubCostMicros, minMarginMicros } =
      decision.inputs;
    const perBps =
      BigInt(predictedViews) * BigInt(unlockPriceMicros) * BigInt(conversionPpm) * BigInt(pSuccessPpm);
    if (perBps === 0n) return reserveBps;
    // EV(bps) = perBps * bps / (1e4 * 1e12) - cost  >  margin
    const need = (BigInt(dubCostMicros) + BigInt(minMarginMicros)) * 10_000n * 1_000_000_000_000n;
    const bps = Number(need / perBps) + 1;
    return Math.max(1, Math.min(bps, reserveBps));
  }

  /** Snapshot of the engagement signals used for a decision. */
  static signalsFrom(input: {
    likes: number;
    replies: number;
    reposts: number;
    quotes?: number;
    views?: number | null;
    authorFollowers: number;
    createdAt: Date;
  }) {
    const ageHours = Math.max(0, (Date.now() - input.createdAt.getTime()) / 3_600_000);
    return {
      likes: input.likes,
      replies: input.replies,
      reposts: input.reposts,
      quotes: input.quotes ?? 0,
      sourceViews: input.views ?? 0,
      authorFollowers: input.authorFollowers,
      ageHours,
    };
  }
}

/** Fisher-Yates. Keeps one persona from winning every race by list position. */
function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/** The three competing personas, seeded at boot. */
export const AGENT_PERSONAS = [
  {
    name: 'Magpie',
    persona: 'Balanced. Takes most reasonable bets and keeps a modest reserve.',
    floorUsd: '1.00',
    minMarginUsd: '0.10',
    maxExposureUsd: '2.00',
    dailyCapUsd: '10.00',
    languageFocus: null,
    optimismPpm: 1_000_000,
  },
  {
    name: 'Kestrel',
    persona: 'Cautious. Demands a wide margin and protects its balance first.',
    floorUsd: '4.00',
    minMarginUsd: '0.60',
    maxExposureUsd: '1.00',
    dailyCapUsd: '6.00',
    languageFocus: null,
    optimismPpm: 800_000,
  },
  {
    name: 'Finch',
    persona: 'Spanish specialist. Bets aggressively, but only on Spanish.',
    floorUsd: '0.50',
    minMarginUsd: '0.02',
    maxExposureUsd: '3.00',
    dailyCapUsd: '12.00',
    languageFocus: 'es',
    optimismPpm: 1_350_000,
  },
] as const;

export { ppm };
