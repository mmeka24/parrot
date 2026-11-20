/**
 * /api/auth/* and /api/me.
 *
 * The browser reaches these through the web app's own origin (the web app
 * proxies /api to this server), so the session cookie is first-party. A cookie
 * that is first-party and SameSite=Lax is not sent on a cross-site POST, which
 * is what stops a malicious page from acting as the user. Every state-changing
 * route also checks the request's Origin, as a second layer.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import { formatUsd, type ApiErrorDto, type MeDto } from '@parrot/shared';
import type { UserRow } from './user-db.js';
import { Accounts, OAUTH_COOKIE, SESSION_COOKIE, readCookie } from './accounts.js';
import { InvalidEmailError, InvalidSignInError, RateLimitedError } from './auth-service.js';

export interface AuthRoutesOptions {
  readonly accounts: Accounts;
  /** Origins allowed to make state-changing requests (web app, local dev). */
  readonly allowedOrigins: () => readonly string[];
  /** The signup bonus, for display ("$1.00"). */
  readonly bonusDisplay: string;
  /** Extra fields for /api/me that the accounts module does not know about. */
  readonly extendMe?: (user: UserRow) => Partial<MeDto>;
}

const fail = (res: Response, status: number, code: ApiErrorDto['code'], title: string, detail: string): void => {
  res.status(status).json({ ok: false, code, title, detail } satisfies ApiErrorDto);
};

/**
 * Best effort. Behind the web app's proxy the socket address is the proxy's, so
 * prefer the first hop in X-Forwarded-For. A caller can forge that, which only
 * weakens this one layer: the per-address and global limits do not depend on it.
 */
const clientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
};

export function registerAuthRoutes(app: Express, o: AuthRoutesOptions): void {
  const { accounts } = o;

  /** Refuse a state-changing request from a page that is not ours. */
  const sameSiteOnly = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !o.allowedOrigins().includes(origin)) {
      return fail(res, 403, 'BAD_REQUEST', 'Not allowed', 'That request came from somewhere we do not recognise.');
    }
    next();
  };

  app.get('/api/auth/config', (_req, res) => {
    res.json({
      enabled: true,
      providers: accounts.auth.providers,
      bonus: o.bonusDisplay,
    });
  });

  // ---- who am I --------------------------------------------------------------

  app.get('/api/me', async (req, res) => {
    const user = accounts.userFor(req);
    if (!user) return res.json({ signedIn: false });

    // Anyone not yet funded gets another try on every visit (a limit may have
    // lifted, a network blip may have passed). Never blocks the response.
    if (user.fundStatus !== 'funded') void accounts.wallets.ensureFunded(user).catch(() => undefined);

    let balance = null;
    try {
      const onchain = await accounts.syncLedger(user);
      balance = { micros: onchain.toString(), display: formatUsd(onchain) };
    } catch {
      // Chain unreachable: say nothing rather than show a wrong number.
    }
    res.json({
      signedIn: true,
      email: user.email,
      balance,
      funding: user.fundStatus,
      // For the curious; the normal screens do not show it.
      address: user.walletAddress,
      ...(o.extendMe?.(user) ?? {}),
    });
  });

  // ---- emailed link ----------------------------------------------------------

  app.post('/api/auth/email/start', sameSiteOnly, async (req, res) => {
    try {
      await accounts.auth.startEmailSignIn(req.body?.email, clientIp(req));
      res.json({ ok: true });
    } catch (error) {
      if (error instanceof InvalidEmailError) {
        return fail(res, 400, 'BAD_REQUEST', 'Check your email address', 'That does not look like an email address.');
      }
      if (error instanceof RateLimitedError) {
        return fail(res, 429, 'RATE_LIMITED', 'Slow down a little', 'Too many tries. Please wait a few minutes.');
      }
      if (error instanceof InvalidSignInError) {
        return fail(res, 503, 'INTERNAL', 'Email sign-in is not available', 'Try another way to sign in.');
      }
      fail(res, 502, 'INTERNAL', 'We could not send the email', 'Please try again in a minute.');
    }
  });

  app.post('/api/auth/email/verify', sameSiteOnly, async (req, res) => {
    try {
      const result = await accounts.auth.completeEmailSignIn(req.body?.token);
      accounts.setSession(res, result.sessionToken, result.sessionMaxAgeS);
      res.json({ ok: true, created: result.created });
    } catch (error) {
      if (error instanceof InvalidSignInError) {
        return fail(res, 400, 'BAD_REQUEST', 'That link has expired', 'Ask for a new one and use it within 15 minutes.');
      }
      fail(res, 500, 'INTERNAL', 'Something went wrong', 'Please try again.');
    }
  });

  // ---- Google ------------------------------------------------------------------

  app.get('/api/auth/google/start', (_req, res) => {
    try {
      const { url, state } = accounts.auth.googleStart();
      accounts.setOauthState(res, state);
      res.redirect(302, url);
    } catch {
      res.redirect(302, `${accounts.webUrl}/signin?error=google_unavailable`);
    }
  });

  app.get('/api/auth/google/callback', async (req, res) => {
    const back = accounts.webUrl.replace(/\/$/, '');
    try {
      const result = await accounts.auth.googleCallback(
        req.query.code,
        req.query.state,
        readCookie(req, OAUTH_COOKIE),
      );
      accounts.clearOauthState(res);
      accounts.setSession(res, result.sessionToken, result.sessionMaxAgeS);
      res.redirect(302, `${back}/?welcome=${result.created ? 'new' : 'back'}`);
    } catch {
      accounts.clearOauthState(res);
      res.redirect(302, `${back}/signin?error=google_failed`);
    }
  });

  // ---- sign out ----------------------------------------------------------------

  app.post('/api/auth/logout', sameSiteOnly, (req, res) => {
    accounts.auth.signOut(readCookie(req, SESSION_COOKIE));
    accounts.clearSession(res);
    res.json({ ok: true });
  });
}

