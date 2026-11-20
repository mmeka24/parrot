import { beforeEach, describe, expect, it } from 'vitest';
import { micros, parseUsd, type Micros } from '@parrot/shared';
import {
  AuthService,
  InvalidEmailError,
  InvalidSignInError,
  RateLimitedError,
  normalizeEmail,
} from '../src/users/auth-service';
import type { Mail, Mailer } from '../src/users/mailer';
import { UserDb } from '../src/users/user-db';
import { WalletService, type ChainOps } from '../src/users/wallet-service';

const TREASURY = '0x00000000000000000000000000000000000000T1' as `0x${string}`;
const WEB = 'https://app.example.test';
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

class FakeChain implements ChainOps {
  balances = new Map<string, bigint>([[TREASURY, parseUsd('50.00') as bigint]]);
  funded: string[] = [];
  private n = 0;
  newKey() {
    this.n += 1;
    return `0x${this.n.toString(16).padStart(64, '0')}` as `0x${string}`;
  }
  addressOf(k: `0x${string}`) {
    return `0xADDR${k.slice(-6)}` as `0x${string}`;
  }
  async usdcBalance(a: string): Promise<Micros> {
    return micros(this.balances.get(a) ?? 0n);
  }
  async fund(to: `0x${string}`, amount: Micros) {
    this.balances.set(to, (this.balances.get(to) ?? 0n) + (amount as bigint));
    this.funded.push(to);
    return '0xtx' as `0x${string}`;
  }
  async allowance() {
    return 0n;
  }
  async approve() {
    return '0xa' as `0x${string}`;
  }
}

class CaptureMailer implements Mailer {
  readonly kind = 'log' as const;
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
  tokenOf(i = this.sent.length - 1): string {
    return /token=([A-Za-z0-9_-]+)/.exec(this.sent[i]!.text)![1]!;
  }
}

let db: UserDb;
let chain: FakeChain;
let mailer: CaptureMailer;
let clock: number;
let auth: AuthService;
let fetchLog: string[];
let googleInfo: Record<string, unknown>;

function fakeFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    fetchLog.push(u);
    // tokeninfo first: its URL also starts with the token endpoint's.
    if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return new Response(JSON.stringify(googleInfo), { status: 200 });
    }
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ id_token: 'IDTOKEN' }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

beforeEach(async () => {
  db = await UserDb.open(':memory:');
  chain = new FakeChain();
  mailer = new CaptureMailer();
  clock = T0;
  fetchLog = [];
  googleInfo = {
    aud: 'cid',
    iss: 'https://accounts.google.com',
    sub: 'g-123',
    email: 'Maria@Example.com',
    email_verified: 'true',
    exp: String(Math.floor(T0 / 1000) + 3600),
  };
  const wallets = new WalletService({
    db,
    chain,
    encryptionKey: 'd'.repeat(64),
    bonus: parseUsd('1.00'),
    dailyLimit: 25,
    treasury: TREASURY,
    now: () => clock,
  });
  auth = new AuthService({
    db,
    wallets,
    mailer,
    webUrl: WEB,
    sessionTtlDays: 30,
    google: { clientId: 'cid', clientSecret: 'secret' },
    fetchImpl: fakeFetch(),
    now: () => clock,
  });
});

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('normalizeEmail', () => {
  it('lowercases and trims', () => expect(normalizeEmail('  Maria@Example.COM ')).toBe('maria@example.com'));
  it.each(['', 'nope', 'a@b', '@x.com', 'a b@x.com', 5, null, 'a'.repeat(300) + '@x.com'])('rejects %s', (v) => {
    expect(() => normalizeEmail(v)).toThrow(InvalidEmailError);
  });
});

describe('emailed sign-in link', () => {
  it('sends a link to the web app, and signing in with it creates a user, a wallet and a session', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe('a@x.com');
    expect(mailer.sent[0]!.text).toContain(`${WEB}/auth/verify?token=`);

    const result = await auth.completeEmailSignIn(mailer.tokenOf());
    expect(result.created).toBe(true);
    expect(result.user.email).toBe('a@x.com');
    expect(result.user.walletAddress).toMatch(/^0xADDR/);
    expect(auth.userForSession(result.sessionToken)?.id).toBe(result.user.id);
  });

  it('funds the new wallet with the bonus, in the background', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const { user } = await auth.completeEmailSignIn(mailer.tokenOf());
    await settle();
    expect(chain.funded).toEqual([user.walletAddress]);
  });

  it('works once only', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const token = mailer.tokenOf();
    await auth.completeEmailSignIn(token);
    await expect(auth.completeEmailSignIn(token)).rejects.toBeInstanceOf(InvalidSignInError);
  });

  it('expires after 15 minutes', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    clock += 15 * 60_000;
    await expect(auth.completeEmailSignIn(mailer.tokenOf())).rejects.toBeInstanceOf(InvalidSignInError);
  });

  it('rejects junk and guessed tokens', async () => {
    for (const t of ['', 'short', 'x'.repeat(43), 42, null, undefined]) {
      await expect(auth.completeEmailSignIn(t)).rejects.toBeInstanceOf(InvalidSignInError);
    }
  });

  it('never stores the token itself, only its hash', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const token = mailer.tokenOf();
    // The raw token is not a database key: looking it up directly finds nothing.
    expect(db.consumeLoginToken(token, clock)).toBeUndefined();
  });

  it('signing in twice is the same user with the same wallet', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const first = await auth.completeEmailSignIn(mailer.tokenOf());
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const second = await auth.completeEmailSignIn(mailer.tokenOf());
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.walletAddress).toBe(first.user.walletAddress);
    await settle();
    expect(chain.funded).toHaveLength(1);
  });

  it('is not case sensitive about the address', async () => {
    await auth.startEmailSignIn('A@X.com', '1.1.1.1');
    const a = await auth.completeEmailSignIn(mailer.tokenOf());
    await auth.startEmailSignIn('a@x.COM', '1.1.1.1');
    const b = await auth.completeEmailSignIn(mailer.tokenOf());
    expect(b.user.id).toBe(a.user.id);
  });

  it('limits one address to 3 links an hour, silently, without revealing anything', async () => {
    for (let i = 0; i < 5; i++) await expect(auth.startEmailSignIn('a@x.com', `9.9.9.${i}`)).resolves.toBeUndefined();
    expect(mailer.sent).toHaveLength(3);
    clock += 60 * 60_000 + 1;
    await auth.startEmailSignIn('a@x.com', '9.9.9.9');
    expect(mailer.sent).toHaveLength(4);
  });

  it('limits one IP and says so', async () => {
    for (let i = 0; i < 20; i++) await auth.startEmailSignIn(`u${i}@x.com`, '5.5.5.5');
    await expect(auth.startEmailSignIn('more@x.com', '5.5.5.5')).rejects.toBeInstanceOf(RateLimitedError);
    await expect(auth.startEmailSignIn('more@x.com', '6.6.6.6')).resolves.toBeUndefined();
  });

  it('caps total emails per hour across everyone', async () => {
    for (let i = 0; i < 300; i++) await auth.startEmailSignIn(`g${i}@x.com`, `10.0.${Math.floor(i / 20)}.${i % 20}`);
    await expect(auth.startEmailSignIn('one-more@x.com', '10.9.9.9')).rejects.toBeInstanceOf(RateLimitedError);
    expect(mailer.sent).toHaveLength(300);
  });

  it('does not email an invalid address', async () => {
    await expect(auth.startEmailSignIn('not-an-email', '1.1.1.1')).rejects.toBeInstanceOf(InvalidEmailError);
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('sessions', () => {
  it('end on sign-out and on expiry', async () => {
    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const { sessionToken, sessionMaxAgeS } = await auth.completeEmailSignIn(mailer.tokenOf());
    expect(sessionMaxAgeS).toBe(30 * 86400);
    expect(auth.userForSession(sessionToken)).toBeDefined();
    auth.signOut(sessionToken);
    expect(auth.userForSession(sessionToken)).toBeUndefined();

    await auth.startEmailSignIn('a@x.com', '1.1.1.1');
    const second = await auth.completeEmailSignIn(mailer.tokenOf());
    clock += 31 * 86400_000;
    expect(auth.userForSession(second.sessionToken)).toBeUndefined();
  });

  it('are not valid when guessed', () => {
    expect(auth.userForSession(undefined)).toBeUndefined();
    expect(auth.userForSession('x'.repeat(43))).toBeUndefined();
  });
});

describe('Google', () => {
  it('signs in with a verified email, and the redirect lands on the web app', async () => {
    const { url, state } = auth.googleStart();
    expect(url).toContain('accounts.google.com');
    expect(url).toContain(encodeURIComponent(`${WEB}/api/auth/google/callback`));
    const result = await auth.googleCallback('code', state, state);
    expect(result.user.email).toBe('maria@example.com');
    expect(result.user.googleSub).toBe('g-123');
    expect(result.user.walletAddress).toBeTruthy();
  });

  it('is the same user as the emailed link for that address', async () => {
    await auth.startEmailSignIn('maria@example.com', '1.1.1.1');
    const viaEmail = await auth.completeEmailSignIn(mailer.tokenOf());
    const { state } = auth.googleStart();
    const viaGoogle = await auth.googleCallback('code', state, state);
    expect(viaGoogle.user.id).toBe(viaEmail.user.id);
    expect(viaGoogle.user.walletAddress).toBe(viaEmail.user.walletAddress);
  });

  it('rejects a mismatched or missing state (CSRF)', async () => {
    const { state } = auth.googleStart();
    await expect(auth.googleCallback('code', state, 'other')).rejects.toBeInstanceOf(InvalidSignInError);
    await expect(auth.googleCallback('code', state, undefined)).rejects.toBeInstanceOf(InvalidSignInError);
    await expect(auth.googleCallback('code', undefined, state)).rejects.toBeInstanceOf(InvalidSignInError);
    expect(fetchLog).toHaveLength(0); // never even called Google
  });

  it.each([
    ['wrong audience', { aud: 'someone-elses-client' }],
    ['unverified email', { email_verified: 'false' }],
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['expired', { exp: '1' }],
    ['no subject', { sub: undefined }],
    ['no email', { email: undefined }],
  ])('rejects a token with %s', async (_name, patch) => {
    googleInfo = { ...googleInfo, ...patch };
    const { state } = auth.googleStart();
    await expect(auth.googleCallback('code', state, state)).rejects.toBeInstanceOf(InvalidSignInError);
  });

  it('accepts email_verified as a boolean too', async () => {
    googleInfo = { ...googleInfo, email_verified: true };
    const { state } = auth.googleStart();
    await expect(auth.googleCallback('code', state, state)).resolves.toBeDefined();
  });
});

describe('providers', () => {
  it('reports what is configured', async () => {
    expect(auth.providers).toEqual({ email: true, google: true });
    const bare = new AuthService({
      db,
      wallets: new WalletService({
        db,
        chain,
        encryptionKey: 'd'.repeat(64),
        bonus: parseUsd('1.00'),
        dailyLimit: 1,
        treasury: null,
      }),
      mailer: null,
      webUrl: WEB,
      sessionTtlDays: 1,
    });
    expect(bare.providers).toEqual({ email: false, google: false });
    await expect(bare.startEmailSignIn('a@x.com', 'ip')).rejects.toBeInstanceOf(InvalidSignInError);
    expect(() => bare.googleStart()).toThrow(InvalidSignInError);
  });
});
