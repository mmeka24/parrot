/**
 * The X surface, behind one small interface.
 *
 * Everything the bot needs from X is four operations, so the whole product can
 * run against an in-memory fake (mock-x-adapter.ts) when no X credentials
 * exist - which, for this project, is the normal case. `isMock` sits ON the
 * interface rather than hidden behind it because the dashboard labels mocked
 * subsystems honestly.
 *
 * X API facts this file is built on (checked 2026-11-15, docs.x.com):
 *
 *  - Access is PREPAID CREDITS now, not the old Basic/Pro tiers. Every call
 *    below costs money, and a bug costs money repeatedly, which is the other
 *    reason the mock is the default.
 *
 *  - GET /2/users/:id/mentions is 450 requests / 15 min per app and only ever
 *    returns the 800 most recent mentions. Past that, mentions are simply gone,
 *    so sinceId checkpointing is not an optimisation, it is correctness.
 *
 *  - POST /2/tweets requires OAuth 1.0a or an OAuth2 USER-CONTEXT token. An
 *    app-only Bearer token will NOT work. We therefore take a separate
 *    userAccessToken and fail loudly rather than silently not replying.
 *
 *  - COST TRAP: a posted reply that CONTAINS A URL is billed at $0.200, versus
 *    $0.015 for one without. Parrot's whole value proposition is a link, so
 *    every published/duplicate reply we send lands in the expensive bucket. At
 *    demo volumes that is real money. Keep the mock as the default, and if you
 *    ever flip X_ENABLED on, watch the credit burn.
 *
 *  - The parent post's author is NOT `in_reply_to_user_id` (that is the user
 *    being addressed in the conversation, not the post owner). To get it you
 *    must expand `referenced_tweets.id,referenced_tweets.id.author_id` and read
 *    the referenced tweet's own author_id out of `includes.tweets`. The
 *    authorisation rule in bot-service.ts depends on this being right.
 */

import { z } from 'zod';
import { mentionSchema, sourcePostSchema, type Mention, type SourcePost } from '@parrot/shared';
import type { Config } from '../config.js';

/** What a reply attempt produced. `posted: false` means it never left the building. */
export interface PostedReply {
  readonly id: string;
  readonly text: string;
  readonly inReplyToId: string;
  readonly posted: boolean;
}

export interface XAdapter {
  /** True for the in-memory fake. Rendered in the UI as "X: mocked". */
  readonly isMock: boolean;
  /** Mentions after `sinceId`, oldest first. Capped by X at the most recent 800. */
  fetchMentions(sinceId?: string): Promise<Mention[]>;
  /** The source post, with video and metrics, or null if it is gone or unreadable. */
  getPost(postId: string): Promise<SourcePost | null>;
  reply(inReplyToId: string, text: string): Promise<PostedReply>;
}

// ---------------------------------------------------------------------------
// Wire schemas. X responses are parsed, never trusted raw.
// ---------------------------------------------------------------------------

const xPublicMetricsSchema = z.object({
  like_count: z.number().int().nonnegative().default(0),
  reply_count: z.number().int().nonnegative().default(0),
  retweet_count: z.number().int().nonnegative().default(0),
  quote_count: z.number().int().nonnegative().default(0),
  bookmark_count: z.number().int().nonnegative().default(0),
  impression_count: z.number().int().nonnegative().nullish(),
});

const xVariantSchema = z.object({
  bit_rate: z.number().int().nonnegative().optional(),
  content_type: z.string(),
  url: z.string().url(),
});

const xMediaSchema = z.object({
  media_key: z.string(),
  type: z.string(),
  duration_ms: z.number().int().positive().optional(),
  preview_image_url: z.string().url().optional(),
  url: z.string().url().optional(),
  variants: z.array(xVariantSchema).optional(),
  public_metrics: z.record(z.number()).optional(),
});

const xUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string().optional(),
  public_metrics: z
    .object({ followers_count: z.number().int().nonnegative() })
    .partial()
    .optional(),
});

const xReferencedTweetSchema = z.object({
  type: z.string(),
  id: z.string(),
});

const xTweetSchema = z.object({
  id: z.string(),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.string().optional(),
  lang: z.string().optional(),
  conversation_id: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  referenced_tweets: z.array(xReferencedTweetSchema).optional(),
  attachments: z.object({ media_keys: z.array(z.string()).optional() }).optional(),
  public_metrics: xPublicMetricsSchema.optional(),
});

const xIncludesSchema = z.object({
  users: z.array(xUserSchema).optional(),
  tweets: z.array(xTweetSchema).optional(),
  media: z.array(xMediaSchema).optional(),
});

const xErrorSchema = z.object({
  title: z.string().optional(),
  detail: z.string().optional(),
  type: z.string().optional(),
});

const xTimelineResponseSchema = z.object({
  data: z.array(xTweetSchema).optional(),
  includes: xIncludesSchema.optional(),
  meta: z
    .object({
      result_count: z.number().int().nonnegative().optional(),
      newest_id: z.string().optional(),
      oldest_id: z.string().optional(),
      next_token: z.string().optional(),
    })
    .optional(),
  errors: z.array(xErrorSchema).optional(),
});

const xSingleTweetResponseSchema = z.object({
  data: xTweetSchema.optional(),
  includes: xIncludesSchema.optional(),
  errors: z.array(xErrorSchema).optional(),
});

const xCreateTweetResponseSchema = z.object({
  data: z.object({ id: z.string(), text: z.string() }).optional(),
  errors: z.array(xErrorSchema).optional(),
});

export type XTweet = z.infer<typeof xTweetSchema>;
export type XIncludes = z.infer<typeof xIncludesSchema>;
export type XMedia = z.infer<typeof xMediaSchema>;

// ---------------------------------------------------------------------------
// Real adapter
// ---------------------------------------------------------------------------

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

export interface XApiAdapterOptions {
  /** App-only Bearer. Enough to READ mentions and posts. */
  readonly bearerToken: string;
  /** The bot's own numeric user id - the :id in /2/users/:id/mentions. */
  readonly botUserId: string;
  /**
   * OAuth2 user-context access token (or an OAuth 1.0a-signing fetch wrapper).
   * Required to POST. Without it, reply() refuses up front rather than
   * collecting a 403 per attempt.
   */
  readonly userAccessToken?: string | undefined;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const X_API_BASE = 'https://api.x.com/2';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
/** Never park a request on a rate-limit reset further out than this. */
const MAX_BACKOFF_MS = 60_000;

const MENTION_FIELDS = [
  'tweet.fields=referenced_tweets,in_reply_to_user_id,conversation_id,created_at,author_id,lang',
  // The ONLY way to learn who owns the post being replied to.
  'expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id',
  'user.fields=username,name,public_metrics',
  'max_results=100',
].join('&');

const POST_FIELDS = [
  'tweet.fields=public_metrics,created_at,author_id,lang,conversation_id',
  'expansions=author_id,attachments.media_keys',
  'user.fields=username,name,public_metrics',
  'media.fields=duration_ms,variants,preview_image_url,public_metrics,type,url',
].join('&');

export class XApiAdapter implements XAdapter {
  readonly isMock = false;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: XApiAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? X_API_BASE).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async fetchMentions(sinceId?: string): Promise<Mention[]> {
    const since = sinceId ? `&since_id=${encodeURIComponent(sinceId)}` : '';
    const url = `${this.baseUrl}/users/${encodeURIComponent(this.options.botUserId)}/mentions?${MENTION_FIELDS}${since}`;
    const body = xTimelineResponseSchema.parse(await this.request(url, { method: 'GET' }));
    const tweets = body.data ?? [];
    const includes = body.includes ?? {};
    // X returns newest-first; the bot wants to process oldest-first.
    return tweets
      .map((tweet) => this.toMention(tweet, includes))
      .filter((m): m is Mention => m !== null)
      .reverse();
  }

  async getPost(postId: string): Promise<SourcePost | null> {
    const url = `${this.baseUrl}/tweets/${encodeURIComponent(postId)}?${POST_FIELDS}`;
    let body: z.infer<typeof xSingleTweetResponseSchema>;
    try {
      body = xSingleTweetResponseSchema.parse(await this.request(url, { method: 'GET' }));
    } catch (error) {
      if (error instanceof XApiError && error.status === 404) return null;
      throw error;
    }
    if (!body.data) return null;
    return this.toSourcePost(body.data, body.includes ?? {});
  }

  async reply(inReplyToId: string, text: string): Promise<PostedReply> {
    if (!this.options.userAccessToken) {
      // App-only Bearer cannot post. Refusing here beats a per-call 403, and
      // beats silently dropping a creator's reply.
      throw new XApiError('POST /2/tweets needs OAuth user context; none configured', 403, false);
    }
    // COST NOTE: our `text` almost always contains a watch link, which bills at
    // $0.200 instead of $0.015. One reply per job, never per retry.
    const body = xCreateTweetResponseSchema.parse(
      await this.request(
        `${this.baseUrl}/tweets`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: inReplyToId } }),
        },
        this.options.userAccessToken,
      ),
    );
    if (!body.data) throw new XApiError('X accepted the post but returned no id', 502, false);
    return { id: body.data.id, text: body.data.text, inReplyToId, posted: true };
  }

  // -------------------------------------------------------------------------

  /** One HTTP call with a timeout, 429/5xx backoff, and JSON decoding. */
  private async request(
    url: string,
    init: RequestInit,
    token: string = this.options.bearerToken,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
          headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
        });
        if (response.ok) return (await response.json()) as unknown;

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.maxRetries) {
          throw new XApiError(
            `X API ${response.status} for ${init.method ?? 'GET'} ${url}`,
            response.status,
            retryable,
          );
        }
        await this.sleep(this.backoffMs(response, attempt));
      } catch (error) {
        if (error instanceof XApiError) throw error;
        // Network error or abort: retry with plain exponential backoff.
        lastError = error;
        if (attempt === this.maxRetries) break;
        await this.sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new XApiError(
      `X API unreachable after ${this.maxRetries + 1} attempts: ${String(lastError)}`,
      0,
      true,
    );
  }

  /**
   * Honour `x-rate-limit-reset` (UNIX SECONDS, not a delta) when X sends it:
   * guessing a delay against a 15-minute window just burns more of the quota.
   */
  private backoffMs(response: Response, attempt: number): number {
    const reset = response.headers.get('x-rate-limit-reset');
    if (reset) {
      const resetMs = Number(reset) * 1000 - this.now();
      if (Number.isFinite(resetMs) && resetMs > 0) return Math.min(MAX_BACKOFF_MS, resetMs + 250);
    }
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_BACKOFF_MS, seconds * 1000);
    }
    return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt);
  }

  private toMention(tweet: XTweet, includes: XIncludes): Mention | null {
    const author = includes.users?.find((u) => u.id === tweet.author_id);
    const repliedTo = tweet.referenced_tweets?.find((r) => r.type === 'replied_to') ?? null;
    const parent = repliedTo ? (includes.tweets?.find((t) => t.id === repliedTo.id) ?? null) : null;
    const parsed = mentionSchema.safeParse({
      id: tweet.id,
      text: tweet.text,
      authorId: tweet.author_id ?? '',
      authorHandle: author?.username ?? tweet.author_id ?? '',
      createdAt: tweet.created_at ?? new Date(this.now()).toISOString(),
      inReplyToPostId: repliedTo?.id ?? null,
      // NOT in_reply_to_user_id - that is the addressee, not the post owner.
      parentAuthorId: parent?.author_id ?? null,
      conversationId: tweet.conversation_id ?? null,
    });
    return parsed.success ? parsed.data : null;
  }

  private toSourcePost(tweet: XTweet, includes: XIncludes): SourcePost | null {
    const author = includes.users?.find((u) => u.id === tweet.author_id);
    const mediaKeys = tweet.attachments?.media_keys ?? [];
    const media = includes.media?.find(
      (m) => mediaKeys.includes(m.media_key) && (m.type === 'video' || m.type === 'animated_gif'),
    );
    const metrics = tweet.public_metrics;

    const parsed = sourcePostSchema.safeParse({
      postId: tweet.id,
      authorId: tweet.author_id ?? '',
      authorHandle: author?.username ?? tweet.author_id ?? '',
      authorFollowers: author?.public_metrics?.followers_count ?? 0,
      text: tweet.text,
      createdAt: tweet.created_at ?? new Date(this.now()).toISOString(),
      metrics: {
        likeCount: metrics?.like_count ?? 0,
        replyCount: metrics?.reply_count ?? 0,
        retweetCount: metrics?.retweet_count ?? 0,
        quoteCount: metrics?.quote_count ?? 0,
        impressionCount: metrics?.impression_count ?? null,
        bookmarkCount: metrics?.bookmark_count ?? 0,
      },
      video: media ? bestVideo(media) : null,
      lang: tweet.lang ?? null,
    });
    return parsed.success ? parsed.data : null;
  }
}

/** Pick the highest-bitrate mp4 variant; that is the one worth dubbing. */
function bestVideo(media: XMedia): unknown {
  const variants = (media.variants ?? [])
    .filter((v) => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0));
  const url = variants[0]?.url ?? media.url;
  if (!url || media.duration_ms === undefined) return null;
  return {
    mediaKey: media.media_key,
    type: 'video',
    durationMs: media.duration_ms,
    previewImageUrl: media.preview_image_url ?? null,
    url,
  };
}

/**
 * Gated on config.capabilities.xApi. Returns null when X is not configured, so
 * the caller falls back to the mock rather than booting a half-live bot.
 */
export function createXApiAdapter(
  config: Config,
  overrides: Partial<XApiAdapterOptions> = {},
): XApiAdapter | null {
  if (!config.capabilities.xApi) return null;
  const { X_BEARER_TOKEN, X_BOT_USER_ID, X_ACCESS_TOKEN } = config.env;
  if (!X_BEARER_TOKEN || !X_BOT_USER_ID) return null;
  return new XApiAdapter({
    bearerToken: X_BEARER_TOKEN,
    botUserId: X_BOT_USER_ID,
    userAccessToken: X_ACCESS_TOKEN,
    ...overrides,
  });
}
