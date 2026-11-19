import { describe, it, expect } from 'vitest';
import { X_TESTID, mentionsHandle, parseStatusHref, xSelector } from '../src/x-dom.js';

describe('parseStatusHref', () => {
  it('reads relative and absolute permalinks', () => {
    expect(parseStatusHref('/maria/status/mock-post-1')).toEqual({
      handle: 'maria',
      postId: 'mock-post-1',
    });
    expect(parseStatusHref('https://x.com/Maria/status/1860042215577')).toEqual({
      handle: 'maria',
      postId: '1860042215577',
    });
  });

  it('ignores the sub-pages of a post', () => {
    expect(parseStatusHref('/maria/status/123/analytics')?.postId).toBe('123');
  });

  it('rejects anything that is not a permalink', () => {
    expect(parseStatusHref('/maria')).toBeNull();
    expect(parseStatusHref('/home')).toBeNull();
    expect(parseStatusHref('/a-handle-that-is-way-too-long/status/1')).toBeNull();
  });
});

describe('mentionsHandle', () => {
  it('finds the handle at the start and mid-sentence, in any case', () => {
    expect(mentionsHandle('@parrot dub this to Spanish', 'parrot')).toBe(true);
    expect(mentionsHandle('hey @Parrot, Hindi please', 'parrot')).toBe(true);
  });

  it('does not match a longer handle or an email address', () => {
    expect(mentionsHandle('@parrotfan dub this', 'parrot')).toBe(false);
    expect(mentionsHandle('mail me at me@parrot.com', 'parrot')).toBe(false);
  });

  it('cannot be turned into a regex by a hostile handle', () => {
    expect(mentionsHandle('anything', '.*')).toBe(false);
  });
});

describe('the DOM contract', () => {
  it('builds attribute selectors from the x.com hook names', () => {
    expect(xSelector(X_TESTID.tweet)).toBe('[data-testid="tweet"]');
    expect(xSelector(X_TESTID.composerInput)).toBe('[data-testid="tweetTextarea_0"]');
  });
});
