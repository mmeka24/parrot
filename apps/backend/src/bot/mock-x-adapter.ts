/**
 * An in-memory fake X. THE DEFAULT, because no X credentials exist for this
 * project and, per x-adapter.ts, every real call is billed against prepaid
 * credits with link-bearing replies at $0.200 each.
 *
 * It is backed by the Store's `botPosts`, so the bot console in the web app
 * renders the same timeline the bot is reading and writing. Nothing here calls
 * the network.
 *
 * Determinism is a hard requirement: a demo must replay identically. So ids are
 * sequence-based (`mock-post-7`), and timestamps come from a fixed epoch plus a
 * fixed step, never from `Date.now()`. Two fresh MockXAdapters produce byte-
 * identical timelines.
 *
 * Replies are recorded as posts with `posted: false` - they exist in our
 * timeline, they were never sent to X. The dashboard reads that flag.
 */

import { mentionSchema, sourcePostSchema, type Mention, type SourcePost } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { BotPost } from '../store/types.js';
import type { PostedReply, XAdapter } from './x-adapter.js';

/** Fixed clock origin, so a replayed demo is byte-identical. 2026-11-15T12:00:00Z. */
export const MOCK_EPOCH_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const MOCK_STEP_MS = 60_000;

export const MOCK_BOT_HANDLE = 'parrot';
export const MOCK_BOT_USER_ID = 'x-user-parrot';

/** A seeded account on fake-X. Followers live here because BotPost has no such field. */
export interface MockXUser {
  readonly handle: string;
  readonly displayName: string;
  readonly xUserId: string;
  readonly followers: number;
}

export interface MockSeedPost {
  readonly handle: string;
  readonly text: string;
  readonly durationS: number;
  readonly metrics: { likes: number; replies: number; reposts: number; quotes: number; views: number };
}

/** The creators the demo ships with. @maria is the brief's worked example. */
export const MOCK_USERS: readonly MockXUser[] = [
  { handle: 'maria', displayName: 'Maria Lopez', xUserId: 'x-user-maria', followers: 50_000 },
  { handle: 'devtoni', displayName: 'Toni Okafor', xUserId: 'x-user-devtoni', followers: 12_400 },
  { handle: 'chefkenji', displayName: 'Kenji Sato', xUserId: 'x-user-chefkenji', followers: 210_000 },
  { handle: 'linafit', displayName: 'Lina Brandt', xUserId: 'x-user-linafit', followers: 3_100 },
];

/**
 * Seeded video posts. The first is the brief's worked example: @maria, a 30s
 * clip, ~10k views, 800 likes / 120 replies / 200 reposts, 50k followers.
 */
export const MOCK_SEED_POSTS: readonly MockSeedPost[] = [
  {
    handle: 'maria',
    text: 'The one thing nobody tells you about learning to cook on a budget.',
    durationS: 30,
    metrics: { likes: 800, replies: 120, reposts: 200, quotes: 35, views: 10_000 },
  },
  {
    handle: 'devtoni',
    text: 'Debugging a race condition live, in under two minutes.',
    durationS: 95,
    metrics: { likes: 240, replies: 31, reposts: 44, quotes: 6, views: 3_200 },
  },
  {
    handle: 'chefkenji',
    text: 'Knife skills: the grip everyone gets wrong.',
    durationS: 48,
    metrics: { likes: 5_400, replies: 610, reposts: 1_200, quotes: 180, views: 92_000 },
  },
  {
    handle: 'linafit',
    text: 'Three minutes, no equipment, actually works.',
    durationS: 170,
    metrics: { likes: 90, replies: 7, reposts: 11, quotes: 1, views: 640 },
  },
];

export interface MockXAdapterOptions {
  readonly seed?: boolean;
  readonly botHandle?: string;
  readonly botUserId?: string;
  readonly epochMs?: number;
}

export class MockXAdapter implements XAdapter {
  readonly isMock = true;

  readonly botHandle: string;
  readonly botUserId: string;

  private readonly users = new Map<string, MockXUser>();
  /** Mention queue in arrival order; fetchMentions slices from it by sinceId. */
  private readonly mentions: Mention[] = [];
  private seq = 0;
  private readonly epochMs: number;

  constructor(
    private readonly store: Store,
    options: MockXAdapterOptions = {},
  ) {
    this.botHandle = options.botHandle ?? MOCK_BOT_HANDLE;
    this.botUserId = options.botUserId ?? MOCK_BOT_USER_ID;
    this.epochMs = options.epochMs ?? MOCK_EPOCH_MS;
    for (const user of MOCK_USERS) this.users.set(user.handle, user);
    if (options.seed !== false) this.seed();
  }

  // -------------------------------------------------------------------------
  // XAdapter
  // -------------------------------------------------------------------------

  fetchMentions(sinceId?: string): Promise<Mention[]> {
    if (sinceId === undefined) return Promise.resolve([...this.mentions]);
    const index = this.mentions.findIndex((m) => m.id === sinceId);
    // Unknown checkpoint: behave like X and return the whole (capped) window.
    return Promise.resolve(index < 0 ? [...this.mentions] : this.mentions.slice(index + 1));
  }

  getPost(postId: string): Promise<SourcePost | null> {
    const post = this.store.botPosts.get(postId);
    if (!post) return Promise.resolve(null);
    const user = this.users.get(post.authorHandle);
    const parsed = sourcePostSchema.safeParse({
      postId: post.id,
      authorId: post.authorXUserId,
      authorHandle: post.authorHandle,
      authorFollowers: user?.followers ?? 0,
      text: post.text,
      createdAt: post.createdAt,
      metrics: {
        likeCount: post.metrics?.likes ?? 0,
        replyCount: post.metrics?.replies ?? 0,
        retweetCount: post.metrics?.reposts ?? 0,
        quoteCount: post.metrics?.quotes ?? 0,
        impressionCount: post.metrics?.views ?? null,
        bookmarkCount: 0,
      },
      video:
        post.hasVideo && post.videoDurationS !== null
          ? {
              mediaKey: `mock-media-${post.id}`,
              type: 'video',
              durationMs: Math.round(post.videoDurationS * 1000),
              previewImageUrl: `https://mock.x.test/preview/${post.id}.jpg`,
              url: `https://mock.x.test/video/${post.id}.mp4`,
            }
          : null,
      lang: 'en',
    });
    return Promise.resolve(parsed.success ? parsed.data : null);
  }

  /**
   * Record the bot's reply. `posted: false` is the honest part: in mock mode
   * nothing is sent to X, and the console renders it as a local reply.
   */
  reply(inReplyToId: string, text: string): Promise<PostedReply> {
    const parent = this.store.botPosts.get(inReplyToId) ?? null;
    const post = this.writePost({
      authorHandle: this.botHandle,
      authorDisplayName: 'Parrot',
      authorXUserId: this.botUserId,
      text,
      isBot: true,
      inReplyToId,
      parentAuthorXUserId: parent?.authorXUserId ?? null,
      metrics: null,
      hasVideo: false,
      videoDurationS: null,
      jobId: null,
      posted: false,
    });
    return Promise.resolve({ id: post.id, text, inReplyToId, posted: false });
  }

  // -------------------------------------------------------------------------
  // Console controls (not part of XAdapter - mock only)
  // -------------------------------------------------------------------------

  /**
   * Inject a mention, as the bot console does. `authorHandle` defaults to the
   * author of the post being replied to, which is the normal case: a creator
   * replying under their own video.
   */
  injectMention(input: {
    text: string;
    inReplyToPostId?: string | null;
    authorHandle?: string;
    jobId?: string | null;
  }): Mention {
    const parent = input.inReplyToPostId
      ? (this.store.botPosts.get(input.inReplyToPostId) ?? null)
      : null;
    const handle = input.authorHandle ?? parent?.authorHandle ?? 'maria';
    const user = this.users.get(handle) ?? this.registerUser(handle);

    const post = this.writePost({
      authorHandle: user.handle,
      authorDisplayName: user.displayName,
      authorXUserId: user.xUserId,
      text: input.text,
      isBot: false,
      inReplyToId: input.inReplyToPostId ?? null,
      parentAuthorXUserId: parent?.authorXUserId ?? null,
      metrics: null,
      hasVideo: false,
      videoDurationS: null,
      jobId: input.jobId ?? null,
      posted: false,
    });

    const mention = mentionSchema.parse({
      id: post.id,
      text: post.text,
      authorId: user.xUserId,
      authorHandle: user.handle,
      createdAt: post.createdAt,
      inReplyToPostId: post.inReplyToId,
      parentAuthorId: post.parentAuthorXUserId,
      conversationId: post.inReplyToId ?? post.id,
    });
    this.mentions.push(mention);
    return mention;
  }

  /** The id of the Nth seeded video post, for wiring a console demo. */
  seededPostIds(): string[] {
    return [...this.store.botPosts.values()].filter((p) => p.hasVideo).map((p) => p.id);
  }

  /** The canonical fake-X permalink for a post. parsedIntentSchema wants a URL. */
  postUrl(postId: string): string {
    const post = this.store.botPosts.get(postId);
    return `https://x.com/${post?.authorHandle ?? 'unknown'}/status/${postId}`;
  }

  userFor(handle: string): MockXUser | undefined {
    return this.users.get(handle.toLowerCase().replace(/^@/, ''));
  }

  // -------------------------------------------------------------------------

  private seed(): void {
    for (const seed of MOCK_SEED_POSTS) {
      const user = this.users.get(seed.handle) ?? this.registerUser(seed.handle);
      this.writePost({
        authorHandle: user.handle,
        authorDisplayName: user.displayName,
        authorXUserId: user.xUserId,
        text: seed.text,
        isBot: false,
        inReplyToId: null,
        parentAuthorXUserId: null,
        metrics: {
          likes: seed.metrics.likes,
          replies: seed.metrics.replies,
          reposts: seed.metrics.reposts,
          quotes: seed.metrics.quotes,
          views: seed.metrics.views,
        },
        hasVideo: true,
        videoDurationS: seed.durationS,
        jobId: null,
        posted: false,
      });
    }
  }

  private registerUser(handle: string): MockXUser {
    const clean = handle.toLowerCase().replace(/^@/, '');
    const user: MockXUser = {
      handle: clean,
      displayName: clean,
      xUserId: `x-user-${clean}`,
      followers: 1_000,
    };
    this.users.set(clean, user);
    return user;
  }

  private writePost(input: Omit<BotPost, 'id' | 'createdAt'>): BotPost {
    this.seq += 1;
    return this.store.createBotPost({
      ...input,
      id: `mock-post-${this.seq}`,
      createdAt: new Date(this.epochMs + this.seq * MOCK_STEP_MS),
    });
  }
}
