import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashToken, newToken, safeEqual } from '../src/users/crypto';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const PK = '0x' + '1'.repeat(64);

describe('wallet key encryption', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret(PK, KEY, 'user-1'), KEY, 'user-1')).toBe(PK);
  });

  it('never stores the key in the clear', () => {
    const blob = encryptSecret(PK, KEY, 'user-1');
    expect(blob).not.toContain(PK);
    expect(blob).not.toContain('1'.repeat(20));
    expect(blob.startsWith('v1.')).toBe(true);
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(PK, KEY, 'u')).not.toBe(encryptSecret(PK, KEY, 'u'));
  });

  it('refuses the wrong key', () => {
    const blob = encryptSecret(PK, KEY, 'user-1');
    expect(() => decryptSecret(blob, OTHER_KEY, 'user-1')).toThrow();
  });

  it('is bound to the user: the same row pasted under another id will not decrypt', () => {
    const blob = encryptSecret(PK, KEY, 'user-1');
    expect(() => decryptSecret(blob, KEY, 'user-2')).toThrow();
  });

  it('detects tampering', () => {
    const [v, iv, tag, ct] = encryptSecret(PK, KEY, 'user-1').split('.');
    const flipped = ct!.slice(0, -2) + (ct!.endsWith('A') ? 'BB' : 'AA');
    expect(() => decryptSecret([v, iv, tag, flipped].join('.'), KEY, 'user-1')).toThrow();
  });

  it('rejects a malformed key and malformed blobs', () => {
    expect(() => encryptSecret(PK, 'short', 'u')).toThrow(/64 hex/);
    expect(() => decryptSecret('nonsense', KEY, 'u')).toThrow();
    expect(() => decryptSecret('v2.a.b.c', KEY, 'u')).toThrow();
  });
});

describe('tokens', () => {
  it('are long, unique and URL-safe', () => {
    const a = newToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(a);
  });

  it('hash deterministically and do not contain the token', () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });

  it('safeEqual compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
