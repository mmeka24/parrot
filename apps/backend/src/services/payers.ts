/**
 * How a creator's balance is read and spent (BillingService's `Payer`).
 *
 *   - `DemoPayer`: a creator nobody has signed in as. The balance is a test
 *     credit in our own books; paying moves a ledger entry and nothing else.
 *   - `WalletPayer`: a signed-in creator. The balance is the USDC really held
 *     by their Arc wallet; paying is a real transfer from it to Parrot's
 *     revenue address. Arc charges its network fee in USDC from the same
 *     balance, so a small reserve is kept aside for it.
 *   - `creatorPayer` picks between them per creator.
 */

import { micros, type Micros } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Creator } from '../store/types.js';
import type { Payer, PaymentResult } from './billing-service.js';
import type { Accounts } from '../users/accounts.js';
import { transferUsdc, withNonceRetry, type Address } from '../chain/client.js';

/** Kept back for network fees, which Arc takes in USDC from the same balance. */
export const FEE_RESERVE: Micros = micros(15_000n);

export class DemoPayer implements Payer {
  constructor(private readonly store: Store) {}

  available(creator: Creator): Promise<Micros | null> {
    return Promise.resolve(this.store.balanceOf(creator.accountId));
  }

  pay(creator: Creator, amount: Micros, ref: string): Promise<PaymentResult> {
    if ((this.store.balanceOf(creator.accountId) as bigint) < (amount as bigint)) {
      return Promise.reject(new Error('the demo balance is too low'));
    }
    this.store.appendLedger({
      accountId: creator.accountId,
      amount: micros(-(amount as bigint)),
      kind: 'view_charge',
      ref,
    });
    return Promise.resolve({ txHash: null, testMode: true });
  }
}

export class WalletPayer implements Payer {
  /** One payment per wallet at a time: two sends from one wallet race on order. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly accounts: Accounts,
    private readonly revenueAddress: Address,
    private readonly send: typeof transferUsdc = transferUsdc,
  ) {}

  async available(creator: Creator): Promise<Micros | null> {
    const user = creator.userId ? this.accounts.db.getUser(creator.userId) : undefined;
    if (!user) return null;
    const balance = await this.accounts.wallets.balance(user);
    const spendable = (balance as bigint) - (FEE_RESERVE as bigint);
    return micros(spendable > 0n ? spendable : 0n);
  }

  pay(creator: Creator, amount: Micros): Promise<PaymentResult> {
    const user = creator.userId ? this.accounts.db.getUser(creator.userId) : undefined;
    if (!user) return Promise.reject(new Error('this creator has no account to pay from'));

    const previous = this.queues.get(user.id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async (): Promise<PaymentResult> => {
        const key = this.accounts.wallets.keyFor(user);
        const result = await withNonceRetry(() => this.send(key, this.revenueAddress, amount));
        return { txHash: result.txHash, testMode: false };
      });
    this.queues.set(user.id, run);
    return run;
  }
}

/** Signed-in creators pay from their wallet; everyone else from a demo balance. */
export function creatorPayer(demo: Payer, wallet: Payer | null): Payer {
  const pick = (creator: Creator): Payer => (creator.userId && wallet ? wallet : demo);
  return {
    available: (creator) => pick(creator).available(creator),
    pay: (creator, amount, ref) => pick(creator).pay(creator, amount, ref),
  };
}
