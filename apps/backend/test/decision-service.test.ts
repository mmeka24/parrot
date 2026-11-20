import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseUsd,
  formatUsd,
  COLD_START_P_SUCCESS,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
  ELEVENLABS_PRICE_PER_MINUTE,
} from '@parrot/shared';
import { Store } from '../src/store/store.js';
import { DecisionService, estimateDubCost, AGENT_PERSONAS } from '../src/services/decision-service.js';
import { resetConfig } from '../src/config.js';
import type { Agent, Job } from '../src/store/types.js';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  resetConfig();
});

function makeStore(): { store: Store; service: DecisionService } {
  const store = new Store();
  return { store, service: new DecisionService(store) };
}

function addAgent(
  store: Store,
  overrides: Partial<Agent> & { name: string },
  fundUsd = '12.00',
): Agent {
  const account = store.createAccount({
    kind: 'agent',
    label: overrides.name,
    email: null,
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  const agent = store.createAgent({
    name: overrides.name,
    persona: overrides.persona ?? 'test',
    accountId: account.id,
    walletAddress: account.walletAddress,
    floor: overrides.floor ?? parseUsd('1.00'),
    minMargin: overrides.minMargin ?? parseUsd('0.10'),
    maxExposurePerJob: overrides.maxExposurePerJob ?? parseUsd('2.00'),
    dailyCap: overrides.dailyCap ?? parseUsd('10.00'),
    languageFocus: overrides.languageFocus ?? null,
    optimismPpm: overrides.optimismPpm ?? 1_000_000,
    active: overrides.active ?? true,
  });
  if (fundUsd !== '0') {
    store.appendLedger({
      accountId: account.id,
      amount: parseUsd(fundUsd),
      kind: 'faucet_funding',
    });
  }
  return agent;
}

/**
 * The worked example: a 30s clip that went viral - 1.2M views. Through the
 * sourced funnel that is ~2,400 likely Spanish viewers, close to the brief's
 * 2,000. (The brief's original 10k-view post only yields ~20, which no 2-cent
 * dub can pay back.)
 */
function workedExampleJob(store: Store, overrides: Partial<Job> = {}): Job {
  const account = store.createAccount({
    kind: 'creator',
    label: '@maria',
    email: null,
    walletAddress: null,
  });
  const creator = store.createCreator({
    xUserId: 'x-1',
    handle: 'maria',
    displayName: 'Maria',
    accountId: account.id,
    followers: 50_000,
    claimed: false,
  });
  return store.createJob({
    creatorId: creator.id,
    sourceUrl: 'https://x.com/maria/status/1',
    sourcePostId: '1',
    requestMentionId: null,
    targetLang: 'es',
    durationS: 30,
    category: 'comedy',
    state: 'EVALUATING',
    claimedByAgentId: null,
    claimedAt: null,
    splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
    splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    dubCost: 0n,
    decision: null,
    qcReport: null,
    providerJobId: null,
    dubUrl: null,
    previewUrl: null,
    posterUrl: null,
    declineReason: null,
    failureReason: null,
    signals: {
      likes: 18_000,
      replies: 640,
      reposts: 2_900,
      quotes: 210,
      sourceViews: 1_200_000,
      authorFollowers: 50_000,
      ageHours: 2,
    },
    viewCount: 0,
    qcDemoFail: false,
    publishedAt: null,
    ...overrides,
  });
}

describe('estimateDubCost', () => {
  it('prices a 60s clip at the tier rate', () => {
    expect(estimateDubCost(60)).toBe(ELEVENLABS_PRICE_PER_MINUTE.v1_clean);
  });

  it('prices a 30s clip at half the minute rate', () => {
    // $0.50/min -> $0.25 for 30 seconds.
    expect(formatUsd(estimateDubCost(30))).toBe('$0.25');
  });

  it('rounds up, so a cost is never understated', () => {
    // 1 second at $0.50/min is $0.008333..., which must not floor to $0.008333.
    const cost = estimateDubCost(1);
    expect(cost).toBeGreaterThanOrEqual(8_333n);
  });

  it('scales linearly with duration', () => {
    expect(estimateDubCost(120)).toBe((ELEVENLABS_PRICE_PER_MINUTE.v1_clean as bigint) * 2n);
  });
});

describe('a single agent evaluating the worked example', () => {
  it('approves it and explains the maths in plain language', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Magpie' });
    const job = workedExampleJob(store);

    const bid = service.evaluate(agent, job);

    expect(bid.approved).toBe(true);
    expect(bid.decision.decision).toBe('APPROVE');
    expect(BigInt(bid.decision.result.evMicros)).toBeGreaterThan(0n);
    // The rationale is for humans: no jargon, no raw units.
    expect(bid.decision.rationale).toMatch(/Spanish/);
    expect(bid.decision.rationale).not.toMatch(/ppm|bps|micros|0x/i);
  });

  it('uses the cold-start p_success before it has a track record', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Magpie' });
    expect(service.pSuccessFor(agent)).toBe(COLD_START_P_SUCCESS);
  });

  it('declines a video nobody engaged with', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Magpie' });
    const job = workedExampleJob(store, {
      signals: {
        likes: 1,
        replies: 0,
        reposts: 0,
        quotes: 0,
        sourceViews: 10,
        authorFollowers: 50,
        ageHours: 72,
      },
    });

    const bid = service.evaluate(agent, job);
    expect(bid.approved).toBe(false);
    expect(bid.decision.declineReason).toBe('LOW_EV');
    expect(bid.decision.rationale).toMatch(/Passing/);
  });

  it('declines when the bet would breach its reserve', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Broke' }, '1.10');
    const job = workedExampleJob(store);

    const bid = service.evaluate(agent, job);
    expect(bid.approved).toBe(false);
    expect(bid.decision.declineReason).toBe('BUDGET_FLOOR');
    expect(bid.decision.rationale).toMatch(/reserve/);
  });

  it('declines a clip too expensive for its per-job limit', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Timid', maxExposurePerJob: parseUsd('0.10') });
    const job = workedExampleJob(store);

    const bid = service.evaluate(agent, job);
    expect(bid.decision.declineReason).toBe('MAX_EXPOSURE');
  });

  it('declines once it has hit its daily cap', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Spent', dailyCap: parseUsd('0.20') });
    store.appendLedger({
      accountId: agent.accountId,
      amount: parseUsd('-0.15'),
      kind: 'dub_cost',
    });
    const job = workedExampleJob(store);

    expect(service.evaluate(agent, job).decision.declineReason).toBe('DAILY_CAP');
  });

  it('becomes pessimistic about itself after repeated QC failures', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Sloppy' });
    for (let i = 0; i < 4; i++) {
      workedExampleJob(store, {
        sourcePostId: `fail-${i}`,
        state: 'REJECTED_BY_QC',
        claimedByAgentId: agent.id,
      });
    }
    // 0 of 4 published: an agent that keeps shipping bad dubs should expect to.
    expect(service.pSuccessFor(agent)).toBe(0);
  });

  it('is confident after a clean record', () => {
    const { store, service } = makeStore();
    const agent = addAgent(store, { name: 'Reliable' });
    for (let i = 0; i < 4; i++) {
      workedExampleJob(store, {
        sourcePostId: `ok-${i}`,
        state: 'PUBLISHED',
        claimedByAgentId: agent.id,
      });
    }
    expect(service.pSuccessFor(agent)).toBe(1_000_000);
  });
});

describe('FORCE_DUB override', () => {
  const lowInterest = {
    likes: 1,
    replies: 0,
    reposts: 0,
    quotes: 0,
    sourceViews: 10,
    authorFollowers: 50,
    ageHours: 72,
  };

  function withForce<T>(on: boolean, fn: () => T): T {
    const before = process.env.FORCE_DUB;
    process.env.FORCE_DUB = on ? 'true' : 'false';
    resetConfig();
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.FORCE_DUB;
      else process.env.FORCE_DUB = before;
      resetConfig();
    }
  }

  it('approves a low-interest job and says the override is on', () => {
    withForce(true, () => {
      const { store, service } = makeStore();
      const agent = addAgent(store, { name: 'Magpie' });
      const bid = service.evaluate(agent, workedExampleJob(store, { signals: lowInterest }));
      expect(bid.approved).toBe(true);
      expect(bid.decision.rationale).toMatch(/override is on/);
    });
  });

  it('is off by default: the same job is declined as low EV', () => {
    withForce(false, () => {
      const { store, service } = makeStore();
      const agent = addAgent(store, { name: 'Magpie' });
      const bid = service.evaluate(agent, workedExampleJob(store, { signals: lowInterest }));
      expect(bid.decision.declineReason).toBe('LOW_EV');
    });
  });

  it('does not bypass language focus', () => {
    withForce(true, () => {
      const { store, service } = makeStore();
      const finch = addAgent(store, { name: 'Finch', languageFocus: 'es' });
      const job = workedExampleJob(store, { targetLang: 'hi', sourcePostId: 'hi-1', signals: lowInterest });
      expect(service.evaluate(finch, job).decision.declineReason).toBe('UNSUPPORTED_LANGUAGE');
    });
  });

  it('does not bypass the per-job spend cap', () => {
    withForce(true, () => {
      const { store, service } = makeStore();
      const agent = addAgent(store, { name: 'Kestrel', maxExposurePerJob: parseUsd('0.01') });
      const bid = service.evaluate(agent, workedExampleJob(store, { signals: lowInterest }));
      expect(bid.approved).toBe(false);
      expect(bid.decision.declineReason).toBe('MAX_EXPOSURE');
    });
  });
});

describe('AGENT_DAILY_CAP_USD clamp', () => {
  function withCap<T>(cap: string | undefined, fn: () => T): T {
    const before = process.env.AGENT_DAILY_CAP_USD;
    if (cap === undefined) delete process.env.AGENT_DAILY_CAP_USD;
    else process.env.AGENT_DAILY_CAP_USD = cap;
    resetConfig();
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.AGENT_DAILY_CAP_USD;
      else process.env.AGENT_DAILY_CAP_USD = before;
      resetConfig();
    }
  }

  it('declines on DAILY_CAP once the clamp is lower than the cost', () => {
    withCap('0.01', () => {
      const { store, service } = makeStore();
      const agent = addAgent(store, { name: 'Magpie' });
      const bid = service.evaluate(agent, workedExampleJob(store));
      expect(bid.approved).toBe(false);
      expect(bid.decision.declineReason).toBe('DAILY_CAP');
    });
  });

  it('never raises an agent cap above its own', () => {
    withCap('1000.00', () => {
      const { store, service } = makeStore();
      const agent = addAgent(store, { name: 'Magpie', dailyCap: parseUsd('0.01') });
      const bid = service.evaluate(agent, workedExampleJob(store));
      expect(bid.decision.declineReason).toBe('DAILY_CAP');
    });
  });

  it('changes nothing when unset', () => {
    withCap(undefined, () => {
      const { store, service } = makeStore();
      const agent = addAgent(store, { name: 'Magpie' });
      expect(service.evaluate(agent, workedExampleJob(store)).approved).toBe(true);
    });
  });
});

describe('the specialist persona', () => {
  it('refuses work outside its language', () => {
    const { store, service } = makeStore();
    const finch = addAgent(store, { name: 'Finch', languageFocus: 'es' });
    const job = workedExampleJob(store, { targetLang: 'de', sourcePostId: 'de-1' });

    const bid = service.evaluate(finch, job);
    expect(bid.approved).toBe(false);
    expect(bid.decision.declineReason).toBe('UNSUPPORTED_LANGUAGE');
  });

  it('bids on its own language', () => {
    const { store, service } = makeStore();
    const finch = addAgent(store, { name: 'Finch', languageFocus: 'es', minMargin: parseUsd('0.02') });
    expect(service.evaluate(finch, workedExampleJob(store)).approved).toBe(true);
  });
});

describe('persona differences', () => {
  it('an optimistic agent bids where a cautious one will not', () => {
    const { store, service } = makeStore();
    const cautious = addAgent(store, {
      name: 'Kestrel',
      minMargin: parseUsd('0.60'),
      optimismPpm: 800_000,
    });
    const aggressive = addAgent(store, {
      name: 'Finch',
      minMargin: parseUsd('0.02'),
      optimismPpm: 1_350_000,
    });

    // A middling post: 150k views. A 30s dub costs $0.25 and each dub viewer
    // is worth $0.0007 (12.5% unlock x $0.02 x 40% x 0.7), so:
    //   cautious, low case:  ~61 viewers   -> about -$0.21, short of its $0.60 margin
    //   bold, high case:    ~1,360 viewers -> about +$0.70, clears its $0.02 margin
    const job = workedExampleJob(store, {
      signals: {
        likes: 2_600,
        replies: 90,
        reposts: 380,
        quotes: 30,
        sourceViews: 150_000,
        authorFollowers: 20_000,
        ageHours: 3,
      },
    });

    expect(service.evaluate(cautious, job).approved).toBe(false);
    expect(service.evaluate(aggressive, job).approved).toBe(true);
  });

  it('the three shipped personas are internally consistent', () => {
    for (const persona of AGENT_PERSONAS) {
      expect(parseUsd(persona.minMarginUsd)).toBeGreaterThan(0n);
      expect(parseUsd(persona.maxExposureUsd)).toBeLessThanOrEqual(parseUsd(persona.dailyCapUsd));
    }
  });
});

describe('the auction', () => {
  it('awards the job to exactly one agent even when several approve', () => {
    const { store, service } = makeStore();
    addAgent(store, { name: 'A', minMargin: parseUsd('0.01') });
    addAgent(store, { name: 'B', minMargin: parseUsd('0.01') });
    addAgent(store, { name: 'C', minMargin: parseUsd('0.01') });
    const job = workedExampleJob(store);

    const outcome = service.runAuction(job);

    expect(outcome.winner).not.toBeNull();
    expect(outcome.bids.filter((b) => b.approved).length).toBeGreaterThan(1);
    expect(store.getJob(job.id)?.claimedByAgentId).toBe(outcome.winner?.id);
  });

  it('records every agent reasoning, including the losers', () => {
    const { store, service } = makeStore();
    addAgent(store, { name: 'A', minMargin: parseUsd('0.01') });
    addAgent(store, { name: 'B', minMargin: parseUsd('9.00') });

    const outcome = service.runAuction(workedExampleJob(store));
    expect(outcome.bids).toHaveLength(2);
    expect(outcome.bids.every((b) => b.decision.rationale.length > 20)).toBe(true);
  });

  it('declines the job when nobody bids, with a reason the creator can act on', () => {
    const { store, service } = makeStore();
    addAgent(store, { name: 'A' });
    addAgent(store, { name: 'B' });

    const job = workedExampleJob(store, {
      signals: {
        likes: 0,
        replies: 0,
        reposts: 0,
        quotes: 0,
        sourceViews: 2,
        authorFollowers: 10,
        ageHours: 100,
      },
    });
    const outcome = service.runAuction(job);

    expect(outcome.winner).toBeNull();
    expect(outcome.declineReason).toBe('LOW_EV');
    expect(store.getJob(job.id)?.claimedByAgentId).toBeNull();
  });

  it('prefers the creator-actionable reason over an agent-specific one', () => {
    const { store, service } = makeStore();
    // One agent is broke (our problem), the other sees low EV (their problem).
    addAgent(store, { name: 'Broke' }, '1.05');
    addAgent(store, { name: 'Picky', minMargin: parseUsd('50.00') });

    const outcome = service.runAuction(workedExampleJob(store));
    expect(outcome.winner).toBeNull();
    expect(outcome.declineReason).toBe('LOW_EV');
  });

  it('cannot be claimed twice, even across repeated auctions', () => {
    const { store, service } = makeStore();
    addAgent(store, { name: 'A', minMargin: parseUsd('0.01') });
    addAgent(store, { name: 'B', minMargin: parseUsd('0.01') });
    const job = workedExampleJob(store);

    const first = service.runAuction(job);
    const second = service.runAuction(store.getJob(job.id) as Job);

    expect(first.winner).not.toBeNull();
    // The job is already claimed, so a re-run cannot hand it to anyone else.
    expect(second.winner).toBeNull();
    expect(store.getJob(job.id)?.claimedByAgentId).toBe(first.winner?.id);
  });

  it('skips inactive agents', () => {
    const { store, service } = makeStore();
    addAgent(store, { name: 'Sleeping', active: false, minMargin: parseUsd('0.01') });
    const outcome = service.runAuction(workedExampleJob(store));
    expect(outcome.bids).toHaveLength(0);
    expect(outcome.winner).toBeNull();
  });
});
