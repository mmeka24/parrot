import { beforeEach, describe, expect, it } from 'vitest';
import { micros, parseUsd, type Micros } from '@parrot/shared';
import { UserDb, type UserRow } from '../src/users/user-db';
import { WalletService, type ChainOps } from '../src/users/wallet-service';

const ENC = 'c'.repeat(64);
const TREASURY = '0x00000000000000000000000000000000000000T1';
const SPLITTER = '0x00000000000000000000000000000000000000S1';
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

class FakeChain implements ChainOps {
  balances = new Map<string, bigint>();
  funded: Array<{ to: string; amount: bigint }> = [];
  approvals: string[] = [];
  allowances = new Map<string, bigint>();
  failNextFund = false;
  landThenThrow = false;
  inFlight = 0;
  maxInFlight = 0;
  private n = 0;

  newKey() {
    this.n += 1;
    return `0x${this.n.toString(16).padStart(64, '0')}` as `0x${string}`;
  }
  addressOf(key: `0x${string}`) {
    return `0xADDR${key.slice(-6)}` as `0x${string}`;
  }
  async usdcBalance(address: string): Promise<Micros> {
    return micros(this.balances.get(address) ?? 0n);
  }
  async fund(to: `0x${string}`, amount: Micros) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 5));
    this.inFlight -= 1;
    if (this.landThenThrow) {
      // The transfer lands on-chain but we never hear back.
      this.balances.set(to, (this.balances.get(to) ?? 0n) + (amount as bigint));
      this.funded.push({ to, amount: amount as bigint });
      this.landThenThrow = false;
      throw new Error('timeout waiting for receipt');
    }
    if (this.failNextFund) {
      this.failNextFund = false;
      throw new Error('rpc down');
    }
    this.balances.set(to, (this.balances.get(to) ?? 0n) + (amount as bigint));
    this.funded.push({ to, amount: amount as bigint });
    return `0xtx${this.funded.length}` as `0x${string}`;
  }
  async allowance(owner: string, spender: string) {
    return this.allowances.get(`${owner}:${spender}`) ?? 0n;
  }
  async approve(userKey: `0x${string}`, spender: `0x${string}`) {
    this.approvals.push(userKey);
    this.allowances.set(`${this.addressOf(userKey)}:${spender}`, 2n ** 255n);
    return '0xapprove' as `0x${string}`;
  }
}

let db: UserDb;
let chain: FakeChain;
let svc: WalletService;
let clock: number;

function make(opts: { dailyLimit?: number; treasuryUsd?: string } = {}): void {
  chain = new FakeChain();
  chain.balances.set(TREASURY, parseUsd(opts.treasuryUsd ?? '20.00') as bigint);
  svc = new WalletService({
    db,
    chain,
    encryptionKey: ENC,
    bonus: parseUsd('1.00'),
    dailyLimit: opts.dailyLimit ?? 25,
    treasury: TREASURY as `0x${string}`,
    now: () => clock,
  });
}

function newUser(email: string, id = email): UserRow {
  return svc.ensureWallet(db.upsertVerifiedUser(email, id, NOW).user);
}

beforeEach(async () => {
  db = await UserDb.open(':memory:');
  clock = NOW;
  make();
});

describe('wallet creation', () => {
  it('creates one wallet per user and keeps it', () => {
    const a = newUser('a@x.com');
    expect(a.walletAddress).toMatch(/^0xADDR/);
    expect(svc.ensureWallet(a).walletAddress).toBe(a.walletAddress);
  });

  it('stores the key encrypted, and the service can recover it for signing', () => {
    const a = newUser('a@x.com');
    expect(a.walletKeyEnc).toBeTruthy();
    expect(a.walletKeyEnc).not.toContain('000000000000000000000000000000000000000000000000000000000000');
    expect(chain.addressOf(svc.keyFor(a))).toBe(a.walletAddress);
  });

  it('gives different users different wallets', () => {
    expect(newUser('a@x.com').walletAddress).not.toBe(newUser('b@x.com').walletAddress);
  });
});

describe('signup bonus', () => {
  it('sends $1 once and records it', async () => {
    const a = newUser('a@x.com');
    const r = await svc.ensureFunded(a);
    expect(r).toEqual({ status: 'funded', txHash: '0xtx1' });
    expect(chain.funded).toEqual([{ to: a.walletAddress, amount: 1_000_000n }]);
    expect(db.getUser(a.id)?.fundStatus).toBe('funded');
  });

  it('never pays the same user twice', async () => {
    const a = newUser('a@x.com');
    await svc.ensureFunded(a);
    await svc.ensureFunded(a);
    await Promise.all([svc.ensureFunded(a), svc.ensureFunded(a)]);
    expect(chain.funded).toHaveLength(1);
  });

  it('serialises sends, so concurrent signups do not race on the Treasury', async () => {
    const users = ['a', 'b', 'c', 'd', 'e'].map((n) => newUser(`${n}@x.com`));
    await Promise.all(users.map((u) => svc.ensureFunded(u)));
    expect(chain.funded).toHaveLength(5);
    expect(chain.maxInFlight).toBe(1);
  });

  it('can be retried after a failed send, and still pays only once', async () => {
    const a = newUser('a@x.com');
    chain.failNextFund = true;
    expect(await svc.ensureFunded(a)).toEqual({ status: 'unavailable', reason: 'FAILED' });
    expect(db.getUser(a.id)?.fundStatus).toBe('failed');
    expect((await svc.ensureFunded(a)).status).toBe('funded');
    expect(chain.funded).toHaveLength(1);
  });

  it('does not pay again when a send landed but the confirmation was lost', async () => {
    const a = newUser('a@x.com');
    chain.landThenThrow = true;
    expect((await svc.ensureFunded(a)).status).toBe('unavailable');
    // Retry: the wallet already holds the money, so it is marked funded, not paid again.
    expect((await svc.ensureFunded(a)).status).toBe('funded');
    expect(chain.funded).toHaveLength(1);
  });

  it('stops at the daily limit, and resumes the next UTC day', async () => {
    make({ dailyLimit: 2 });
    const [a, b, c] = ['a', 'b', 'c'].map((n) => newUser(`${n}@x.com`)) as [UserRow, UserRow, UserRow];
    await svc.ensureFunded(a);
    await svc.ensureFunded(b);
    expect(await svc.ensureFunded(c)).toEqual({ status: 'unavailable', reason: 'DAILY_LIMIT' });
    expect(chain.funded).toHaveLength(2);
    clock += 24 * 60 * 60 * 1000;
    expect((await svc.ensureFunded(c)).status).toBe('funded');
  });

  it('keeps the Treasury reserve: never drains it below the floor', async () => {
    make({ treasuryUsd: '1.50' }); // bonus 1.00 + reserve 1.00 > 1.50
    const a = newUser('a@x.com');
    expect(await svc.ensureFunded(a)).toEqual({ status: 'unavailable', reason: 'TREASURY_LOW' });
    expect(chain.funded).toHaveLength(0);
  });

  it('reports a user whose wallet was never created as unavailable', async () => {
    const bare = db.upsertVerifiedUser('z@x.com', 'z', NOW).user;
    expect(await svc.ensureFunded(bare)).toEqual({ status: 'unavailable', reason: 'FAILED' });
  });
});

describe('allowance for the splitter', () => {
  it('approves once, from the user wallet, and not again', async () => {
    const a = newUser('a@x.com');
    await svc.ensureAllowance(a, SPLITTER as `0x${string}`, 20_000n);
    await svc.ensureAllowance(a, SPLITTER as `0x${string}`, 20_000n);
    expect(chain.approvals).toHaveLength(1);
    expect(db.getUser(a.id)?.approveTx).toBe('0xapprove');
  });
});

describe('balance', () => {
  it('reads the live on-chain balance', async () => {
    const a = newUser('a@x.com');
    expect(await svc.balance(a)).toBe(0n);
    await svc.ensureFunded(a);
    expect(await svc.balance(a)).toBe(1_000_000n);
  });
});
