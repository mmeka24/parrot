/**
 * Every way a dub gets asked for, through one door.
 *
 *   - a creator replies "@parrot dub this" under their own video
 *   - a creator with auto-dub on posts a new video
 *   - a creator presses "Dub this post" on their dashboard
 *   - the browser extension asks on a creator's behalf from x.com
 *
 * All four end in `request`, which decides, orders the dubs through
 * CampaignService and says what it is doing in the thread. So there is one
 * place where "who may ask" and "what does it cost Parrot today" are enforced.
 */

import {
  DEFAULT_POST_BUDGET,
  DEFAULT_VALUE_PER_THOUSAND_VIEWS,
  DEMO_CREATOR_BALANCE,
  estimateDubCost,
  type DeclineReason,
  type Micros,
  type SourcePost,
} from '@parrot/shared';
import type { BotService } from '../bot/bot-service.js';
import { replies } from '../bot/bot-service.js';
import { parseIntent, resolveLanguage } from '../bot/grok-parser.js';
import type { MockXAdapter } from '../bot/mock-x-adapter.js';
import type { Store } from '../store/store.js';
import type { Creator, Dub, DubbedPost, ObservedPost } from '../store/types.js';
import type { CampaignService } from './campaign-service.js';

export interface DubFlowDeps {
  readonly store: Store;
  readonly bot: BotService;
  readonly campaigns: CampaignService;
  /** The stand-in timeline, when it is the one in use. */
  readonly mockX: MockXAdapter | null;
  readonly botHandle: string;
  readonly grok: { apiKey?: string | undefined; baseUrl?: string; model?: string };
  /** The most Parrot will spend on dubs in a day. Null for no limit. */
  readonly dailySpendCap: Micros | null;
  /** Demo: handle -> languages whose dub should fail the quality check. */
  readonly qcDemoFail?: Readonly<Record<string, readonly string[]>>;
}

export type FlowResult =
  | { readonly kind: 'started'; readonly post: DubbedPost; readonly dubs: readonly Dub[]; readonly summary: string; readonly done: Promise<void> }
  | { readonly kind: 'duplicate'; readonly dub: Dub; readonly link: string }
  | { readonly kind: 'declined'; readonly reason: DeclineReason }
  | { readonly kind: 'busy' };

export interface RequestInput {
  readonly creator: Creator;
  readonly sourcePostId: string;
  readonly sourceUrl: string;
  readonly text: string;
  readonly durationS: number;
  readonly originalViews: number | null;
  readonly lang: string | null;
  /** Where Parrot says what it is doing. Null to stay quiet (no thread to speak in). */
  readonly announceUnder: string | null;
  readonly createdAt?: Date;
}

export class DubFlow {
  constructor(private readonly deps: DubFlowDeps) {}

  /** The creator record for whoever wrote a post, made on first sight. */
  ensureCreator(author: { xUserId: string; handle: string; displayName: string; followers: number }): Creator {
    const { store } = this.deps;
    const existing = store.findCreatorByXUserId(author.xUserId) ?? store.findCreatorByHandle(author.handle);
    if (existing) return existing;
    const account = store.createAccount({ kind: 'creator', label: `@${author.handle}`, email: null, walletAddress: null });
    // Nobody has signed in as them yet, so they start on a test balance.
    store.appendLedger({ accountId: account.id, amount: DEMO_CREATOR_BALANCE, kind: 'demo_credit', ref: 'demo-balance' });
    return store.createCreator({
      xUserId: author.xUserId,
      handle: author.handle,
      displayName: author.displayName,
      accountId: account.id,
      followers: author.followers,
      userId: null,
      valuePerThousand: DEFAULT_VALUE_PER_THOUSAND_VIEWS,
      valueIsDefault: true,
      postBudget: DEFAULT_POST_BUDGET,
      autoDub: false,
      sourceLang: 'en',
      lowBalance: false,
    });
  }

  /** A creator for a name on the stand-in timeline, if there is such a person. */
  creatorForHandle(handle: string): Creator | undefined {
    const { store, mockX } = this.deps;
    const existing = store.findCreatorByHandle(handle);
    if (existing || !mockX) return existing;
    const user = mockX.userFor(handle);
    if (!user || user.handle === this.deps.botHandle) return undefined;
    return this.ensureCreator(user);
  }

  private spentToday(): bigint {
    const { store } = this.deps;
    const house = store.houseAccount().id;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    let total = 0n;
    for (const entry of store.ledger) {
      if (entry.accountId === house && entry.kind === 'dub_cost' && entry.createdAt >= start) total -= entry.amount as bigint;
    }
    return total;
  }

  /** Order dubs for a post, and say so in the thread. */
  async request(input: RequestInput): Promise<FlowResult> {
    const { campaigns, bot } = this.deps;
    const say = async (text: string): Promise<void> => {
      if (input.announceUnder) await bot.send(input.announceUnder, text).catch(() => undefined);
    };

    // A public server must have a bounded worst case. Checked against the most
    // this request could cost, before anything is ordered.
    if (this.deps.dailySpendCap !== null) {
      const most = (estimateDubCost(input.durationS) as bigint) * BigInt(input.lang ? 1 : campaigns.plan(input.creator).entries.length);
      if (this.spentToday() + most > (this.deps.dailySpendCap as bigint)) {
        await say(replies.rateLimited());
        return { kind: 'busy' };
      }
    }

    const result = await campaigns.start({
      creator: input.creator,
      sourcePostId: input.sourcePostId,
      sourceUrl: input.sourceUrl,
      text: input.text,
      durationS: input.durationS,
      originalViews: input.originalViews,
      lang: input.lang,
      qcDemoFail: this.deps.qcDemoFail?.[input.creator.handle] ?? [],
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });

    if (result.kind === 'declined') {
      await say(replies.declined(result.reason));
      return result;
    }
    if (result.kind === 'duplicate') {
      const link = bot.link(result.dub.id);
      await say(replies.duplicate(result.dub.lang, link));
      return { kind: 'duplicate', dub: result.dub, link };
    }

    await say(replies.plan(result.dubs.map((d) => d.lang)));
    const done = campaigns.run(result.post.id).catch((error: unknown) => {
      console.error(`[flow] dubbing post ${result.post.id} failed`, error);
    });
    return { kind: 'started', post: result.post, dubs: result.dubs, summary: result.summary, done };
  }

  private inputFromSource(creator: Creator, source: SourcePost, sourceUrl: string, lang: string | null, announceUnder: string | null): RequestInput {
    return {
      creator,
      sourcePostId: source.postId,
      sourceUrl,
      text: source.text,
      durationS: source.video ? source.video.durationMs / 1000 : 0,
      originalViews: source.metrics.impressionCount,
      lang,
      announceUnder,
      createdAt: source.createdAt,
    };
  }

  /** Dub one of a creator's own posts on the timeline. Used by the dashboard and auto-dub. */
  async requestForPost(creator: Creator, sourcePostId: string, lang: string | null): Promise<FlowResult> {
    const source = await this.deps.bot.getPost(sourcePostId);
    if (!source?.video) return { kind: 'declined', reason: 'NO_VIDEO' };
    if (source.authorHandle.toLowerCase() !== creator.handle.toLowerCase()) return { kind: 'declined', reason: 'NOT_AUTHOR' };
    return this.request(this.inputFromSource(creator, source, this.urlFor(source), lang, source.postId));
  }

  private urlFor(source: SourcePost): string {
    return this.deps.mockX
      ? this.deps.mockX.postUrl(source.postId)
      : `https://x.com/${source.authorHandle}/status/${source.postId}`;
  }

  /**
   * The whole journey from a mention to a reply. Returns once the dubs have
   * been ordered; `done` on the result settles when they are all finished.
   */
  async processMention(mentionId: string): Promise<FlowResult | null> {
    const { bot } = this.deps;
    if (!bot.claimMention(mentionId)) return null;

    const mention = (await bot.fetchMentions()).find((m) => m.id === mentionId);
    if (!mention) return null;

    const intent = await parseIntent(mention.text, { botHandle: this.deps.botHandle, ...this.deps.grok });
    if (intent.action !== 'dub') {
      await bot.send(mention.id, replies.error());
      bot.recordOutcome(mention.id, null, 'not_a_dub_request');
      return null;
    }
    // No language named means "you choose". A language named that Parrot does
    // not speak is a different thing, and gets an honest no.
    if (intent.targetLang === null && resolveLanguage(mention.text).unsupported !== null) {
      await bot.send(mention.id, replies.declined('UNSUPPORTED_LANGUAGE'));
      bot.recordOutcome(mention.id, null, 'declined:UNSUPPORTED_LANGUAGE');
      return { kind: 'declined', reason: 'UNSUPPORTED_LANGUAGE' };
    }

    const source = mention.inReplyToPostId ? await bot.getPost(mention.inReplyToPostId) : null;
    if (!source?.video) {
      await bot.send(mention.id, replies.declined('NO_VIDEO'));
      bot.recordOutcome(mention.id, null, 'declined:NO_VIDEO');
      return { kind: 'declined', reason: 'NO_VIDEO' };
    }
    // Only the author may ask: the views are charged to the post's owner.
    if (!bot.isAuthorised(mention, source)) {
      await bot.send(mention.id, replies.declined('NOT_AUTHOR'));
      bot.recordOutcome(mention.id, null, 'declined:NOT_AUTHOR');
      return { kind: 'declined', reason: 'NOT_AUTHOR' };
    }

    const creator = this.ensureCreator({
      xUserId: source.authorId,
      handle: source.authorHandle,
      displayName: source.authorDisplayName ?? source.authorHandle,
      followers: source.authorFollowers,
    });
    const result = await this.request(this.inputFromSource(creator, source, this.urlFor(source), intent.targetLang, mention.id));
    bot.recordOutcome(
      mention.id,
      result.kind === 'started' ? result.post.id : null,
      result.kind === 'declined' ? `declined:${result.reason}` : result.kind,
    );
    return result;
  }

  /**
   * A request for a real x.com post, from the extension. The post's numbers
   * were read off a page (unverified), and the answer goes back to the
   * extension rather than into a reply on X, which Parrot cannot post to.
   */
  async dubObservedPost(post: ObservedPost, lang: string | null): Promise<string> {
    const creator = this.ensureCreator({
      // No X user id without the API; the handle is the stable key we have.
      xUserId: `x-handle-${post.authorHandle}`,
      handle: post.authorHandle,
      displayName: post.authorDisplayName || post.authorHandle,
      followers: 0,
    });
    const result = await this.request({
      creator,
      sourcePostId: post.postId,
      sourceUrl: `https://x.com/${post.authorHandle}/status/${post.postId}`,
      text: post.text,
      durationS: post.durationS ?? 30,
      originalViews: post.metrics.views,
      lang,
      announceUnder: null,
      ...(post.createdAt ? { createdAt: post.createdAt } : {}),
    });
    if (result.kind === 'declined') return replies.declined(result.reason);
    if (result.kind === 'duplicate') return replies.duplicate(result.dub.lang, result.link);
    if (result.kind === 'busy') return replies.rateLimited();
    return replies.plan(result.dubs.map((d) => d.lang));
  }

  /** A new video post on the timeline: dub it if its author asked for that. */
  async onNewVideoPost(postId: string, authorHandle: string): Promise<void> {
    const creator = this.deps.store.findCreatorByHandle(authorHandle);
    if (!creator?.autoDub) return;
    await this.requestForPost(creator, postId, null);
  }
}
