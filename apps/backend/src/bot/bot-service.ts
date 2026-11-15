/**
 * What the bot says, who it is allowed to say yes to, and how often it speaks.
 *
 * Three responsibilities, all of them boring on purpose:
 *
 *  1. COMPOSITION. Every user-facing word comes from `copy.bot.*` through
 *     `fill()`. Nothing in this file writes a sentence of its own. That is what
 *     keeps the forbidden-vocabulary guard in packages/shared/test/copy.test.ts
 *     meaningful - if replies were assembled from local string literals, the
 *     word "wallet" could reach a creator without the build noticing.
 *
 *  2. AUTHORISATION (see isAuthorised below).
 *
 *  3. DEDUPE + RATE LIMITING. X redelivers mentions, and a redelivered mention
 *     that re-dubs is money spent twice.
 */

import {
  copy,
  fill,
  formatUsd,
  languageName,
  type DeclineReason,
  type JobState,
  type Mention,
  type Micros,
  type SourcePost,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { PostedReply, XAdapter } from './x-adapter.js';

// ---------------------------------------------------------------------------
// Reply composition
// ---------------------------------------------------------------------------

export type ReplyKind =
  | 'accepted'
  | 'published'
  | 'duplicate'
  | 'declined'
  | 'qcFailed'
  | 'firstUnlock'
  | 'dailySummary'
  | 'status'
  | 'error'
  | 'rateLimited';

export interface ReplyParamsByKind {
  accepted: { language: string };
  published: { language: string; link: string };
  duplicate: { language: string; link: string };
  declined: { reason: DeclineReason };
  qcFailed: Record<string, never>;
  firstUnlock: { language: string; amount: Micros | string };
  dailySummary: { language: string; amount: Micros | string; count: number };
  status: { state: JobState; detail?: string };
  error: Record<string, never>;
  rateLimited: Record<string, never>;
}

/**
 * One decline reason -> one line of copy. The reasons come from the state
 * machine's DECLINE_REASONS, so a new reason is a compile error here rather
 * than a silently generic reply.
 */
const DECLINE_COPY: Readonly<Record<DeclineReason, string>> = {
  LOW_EV: copy.bot.declineReasonLowSignal,
  BUDGET_FLOOR: copy.bot.declineReasonBudget,
  DAILY_CAP: copy.bot.declineReasonBudget,
  MAX_EXPOSURE: copy.bot.declineReasonBudget,
  TOO_LONG: copy.bot.declineReasonTooLong,
  UNSUPPORTED_LANGUAGE: copy.bot.declineReasonUnsupportedLanguage,
  NO_VIDEO: copy.bot.declineReasonNoVideo,
  NOT_AUTHOR: copy.bot.declineReasonNotAuthor,
};

/** Job state -> the plain-language phrase a creator reads. */
const STATE_COPY: Readonly<Record<JobState, string>> = {
  REQUESTED: copy.status.requested,
  PARSED: copy.status.parsed,
  EVALUATING: copy.status.evaluating,
  DECLINED: copy.status.declined,
  APPROVED: copy.status.approved,
  DUBBING: copy.status.dubbing,
  QC: copy.status.qc,
  REJECTED_BY_QC: copy.status.rejectedByQc,
  PUBLISHED: copy.status.published,
  EARNING: copy.status.earning,
  SETTLED: copy.status.settled,
  FAILED: copy.status.failed,
};

export function statusPhrase(state: JobState): string {
  return STATE_COPY[state];
}

export function declineLine(reason: DeclineReason): string {
  return DECLINE_COPY[reason];
}

function asAmount(value: Micros | string): string {
  return typeof value === 'string' ? value : formatUsd(value);
}

export function composeReply(kind: 'accepted', params: ReplyParamsByKind['accepted']): string;
export function composeReply(kind: 'published', params: ReplyParamsByKind['published']): string;
export function composeReply(kind: 'duplicate', params: ReplyParamsByKind['duplicate']): string;
export function composeReply(kind: 'declined', params: ReplyParamsByKind['declined']): string;
export function composeReply(kind: 'qcFailed', params?: ReplyParamsByKind['qcFailed']): string;
export function composeReply(kind: 'firstUnlock', params: ReplyParamsByKind['firstUnlock']): string;
export function composeReply(
  kind: 'dailySummary',
  params: ReplyParamsByKind['dailySummary'],
): string;
export function composeReply(kind: 'status', params: ReplyParamsByKind['status']): string;
export function composeReply(kind: 'error', params?: ReplyParamsByKind['error']): string;
export function composeReply(kind: 'rateLimited', params?: ReplyParamsByKind['rateLimited']): string;
export function composeReply(kind: ReplyKind, params: Record<string, unknown> = {}): string {
  switch (kind) {
    case 'accepted': {
      const p = params as unknown as ReplyParamsByKind['accepted'];
      return fill(copy.bot.acceptedReply, { language: languageName(p.language) });
    }
    case 'published': {
      const p = params as unknown as ReplyParamsByKind['published'];
      return fill(copy.bot.publishedReply, {
        language: languageName(p.language),
        link: p.link,
      });
    }
    case 'duplicate': {
      const p = params as unknown as ReplyParamsByKind['duplicate'];
      return fill(copy.bot.duplicateReply, {
        language: languageName(p.language),
        link: p.link,
      });
    }
    case 'declined': {
      const p = params as unknown as ReplyParamsByKind['declined'];
      return fill(copy.bot.declinedReply, { reason: declineLine(p.reason) });
    }
    case 'qcFailed':
      return copy.bot.qcFailedReply;
    case 'firstUnlock': {
      const p = params as unknown as ReplyParamsByKind['firstUnlock'];
      return fill(copy.bot.firstUnlockReply, {
        language: languageName(p.language),
        amount: asAmount(p.amount),
      });
    }
    case 'dailySummary': {
      const p = params as unknown as ReplyParamsByKind['dailySummary'];
      return fill(copy.bot.dailySummaryReply, {
        language: languageName(p.language),
        amount: asAmount(p.amount),
        count: p.count,
      });
    }
    case 'status': {
      const p = params as unknown as ReplyParamsByKind['status'];
      // `detail` is optional in the call but not in the template, so an empty
      // one becomes an empty string rather than making fill() throw.
      return fill(copy.bot.statusReply, {
        status: statusPhrase(p.state),
        detail: p.detail ?? '',
      }).trim();
    }
    case 'error':
      return copy.bot.errorReply;
    case 'rateLimited':
      return copy.bot.rateLimitedReply;
    default: {
      const exhaustive: never = kind;
      throw new Error(`unknown reply kind ${String(exhaustive)}`);
    }
  }
}

/** The watch link that goes in a published/duplicate reply. */
export function watchLink(jobId: string, webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/$/, '')}/w/${jobId}`;
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * AUTHORISATION RULE: by default, only the AUTHOR of the post may ask for it to
 * be dubbed.
 *
 * The reason is money, not politeness. A published dub pays the creator share
 * to whoever Parrot recognises as the creator of the source post. If anyone
 * could reply "@parrot dub this to Spanish" under someone else's video, they
 * would be spending Parrot's budget on content they do not own, and the
 * earnings would attach to a post whose author never opted in. It is also the
 * only consent signal we have: a creator asking under their own video is the
 * creator agreeing to be dubbed.
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
    this.webBaseUrl = options.webBaseUrl ?? 'http://localhost:3000';
    this.limiter = new RateLimiter(
      options.replyLimit ?? DEFAULT_REPLY_LIMIT,
      options.replyWindowMs ?? DEFAULT_REPLY_WINDOW_MS,
      options.now,
    );
  }

  get isMock(): boolean {
    return this.adapter.isMock;
  }

  link(jobId: string): string {
    return watchLink(jobId, this.webBaseUrl);
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
  recordOutcome(mentionId: string, jobId: string | null, outcome: string): void {
    this.store.markMentionProcessed(mentionId, jobId, outcome);
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
        text: composeReply('rateLimited'),
        reply: null,
        suppressedBy: 'rate_limit',
      };
    }
    const reply = await this.adapter.reply(inReplyToId, text);
    return { sent: true, text, reply };
  }
}
