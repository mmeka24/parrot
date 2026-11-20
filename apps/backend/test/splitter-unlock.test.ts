/**
 * Unlocks through the ParrotSplitter contract: the contract pays the parties
 * directly, so the settlement sweep must not pay those legs a second time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UNLOCK_PRICE, parseUsd } from '@parrot/shared';

const splitUnlockOnchain = vi.fn();
vi.mock('../src/chain/splitter.js', () => ({
  splitUnlockOnchain: (...args: unknown[]) => splitUnlockOnchain(...args),
}));
const transferUsdc = vi.fn();
vi.mock('../src/chain/client.js', () => ({
  transferUsdc: (...args: unknown[]) => transferUsdc(...args),
  withNonceRetry: <T>(fn: () => Promise<T>) => fn(),
}));

import { Store } from '../src/store/store.js';
import { PaymentService } from '../src/services/payment-service.js';
import { SettlementScheduler } from '../src/payments/settlement-scheduler.js';
import { resetConfig } from '../src/config.js';

const KEY = `0x${'1'.repeat(64)}` as const;
const POOL_KEY = `0x${'2'.repeat(64)}` as const;
const SPLITTER = '0x4444444444444444444444444444444444444444';
const TX = `0x${'cd'.repeat(32)}`;

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  process.env.PARROT_REVENUE_PRIVATE_KEY = KEY;
  process.env.PARROT_TREASURY_PRIVATE_KEY = KEY;
  process.env.VIEWER_POOL_PRIVATE_KEY = POOL_KEY;
  process.env.SPLITTER_ADDRESS = SPLITTER;
  resetConfig();
  splitUnlockOnchain.mockReset();
  transferUsdc.mockReset();
});
afterEach(() => {
  for (const k of ['PARROT_REVENUE_PRIVATE_KEY', 'PARROT_TREASURY_PRIVATE_KEY', 'VIEWER_POOL_PRIVATE_KEY', 'SPLITTER_ADDRESS']) delete process.env[k];
  resetConfig();
});

function setup() {
  const store = new Store();
  const payments = new PaymentService(store);
  const viewer = store.createAccount({ kind: 'viewer', label: 'Guest', email: null, walletAddress: null });
  payments.grantStarterCredit(viewer.id);
  const revenue = store.createAccount({ kind: 'revenue', label: 'Revenue', email: null, walletAddress: '0x3333333333333333333333333333333333333333' });
  const agentAcc = store.createAccount({ kind: 'agent', label: 'Finch', email: null, walletAddress: '0x1111111111111111111111111111111111111111' });
  const agent = store.createAgent({
    name: 'Finch', persona: '', accountId: agentAcc.id, walletAddress: agentAcc.walletAddress,
    floor: parseUsd('0'), minMargin: parseUsd('0'), maxExposurePerJob: parseUsd('1'), dailyCap: parseUsd('1'),
    languageFocus: null, optimismPpm: 1_000_000, active: true,
  });
  // The creator has no wallet yet: the contract pays their share to the revenue wallet.
  const creatorAcc = store.createAccount({ kind: 'creator', label: '@maria', email: null, walletAddress: null });
  const creator = store.createCreator({ xUserId: 'x', handle: 'maria', displayName: 'Maria', accountId: creatorAcc.id, followers: 1, claimed: false });
  const job = store.createJob({
    creatorId: creator.id, sourceUrl: 'u', sourcePostId: '1', requestMentionId: null, targetLang: 'es', durationS: 30,
    category: 'comedy', state: 'PUBLISHED', claimedByAgentId: agent.id, claimedAt: new Date(),
    splitAgentBps: 825, splitCreatorBps: 9_175, dubCost: 0n, decision: null, qcReport: null, providerJobId: null,
    dubUrl: null, previewUrl: null, posterUrl: null, declineReason: null, failureReason: null, signals: null,
    viewCount: 0, qcDemoFail: false, publishedAt: new Date(),
  } as never);
  store.appendEvent({ jobId: job.id, type: 'APPROVED', fromState: 'EVALUATING', toState: 'APPROVED', payload: null, txHash: TX });
  return { store, payments, job, viewer, agentAcc, creatorAcc, revenue };
}

describe('unlocks through the splitter contract', () => {
  it('routes to the contract, and the sweep pays only the leg the contract did not', async () => {
    splitUnlockOnchain.mockResolvedValue(TX);
    transferUsdc.mockResolvedValue({ txHash: `0x${'ef'.repeat(32)}` });
    const { store, payments, job, viewer, agentAcc, creatorAcc, revenue } = setup();

    const route = payments.splitterRouteFor(job);
    expect(route).toEqual({ address: SPLITTER, agentDirect: true, creatorDirect: false });

    const result = await payments.recordPaidUnlock({
      jobId: job.id, viewerAccountId: viewer.id, amount: UNLOCK_PRICE,
      agentAccountId: agentAcc.id, creatorAccountId: creatorAcc.id,
      splitAgentBps: job.splitAgentBps, splitCreatorBps: job.splitCreatorBps,
      viewerPoolPrivateKey: POOL_KEY, revenueAccountId: revenue.id, splitter: route,
    });
    expect(result.unlock.paymentRef).toBe(TX);
    expect(transferUsdc).not.toHaveBeenCalled(); // the contract did the paying

    const scheduler = new SettlementScheduler({ store, payments });
    const legs = scheduler.legsForJob(job.id);
    const agentLeg = legs.find((l) => l.role === 'agent')!;
    const creatorLeg = legs.find((l) => l.role === 'creator')!;
    expect(agentLeg.owed).toBe(0n); // paid on-chain by the contract: never again
    expect(creatorLeg.owed).toBe(result.creatorShare); // held for the creator, settled as before
  });

  it('a job whose auction never reached the chain keeps the old path', () => {
    const { payments, job } = setup();
    expect(payments.splitterRouteFor(job)).not.toBeNull();
    expect(payments.splitterRouteFor({ ...job, id: 'no-auction-recorded' })).toBeNull();
  });
});
