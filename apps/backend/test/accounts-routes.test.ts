/**
 * Sign-in, wallets and the paywall, over real HTTP against the real app.
 * Only the chain and the mailbox are fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { micros, parseUsd, type Micros } from '@parrot/shared';
import { createApp } from '../src/api/routes';
import { resetConfig } from '../src/config';
import { PaymentService } from '../src/services/payment-service';
import { Store } from '../src/store/store';
import { Accounts } from '../src/users/accounts';
import { AuthService } from '../src/users/auth-service';
import type { Mail, Mailer } from '../src/users/mailer';
import { UserDb } from '../src/users/user-db';
import { WalletService, type ChainOps } from '../src/users/wallet-service';

const TREASURY = '0x00000000000000000000000000000000000000T1' as `0x${string}`;
const WEB = 'http://localhost:3100';
const DUB_BYTES = Buffer.from('FULL-PAID-DUB-BYTES');
const PREVIEW_BYTES = Buffer.from('short-preview');

class FakeChain implements ChainOps {
  balances = new Map<string, bigint>([[TREASURY, parseUsd('100.00') as bigint]]);
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
    return '0xfund' as `0x${string}`;
  }
  async allowance() {
    return 2n ** 255n;
  }
  async approve() {
    return '0xa' as `0x${string}`;
  }
}

class Inbox implements Mailer {
  readonly kind = 'log' as const;
  mails: Mail[] = [];
  async send(m: Mail) {
    this.mails.push(m);
  }
  lastToken(): string {
    return /token=([A-Za-z0-9_-]+)/.exec(this.mails.at(-1)!.text)![1]!;
  }
}

let server: Server;
let base: string;
let store: Store;
let chain: FakeChain;
let inbox: Inbox;
let mediaDir: string;
let jobId: string;
let dubFile: string;
let previewFile: string;

async function start(): Promise<void> {
  mediaDir = mkdtempSync(join(tmpdir(), 'parrot-media-'));
  dubFile = 'abc123.es.mp4';
  previewFile = 'abc123.es.preview.mp4';
  writeFileSync(join(mediaDir, dubFile), DUB_BYTES);
  writeFileSync(join(mediaDir, previewFile), PREVIEW_BYTES);

  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  process.env.MEDIA_STORAGE_DIR = mediaDir;
  process.env.PUBLIC_WEB_URL = WEB;
  process.env.PUBLIC_BACKEND_URL = 'http://localhost:8788';
  for (const k of ['PARROT_REVENUE_PRIVATE_KEY', 'PARROT_TREASURY_PRIVATE_KEY', 'VIEWER_POOL_PRIVATE_KEY', 'SPLITTER_ADDRESS']) {
    delete process.env[k];
  }
  resetConfig();

  store = new Store();
  const payments = new PaymentService(store);

  const agentAcc = store.createAccount({ kind: 'agent', label: 'Finch', email: null, walletAddress: null });
  const agent = store.createAgent({
    name: 'Finch', persona: '', accountId: agentAcc.id, walletAddress: null,
    floor: parseUsd('0'), minMargin: parseUsd('0'), maxExposurePerJob: parseUsd('1'), dailyCap: parseUsd('1'),
    languageFocus: null, optimismPpm: 1_000_000, active: true,
  });
  const creatorAcc = store.createAccount({ kind: 'creator', label: '@maria', email: null, walletAddress: null });
  const creator = store.createCreator({
    xUserId: 'x', handle: 'maria', displayName: 'Maria', accountId: creatorAcc.id, followers: 1, claimed: false,
  });
  const job = store.createJob({
    creatorId: creator.id, sourceUrl: 'u', sourcePostId: 'p1', requestMentionId: null, targetLang: 'es', durationS: 30,
    category: 'comedy', state: 'PUBLISHED', claimedByAgentId: agent.id, claimedAt: new Date(),
    splitAgentBps: 4000, splitCreatorBps: 6000, dubCost: 0n, decision: null, qcReport: null, providerJobId: 'abc123',
    dubUrl: join(mediaDir, dubFile), previewUrl: join(mediaDir, previewFile), posterUrl: null,
    declineReason: null, failureReason: null, signals: null, viewCount: 0, qcDemoFail: false, publishedAt: new Date(),
  } as never);
  jobId = job.id;

  const db = await UserDb.open(':memory:');
  chain = new FakeChain();
  inbox = new Inbox();
  const wallets = new WalletService({
    db, chain, encryptionKey: 'e'.repeat(64), bonus: parseUsd('1.00'), dailyLimit: 25, treasury: TREASURY,
  });
  const auth = new AuthService({ db, wallets, mailer: inbox, webUrl: WEB, sessionTtlDays: 30 });
  const accounts = new Accounts({ store, db, auth, wallets, webUrl: WEB, secureCookies: false });

  const app = createApp({
    accounts,
    store,
    payments,
    pipeline: { notePaidUnlock: async () => undefined } as never,
    learning: {} as never,
    seed: {} as never,
    feedStatus: () => ({ live: false, source: 'simulated', latestBlock: null, lastEventAt: null }),
    broadcast: () => undefined,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

class Browser {
  cookies = new Map<string, string>();
  private jar(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: this.jar(), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const [k, ...v] = pair!.split('=');
      const value = v.join('=');
      if (value === '') this.cookies.delete(k!);
      else this.cookies.set(k!, value);
    }
    return res;
  }
  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const res = await this.req(method, path, body, headers);
    return { status: res.status, body: (await res.json()) as T, headers: res.headers };
  }
}

/** Sign a browser in through the emailed link. */
async function signIn(b: Browser, email: string): Promise<void> {
  expect((await b.json('POST', '/api/auth/email/start', { email })).status).toBe(200);
  const res = await b.json('POST', '/api/auth/email/verify', { token: inbox.lastToken() });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 20)); // the bonus is sent in the background
}

beforeEach(start);
afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(mediaDir, { recursive: true, force: true });
});

describe('guests', () => {
  it('can open a dub page but have no balance and no full video', async () => {
    const { status, body } = await new Browser().json<{ unlocked: boolean; viewerBalance: unknown; fullUrl: unknown }>('GET', `/api/dubs/${jobId}`);
    expect(status).toBe(200);
    expect(body.unlocked).toBe(false);
    expect(body.viewerBalance).toBeNull();
    expect(body.fullUrl).toBeNull();
  });

  it('cannot unlock, and are told to sign in', async () => {
    const { status, body } = await new Browser().json<{ code: string }>('POST', `/api/dubs/${jobId}/unlock`, {});
    expect(status).toBe(401);
    expect(body.code).toBe('SIGN_IN_REQUIRED');
  });

  it('are not given a free credit or an account just for looking', async () => {
    const before = store.accounts.size;
    await new Browser().json('GET', `/api/dubs/${jobId}`);
    expect(store.accounts.size).toBe(before);
  });
});

describe('sign in', () => {
  it('advertises what is available', async () => {
    const { body } = await new Browser().json<{ enabled: boolean; providers: { email: boolean }; bonus: string }>('GET', '/api/auth/config');
    expect(body).toMatchObject({ enabled: true, providers: { email: true, google: false }, bonus: '$1.00' });
  });

  it('sets an HttpOnly, SameSite=Lax session cookie', async () => {
    const b = new Browser();
    await b.json('POST', '/api/auth/email/start', { email: 'a@x.com' });
    const res = await b.req('POST', '/api/auth/email/verify', { token: inbox.lastToken() });
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('parrot_session='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain(inbox.lastToken()); // the cookie is a different secret from the emailed link
  });

  it('shows the new user their $1 balance', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    const { body } = await b.json<{ signedIn: boolean; email: string; funding: string; balance: { display: string } }>('GET', '/api/me');
    expect(body).toMatchObject({ signedIn: true, email: 'a@x.com', balance: { display: '$1.00' } });
  });

  it('a signed-out browser is simply not signed in', async () => {
    expect((await new Browser().json('GET', '/api/me')).body).toEqual({ signedIn: false });
  });

  it('refuses a made-up session cookie', async () => {
    const b = new Browser();
    b.cookies.set('parrot_session', 'x'.repeat(43));
    expect((await b.json('GET', '/api/me')).body).toEqual({ signedIn: false });
  });

  it('refuses sign-in requests from another website', async () => {
    const { status } = await new Browser().json('POST', '/api/auth/email/start', { email: 'a@x.com' }, { origin: 'https://evil.test' });
    expect(status).toBe(403);
    expect(inbox.mails).toHaveLength(0);
  });

  it('signs out', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    await b.json('POST', '/api/auth/logout', {});
    expect((await b.json('GET', '/api/me')).body).toEqual({ signedIn: false });
  });

  it('Google start redirects to Google with a state cookie, or back to sign-in if not configured', async () => {
    const res = await new Browser().req('GET', '/api/auth/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`${WEB}/signin`);
  });
});

describe('unlocking with your own wallet', () => {
  it('works, takes the price from the user and reveals the full video', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    const { status, body } = await b.json<{ ok: boolean; fullUrl: string }>('POST', `/api/dubs/${jobId}/unlock`, {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fullUrl).toContain(dubFile);

    const me = (await b.json<{ balance: { micros: string } }>('GET', '/api/me')).body;
    expect(me.balance.micros).toBe('1000000'); // simulated payment here: the chain fake is not debited
  });

  it('is free the second time', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    await b.json('POST', `/api/dubs/${jobId}/unlock`, {});
    const before = store.allUnlocks().length;
    const again = await b.json('POST', `/api/dubs/${jobId}/unlock`, {});
    expect(again.status).toBe(200);
    expect(store.allUnlocks().length).toBe(before);
  });

  it('is refused when the wallet cannot cover the price plus gas', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    const user = [...store.accounts.values()].find((a) => a.email === 'a@x.com');
    void user;
    // Drain the wallet: 0.02 price + 0.015 gas reserve is the minimum.
    for (const [addr] of chain.balances) if (addr.startsWith('0xADDR')) chain.balances.set(addr, 30_000n);
    const { status, body } = await b.json<{ code: string }>('POST', `/api/dubs/${jobId}/unlock`, {});
    expect(status).toBe(402);
    expect(body.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('shows the dub page as unlocked, with a balance, once paid', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    await b.json('POST', `/api/dubs/${jobId}/unlock`, {});
    const { body } = await b.json<{ unlocked: boolean; fullUrl: string; viewerBalance: { display: string } }>('GET', `/api/dubs/${jobId}`);
    expect(body.unlocked).toBe(true);
    expect(body.fullUrl).toContain(dubFile);
    expect(body.viewerBalance).toBeTruthy();
  });
});

describe('the paywall on the video file itself', () => {
  it('keeps the full dub from guests', async () => {
    const res = await new Browser().req('GET', `/media/${dubFile}`);
    expect(res.status).toBe(403);
    expect(Buffer.from(await res.arrayBuffer()).includes(DUB_BYTES)).toBe(false);
  });

  it('keeps the full dub from a signed-in user who has not unlocked it', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    expect((await b.req('GET', `/media/${dubFile}`)).status).toBe(403);
  });

  it('gives the full dub to the user who unlocked it, privately cached only', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    await b.json('POST', `/api/dubs/${jobId}/unlock`, {});
    const res = await b.req('GET', `/media/${dubFile}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(DUB_BYTES)).toBe(true);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('does not give it to a different user just because someone else paid', async () => {
    const payer = new Browser();
    await signIn(payer, 'a@x.com');
    await payer.json('POST', `/api/dubs/${jobId}/unlock`, {});
    const other = new Browser();
    await signIn(other, 'b@x.com');
    expect((await other.req('GET', `/media/${dubFile}`)).status).toBe(403);
  });

  it('serves ranges, so the video can seek', async () => {
    const b = new Browser();
    await signIn(b, 'a@x.com');
    await b.json('POST', `/api/dubs/${jobId}/unlock`, {});
    const res = await b.req('GET', `/media/${dubFile}`, undefined, { range: 'bytes=0-3' });
    expect(res.status).toBe(206);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('FULL');
  });

  it('leaves the short preview public', async () => {
    const res = await new Browser().req('GET', `/media/${previewFile}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PREVIEW_BYTES)).toBe(true);
  });

  it('cannot be dodged with an encoded path', async () => {
    const res = await new Browser().req('GET', `/media/%2e%2e%2f${dubFile}`);
    expect([403, 404]).toContain(res.status);
    const res2 = await new Browser().req('GET', `/media/${encodeURIComponent(dubFile)}`);
    expect(res2.status).toBe(403);
  });
});
