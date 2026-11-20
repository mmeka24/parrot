/**
 * Durable storage for accounts: users, sessions, one-time sign-in tokens.
 *
 * The rest of the backend keeps its state in memory and loses it on restart.
 * Users cannot: a wallet the server forgets is money nobody can reach. So this
 * is a small SQLite file (on Fly, on the /data volume).
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.13), imported lazily so a
 * server that does not use accounts still boots on older Node.
 *
 * Only hashes of tokens are stored. Wallet keys arrive already encrypted.
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export type FundStatus = 'none' | 'pending' | 'funded' | 'failed';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly googleSub: string | null;
  readonly createdAt: number;
  readonly walletAddress: string | null;
  /** AES-GCM blob. Never leaves this module except to the wallet service. */
  readonly walletKeyEnc: string | null;
  readonly fundStatus: FundStatus;
  readonly fundTx: string | null;
  readonly fundedAt: number | null;
  readonly approveTx: string | null;
}

interface RawUser {
  id: string;
  email: string;
  google_sub: string | null;
  created_at: number;
  wallet_address: string | null;
  wallet_key_enc: string | null;
  fund_status: FundStatus;
  fund_tx: string | null;
  funded_at: number | null;
  approve_tx: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  google_sub      TEXT UNIQUE,
  created_at      INTEGER NOT NULL,
  wallet_address  TEXT,
  wallet_key_enc  TEXT,
  fund_status     TEXT NOT NULL DEFAULT 'none',
  fund_tx         TEXT,
  funded_at       INTEGER,
  approve_tx      TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash  TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
`;

const toUser = (r: RawUser): UserRow => ({
  id: r.id,
  email: r.email,
  googleSub: r.google_sub,
  createdAt: r.created_at,
  walletAddress: r.wallet_address,
  walletKeyEnc: r.wallet_key_enc,
  fundStatus: r.fund_status,
  fundTx: r.fund_tx,
  fundedAt: r.funded_at,
  approveTx: r.approve_tx,
});

export class UserDb {
  private constructor(private readonly db: DatabaseSync) {}

  /** Open (creating if needed). Use ':memory:' in tests. */
  static async open(path: string): Promise<UserDb> {
    // createRequire, not import(): bundlers and test runners strip the `node:`
    // prefix from `node:sqlite`, which only exists with it.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    return new UserDb(db);
  }

  close(): void {
    this.db.close();
  }

  // ---- users ----------------------------------------------------------------

  getUser(id: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as RawUser | undefined;
    return row ? toUser(row) : undefined;
  }

  getUserByEmail(email: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as RawUser | undefined;
    return row ? toUser(row) : undefined;
  }

  /**
   * Find the user for a verified email, or create them. Returns whether it was
   * a new signup. A Google subject is attached the first time it is seen.
   */
  upsertVerifiedUser(email: string, id: string, now: number, googleSub?: string): { user: UserRow; created: boolean } {
    const existing = this.getUserByEmail(email);
    if (existing) {
      if (googleSub && !existing.googleSub) {
        this.db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(googleSub, existing.id);
      }
      return { user: this.getUser(existing.id) as UserRow, created: false };
    }
    this.db
      .prepare('INSERT INTO users (id, email, google_sub, created_at) VALUES (?, ?, ?, ?)')
      .run(id, email, googleSub ?? null, now);
    return { user: this.getUser(id) as UserRow, created: true };
  }

  setWallet(userId: string, address: string, keyEnc: string): boolean {
    // Only ever set once: a second wallet would orphan the first one's funds.
    const res = this.db
      .prepare('UPDATE users SET wallet_address = ?, wallet_key_enc = ? WHERE id = ? AND wallet_address IS NULL')
      .run(address, keyEnc, userId);
    return Number(res.changes) === 1;
  }

  setFunding(userId: string, status: FundStatus, tx?: string, at?: number): void {
    this.db
      .prepare('UPDATE users SET fund_status = ?, fund_tx = COALESCE(?, fund_tx), funded_at = COALESCE(?, funded_at) WHERE id = ?')
      .run(status, tx ?? null, at ?? null, userId);
  }

  setApproveTx(userId: string, tx: string): void {
    this.db.prepare('UPDATE users SET approve_tx = ? WHERE id = ?').run(tx, userId);
  }

  /** How many wallets were funded since `sinceMs` (for the daily limit). */
  fundedSince(sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE fund_status IN ('funded','pending') AND funded_at >= ?")
      .get(sinceMs) as { n: number };
    return Number(row.n);
  }

  /** Mark a funding attempt as started, so the daily limit counts it immediately. */
  beginFunding(userId: string, at: number): void {
    this.db.prepare("UPDATE users SET fund_status = 'pending', funded_at = ? WHERE id = ?").run(at, userId);
  }

  // ---- sessions -------------------------------------------------------------

  createSession(tokenHash: string, userId: string, now: number, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, now, expiresAt);
  }

  /** The user behind a live session, or undefined. */
  userForSession(tokenHash: string, now: number): UserRow | undefined {
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as RawUser | undefined;
    return row ? toUser(row) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  purgeExpired(now: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM login_tokens WHERE expires_at <= ?').run(now);
  }

  // ---- one-time sign-in tokens ---------------------------------------------

  createLoginToken(tokenHash: string, email: string, now: number, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, email, now, expiresAt);
  }

  /**
   * Spend a token. Atomic: of two concurrent attempts exactly one wins, and an
   * expired or already-used token returns undefined.
   */
  consumeLoginToken(tokenHash: string, now: number): string | undefined {
    const row = this.db
      .prepare(
        `UPDATE login_tokens SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
         RETURNING email`,
      )
      .get(now, tokenHash, now) as { email: string } | undefined;
    return row?.email;
  }
}
