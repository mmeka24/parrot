/**
 * The "crypto is invisible" guard.
 *
 * This test is the enforcement mechanism for the product's central promise. If
 * someone writes "connect your wallet" into a button label, the build fails.
 */

import { describe, it, expect } from 'vitest';
import { copy, technicalCopy, FORBIDDEN_WORDS, fill } from '../src/copy.js';

/** Walk the copy tree and yield [path, string] for every leaf. */
function collectStrings(
  node: unknown,
  path: string[] = [],
): Array<{ path: string; value: string }> {
  if (typeof node === 'string') return [{ path: path.join('.'), value: node }];
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, child]) => collectStrings(child, [...path, key]));
  }
  return [];
}

const allCopy = collectStrings(copy);

describe('forbidden words', () => {
  it('finds a meaningful number of strings to check', () => {
    // Guards against the test silently passing because the walk broke.
    expect(allCopy.length).toBeGreaterThan(80);
  });

  it.each(FORBIDDEN_WORDS)('never says "%s" anywhere a user can read it', (word) => {
    const pattern = new RegExp(`\\b${word.replace(/[-]/g, '\\-')}\\b`, 'i');
    const offenders = allCopy.filter((entry) => pattern.test(entry.value));
    expect(
      offenders,
      offenders.map((o) => `${o.path}: ${JSON.stringify(o.value)}`).join('\n'),
    ).toEqual([]);
  });

  it('catches a violation if one is introduced', () => {
    // Proves the matcher works, so a green suite means something.
    const bad = collectStrings({ cta: 'Connect your wallet to continue' });
    const pattern = new RegExp('\\bwallet\\b', 'i');
    expect(bad.filter((e) => pattern.test(e.value))).toHaveLength(1);
  });

  it('does not false-positive on innocent words that contain a banned substring', () => {
    const innocent = ['unchanged', 'Las Vegas', 'mintage-free prose', 'contact us'];
    for (const phrase of innocent) {
      const hit = FORBIDDEN_WORDS.some((w) =>
        new RegExp(`\\b${w.replace(/[-]/g, '\\-')}\\b`, 'i').test(phrase),
      );
      expect(hit, phrase).toBe(false);
    }
  });
});

describe('the documented exception', () => {
  it('keeps "Verify on Arc" as the only chain-facing phrase in user copy', () => {
    expect(copy.receipt.verifyLink).toBe('Verify on Arc');
    // It names the network but uses none of the banned vocabulary.
    const banned = FORBIDDEN_WORDS.filter((w) =>
      new RegExp(`\\b${w.replace(/[-]/g, '\\-')}\\b`, 'i').test(copy.receipt.verifyLink),
    );
    expect(banned).toEqual([]);
  });

  it('allows technicalCopy to be explicit, since judges read it', () => {
    const technical = collectStrings(technicalCopy);
    const usesBannedWords = technical.some((entry) =>
      FORBIDDEN_WORDS.some((w) =>
        new RegExp(`\\b${w.replace(/[-]/g, '\\-')}\\b`, 'i').test(entry.value),
      ),
    );
    expect(usesBannedWords).toBe(true);
  });
});

describe('copy quality', () => {
  it('has no empty strings', () => {
    const empty = allCopy.filter((e) => e.value.trim() === '');
    expect(empty).toEqual([]);
  });

  it('has no leftover TODO or placeholder text', () => {
    const todo = allCopy.filter((e) => /TODO|FIXME|lorem ipsum|xxx/i.test(e.value));
    expect(todo).toEqual([]);
  });

  it('keeps bot replies within a post length budget', () => {
    // Leaves room for a link and the handle being replied to.
    for (const entry of collectStrings(copy.bot)) {
      expect(entry.value.length, entry.path).toBeLessThanOrEqual(200);
    }
  });
});

describe('fill', () => {
  it('substitutes placeholders', () => {
    expect(fill(copy.viewer.unlockCta, { price: '$0.02' })).toBe('Unlock for $0.02');
    expect(fill(copy.creator.claimCta, { amount: '$0.84' })).toBe('Claim $0.84');
  });

  it('fills multiple placeholders including repeats', () => {
    expect(
      fill(copy.bot.dailySummaryReply, { language: 'Spanish', amount: '$0.84', count: 70 }),
    ).toBe('Your Spanish dub earned $0.84 from 70 viewers today.');
  });

  it('throws rather than shipping "{amount}" to a user', () => {
    expect(() => fill(copy.creator.claimCta, {})).toThrow(/placeholder \{amount\}/);
  });

  it('leaves strings without placeholders untouched', () => {
    expect(fill(copy.viewer.shareCta, {})).toBe('Share');
  });

  it('every placeholder in the tree is a plain identifier', () => {
    for (const entry of allCopy) {
      for (const match of entry.value.matchAll(/\{([^}]*)\}/g)) {
        expect(match[1], `${entry.path}: ${match[0]}`).toMatch(/^\w+$/);
      }
    }
  });
});
