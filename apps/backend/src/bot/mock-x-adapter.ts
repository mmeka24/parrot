/**
 * An in-memory fake X. THE DEFAULT, because no X credentials exist for this
 * project and, per x-adapter.ts, every real call is billed against prepaid
 * credits with link-bearing replies at $0.200 each.
 *
 * It is backed by the Store's `botPosts`, so the stand-in timeline (apps/x-clone)
 * shows the same posts the bot is reading and writing. Nothing here calls
 * the network.
 *
 * Determinism is a hard requirement: a demo must replay identically. So ids are
 * sequence-based (`mock-post-7`), and timestamps come from a fixed epoch plus a
 * fixed step, never from `Date.now()`. Two fresh MockXAdapters produce byte-
 * identical timelines.
 *
 * Replies are recorded as posts with `posted: false` - they exist in our
 * timeline, they were never sent to X.
 */

import { mentionSchema, sourcePostSchema, type Mention, type SourcePost } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { BotPost } from '../store/types.js';
import type { PostReply, PostedReply, XAdapter } from './x-adapter.js';

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

/** The creators the demo ships with. */
export const MOCK_USERS: readonly MockXUser[] = [
  { handle: 'maria', displayName: 'Maria Lopez', xUserId: 'x-user-maria', followers: 50_000 },
  { handle: 'devtoni', displayName: 'Toni Okafor', xUserId: 'x-user-devtoni', followers: 12_400 },
  { handle: 'chefkenji', displayName: 'Kenji Sato', xUserId: 'x-user-chefkenji', followers: 210_000 },
  { handle: 'linafit', displayName: 'Lina Brandt', xUserId: 'x-user-linafit', followers: 3_100 },
];

/**
 * Seeded video posts, oldest first. They have a length and an audience but no
 * media behind them, so their dubs are always the simulated stand-in.
 *
 * @maria has three: the demo dubs the first two on boot (so there is something
 * learned to show) and leaves the third for a person to dub. @devtoni is a
 * creator Parrot knows nothing about yet. One of @chefkenji's dubs is made to
 * fail the quality check, so the loss path is visible.
 */
export const MOCK_SEED_POSTS: readonly MockSeedPost[] = [
  {
    handle: 'maria',
    text: 'The one thing nobody tells you about learning to cook on a budget.',
    durationS: 30,
    metrics: { likes: 18_000, replies: 640, reposts: 2_900, quotes: 210, views: 1_200_000 },
  },
  {
    handle: 'chefkenji',
    text: 'Knife skills: the grip everyone gets wrong.',
    durationS: 48,
    metrics: { likes: 52_000, replies: 1_900, reposts: 9_800, quotes: 600, views: 2_400_000 },
  },
  {
    handle: 'maria',
    text: 'Five dollars, four meals. Here is the whole shop.',
    durationS: 30,
    metrics: { likes: 11_400, replies: 410, reposts: 1_800, quotes: 120, views: 800_000 },
  },
  {
    handle: 'devtoni',
    text: 'Debugging a race condition live, in under two minutes.',
    durationS: 95,
    metrics: { likes: 41_000, replies: 1_300, reposts: 6_200, quotes: 380, views: 2_100_000 },
  },
  {
    handle: 'linafit',
    text: 'Three minutes, no equipment, actually works.',
    durationS: 170,
    metrics: { likes: 90, replies: 7, reposts: 11, quotes: 1, views: 640 },
  },
  {
    handle: 'maria',
    text: 'Stop throwing away the pasta water. Thirty seconds on why.',
    durationS: 30,
    metrics: { likes: 9_800, replies: 350, reposts: 1_500, quotes: 95, views: 650_000 },
  },
];

export interface MockXAdapterOptions {
  readonly seed?: boolean;
  readonly botHandle?: string;
  readonly botUserId?: string;
  readonly epochMs?: number;
  /**
   * Origin that post permalinks are built on. Defaults to x.com so a bare
   * adapter still produces X-shaped links; the backend passes the local clone's
   * origin so a permalink actually opens the post it names.
   */
  readonly permalinkBase?: string;
  /** Builds the public URL of an uploaded source video from its file path. */
  readonly mediaUrlFor?: (videoPath: string) => string | null;
}

/** A post written through the clone's composer. */
export interface CreateClonePostInput {
  readonly text: string;
  readonly authorHandle: string;
  readonly inReplyToPostId?: string | null;
  readonly video?: { readonly durationS: number; readonly path: string | null } | null;
  /** Demo-only starting metrics for a top-level post (see simulatedViews). */
  readonly metrics?: { likes: number; replies: number; reposts: number; quotes: number; views: number } | null;
  /** For an account that does not exist yet: the name to show for it. */
  readonly displayName?: string;
}

/** One of Parrot's dubs, posted in the thread under the original. */
export interface PostDubInput {
  readonly inReplyToId: string;
  readonly text: string;
  readonly dubId: string;
  readonly durationS: number;
  /** The rendered dub. Null for a simulated stand-in with nothing to play. */
  readonly videoPath: string | null;
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
  private readonly permalinkBase: string;
  private readonly mediaUrlFor: (videoPath: string) => string | null;
  /** False while seeding (fixed clock, replayable); true once people post live. */
  private wallClock = false;
  private lastStampMs = 0;

  constructor(
    private readonly store: Store,
    options: MockXAdapterOptions = {},
  ) {
    this.botHandle = options.botHandle ?? MOCK_BOT_HANDLE;
    this.botUserId = options.botUserId ?? MOCK_BOT_USER_ID;
    this.epochMs = options.epochMs ?? MOCK_EPOCH_MS;
    this.permalinkBase = (options.permalinkBase ?? 'https://x.com').replace(/\/$/, '');
    this.mediaUrlFor = options.mediaUrlFor ?? (() => null);
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
      authorDisplayName: post.authorDisplayName || user?.displayName || undefined,
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
              // A really-uploaded clip resolves to where it is served; a seeded
              // post has no media, and its placeholder URL says so.
              url:
                (post.videoPath ? this.mediaUrlFor(post.videoPath) : null) ??
                `https://mock.x.test/video/${post.id}.mp4`,
            }
          : null,
      lang: 'en',
    });
    return Promise.resolve(parsed.success ? parsed.data : null);
  }

  /**
   * Record the bot's reply. `posted: false` is the honest part: in mock mode
   * nothing is sent to X.
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
      dubId: null,
      posted: false,
    });
    return Promise.resolve({ id: post.id, text, inReplyToId, posted: false });
  }

  /** Everything written directly under a post, oldest first. */
  listReplies(postId: string): Promise<PostReply[]> {
    const replies = [...this.store.botPosts.values()]
      .filter((p) => p.inReplyToId === postId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((p) => ({ id: p.id, text: p.text, authorHandle: p.authorHandle }));
    return Promise.resolve(replies);
  }

  /**
   * Post a dub in the thread under the original, as a video reply from the bot.
   * It starts at zero views like any other post, and is counted from there.
   */
  postDub(input: PostDubInput): Promise<PostedReply> {
    const parent = this.store.botPosts.get(input.inReplyToId) ?? null;
    const post = this.writePost({
      authorHandle: this.botHandle,
      authorDisplayName: 'Parrot',
      authorXUserId: this.botUserId,
      text: input.text,
      isBot: true,
      inReplyToId: input.inReplyToId,
      parentAuthorXUserId: parent?.authorXUserId ?? null,
      metrics: { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 },
      hasVideo: true,
      videoDurationS: input.durationS,
      videoPath: input.videoPath,
      dubId: input.dubId,
      posted: false,
    });
    if (parent?.metrics) parent.metrics.replies += 1;
    return Promise.resolve({ id: post.id, text: input.text, inReplyToId: input.inReplyToId, posted: false });
  }

  // -------------------------------------------------------------------------
  // Stand-in controls (not part of XAdapter - mock only)
  // -------------------------------------------------------------------------

  /** Count views on a post, as the timeline itself would. Returns the new total. */
  addViews(postId: string, count: number): number {
    const post = this.store.botPosts.get(postId);
    if (!post) return 0;
    post.metrics ??= { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 };
    post.metrics.views = (post.metrics.views ?? 0) + Math.max(0, Math.floor(count));
    return post.metrics.views;
  }

  /** Add likes and reposts to a post, for the demo audience. */
  addEngagement(postId: string, likes: number, reposts: number): void {
    const post = this.store.botPosts.get(postId);
    if (!post) return;
    post.metrics ??= { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 };
    post.metrics.likes += Math.max(0, Math.floor(likes));
    post.metrics.reposts += Math.max(0, Math.floor(reposts));
  }

  /**
   * Inject a mention, as the stand-in's composer does. `authorHandle` defaults to the
   * author of the post being replied to, which is the normal case: a creator
   * replying under their own video.
   */
  injectMention(input: {
    text: string;
    inReplyToPostId?: string | null;
    authorHandle?: string;
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
      dubId: null,
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

  /**
   * Write an ordinary post or reply, as the clone's composer does. This is NOT
   * a mention: nothing here reaches the bot. A post that addresses the bot goes
   * through injectMention instead.
   */
  createPost(input: CreateClonePostInput): BotPost {
    const parent = input.inReplyToPostId
      ? (this.store.botPosts.get(input.inReplyToPostId) ?? null)
      : null;
    const user = this.userFor(input.authorHandle) ?? this.registerUser(input.authorHandle, input.displayName);
    const video = input.video ?? null;
    return this.writePost({
      authorHandle: user.handle,
      authorDisplayName: user.displayName,
      authorXUserId: user.xUserId,
      text: input.text,
      isBot: false,
      inReplyToId: parent?.id ?? null,
      parentAuthorXUserId: parent?.authorXUserId ?? null,
      // Top-level posts start with real zeroes; ordinary replies carry no
      // metrics.
      metrics: parent
        ? null
        : (input.metrics ?? { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 }),
      hasVideo: video !== null,
      videoDurationS: video?.durationS ?? null,
      videoPath: video?.path ?? null,
      dubId: null,
      posted: false,
    });
  }

  /**
   * Switch from the fixed seeding clock to real time. Called once the demo
   * world is seeded, so the seed replays identically but a post written by a
   * person is stamped when they wrote it - which the age signal depends on.
   */
  useWallClock(): void {
    this.wallClock = true;
  }

  /** Everyone with an account on fake-X, the bot included. */
  listUsers(): MockXUser[] {
    return [
      ...this.users.values(),
      { handle: this.botHandle, displayName: 'Parrot', xUserId: this.botUserId, followers: 0 },
    ];
  }

  /** The id of the Nth seeded video post, for wiring a console demo. */
  seededPostIds(): string[] {
    return [...this.store.botPosts.values()].filter((p) => p.hasVideo).map((p) => p.id);
  }

  /** The canonical fake-X permalink for a post. parsedIntentSchema wants a URL. */
  postUrl(postId: string): string {
    const post = this.store.botPosts.get(postId);
    return `${this.permalinkBase}/${post?.authorHandle ?? 'unknown'}/status/${postId}`;
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
        dubId: null,
        posted: false,
      });
    }
  }

  private registerUser(handle: string, displayName?: string): MockXUser {
    const clean = handle.toLowerCase().replace(/^@/, '');
    const user: MockXUser = {
      handle: clean,
      displayName: displayName?.trim() || clean,
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
      createdAt: new Date(this.stamp()),
    });
  }

  /** Strictly increasing, so a thread sorted by time is in the order it was written. */
  private stamp(): number {
    const candidate = this.wallClock ? Date.now() : this.epochMs + this.seq * MOCK_STEP_MS;
    this.lastStampMs = Math.max(candidate, this.lastStampMs + 1);
    return this.lastStampMs;
  }
}
