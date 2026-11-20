/**
 * Per-user wallets.
 *
 * Each signed-up user gets one Arc wallet, created by Parrot and held by Parrot
 * (custodial): the private key is generated here, encrypted with
 * WALLET_ENCRYPTION_KEY, and stored only in encrypted form. The user never sees
 * or handles a key. That is the trade for "sign up with an email and it just
 * works", and it is stated plainly in the README.
 *
 * Funding: a new wallet gets a one-time bonus of testnet USDC from the
 * Treasury. Safeguards, because this is a faucet pointed at a real wallet:
 *   - once per user (database state, plus an on-chain balance check, so a
 *     crash between sending and recording cannot pay twice);
 *   - a daily cap on new funded wallets;
 *   - the Treasury keeps a reserve and is never drained by signups;
 *   - funding is serialised, because concurrent sends from one wallet race on
 *     its transaction order.
 *
 * The chain is behind `ChainOps` so all of this is testable without a network.
 */

import { maxUint256, parseAbi } from 'viem';
import { arcTestnet } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ARC_MIN_MAX_FEE_PER_GAS_WEI, USDC_ADDRESS, micros, type Micros } from '@parrot/shared';
import { decryptSecret, encryptSecret } from './crypto.js';
import type { UserDb, UserRow } from './user-db.js';
import {
  getPublicClient,
  getUsdcBalance,
  transferUsdc,
  walletFromKey,
  withNonceRetry,
  type Address,
  type Hex,
} from '../chain/client.js';

export interface ChainOps {
  newKey(): Hex;
  addressOf(key: Hex): Address;
  usdcBalance(address: Address): Promise<Micros>;
  /** Send `amount` from the funding (Treasury) wallet. Resolves with the tx hash. */
  fund(to: Address, amount: Micros): Promise<Hex>;
  allowance(owner: Address, spender: Address): Promise<bigint>;
  /** Approve `spender` for the max from the user's own wallet. Resolves with the tx hash. */
  approve(userKey: Hex, spender: Address): Promise<Hex>;
}

const ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export function realChainOps(treasuryKey: Hex): ChainOps {
  return {
    newKey: () => generatePrivateKey(),
    addressOf: (key) => privateKeyToAccount(key).address,
    usdcBalance: (address) => getUsdcBalance(address),
    fund: async (to, amount) => (await withNonceRetry(() => transferUsdc(treasuryKey, to, amount))).txHash,
    allowance: (owner, spender) =>
      getPublicClient().readContract({
        address: USDC_ADDRESS,
        abi: ALLOWANCE_ABI,
        functionName: 'allowance',
        args: [owner, spender],
      }),
    approve: async (userKey, spender) => {
      const wallet = walletFromKey(userKey);
      const account = wallet.account;
      if (!account) throw new Error('wallet client has no account');
      return withNonceRetry(async () => {
        const hash = await wallet.writeContract({
          address: USDC_ADDRESS,
          abi: ALLOWANCE_ABI,
          functionName: 'approve',
          args: [spender, maxUint256],
          chain: arcTestnet,
          account,
          maxFeePerGas: ARC_MIN_MAX_FEE_PER_GAS_WEI,
          maxPriorityFeePerGas: 1_000_000_000n,
        });
        const receipt = await getPublicClient().waitForTransactionReceipt({ hash, timeout: 90_000 });
        if (receipt.status !== 'success') throw new Error(`approve reverted: ${hash}`);
        return hash;
      });
    },
  };
}

export interface WalletServiceOptions {
  readonly db: UserDb;
  readonly chain: ChainOps;
  /** 64 hex characters. */
  readonly encryptionKey: string;
  readonly bonus: Micros;
  readonly dailyLimit: number;
  /** The funding wallet's address, to check its balance before paying out. */
  readonly treasury: Address | null;
  /** The Treasury is never taken below this by signup bonuses. */
  readonly treasuryReserve?: Micros;
  readonly now?: () => number;
}

export type FundResult =
  | { readonly status: 'funded'; readonly txHash: string | null }
  | { readonly status: 'unavailable'; readonly reason: 'DAILY_LIMIT' | 'TREASURY_LOW' | 'NO_TREASURY' | 'FAILED' };

export class WalletService {
  private readonly db: UserDb;
  private readonly chain: ChainOps;
  private readonly now: () => number;
  private readonly reserve: Micros;
  /** One funding transaction at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: WalletServiceOptions) {
    this.db = opts.db;
    this.chain = opts.chain;
    this.now = opts.now ?? Date.now;
    this.reserve = opts.treasuryReserve ?? micros(1_000_000n);
  }

  /** Create the user's wallet if they do not have one. Safe to call repeatedly. */
  ensureWallet(user: UserRow): UserRow {
    if (user.walletAddress) return user;
    const key = this.chain.newKey();
    const address = this.chain.addressOf(key);
    const created = this.db.setWallet(user.id, address, encryptSecret(key, this.opts.encryptionKey, user.id));
    // Lost a race with another request that created it first: use theirs.
    void created;
    return this.db.getUser(user.id) as UserRow;
  }

  /** The user's signing key. Only the payment path should call this. */
  keyFor(user: UserRow): Hex {
    if (!user.walletKeyEnc) throw new Error('user has no wallet');
    return decryptSecret(user.walletKeyEnc, this.opts.encryptionKey, user.id) as Hex;
  }

  /** The user's live on-chain balance. */
  async balance(user: UserRow): Promise<Micros> {
    if (!user.walletAddress) return micros(0n);
    return this.chain.usdcBalance(user.walletAddress as Address);
  }

  /** Give the user their one-time bonus. Idempotent. */
  ensureFunded(user: UserRow): Promise<FundResult> {
    const run = this.queue.then(() => this.fundOnce(user.id));
    // A failure must not poison the queue for the next signup.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fundOnce(userId: string): Promise<FundResult> {
    const user = this.db.getUser(userId);
    if (!user?.walletAddress) return { status: 'unavailable', reason: 'FAILED' };
    if (user.fundStatus === 'funded') return { status: 'funded', txHash: user.fundTx };

    const address = user.walletAddress as Address;

    // A previous attempt may have landed without us recording it. If the wallet
    // already holds a meaningful balance, it has been funded: never pay twice.
    const existing = await this.chain.usdcBalance(address);
    if ((existing as bigint) * 2n >= (this.opts.bonus as bigint)) {
      this.db.setFunding(user.id, 'funded', undefined, this.now());
      return { status: 'funded', txHash: user.fundTx };
    }

    const startOfDay = new Date(this.now());
    startOfDay.setUTCHours(0, 0, 0, 0);
    if (this.db.fundedSince(startOfDay.getTime()) >= this.opts.dailyLimit) {
      return { status: 'unavailable', reason: 'DAILY_LIMIT' };
    }

    if (!this.opts.treasury) return { status: 'unavailable', reason: 'NO_TREASURY' };
    const treasuryBalance = await this.chain.usdcBalance(this.opts.treasury);
    if ((treasuryBalance as bigint) < (this.opts.bonus as bigint) + (this.reserve as bigint)) {
      return { status: 'unavailable', reason: 'TREASURY_LOW' };
    }

    this.db.beginFunding(user.id, this.now());
    try {
      const tx = await this.chain.fund(address, this.opts.bonus);
      this.db.setFunding(user.id, 'funded', tx, this.now());
      return { status: 'funded', txHash: tx };
    } catch {
      // Retry later is safe: the balance check above catches a send that landed.
      this.db.setFunding(user.id, 'failed');
      return { status: 'unavailable', reason: 'FAILED' };
    }
  }

  /**
   * Make sure the user's wallet has approved `splitter` to pull its USDC, so the
   * contract can split an unlock. Done lazily, on the first unlock that needs
   * it. The gas for the approval comes out of the user's own balance.
   */
  async ensureAllowance(user: UserRow, splitter: Address, atLeast: bigint): Promise<void> {
    if (!user.walletAddress) throw new Error('user has no wallet');
    const current = await this.chain.allowance(user.walletAddress as Address, splitter);
    if (current >= atLeast) return;
    const tx = await this.chain.approve(this.keyFor(user), splitter);
    this.db.setApproveTx(user.id, tx);
  }
}
