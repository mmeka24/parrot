/**
 * What Parrot says under a post, who it listens to, and how often it speaks.
 *
 * Every reply is composed from the vocabulary map in @parrot/shared, so the
 * words a creator reads on the timeline are covered by the same forbidden-word
 * test as the rest of the product.
 */

import {
  copy,
  fill,
  languageByCode,
  languageName,
  type DeclineReason,
  type DubState,
  type Mention,
  type SourcePost,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { PostedReply, XAdapter } from './x-adapter.js';

// ---------------------------------------------------------------------------
// Reply composition
// ---------------------------------------------------------------------------

/**
 * One decline reason -> one line of copy. The reasons come from the state
 * machine's DECLINE_REASONS, so a new reason is a compile error here rather
 * than a silently generic reply.
 */
const DECLINE_COPY: Readonly<Record<DeclineReason, string>> = {
  TOO_LONG: copy.bot.declineReasonTooLong,
  TOO_SHORT: copy.bot.declineReasonTooShort,
  UNSUPPORTED_LANGUAGE: copy.bot.declineReasonUnsupportedLanguage,
  NO_VIDEO: copy.bot.declineReasonNoVideo,
  NOT_AUTHOR: copy.bot.declineReasonNotAuthor,
  NO_BALANCE: copy.bot.declineReasonNoBalance,
  ALREADY_DUBBED: copy.bot.declineReasonAlreadyDubbed,
};

/** Dub state -> the plain-language phrase a creator reads. */
const STATE_COPY: Readonly<Record<DubState, string>> = {
  QUEUED: copy.status.queued,
  DUBBING: copy.status.dubbing,
  QC: copy.status.qc,
  PUBLISHED: copy.status.published,
  REJECTED_BY_QC: copy.status.rejectedByQc,
  FAILED: copy.status.failed,
};

export function statusPhrase(state: DubState): string {
  return STATE_COPY[state];
}

export function declineLine(reason: DeclineReason): string {
  return DECLINE_COPY[reason];
}

function nameList(codes: readonly string[]): string {
  const names = codes.map((c) => languageName(c));
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The replies Parrot can give. Each returns the finished text. */
export const replies = {
  /** "On it" for a post Parrot chose the languages for. */
  plan: (langs: readonly string[]): string =>
    langs.length === 1
      ? fill(copy.bot.singleReply, { language: languageName(langs[0] as string) })
      : fill(copy.bot.planReply, { languages: nameList(langs) }),
  /** The text of the post that carries a dub. */
  dubPost: (lang: string, link: string): string => {
    const spec = languageByCode(lang);
    return fill(copy.bot.dubPost, {
      flag: spec?.flag ?? '',
      nativeName: spec?.nativeName ?? lang,
      language: spec?.englishName ?? lang,
      link,
    }).trim();
  },
  duplicate: (lang: string, link: string): string =>
    fill(copy.bot.duplicateReply, { language: languageName(lang), link }),
  declined: (reason: DeclineReason): string => fill(copy.bot.declinedReply, { reason: declineLine(reason) }),
  qcFailed: (lang: string): string => fill(copy.bot.qcFailedReply, { language: languageName(lang) }),
  failed: (lang: string): string => fill(copy.bot.failedReply, { language: languageName(lang) }),
  error: (): string => copy.bot.errorReply,
  rateLimited: (): string => copy.bot.rateLimitedReply,
} as const;

/** The watch link that goes with a dub. */
export function watchLink(dubId: string, webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/$/, '')}/w/${dubId}`;
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * AUTHORISATION RULE: by default, only the AUTHOR of the post may ask for it to
 * be dubbed.
 *
 * The reason is money, not politeness. The views a dub gets are charged to the
 * creator of the source post. If anyone could reply "@parrot dub this" under
 * someone else's video, they would be running up a bill for a person who never
 * asked. It is also the only consent signal we have: a creator asking under
 * their own video is the creator agreeing to be dubbed.
 *
 * `mention.parentAuthorId` MUST come from the expanded referenced-tweet author
 * (see x-adapter.ts) - `in_reply_to_user_id` is a different thing and using it
 * here would let a third party pass this check.
 *
 * When the mention is not a reply, there is no post to own, so there is nothing
 * to authorise and the caller declines with NO_VIDEO instead.
 */
export function isAuthorised(mention: Mention, sourcePost: SourcePost | null): boolean {
  if (!sourcePost) return false;
  if (mention.authorId === sourcePost.authorId) return true;
  // Fall back to the expansion when the post lookup is unavailable but the
  // mention still carries the parent author.
  if (mention.parentAuthorId !== null && mention.authorId === mention.parentAuthorId) {
    return sourcePost.authorId === mention.parentAuthorId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * A sliding window, sized to stay well inside X's limits (and, more to the
 * point, inside our prepaid credits - every link-bearing reply is $0.200).
 */
export class RateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Consume one slot. False means "do not send"; the caller replies rateLimited. */
  tryConsume(): boolean {
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] ?? 0) <= cutoff) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(this.now());
    return true;
  }

  get remaining(): number {
    const cutoff = this.now() - this.windowMs;
    return this.limit - this.hits.filter((t) => t > cutoff).length;
  }
}

/** Replies per 15 minutes. X allows more; our credit balance does not. */
export const DEFAULT_REPLY_LIMIT = 40;
export const DEFAULT_REPLY_WINDOW_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BotServiceOptions {
  readonly webBaseUrl?: string;
  readonly replyLimit?: number;
  readonly replyWindowMs?: number;
  readonly now?: () => number;
}

export interface SendResult {
  readonly sent: boolean;
  readonly text: string;
  readonly reply: PostedReply | null;
  /** Set when the reply was suppressed rather than sent. */
  readonly suppressedBy?: 'rate_limit';
}

export class BotService {
  private readonly limiter: RateLimiter;
  private readonly webBaseUrl: string;

  constructor(
    private readonly store: Store,
    private readonly adapter: XAdapter,
    options: BotServiceOptions = {},
  ) {
    this.webBaseUrl = options.webBaseUrl ?? 'http://localhost:3100';
    this.limiter = new RateLimiter(
      options.replyLimit ?? DEFAULT_REPLY_LIMIT,
      options.replyWindowMs ?? DEFAULT_REPLY_WINDOW_MS,
      options.now,
    );
  }

  get isMock(): boolean {
    return this.adapter.isMock;
  }

  link(dubId: string): string {
    return watchLink(dubId, this.webBaseUrl);
  }

  isAuthorised(mention: Mention, sourcePost: SourcePost | null): boolean {
    return isAuthorised(mention, sourcePost);
  }

  // -- dedupe ---------------------------------------------------------------

  /**
   * The double-dub guard. X redelivers mentions after a timeout or a restart,
   * and the 800-mention window means a replayed checkpoint re-reads old ones.
   * Claiming BEFORE doing any work is what makes the retry a no-op: the first
   * caller gets true, every later caller gets false.
   */
  claimMention(mentionId: string, outcome = 'claimed'): boolean {
    if (this.store.wasMentionProcessed(mentionId)) return false;
    this.store.markMentionProcessed(mentionId, null, outcome);
    return true;
  }

  /** Record the final outcome of a mention we already claimed. */
  recordOutcome(mentionId: string, postId: string | null, outcome: string): void {
    this.store.markMentionProcessed(mentionId, postId, outcome);
  }

  wasProcessed(mentionId: string): boolean {
    return this.store.wasMentionProcessed(mentionId);
  }

  // -- sending --------------------------------------------------------------

  async fetchMentions(sinceId?: string): Promise<Mention[]> {
    return this.adapter.fetchMentions(sinceId);
  }

  async getPost(postId: string): Promise<SourcePost | null> {
    return this.adapter.getPost(postId);
  }

  /**
   * Send a composed reply, unless we are over our own limit - in which case we
   * say so in the creator's language rather than going quiet.
   */
  async send(inReplyToId: string, text: string): Promise<SendResult> {
    if (!this.limiter.tryConsume()) {
      return {
        sent: false,
        text: replies.rateLimited(),
        reply: null,
        suppressedBy: 'rate_limit',
      };
    }
    const reply = await this.adapter.reply(inReplyToId, text);
    return { sent: true, text, reply };
  }
}
