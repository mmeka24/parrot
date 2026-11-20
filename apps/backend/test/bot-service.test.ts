/**
 * The bot's three promises: it only ever speaks in words from copy.ts, it only
 * dubs for the person who owns the video, and it never acts on a request twice.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DECLINE_REASONS,
  DUB_STATES,
  FORBIDDEN_WORDS,
  copy,
  mentionSchema,
  type Mention,
  type SourcePost,
} from '@parrot/shared';
import { Store } from '../src/store/store.js';
import {
  BotService,
  RateLimiter,
  declineLine,
  replies,
  isAuthorised,
  statusPhrase,
  watchLink,
} from '../src/bot/bot-service.js';
import { MockXAdapter, MOCK_EPOCH_MS } from '../src/bot/mock-x-adapter.js';

const WEB = 'http://localhost:3000';
const LINK = watchLink('dub-1', WEB);

let store: Store;
let adapter: MockXAdapter;
let service: BotService;

beforeEach(() => {
  store = new Store();
  adapter = new MockXAdapter(store);
  service = new BotService(store, adapter, { webBaseUrl: WEB });
});

/** One of every reply the bot can send, for the blanket checks below. */
function everyReply(): Array<{ kind: string; text: string; hasLink: boolean }> {
  const all: Array<{ kind: string; text: string; hasLink: boolean }> = [
    { kind: 'plan:one', text: replies.plan(['es']), hasLink: false },
    { kind: 'plan:six', text: replies.plan(['ja', 'es', 'ar', 'id', 'pt', 'fr']), hasLink: false },
    { kind: 'dubPost', text: replies.dubPost('pt', LINK), hasLink: true },
    { kind: 'duplicate', text: replies.duplicate('pt', LINK), hasLink: true },
    { kind: 'qcFailed', text: replies.qcFailed('fr'), hasLink: false },
    { kind: 'failed', text: replies.failed('hi'), hasLink: false },
    { kind: 'error', text: replies.error(), hasLink: false },
    { kind: 'rateLimited', text: replies.rateLimited(), hasLink: false },
  ];
  for (const reason of DECLINE_REASONS) {
    all.push({ kind: `declined:${reason}`, text: replies.declined(reason), hasLink: false });
  }
  return all;
}

describe('reply composition', () => {
  it.each(everyReply())('$kind is non-empty and fits in a post', ({ text }) => {
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(280);
  });

  it.each(everyReply().filter((r) => !r.hasLink))('$kind stays under 200 characters', ({ text }) => {
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('says nothing a normal person would have to decode', () => {
    for (const { kind, text } of everyReply()) {
      for (const word of FORBIDDEN_WORDS) {
        const pattern = new RegExp(`\\b${word.replace(/-/g, '\\-')}\\b`, 'i');
        expect(pattern.test(text), `${kind}: ${text}`).toBe(false);
      }
    }
  });

  it('builds every reply out of copy.bot, not local strings', () => {
    expect(replies.error()).toBe(copy.bot.errorReply);
    expect(replies.rateLimited()).toBe(copy.bot.rateLimitedReply);
  });

  it('names every language in the plan, in words a creator recognises', () => {
    expect(replies.plan(['es'])).toContain('Spanish');
    const plan = replies.plan(['es', 'pt', 'hi']);
    expect(plan).toContain('Spanish, Portuguese and Hindi');
  });

  it('posts a dub under its own language name, with the link to watch it', () => {
    const text = replies.dubPost('pt', LINK);
    expect(text).toContain('Portugues');
    expect(text).toContain('Portuguese');
    expect(text).toContain(LINK);
  });

  it('gives each decline its own one-line reason', () => {
    const lines = new Set(DECLINE_REASONS.map((r) => declineLine(r)));
    expect(lines.size).toBe(DECLINE_REASONS.length);
    expect(replies.declined('NOT_AUTHOR')).toContain(copy.bot.declineReasonNotAuthor);
    expect(replies.declined('NO_VIDEO')).toContain(copy.bot.declineReasonNoVideo);
  });

  it('covers every dub state with a plain-language phrase', () => {
    for (const state of DUB_STATES) {
      expect(statusPhrase(state).length).toBeGreaterThan(0);
    }
    expect(statusPhrase('PUBLISHED')).toBe('Live');
  });
});

// ---------------------------------------------------------------------------

function mention(overrides: Partial<Mention> = {}): Mention {
  return mentionSchema.parse({
    id: 'mention-1',
    text: '@parrot dub this to Spanish',
    authorId: 'x-user-maria',
    authorHandle: 'maria',
    createdAt: new Date(MOCK_EPOCH_MS),
    inReplyToPostId: 'mock-post-1',
    parentAuthorId: 'x-user-maria',
    conversationId: 'mock-post-1',
    ...overrides,
  });
}

describe('authorisation', () => {
  it('lets the author of the video ask for a dub', async () => {
    const post = await adapter.getPost('mock-post-1');
    expect(post).not.toBeNull();
    expect(isAuthorised(mention(), post)).toBe(true);
  });

  it('blocks a stranger from dubbing someone else video and running up their bill', async () => {
    const post = await adapter.getPost('mock-post-1');
    const stranger = mention({ id: 'mention-2', authorId: 'x-user-devtoni', authorHandle: 'devtoni' });
    expect(isAuthorised(stranger, post)).toBe(false);
    expect(service.isAuthorised(stranger, post)).toBe(false);
  });

  it('is not fooled by a mention that claims the wrong parent author', async () => {
    const post = await adapter.getPost('mock-post-1');
    // in_reply_to_user_id would say "devtoni" in a thread; it is not the owner.
    const spoofed = mention({
      id: 'mention-3',
      authorId: 'x-user-devtoni',
      authorHandle: 'devtoni',
      parentAuthorId: 'x-user-devtoni',
    });
    expect(isAuthorised(spoofed, post)).toBe(false);
  });

  it('refuses when there is no source post at all', () => {
    expect(isAuthorised(mention({ inReplyToPostId: null, parentAuthorId: null }), null)).toBe(false);
  });

  it('declines a non-author in words the creator can read', () => {
    expect(replies.declined('NOT_AUTHOR')).toContain('only the person who posted');
  });
});

describe('dedupe', () => {
  it('lets the first delivery through and nothing after it', () => {
    expect(service.claimMention('mention-1')).toBe(true);
    expect(service.claimMention('mention-1')).toBe(false);
    expect(service.claimMention('mention-1')).toBe(false);
    expect(service.wasProcessed('mention-1')).toBe(true);
  });

  it('survives a redelivery of the same mention from X', async () => {
    const m = adapter.injectMention({ text: '@parrot dub this to es', inReplyToPostId: 'mock-post-1' });
    let dubs = 0;
    for (let i = 0; i < 5; i++) {
      // The same mention arriving five times must buy exactly one dub.
      if (service.claimMention(m.id)) dubs += 1;
    }
    expect(dubs).toBe(1);
    const again = await adapter.fetchMentions();
    expect(again.filter((x) => x.id === m.id)).toHaveLength(1);
  });

  it('records the outcome against the post', () => {
    service.claimMention('mention-9');
    service.recordOutcome('mention-9', 'post-1', 'started');
    expect(store.processedMentions.get('mention-9')?.postId).toBe('post-1');
    expect(store.processedMentions.get('mention-9')?.outcome).toBe('started');
  });
});

describe('rate limiting', () => {
  it('stops at the limit and recovers once the window rolls', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, 1_000, () => now);
    expect([limiter.tryConsume(), limiter.tryConsume(), limiter.tryConsume()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.tryConsume()).toBe(false);
    now += 1_001;
    expect(limiter.tryConsume()).toBe(true);
  });

  it('says so in copy instead of going silent', async () => {
    const limited = new BotService(store, adapter, { webBaseUrl: WEB, replyLimit: 1 });
    const first = await limited.send('mock-post-1', replies.plan(['es']));
    expect(first.sent).toBe(true);
    const second = await limited.send('mock-post-1', replies.plan(['es']));
    expect(second.sent).toBe(false);
    expect(second.suppressedBy).toBe('rate_limit');
    expect(second.text).toBe(copy.bot.rateLimitedReply);
  });
});

describe('the mock X', () => {
  it('is the default and admits it', () => {
    expect(adapter.isMock).toBe(true);
    expect(service.isMock).toBe(true);
  });

  it('seeds a viral post to dub', async () => {
    const post = await adapter.getPost('mock-post-1');
    expect(post?.authorHandle).toBe('maria');
    expect(post?.authorFollowers).toBe(50_000);
    expect(post?.video?.durationMs).toBe(30_000);
    expect(post?.metrics).toMatchObject({
      impressionCount: 1_200_000,
      likeCount: 18_000,
      replyCount: 640,
      retweetCount: 2_900,
    });
  });

  it('is deterministic across runs', async () => {
    const other = new MockXAdapter(new Store());
    const a = await adapter.getPost('mock-post-1');
    const b = await other.getPost('mock-post-1');
    expect(a).toEqual(b);
  });

  it('records a reply as an unposted post, because nothing was sent to X', async () => {
    const result = await service.send('mock-post-1', replies.plan(['es']));
    expect(result.sent).toBe(true);
    expect(result.reply?.posted).toBe(false);
    const recorded = store.botPosts.get(result.reply?.id ?? '');
    expect(recorded?.isBot).toBe(true);
    expect(recorded?.posted).toBe(false);
    expect(recorded?.inReplyToId).toBe('mock-post-1');
    expect([...store.botPosts.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())).toContainEqual(recorded);
  });

  it('hands injected mentions back with the real parent author attached', async () => {
    const injected = adapter.injectMention({
      text: '@parrot dub this in spanish',
      inReplyToPostId: 'mock-post-1',
    });
    expect(injected.authorHandle).toBe('maria');
    expect(injected.parentAuthorId).toBe('x-user-maria');
    const post = await adapter.getPost('mock-post-1');
    expect(isAuthorised(injected, post)).toBe(true);
  });

  it('checkpoints with sinceId so a mention is not re-read forever', async () => {
    const first = adapter.injectMention({ text: '@parrot status', inReplyToPostId: 'mock-post-1' });
    const second = adapter.injectMention({
      text: '@parrot earnings',
      inReplyToPostId: 'mock-post-2',
    });
    expect((await adapter.fetchMentions()).map((m) => m.id)).toEqual([first.id, second.id]);
    expect((await adapter.fetchMentions(first.id)).map((m) => m.id)).toEqual([second.id]);
    expect(await adapter.fetchMentions(second.id)).toEqual([]);
  });
});
