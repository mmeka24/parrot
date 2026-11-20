/**
 * Sign-in: emailed one-time links and Google. Both end the same way: a verified
 * email, a user row, a wallet, and a session.
 *
 * What this relies on being true, and where it is enforced:
 *  - A sign-in link works once and for 15 minutes (login_tokens, atomic).
 *  - Only a hash of any token is stored (crypto.hashToken).
 *  - The same email is the same user, whichever way they sign in. Google's
 *    email is trusted only when Google says it is verified.
 *  - Asking for a link never reveals whether an email has an account.
 */

import { randomUUID } from 'node:crypto';
import { hashToken, newToken, safeEqual } from './crypto.js';
import { signInEmail, type Mailer } from './mailer.js';
import type { UserDb, UserRow } from './user-db.js';
import type { WalletService } from './wallet-service.js';

const LINK_MINUTES = 15;
const HOUR_MS = 60 * 60 * 1000;
const PER_EMAIL_PER_HOUR = 3;
const PER_IP_PER_HOUR = 20;
/** Across everyone: bounds an abuser spraying many addresses, and the email bill. */
const GLOBAL_PER_HOUR = 300;

export class RateLimitedError extends Error {
  constructor() {
    super('too many sign-in requests');
    this.name = 'RateLimitedError';
  }
}
export class InvalidEmailError extends Error {
  constructor() {
    super('invalid email');
    this.name = 'InvalidEmailError';
  }
}
export class InvalidSignInError extends Error {
  constructor(message = 'that sign-in link is not valid') {
    super(message);
    this.name = 'InvalidSignInError';
  }
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface AuthServiceOptions {
  readonly db: UserDb;
  readonly wallets: WalletService;
  readonly mailer: Mailer | null;
  /** Where the web app lives. Sign-in links and the Google redirect point here. */
  readonly webUrl: string;
  readonly sessionTtlDays: number;
  readonly google?: GoogleConfig | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface SignedIn {
  readonly user: UserRow;
  readonly created: boolean;
  /** The raw session token, to be set as a cookie. Never stored. */
  readonly sessionToken: string;
  readonly sessionMaxAgeS: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidEmailError();
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new InvalidEmailError();
  return email;
}

export class AuthService {
  private readonly db: UserDb;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: AuthServiceOptions) {
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get providers(): { email: boolean; google: boolean } {
    return { email: this.opts.mailer !== null, google: this.opts.google !== undefined };
  }

  // ---- emailed link ---------------------------------------------------------

  /**
   * Email a sign-in link. Resolves the same way whether or not the address has
   * an account, and whether or not this address is being rate limited.
   * Only an IP-level limit is reported, since that does not reveal anything
   * about an email.
   */
  async startEmailSignIn(rawEmail: unknown, ip: string): Promise<void> {
    if (!this.opts.mailer) throw new InvalidSignInError('email sign-in is not available');
    const email = normalizeEmail(rawEmail);

    if (!this.allow('global', GLOBAL_PER_HOUR) || !this.allow(`ip:${ip}`, PER_IP_PER_HOUR)) {
      throw new RateLimitedError();
    }
    if (!this.allow(`email:${email}`, PER_EMAIL_PER_HOUR)) return; // silently: do not reveal anything

    const token = newToken();
    const now = this.now();
    this.db.createLoginToken(hashToken(token), email, now, now + LINK_MINUTES * 60_000);
    const link = `${this.opts.webUrl.replace(/\/$/, '')}/auth/verify?token=${token}`;
    await this.opts.mailer.send(signInEmail(email, link, LINK_MINUTES));
  }

  /** Spend a sign-in link. Throws InvalidSignInError if it is unknown, used or expired. */
  async completeEmailSignIn(token: unknown): Promise<SignedIn> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) throw new InvalidSignInError();
    const email = this.db.consumeLoginToken(hashToken(token), this.now());
    if (!email) throw new InvalidSignInError();
    return this.signIn(email);
  }

  // ---- Google ---------------------------------------------------------------

  /** The URL to send the browser to, and the state to remember in a cookie. */
  googleStart(): { url: string; state: string } {
    const g = this.opts.google;
    if (!g) throw new InvalidSignInError('Google sign-in is not available');
    const state = newToken();
    const params = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: this.googleRedirectUri(),
      response_type: 'code',
      scope: 'openid email',
      state,
      prompt: 'select_account',
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state };
  }

  googleRedirectUri(): string {
    return `${this.opts.webUrl.replace(/\/$/, '')}/api/auth/google/callback`;
  }

  /** Finish Google sign-in. `cookieState` is the state remembered at the start. */
  async googleCallback(code: unknown, state: unknown, cookieState: unknown): Promise<SignedIn> {
    const g = this.opts.google;
    if (!g) throw new InvalidSignInError('Google sign-in is not available');
    if (
      typeof code !== 'string' ||
      typeof state !== 'string' ||
      typeof cookieState !== 'string' ||
      !safeEqual(state, cookieState)
    ) {
      throw new InvalidSignInError();
    }

    const tokenRes = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: g.clientId,
        client_secret: g.clientSecret,
        redirect_uri: this.googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw new InvalidSignInError();
    const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
    if (!idToken) throw new InvalidSignInError();

    // Google verifies the signature and expiry; we then check who it is for.
    const infoRes = await this.fetchImpl(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!infoRes.ok) throw new InvalidSignInError();
    const info = (await infoRes.json()) as {
      aud?: string;
      iss?: string;
      sub?: string;
      email?: string;
      email_verified?: string | boolean;
      exp?: string | number;
    };
    const issuerOk = info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
    const verified = info.email_verified === true || info.email_verified === 'true';
    const expiresOk = Number(info.exp) * 1000 > this.now();
    if (info.aud !== g.clientId || !issuerOk || !verified || !expiresOk || !info.email || !info.sub) {
      throw new InvalidSignInError();
    }
    return this.signIn(normalizeEmail(info.email), info.sub);
  }

  // ---- sessions -------------------------------------------------------------

  /** The user behind a session cookie value, if it is live. */
  userForSession(token: string | undefined): UserRow | undefined {
    if (!token) return undefined;
    return this.db.userForSession(hashToken(token), this.now());
  }

  signOut(token: string | undefined): void {
    if (token) this.db.deleteSession(hashToken(token));
  }

  // ---- shared ---------------------------------------------------------------

  private async signIn(email: string, googleSub?: string): Promise<SignedIn> {
    const now = this.now();
    this.db.purgeExpired(now);
    const { user: found, created } = this.db.upsertVerifiedUser(email, randomUUID(), now, googleSub);
    const user = this.opts.wallets.ensureWallet(found);

    // Fund in the background so sign-in is instant. If it cannot happen now
    // (limit, Treasury low, network), the next sign-in tries again.
    void this.opts.wallets.ensureFunded(user).catch(() => undefined);

    const token = newToken();
    const maxAgeS = this.opts.sessionTtlDays * 24 * 60 * 60;
    this.db.createSession(hashToken(token), user.id, now, now + maxAgeS * 1000);
    return { user, created, sessionToken: token, sessionMaxAgeS: maxAgeS };
  }

  /** Sliding-window limiter, in memory. */
  private allow(key: string, limit: number): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
