/**
 * Glue between sign-in, wallets and the rest of the backend.
 *
 * The rest of the backend thinks in "accounts" with an in-memory ledger. A
 * signed-in user is an account whose id is the user's id.
 *
 * The one thing to keep true: for a signed-in user the REAL balance is the
 * on-chain one. `syncLedger` aligns the ledger to it before anything that
 * spends, so the app never lets someone spend money their wallet does not have.
 */

import type { Request, Response } from 'express';
import { micros, type Micros } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Account } from '../store/types.js';
import type { AuthService } from './auth-service.js';
import type { UserDb, UserRow } from './user-db.js';
import type { WalletService } from './wallet-service.js';

export const SESSION_COOKIE = 'parrot_session';
export const OAUTH_COOKIE = 'parrot_oauth';

export interface AccountsOptions {
  readonly store: Store;
  readonly db: UserDb;
  readonly auth: AuthService;
  readonly wallets: WalletService;
  readonly webUrl: string;
  /** Add the Secure flag. True behind https. */
  readonly secureCookies: boolean;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export class Accounts {
  readonly auth: AuthService;
  readonly wallets: WalletService;
  readonly db: UserDb;
  readonly webUrl: string;

  constructor(private readonly o: AccountsOptions) {
    this.auth = o.auth;
    this.wallets = o.wallets;
    this.db = o.db;
    this.webUrl = o.webUrl;
  }

  /** The signed-in user for this request, if any. */
  userFor(req: Request): UserRow | undefined {
    return this.auth.userForSession(readCookie(req, SESSION_COOKIE));
  }

  /** The ledger account for a user, created on first use (the ledger is in memory). */
  accountFor(user: UserRow): Account {
    const existing = this.o.store.getAccount(user.id);
    if (existing) return existing;
    return this.o.store.createAccount({
      id: user.id,
      kind: 'creator',
      label: user.email.split('@')[0] ?? 'Creator',
      email: user.email,
      walletAddress: user.walletAddress,
    });
  }

  /**
   * Align the user's ledger with their real, on-chain balance, and return that
   * balance. If the chain cannot be read, the ledger is left as it is and the
   * error is thrown: spending must not proceed on a guess.
   */
  async syncLedger(user: UserRow): Promise<Micros> {
    const account = this.accountFor(user);
    const onchain = await this.wallets.balance(user);
    const diff = (onchain as bigint) - (this.o.store.balanceOf(account.id) as bigint);
    if (diff !== 0n) {
      this.o.store.appendLedger({
        accountId: account.id,
        amount: micros(diff),
        kind: 'wallet_sync',
        ref: 'onchain-balance',
      });
    }
    return onchain;
  }

  // ---- cookies --------------------------------------------------------------

  setSession(res: Response, token: string, maxAgeS: number): void {
    this.appendCookie(res, `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${this.secure}`);
  }

  clearSession(res: Response): void {
    this.appendCookie(res, `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${this.secure}`);
  }

  setOauthState(res: Response, state: string): void {
    this.appendCookie(res, `${OAUTH_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${this.secure}`);
  }

  clearOauthState(res: Response): void {
    this.appendCookie(res, `${OAUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${this.secure}`);
  }

  private get secure(): string {
    return this.o.secureCookies ? '; Secure' : '';
  }

  private appendCookie(res: Response, cookie: string): void {
    const existing = res.getHeader('Set-Cookie');
    const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
    res.setHeader('Set-Cookie', [...list, cookie]);
  }
}
