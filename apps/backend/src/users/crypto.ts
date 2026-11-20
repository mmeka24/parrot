/**
 * Small, boring crypto for accounts.
 *
 *  - Wallet keys are encrypted at rest with AES-256-GCM. The ciphertext is bound
 *    to the user's id (as authenticated data), so a stolen row cannot be pasted
 *    under a different user and decrypted.
 *  - Sign-in and session tokens are random 256-bit values. Only their SHA-256 is
 *    stored, so a leaked database does not leak a usable token.
 *
 * Nothing here logs, and nothing returns a key except `decryptSecret`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

function keyBytes(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error('encryption key must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

/** Encrypt `plain`; `aad` (the user id) is authenticated but not stored in the blob. */
export function encryptSecret(plain: string, keyHex: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(keyHex), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Throws if the blob was tampered with, the key is wrong, or `aad` does not match. */
export function decryptSecret(blob: string, keyHex: string, aad: string): string {
  const [version, iv, tag, ciphertext] = blob.split('.');
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error('unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(keyHex), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/** A fresh random token, safe in a URL or cookie. 256 bits. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
