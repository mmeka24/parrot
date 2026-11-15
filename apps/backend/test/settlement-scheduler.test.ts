/**
 * Settlement scheduler tests.
 *
 * No network, no keys, no timers left running. The scheduler is driven through
 * `runOnce()` and the Gateway client is injected, so every assertion here is
 * about the aggregation and idempotency logic rather than about Circle.
 *
 * The money arithmetic the fixtures rely on, stated once:
 *   unlock            $0.02  = 20_000 micros
 *   agent share 40%   $0.008 =  8_000 micros
 *   creator share 60% $0.012 = 12_000 micros
 *   threshold         $0.10  = 100_000 micros
 *   -> the agent crosses the threshold at 13 unlocks, the creator at 9.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  UNLOCK_PRICE,
  SETTLEMENT_THRESHOLD,
  SETTLEMENT_INTERVAL_MS,
  DEMO_SETTLEMENT_INTERVAL_MS,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
  parseUsd,
  micros,
} from '@parrot/shared';
import { Store } from '../src/store/store.js';
import { PaymentService } from '../src/services/payment-service.js';
import { loadConfig, resetConfig, type Config } from '../src/config.js';
import {
  SettlementScheduler,
  totalOutstanding,
  type SettlementRunResult,
} from '../src/payments/settlement-scheduler.js';
import type { GatewayClientLike } from '../src/payments/x402-buyer.js';

const AGENT_SHARE = 8_000n;
const CREATOR_SHARE = 12_000n;

function mockEnv(): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  delete process.env.PARROT_REVENUE_PRIVATE_KEY;
  delete process.env.PARROT_TREASURY_PRIVATE_KEY;
  delete process.env.VIEWER_POOL_PRIVATE_KEY;
  delete process.env.COST_SINK_ADDRESS;
  delete process.env.DEMO_MODE;
  resetConfig();
}

interface Fixture {
  store: Store;
  payments: PaymentService;
  scheduler: SettlementScheduler;
  config: Config;
  jobId: string;
  agentAccountId: string;
  creatorAccountId: string;
  unlock: (n: number) => void;
}

function setup(options: { config?: Config } = {}): Fixture {
  const store = new Store();
  const payments = new PaymentService(store);
  const config = options.config ?? loadConfig(process.env);

  const agentAccount = store.createAccount({
    kind: 'agent',
    label: 'Magpie',
    email: null,
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  const creatorAccount = store.createAccount({
    kind: 'creator',
    label: '@maria',
    email: null,
    walletAddress: '0x2222222222222222222222222222222222222222',
  });

  const agent = store.createAgent({
    name: 'Magpie',
    persona: 'optimist',
    accountId: agentAccount.id,
    walletAddress: agentAccount.walletAddress,
    floor: parseUsd('1.00'),
    minMargin: parseUsd('0.10'),
    maxExposurePerJob: parseUsd('2.00'),
    dailyCap: parseUsd('10.00'),
    languageFocus: null,
    optimismPpm: 1_000_000,
    active: true,
  });
  const creator = store.createCreator({
    xUserId: 'x-1',
    handle: 'maria',
    displayName: 'Maria',
    accountId: creatorAccount.id,
    followers: 1000,
    claimed: true,
  });

  const job = store.createJob({
    creatorId: creator.id,
    sourceUrl: 'https://x.com/maria/status/1',
    sourcePostId: '1',
    requestMentionId: null,
    targetLang: 'es',
    durationS: 60,
    category: 'comedy',
    state: 'EARNING',
    claimedByAgentId: agent.id,
    claimedAt: new Date(),
    splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
    splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    dubCost: parseUsd('0.50'),
    decision: null,
    qcReport: null,
    providerJobId: null,
    dubUrl: null,
    previewUrl: null,
    posterUrl: null,
    declineReason: null,
    failureReason: null,
    signals: null,
    viewCount: 0,
    qcDemoFail: false,
    publishedAt: new Date(),
  });

  let viewerSeq = 0;
  const unlock = (n: number): void => {
    for (let i = 0; i < n; i++) {
      viewerSeq++;
      const viewer = store.createAccount({
        kind: 'viewer',
        label: `Guest ${viewerSeq}`,
        email: null,
        walletAddress: null,
      });
      payments.grantStarterCredit(viewer.id);
      payments.recordUnlock({
        jobId: job.id,
        viewerAccountId: viewer.id,
        amount: UNLOCK_PRICE,
        agentAccountId: agentAccount.id,
        creatorAccountId: creatorAccount.id,
        splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
        splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
        paymentRef: `sim:ref-${viewerSeq}`,
        simulated: true,
      });
    }
  };

  const scheduler = new SettlementScheduler({ store, payments, config });

  return {
    store,
    payments,
    scheduler,
    config,
    jobId: job.id,
    agentAccountId: agentAccount.id,
    creatorAccountId: creatorAccount.id,
    unlock,
  };
}

function paidTo(result: SettlementRunResult, accountId: string): bigint {
  return result.settlements
    .filter((s) => s.toAccountId === accountId && s.status === 'confirmed')
    .reduce((total, s) => total + (s.amount as bigint), 0n);
}

let fixtures: Fixture[] = [];

beforeEach(() => {
  mockEnv();
  fixtures = [];
});

afterEach(async () => {
  for (const fixture of fixtures) await fixture.scheduler.drain();
});

function makeFixture(options: { config?: Config } = {}): Fixture {
  const fixture = setup(options);
  fixtures.push(fixture);
  return fixture;
}

// ---------------------------------------------------------------------------

describe('the fixture economics', () => {
  it('splits a $0.02 unlock into 8_000 / 12_000 micros', () => {
    const f = makeFixture();
    f.unlock(1);
    const [unlock] = f.store.unlocksForJob(f.jobId);
    expect(unlock?.amount).toBe(20_000n);
    expect(unlock?.agentShare).toBe(AGENT_SHARE);
    expect(unlock?.creatorShare).toBe(CREATOR_SHARE);
    expect(SETTLEMENT_THRESHOLD).toBe(100_000n);
  });
});

describe('cadence', () => {
  it('uses the normal interval, and the fast one in demo mode', () => {
    const f = makeFixture();
    expect(f.scheduler.intervalMs).toBe(SETTLEMENT_INTERVAL_MS);

    process.env.DEMO_MODE = 'true';
    resetConfig();
    const demo = makeFixture({ config: loadConfig(process.env) });
    expect(demo.scheduler.intervalMs).toBe(DEMO_SETTLEMENT_INTERVAL_MS);
    expect(DEMO_SETTLEMENT_INTERVAL_MS).toBeLessThan(SETTLEMENT_INTERVAL_MS);
  });

  it('start() is idempotent and stop() really stops', () => {
    const f = makeFixture();
    expect(f.scheduler.running).toBe(false);
    f.scheduler.start();
    f.scheduler.start();
    expect(f.scheduler.running).toBe(true);
    f.scheduler.stop();
    expect(f.scheduler.running).toBe(false);
  });
});

describe('aggregation', () => {
  it('sums every unlock into one payout per (job, recipient)', async () => {
    const f = makeFixture();
    f.unlock(13);

    const result = await f.scheduler.runOnce();

    expect(result.jobsConsidered).toBe(1);
    expect(result.settlements).toHaveLength(2);
    expect(paidTo(result, f.agentAccountId)).toBe(13n * AGENT_SHARE); // 104_000
    expect(paidTo(result, f.creatorAccountId)).toBe(13n * CREATOR_SHARE); // 156_000
    expect(result.totalPaid).toBe(13n * 20_000n);
  });

  it('uses a stable PaymentService.settlementKey for each leg', async () => {
    const f = makeFixture();
    f.unlock(13);
    await f.scheduler.runOnce();

    const keys = f.store.settlementsForJob(f.jobId).map((s) => s.idempotencyKey).sort();
    expect(keys).toEqual(
      [
        PaymentService.settlementKey(f.jobId, f.agentAccountId, 0),
        PaymentService.settlementKey(f.jobId, f.creatorAccountId, 0),
      ].sort(),
    );
  });

  it('ignores jobs whose unlocks are already settled', async () => {
    const f = makeFixture();
    f.unlock(13);
    await f.scheduler.runOnce();

    const second = await f.scheduler.runOnce();
    expect(second.jobsConsidered).toBe(0);
    expect(second.settlements).toHaveLength(0);
  });
});

describe('the threshold', () => {
  it('pays nothing at all below it', async () => {
    const f = makeFixture();
    f.unlock(4); // agent 32_000, creator 48_000: both under $0.10

    const result = await f.scheduler.runOnce();
    expect(result.settlements).toHaveLength(0);
    expect(result.legsBelowThreshold).toBe(2);
    expect(result.unlocksMarkedSettled).toBe(0);
    expect(totalOutstanding(f.scheduler, f.store)).toBe(4n * 20_000n);
  });

  it('fires at exactly the threshold, not a micro before', async () => {
    const f = makeFixture();
    f.unlock(4); // $0.08
    expect((await f.scheduler.runOnce()).settlements).toHaveLength(0);

    f.unlock(1); // $0.10 exactly
    const result = await f.scheduler.runOnce();
    expect(result.settlements).toHaveLength(2);
    expect(paidTo(result, f.agentAccountId)).toBe(5n * AGENT_SHARE);
    expect(paidTo(result, f.creatorAccountId)).toBe(5n * CREATOR_SHARE);
    expect(result.unlocksMarkedSettled).toBe(5);
  });

  it('leaves sub-threshold residue open until it grows', async () => {
    const f = makeFixture();
    f.unlock(5);
    await f.scheduler.runOnce();

    f.unlock(2); // $0.04 of new revenue: under the threshold
    const quiet = await f.scheduler.runOnce();
    expect(quiet.settlements).toHaveLength(0);
    expect(quiet.legsBelowThreshold).toBe(2);
    expect(quiet.unlocksMarkedSettled).toBe(0);
    expect(totalOutstanding(f.scheduler, f.store)).toBe(2n * 20_000n);

    f.unlock(3); // residue is now $0.10
    const loud = await f.scheduler.runOnce();
    // Only the 5 NEW unlocks are paid for, never the 5 already settled.
    expect(paidTo(loud, f.agentAccountId)).toBe(5n * AGENT_SHARE);
    expect(paidTo(loud, f.creatorAccountId)).toBe(5n * CREATOR_SHARE);
    expect(loud.unlocksMarkedSettled).toBe(5);
    expect(totalOutstanding(f.scheduler, f.store)).toBe(0n);
  });
});

describe('idempotency and over-payment', () => {
  it('repeated runOnce() never pays twice', async () => {
    const f = makeFixture();
    f.unlock(13);

    await f.scheduler.runOnce();
    await f.scheduler.runOnce();
    await f.scheduler.runOnce();

    const all = f.store.settlementsForJob(f.jobId);
    expect(all).toHaveLength(2);
    const total = all.reduce((t, s) => t + (s.amount as bigint), 0n);
    expect(total).toBe(13n * 20_000n);
  });

  it('never pays out more than the ledger says was earned', async () => {
    const f = makeFixture();
    for (let round = 0; round < 4; round++) {
      f.unlock(5);
      await f.scheduler.runOnce();
      await f.scheduler.runOnce();

      const earned = f.store
        .unlocksForJob(f.jobId)
        .reduce((t, u) => t + (u.agentShare as bigint) + (u.creatorShare as bigint), 0n);
      const paid = f.store
        .settlementsForJob(f.jobId)
        .filter((s) => s.status === 'confirmed')
        .reduce((t, s) => t + (s.amount as bigint), 0n);

      expect(paid).toBeLessThanOrEqual(earned);
    }

    // 20 unlocks: every cent is eventually paid, and not one more.
    const earned = 20n * 20_000n;
    const paid = f.store
      .settlementsForJob(f.jobId)
      .filter((s) => s.status === 'confirmed')
      .reduce((t, s) => t + (s.amount as bigint), 0n);
    expect(paid).toBe(earned);
  });

  it('marks each unlock settled exactly once', async () => {
    const f = makeFixture();
    f.unlock(13);

    const first = await f.scheduler.runOnce();
    expect(first.unlocksMarkedSettled).toBe(13);

    const stamps = f.store.unlocksForJob(f.jobId).map((u) => u.settledAt?.getTime());
    expect(stamps.every((t) => typeof t === 'number')).toBe(true);

    const second = await f.scheduler.runOnce();
    expect(second.unlocksMarkedSettled).toBe(0);
    expect(f.store.unlocksForJob(f.jobId).map((u) => u.settledAt?.getTime())).toEqual(stamps);
  });

  it('joins an in-flight sweep instead of starting a second one', async () => {
    const f = makeFixture();
    f.unlock(13);

    const [a, b] = await Promise.all([f.scheduler.runOnce(), f.scheduler.runOnce()]);

    // Exactly one of the two actually swept; the other rode along.
    expect([a.reentered, b.reentered].filter(Boolean)).toHaveLength(1);
    expect(f.store.settlementsForJob(f.jobId)).toHaveLength(2);
    const total = f.store
      .settlementsForJob(f.jobId)
      .reduce((t, s) => t + (s.amount as bigint), 0n);
    expect(total).toBe(13n * 20_000n);
  });

  it('retries a FAILED leg with a fresh sequence and still does not over-pay', async () => {
    const f = makeFixture();
    f.unlock(13);

    // Force the agent leg to fail once, the way a reverted transfer would.
    const realSettle = f.payments.settle.bind(f.payments);
    let failed = false;
    f.payments.settle = async (request) => {
      const settlement = await realSettle(request);
      if (!failed && request.toAccountId === f.agentAccountId) {
        failed = true;
        return f.store.updateSettlement(settlement.id, {
          status: 'failed',
          error: 'nonce too low',
          confirmedAt: null,
        });
      }
      return settlement;
    };

    const first = await f.scheduler.runOnce();
    expect(first.errors.some((e) => e.includes('nonce too low'))).toBe(true);
    expect(paidTo(first, f.agentAccountId)).toBe(0n);
    expect(first.unlocksMarkedSettled).toBe(0);

    const second = await f.scheduler.runOnce();
    expect(paidTo(second, f.agentAccountId)).toBe(13n * AGENT_SHARE);
    expect(second.unlocksMarkedSettled).toBe(13);

    const confirmed = f.store
      .settlementsForJob(f.jobId)
      .filter((s) => s.status === 'confirmed')
      .reduce((t, s) => t + (s.amount as bigint), 0n);
    expect(confirmed).toBe(13n * 20_000n);

    // The retry used a new idempotency key; the failed one is still claimed.
    expect(
      f.store.findSettlementByKey(PaymentService.settlementKey(f.jobId, f.agentAccountId, 0))
        ?.status,
    ).toBe('failed');
    expect(
      f.store.findSettlementByKey(PaymentService.settlementKey(f.jobId, f.agentAccountId, 1))
        ?.status,
    ).toBe('confirmed');
  });
});

describe('honesty with no funded keys', () => {
  it('records simulated settlements that carry no transaction hash', async () => {
    const f = makeFixture();
    expect(f.config.capabilities.onchainSettlement).toBe(false);
    f.unlock(13);

    const result = await f.scheduler.runOnce();
    for (const settlement of result.settlements) {
      expect(settlement.simulated).toBe(true);
      expect(settlement.txHash).toBeNull();
      expect(settlement.status).toBe('confirmed');
    }
  });
});

describe('withdrawFromGateway', () => {
  function fakeGateway(calls: Array<[string, unknown]>): GatewayClientLike {
    return {
      address: '0x3333333333333333333333333333333333333333',
      async getBalances() {
        return {
          wallet: { balance: 0n, formatted: '0' },
          gateway: {
            total: 500_000n,
            available: 500_000n,
            withdrawing: 0n,
            withdrawable: 500_000n,
            formattedTotal: '0.5',
            formattedAvailable: '0.5',
            formattedWithdrawing: '0',
            formattedWithdrawable: '0.5',
          },
        };
      },
      async deposit() {
        throw new Error('not used');
      },
      async pay() {
        throw new Error('not used');
      },
      async withdraw(amount, options) {
        calls.push([amount, options]);
        return {
          mintTxHash: '0xabc',
          amount: BigInt(Math.round(Number(amount) * 1e6)),
          formattedAmount: amount,
          sourceChain: 'arcTestnet',
          destinationChain: 'arcTestnet',
          recipient: '0x3333333333333333333333333333333333333333',
        };
      },
    };
  }

  it('turns a Gateway balance into on-chain USDC on the same chain', async () => {
    const calls: Array<[string, unknown]> = [];
    const store = new Store();
    const scheduler = new SettlementScheduler({
      store,
      payments: new PaymentService(store),
      config: loadConfig(process.env),
      gatewayFactory: async () => fakeGateway(calls),
    });

    const result = await scheduler.withdrawFromGateway(parseUsd('0.26'));

    expect(calls).toEqual([['0.26', { chain: 'arcTestnet' }]]);
    expect(result).toEqual({
      simulated: false,
      amount: 260_000n,
      txHash: '0xabc',
      recipient: '0x3333333333333333333333333333333333333333',
    });
    expect(await scheduler.gatewayBalance()).toBe(500_000n);
  });

  it('simulates, and invents no hash, when there is no funded key', async () => {
    const f = makeFixture();
    const result = await f.scheduler.withdrawFromGateway(parseUsd('0.26'));
    expect(result).toEqual({
      simulated: true,
      amount: 260_000n,
      txHash: null,
      recipient: null,
    });
    expect(await f.scheduler.gatewayBalance()).toBeNull();
  });

  it('refuses a non-positive withdrawal', async () => {
    const f = makeFixture();
    await expect(f.scheduler.withdrawFromGateway(micros(0n))).rejects.toThrow(RangeError);
  });
});
