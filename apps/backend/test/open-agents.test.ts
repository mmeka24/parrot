import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SPLIT_AGENT_BPS, DEFAULT_SPLIT_CREATOR_BPS } from '@parrot/shared';
import { Store } from '../src/store/store.js';
import { PaymentService } from '../src/services/payment-service.js';
import { DecisionService } from '../src/services/decision-service.js';
import { AgentRegistry, AgentRegistrationError, isAllowedBidUrl } from '../src/services/agent-registry.js';
import { collectExternalBids } from '../src/services/external-bids.js';
import { resetConfig } from '../src/config.js';
import type { Job } from '../src/store/types.js';

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  resetConfig();
});

function setup() {
  const store = new Store();
  const payments = new PaymentService(store);
  return { store, registry: new AgentRegistry(store, payments), decisions: new DecisionService(store) };
}

function viralJob(store: Store): Job {
  const account = store.createAccount({ kind: 'creator', label: '@c', email: null, walletAddress: null });
  const creator = store.createCreator({ xUserId: 'x', handle: 'c', displayName: 'C', accountId: account.id, followers: 50_000, claimed: false });
  return store.createJob({
    creatorId: creator.id, sourceUrl: 'u', sourcePostId: '1', requestMentionId: null, targetLang: 'es', durationS: 30,
    category: 'comedy', state: 'EVALUATING', claimedByAgentId: null, claimedAt: null,
    splitAgentBps: DEFAULT_SPLIT_AGENT_BPS, splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS, dubCost: 0n, decision: null,
    qcReport: null, providerJobId: null, dubUrl: null, previewUrl: null, posterUrl: null, declineReason: null,
    failureReason: null,
    signals: { likes: 110_000, replies: 4_000, reposts: 17_000, quotes: 2_700, sourceViews: 5_000_000, authorFollowers: 50_000, ageHours: 2 },
    viewCount: 0, qcDemoFail: false, publishedAt: null,
  } as never);
}

describe('open agent registration', () => {
  it('registers a funded agent with its own wallet and settings', () => {
    const { store, registry } = setup();
    const agent = registry.register({
      name: 'Toucan', languageFocus: 'pt', optimism: 'cautious', minMarginUsd: '0.25',
      walletAddress: '0x52908400098527886e0f7030069857d2e4169ee7',
    });
    expect(agent.walletAddress).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
    expect(agent.optimismPpm).toBe(800_000);
    expect(store.balanceOf(agent.accountId)).toBe(12_000_000n);
  });

  it('rejects duplicates, bad input and non-https bid endpoints', () => {
    const { registry } = setup();
    registry.register({ name: 'Toucan' });
    expect(() => registry.register({ name: 'toucan' })).toThrow(AgentRegistrationError);
    expect(() => registry.register({ name: 'X' })).toThrow(/name/);
    expect(() => registry.register({ name: 'Bad', walletAddress: '0x123' })).toThrow(/walletAddress/);
    expect(() => registry.register({ name: 'Leaky', bidUrl: 'http://10.0.0.5/bid' })).toThrow(/https/);
    expect(isAllowedBidUrl('http://localhost:9000/bid', true)).toBe(false);
  });

  it('a registered agent competes in the auction with the house agents', () => {
    const { store, registry, decisions } = setup();
    registry.register({ name: 'House', minMarginUsd: '0.50' });
    const lean = registry.register({ name: 'Lean', minMarginUsd: '0.01', optimism: 'optimistic' });
    const outcome = decisions.runAuction(viralJob(store));
    expect(outcome.winner?.id).toBe(lean.id);
    expect(outcome.auction?.bids).toHaveLength(2);
  });
});

describe('external agents bid from their own server', () => {
  it('asks each endpoint, and its bid competes on equal terms', async () => {
    const { store, registry, decisions } = setup();
    registry.register({ name: 'House', minMarginUsd: '0.01' });
    const ext = registry.register({ name: 'Remote', bidUrl: 'https://agent.example/bid' });
    const job = viralJob(store);

    let sent: Record<string, unknown> | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ bidBps: 1 }), { status: 200 });
    }) as typeof fetch;

    const bids = await collectExternalBids(store, job, fakeFetch);
    expect(bids.get(ext.id)).toBe(1);
    expect((sent?.quote as { reserveBps: number }).reserveBps).toBe(DEFAULT_SPLIT_AGENT_BPS);

    const outcome = decisions.runAuction(job, bids);
    expect(outcome.winner?.id).toBe(ext.id); // a 0.01% bid beats the house formula
  });

  it('a slow, broken or out-of-range answer is a pass, never a stall', async () => {
    const { store, registry, decisions } = setup();
    const a = registry.register({ name: 'Broken', bidUrl: 'https://a.example/bid' });
    const b = registry.register({ name: 'Greedy', bidUrl: 'https://b.example/bid' });
    const job = viralJob(store);
    const fakeFetch = (async (url: string) => {
      if (url.startsWith('https://a.')) throw new Error('connection refused');
      return new Response(JSON.stringify({ bidBps: 9_999 }), { status: 200 }); // above the reserve
    }) as typeof fetch;

    const bids = await collectExternalBids(store, job, fakeFetch);
    expect(bids.get(a.id)).toBeNull();
    expect(bids.get(b.id)).toBeNull();
    expect(decisions.runAuction(job, bids).winner).toBeNull();
  });
});

describe('forecast calibration', () => {
  it('an agent that over-forecasts plans lower next time, and a freak result cannot zero it', async () => {
    const { updateCalibration } = await import('../src/services/decision-service.js');
    const once = updateCalibration(1_000_000, 1_000, 250); // promised 4x what happened
    expect(once).toBeLessThan(1_000_000);
    let cal = 1_000_000;
    for (let i = 0; i < 50; i++) cal = updateCalibration(cal, 1_000, 0);
    expect(cal).toBe(100_000); // clamped at 0.1
  });
});
