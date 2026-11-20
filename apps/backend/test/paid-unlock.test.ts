import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  UNLOCK_PRICE,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
} from '@parrot/shared';

// The chain is faked: these tests are about what Parrot does around the
// transfer (order, idempotency, refusing to unlock on a failed payment).
const transferUsdc = vi.fn();
vi.mock('../src/chain/client.js', () => ({
  transferUsdc: (...args: unknown[]) => transferUsdc(...args),
  withNonceRetry: <T>(fn: () => Promise<T>) => fn(),
}));

import { Store } from '../src/store/store.js';
import { PaymentService, PaymentError, InsufficientBalanceError } from '../src/services/payment-service.js';
import { resetConfig } from '../src/config.js';

const KEY = `0x${'1'.repeat(64)}` as const;
const POOL_KEY = `0x${'2'.repeat(64)}` as const;
const TX = `0x${'ab'.repeat(32)}`;

function liveEnv(): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  process.env.PARROT_REVENUE_PRIVATE_KEY = KEY;
  process.env.PARROT_TREASURY_PRIVATE_KEY = KEY;
  process.env.VIEWER_POOL_PRIVATE_KEY = POOL_KEY;
  resetConfig();
}

function setup() {
  const store = new Store();
  const payments = new PaymentService(store);
  const viewer = store.createAccount({ kind: 'viewer', label: 'Guest', email: null, walletAddress: null });
  payments.grantStarterCredit(viewer.id);
  const agent = store.createAccount({
    kind: 'agent', label: 'Magpie', email: null,
    walletAddress: '0x1111111111111111111111111111111111111111',
  });
  const creator = store.createAccount({ kind: 'creator', label: '@maria', email: null, walletAddress: null });
  const revenue = store.createAccount({
    kind: 'revenue', label: 'Revenue', email: null,
    walletAddress: '0x3333333333333333333333333333333333333333',
  });
  const args = {
    jobId: '11111111-1111-4111-8111-111111111111',
    viewerAccountId: viewer.id,
    amount: UNLOCK_PRICE,
    agentAccountId: agent.id,
    creatorAccountId: creator.id,
    splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
    splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    viewerPoolPrivateKey: POOL_KEY,
    revenueAccountId: revenue.id,
  };
  return { store, payments, args };
}

beforeEach(() => {
  liveEnv();
  transferUsdc.mockReset();
});

afterEach(() => {
  delete process.env.PARROT_REVENUE_PRIVATE_KEY;
  delete process.env.PARROT_TREASURY_PRIVATE_KEY;
  delete process.env.VIEWER_POOL_PRIVATE_KEY;
  resetConfig();
});

describe('recordPaidUnlock - the viewer pays on-chain', () => {
  it('sends the unlock price from the viewer wallet to the revenue wallet, then unlocks', async () => {
    transferUsdc.mockResolvedValue({ txHash: TX });
    const { store, payments, args } = setup();

    const result = await payments.recordPaidUnlock(args);

    expect(transferUsdc).toHaveBeenCalledTimes(1);
    expect(transferUsdc).toHaveBeenCalledWith(POOL_KEY, '0x3333333333333333333333333333333333333333', UNLOCK_PRICE);
    expect(result.unlock.simulated).toBe(false);
    expect(result.unlock.paymentRef).toBe(TX);
    expect(store.unlocksForJob(args.jobId)).toHaveLength(1);
  });

  it('does not unlock when the payment fails', async () => {
    transferUsdc.mockRejectedValue(new Error('insufficient funds for gas'));
    const { store, payments, args } = setup();

    await expect(payments.recordPaidUnlock(args)).rejects.toBeInstanceOf(PaymentError);
    expect(store.unlocksForJob(args.jobId)).toHaveLength(0);
  });

  it('never charges twice for the same viewer and dub', async () => {
    transferUsdc.mockResolvedValue({ txHash: TX });
    const { payments, args } = setup();

    await payments.recordPaidUnlock(args);
    const again = await payments.recordPaidUnlock(args);

    expect(transferUsdc).toHaveBeenCalledTimes(1);
    expect(again.unlock.paymentRef).toBe(TX);
  });

  it('moves no money for a viewer without credit', async () => {
    transferUsdc.mockResolvedValue({ txHash: TX });
    const { store, payments, args } = setup();
    const broke = store.createAccount({ kind: 'viewer', label: 'Broke', email: null, walletAddress: null });

    await expect(
      payments.recordPaidUnlock({ ...args, viewerAccountId: broke.id }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(transferUsdc).not.toHaveBeenCalled();
  });

  it('falls back to a simulated, ledger-only unlock without a viewer wallet', async () => {
    const { payments, args } = setup();

    const result = await payments.recordPaidUnlock({ ...args, viewerPoolPrivateKey: undefined });

    expect(transferUsdc).not.toHaveBeenCalled();
    expect(result.unlock.simulated).toBe(true);
    expect(result.unlock.paymentRef).toBeNull();
  });
});
