import { beforeEach, describe, expect, it } from 'vitest';
import { UserDb } from '../src/users/user-db';

let db: UserDb;
beforeEach(async () => {
  db = await UserDb.open(':memory:');
});

const NOW = 1_700_000_000_000;

describe('users', () => {
  it('creates a user once per email and reports whether it was new', () => {
    const a = db.upsertVerifiedUser('a@x.com', 'u1', NOW);
    expect(a.created).toBe(true);
    const b = db.upsertVerifiedUser('a@x.com', 'u2', NOW + 1);
    expect(b.created).toBe(false);
    expect(b.user.id).toBe('u1');
  });

  it('attaches a Google subject the first time it is seen, and keeps it', () => {
    db.upsertVerifiedUser('a@x.com', 'u1', NOW);
    expect(db.upsertVerifiedUser('a@x.com', 'u9', NOW, 'g-1').user.googleSub).toBe('g-1');
    expect(db.upsertVerifiedUser('a@x.com', 'u9', NOW, 'g-2').user.googleSub).toBe('g-1');
  });

  it('sets a wallet exactly once', () => {
    db.upsertVerifiedUser('a@x.com', 'u1', NOW);
    expect(db.setWallet('u1', '0xAAA', 'enc1')).toBe(true);
    expect(db.setWallet('u1', '0xBBB', 'enc2')).toBe(false);
    expect(db.getUser('u1')?.walletAddress).toBe('0xAAA');
    expect(db.getUser('u1')?.walletKeyEnc).toBe('enc1');
  });

  it('counts funding toward the daily limit as soon as it begins', () => {
    db.upsertVerifiedUser('a@x.com', 'u1', NOW);
    db.upsertVerifiedUser('b@x.com', 'u2', NOW);
    expect(db.fundedSince(NOW - 1)).toBe(0);
    db.beginFunding('u1', NOW);
    expect(db.fundedSince(NOW - 1)).toBe(1);
    db.setFunding('u1', 'funded', '0xtx', NOW);
    expect(db.fundedSince(NOW - 1)).toBe(1);
    db.setFunding('u2', 'failed');
    expect(db.fundedSince(NOW - 1)).toBe(1);
    expect(db.getUser('u1')?.fundTx).toBe('0xtx');
  });
});

describe('sessions', () => {
  it('resolve to their user until they expire', () => {
    db.upsertVerifiedUser('a@x.com', 'u1', NOW);
    db.createSession('h1', 'u1', NOW, NOW + 1000);
    expect(db.userForSession('h1', NOW + 999)?.email).toBe('a@x.com');
    expect(db.userForSession('h1', NOW + 1000)).toBeUndefined();
    expect(db.userForSession('nope', NOW)).toBeUndefined();
  });

  it('can be deleted, and purge removes expired ones', () => {
    db.upsertVerifiedUser('a@x.com', 'u1', NOW);
    db.createSession('h1', 'u1', NOW, NOW + 1000);
    db.createSession('h2', 'u1', NOW, NOW + 5000);
    db.deleteSession('h1');
    expect(db.userForSession('h1', NOW)).toBeUndefined();
    db.purgeExpired(NOW + 6000);
    expect(db.userForSession('h2', NOW)).toBeUndefined();
  });
});

describe('one-time sign-in tokens', () => {
  it('can be spent exactly once', () => {
    db.createLoginToken('t1', 'a@x.com', NOW, NOW + 1000);
    expect(db.consumeLoginToken('t1', NOW + 10)).toBe('a@x.com');
    expect(db.consumeLoginToken('t1', NOW + 11)).toBeUndefined();
  });

  it('cannot be spent after they expire, or if unknown', () => {
    db.createLoginToken('t1', 'a@x.com', NOW, NOW + 1000);
    expect(db.consumeLoginToken('t1', NOW + 1000)).toBeUndefined();
    expect(db.consumeLoginToken('zzz', NOW)).toBeUndefined();
  });
});
