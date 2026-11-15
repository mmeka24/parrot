import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseUsd,
  micros,
  UNLOCK_PRICE,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
  VIEWER_STARTER_CREDIT,
  VIEWER_UNLOCK_CAP_PER_HOUR,
} from '@parrot/shared';
import { Store } from '../src/store/store.js';
import {
  PaymentService,
  InsufficientBalanceError,
  RateLimitedError,
} from '../src/services/payment-service.js';
import { resetConfig } from '../src/config.js';

/** Minimal env so loadConfig() succeeds with no credentials: everything mocked. */
function mockEnv(): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  delete process.env.PARROT_REVENUE_PRIVATE_KEY;
  delete process.env.PARROT_TREASURY_PRIVATE_KEY;
  delete process.env.VIEWER_POOL_PRIVATE_KEY;
  delete process.env.COST_SINK_ADDRESS;
  resetConfig();
}

interface Fixture {
  store: Store;
  payments: PaymentService;
  viewerId: string;
  agentAccountId: string;
  creatorAccountId: string;
  jobId: string;
}

function setup(): Fixture {
  const store = new Store();
  const payments = new PaymentService(store);

  const viewer = store.createAccount({
    kind: 'viewer',
    label: 'Guest',
    email: null,
    walletAddress: null,
  });
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

  return {
    store,
    payments,
    viewerId: viewer.id,
    agentAccountId: agentAccount.id,
    creatorAccountId: creatorAccount.id,
    jobId: '11111111-1111-4111-8111-111111111111',
  };
}

function unlockArgs(f: Fixture, overrides: Partial<Parameters<PaymentService['recordUnlock']>[0]> = {}) {
  return {
    jobId: f.jobId,
    viewerAccountId: f.viewerId,
    amount: UNLOCK_PRICE,
    agentAccountId: f.agentAccountId,
    creatorAccountId: f.creatorAccountId,
    splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
    splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    paymentRef: 'x402-ref-1',
    simulated: true,
    ...overrides,
  };
}

beforeEach(mockEnv);

describe('starter credit', () => {
  it('grants the test-mode credit once', () => {
    const f = setup();
    expect(f.payments.grantStarterCredit(f.viewerId)).toBe(VIEWER_STARTER_CREDIT);
    // A second call must not top them up again.
    expect(f.payments.grantStarterCredit(f.viewerId)).toBe(VIEWER_STARTER_CREDIT);
    expect(f.store.balanceOf(f.viewerId)).toBe(parseUsd('1.00'));
  });
});

describe('recordUnlock', () => {
  it('splits a $0.02 unlock 40/60 and leaves the ledger balanced', () => {
    const f = setup();
    f.payments.grantStarterCredit(f.viewerId);

    const result = f.payments.recordUnlock(unlockArgs(f));

    expect(result.agentShare).toBe(parseUsd('0.008'));
    expect(result.creatorShare).toBe(parseUsd('0.012'));
    expect(f.store.balanceOf(f.viewerId)).toBe(parseUsd('0.98'));
    expect(f.store.balanceOf(f.agentAccountId)).toBe(parseUsd('0.008'));
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(parseUsd('0.012'));

    // The three rows for this unlock sum to zero: no money created or lost.
    const unlockRows = f.store.ledger.filter((e) => e.ref === 'x402-ref-1');
    expect(unlockRows).toHaveLength(3);
    expect(unlockRows.reduce((sum, e) => sum + (e.amount as bigint), 0n)).toBe(0n);
  });

  it('is idempotent: re-watching does not charge again', () => {
    const f = setup();
    f.payments.grantStarterCredit(f.viewerId);

    const first = f.payments.recordUnlock(unlockArgs(f));
    const second = f.payments.recordUnlock(unlockArgs(f));

    expect(second.unlock.id).toBe(first.unlock.id);
    expect(f.store.balanceOf(f.viewerId)).toBe(parseUsd('0.98'));
    expect(f.store.unlocksForJob(f.jobId)).toHaveLength(1);
  });

  it('refuses when the viewer cannot afford it', () => {
    const f = setup();
    expect(() => f.payments.recordUnlock(unlockArgs(f))).toThrow(InsufficientBalanceError);
    expect(f.store.unlocksForJob(f.jobId)).toHaveLength(0);
    // A refused unlock must leave no partial ledger rows behind.
    expect(f.store.ledger).toHaveLength(0);
  });

  it('enforces the per-viewer hourly cap', () => {
    const f = setup();
    f.payments.grantStarterCredit(f.viewerId);
    f.payments.fundFromFaucet(f.viewerId, parseUsd('100.00'));

    for (let i = 0; i < VIEWER_UNLOCK_CAP_PER_HOUR; i++) {
      f.payments.recordUnlock(unlockArgs(f, { jobId: `job-${i}`, paymentRef: `ref-${i}` }));
    }

    expect(() =>
      f.payments.recordUnlock(unlockArgs(f, { jobId: 'job-over', paymentRef: 'ref-over' })),
    ).toThrow(RateLimitedError);
  });

  it('conserves money across many unlocks from many viewers', () => {
    const f = setup();
    let expectedAgent = 0n;
    let expectedCreator = 0n;

    for (let i = 0; i < 250; i++) {
      const viewer = f.store.createAccount({
        kind: 'viewer',
        label: `Guest ${i}`,
        email: null,
        walletAddress: null,
      });
      f.payments.grantStarterCredit(viewer.id);
      const result = f.payments.recordUnlock(
        unlockArgs(f, { viewerAccountId: viewer.id, paymentRef: `ref-${i}` }),
      );
      expectedAgent += result.agentShare as bigint;
      expectedCreator += result.creatorShare as bigint;
    }

    expect(f.store.balanceOf(f.agentAccountId)).toBe(expectedAgent);
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(expectedCreator);
    // 250 unlocks at $0.02 = $5.00, split $2.00 / $3.00.
    expect(expectedAgent).toBe(parseUsd('2.00'));
    expect(expectedCreator).toBe(parseUsd('3.00'));
  });
});

describe('settle - the audited payout', () => {
  it('is idempotent on the key: a retry never pays twice', async () => {
    const f = setup();
    const request = {
      toAccountId: f.creatorAccountId,
      amount: parseUsd('0.50'),
      kind: 'creator_payout' as const,
      idempotencyKey: 'payout:abc',
    };

    const first = await f.payments.settle(request);
    const second = await f.payments.settle(request);
    const third = await f.payments.settle(request);

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(f.store.allSettlements()).toHaveLength(1);
  });

  it('marks a settlement simulated and refuses to invent a hash', async () => {
    const f = setup();
    const settlement = await f.payments.settle({
      toAccountId: f.creatorAccountId,
      amount: parseUsd('0.50'),
      kind: 'creator_payout',
      idempotencyKey: 'payout:sim',
    });

    expect(settlement.simulated).toBe(true);
    expect(settlement.txHash).toBeNull();
    expect(settlement.status).toBe('confirmed');
  });

  it('refuses a non-positive amount', async () => {
    const f = setup();
    await expect(
      f.payments.settle({
        toAccountId: f.creatorAccountId,
        amount: micros(0n),
        kind: 'creator_payout',
        idempotencyKey: 'payout:zero',
      }),
    ).rejects.toThrow(/refusing to settle/);
  });

  it('refuses an unknown recipient', async () => {
    const f = setup();
    await expect(
      f.payments.settle({
        toAccountId: 'nobody',
        amount: parseUsd('1.00'),
        kind: 'creator_payout',
        idempotencyKey: 'payout:ghost',
      }),
    ).rejects.toThrow(/unknown account/);
  });

  it('moves money without creating it when both sides are given', async () => {
    const f = setup();
    f.payments.fundFromFaucet(f.agentAccountId, parseUsd('10.00'));

    await f.payments.settle({
      toAccountId: f.creatorAccountId,
      amount: parseUsd('2.00'),
      kind: 'settlement_in',
      idempotencyKey: 'move:1',
      fromAccountId: f.agentAccountId,
    });

    expect(f.store.balanceOf(f.agentAccountId)).toBe(parseUsd('8.00'));
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(parseUsd('2.00'));
    // Total is unchanged: value moved, none was minted.
    const total = f.store.ledger.reduce((sum, e) => sum + (e.amount as bigint), 0n);
    expect(total).toBe(parseUsd('10.00'));
  });
});

describe('payoutCreator', () => {
  it('pays out earnings and clears the claimable balance', async () => {
    const f = setup();
    f.payments.grantStarterCredit(f.viewerId);
    f.payments.recordUnlock(unlockArgs(f));
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(parseUsd('0.012'));

    await f.payments.payoutCreator({
      creatorAccountId: f.creatorAccountId,
      amount: parseUsd('0.012'),
      requestId: 'req-1',
    });

    // Claimed earnings must not remain claimable.
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(0n);
  });

  it('refuses to pay out more than was earned', async () => {
    const f = setup();
    await expect(
      f.payments.payoutCreator({
        creatorAccountId: f.creatorAccountId,
        amount: parseUsd('5.00'),
        requestId: 'req-2',
      }),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it('does not double-pay when a claim is retried with the same request id', async () => {
    const f = setup();
    f.payments.fundFromFaucet(f.creatorAccountId, parseUsd('1.00'));

    await f.payments.payoutCreator({
      creatorAccountId: f.creatorAccountId,
      amount: parseUsd('0.50'),
      requestId: 'same-request',
    });
    const balanceAfterFirst = f.store.balanceOf(f.creatorAccountId);

    await f.payments.payoutCreator({
      creatorAccountId: f.creatorAccountId,
      amount: parseUsd('0.50'),
      requestId: 'same-request',
    });

    // The second call returned the original settlement and changed nothing.
    expect(f.store.allSettlements()).toHaveLength(1);
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(balanceAfterFirst);
  });
});

describe('chargeDubCost', () => {
  it('books the off-chain ElevenLabs bill against the agent', async () => {
    const f = setup();
    f.payments.fundFromFaucet(f.agentAccountId, parseUsd('12.00'));

    const settlement = await f.payments.chargeDubCost({
      agentAccountId: f.agentAccountId,
      jobId: f.jobId,
      amount: parseUsd('0.40'),
    });

    // No cost sink configured, so nothing goes on-chain - but the P&L is honest.
    expect(settlement).toBeNull();
    expect(f.store.balanceOf(f.agentAccountId)).toBe(parseUsd('11.60'));
    expect(f.store.totalSpend(f.agentAccountId, 'dub_cost')).toBe(parseUsd('0.40'));
  });

  it('refuses a non-positive cost', async () => {
    const f = setup();
    await expect(
      f.payments.chargeDubCost({
        agentAccountId: f.agentAccountId,
        jobId: f.jobId,
        amount: micros(0n),
      }),
    ).rejects.toThrow(/must be positive/);
  });
});

describe('the worked example, end to end through the ledger', () => {
  it('leaves the agent down $0.40 then recouping $0.008 per unlock', async () => {
    const f = setup();
    f.payments.fundFromFaucet(f.agentAccountId, parseUsd('12.00'));

    await f.payments.chargeDubCost({
      agentAccountId: f.agentAccountId,
      jobId: f.jobId,
      amount: parseUsd('0.40'),
    });
    expect(f.store.balanceOf(f.agentAccountId)).toBe(parseUsd('11.60'));

    // 250 unlocks, the EV model's expectation for 2,000 views at 12.5%.
    for (let i = 0; i < 250; i++) {
      const viewer = f.store.createAccount({
        kind: 'viewer',
        label: `V${i}`,
        email: null,
        walletAddress: null,
      });
      f.payments.grantStarterCredit(viewer.id);
      f.payments.recordUnlock(unlockArgs(f, { viewerAccountId: viewer.id, paymentRef: `r${i}` }));
    }

    // $11.60 + $2.00 earned = $13.60, i.e. $1.60 up on the $12.00 it started
    // with, against an EV that predicted +$1.00. The agent beat its own model.
    expect(f.store.balanceOf(f.agentAccountId)).toBe(parseUsd('13.60'));
    expect(f.store.balanceOf(f.creatorAccountId)).toBe(parseUsd('3.00'));
  });
});
