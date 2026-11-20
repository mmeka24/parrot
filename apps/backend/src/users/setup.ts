/**
 * Decides at startup whether accounts are on, and builds them if so.
 *
 * With accounts on, a creator can sign in and pay for their views from their
 * own balance. They must never switch on half-configured. All of these must
 * hold:
 *   - WALLET_ENCRYPTION_KEY is set (wallet keys are encrypted with it);
 *   - on-chain settlement is configured (wallets need a funding source);
 *   - at least one way to sign in exists (emailed links or Google);
 *   - the database opens (needs Node >= 22.13 for node:sqlite).
 * Otherwise creators run on demo balances only, and the reason is reported.
 */

import { parseUsd } from '@parrot/shared';
import type { Config } from '../config.js';
import type { Store } from '../store/store.js';
import { addressFromKey, type Hex } from '../chain/client.js';
import { Accounts } from './accounts.js';
import { AuthService } from './auth-service.js';
import { LogMailer, ResendMailer, type Mailer } from './mailer.js';
import { UserDb } from './user-db.js';
import { WalletService, realChainOps } from './wallet-service.js';

export interface AccountsSetup {
  readonly accounts: Accounts | null;
  /** One line for the startup banner. */
  readonly status: string;
}

export async function buildAccounts(config: Config, store: Store): Promise<AccountsSetup> {
  const env = config.env;
  const off = (why: string): AccountsSetup => ({ accounts: null, status: `off (${why}); creators use demo balances` });

  if (!env.WALLET_ENCRYPTION_KEY) return off('WALLET_ENCRYPTION_KEY not set');
  const treasuryKey = env.PARROT_TREASURY_PRIVATE_KEY as Hex | undefined;
  if (!config.capabilities.onchainPayments || !treasuryKey) return off('needs the on-chain wallet keys');

  let mailer: Mailer | null = null;
  if (env.RESEND_API_KEY && env.EMAIL_FROM) mailer = new ResendMailer(env.RESEND_API_KEY, env.EMAIL_FROM);
  else if (env.NODE_ENV !== 'production') mailer = new LogMailer();
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : undefined;
  if (!mailer && !google) return off('no sign-in method: set RESEND_API_KEY + EMAIL_FROM, or the Google keys');

  let db: UserDb;
  try {
    db = await UserDb.open(env.USERS_DB_PATH);
  } catch (error) {
    return off(`user database unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const wallets = new WalletService({
    db,
    chain: realChainOps(treasuryKey),
    encryptionKey: env.WALLET_ENCRYPTION_KEY,
    bonus: parseUsd(env.SIGNUP_BONUS_USD),
    dailyLimit: env.SIGNUP_DAILY_LIMIT,
    treasury: addressFromKey(treasuryKey),
  });
  const webUrl = env.PUBLIC_WEB_URL.replace(/\/$/, '');
  const auth = new AuthService({
    db,
    wallets,
    mailer,
    webUrl,
    sessionTtlDays: env.SESSION_TTL_DAYS,
    google,
  });
  const accounts = new Accounts({ store, db, auth, wallets, webUrl, secureCookies: webUrl.startsWith('https://') });

  const methods = [google ? 'Google' : null, mailer ? (mailer.kind === 'log' ? 'email (dev: link in the log)' : 'email') : null]
    .filter(Boolean)
    .join(' + ');
  return { accounts, status: `on, sign in with ${methods}; $${env.SIGNUP_BONUS_USD} to each new wallet, max ${env.SIGNUP_DAILY_LIMIT}/day` };
}
