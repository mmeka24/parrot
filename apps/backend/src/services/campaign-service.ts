/**
 * Dubbing a post: decide the languages, make the dubs, check them, post them.
 *
 * One post becomes several dubs, one per language. Which languages is decided
 * by `planLanguages` (@parrot/shared) from what this creator's earlier posts
 * showed; a creator can also ask for one language by name.
 *
 * Who pays for what:
 *   - Parrot pays for every dub the moment it is ordered (a `dub_cost` entry
 *     against the house account). A dub that fails the quality check, or that
 *     nobody watches, is Parrot's loss.
 *   - The creator pays nothing here. They are charged later, per view, by
 *     BillingService.
 *
 * Each dub moves through the state machine in @parrot/shared and nowhere else,
 * so a dub cannot be posted without having passed the quality check.
 */

import {
  MAX_SOURCE_DURATION_S,
  MIN_CHARGE,
  MIN_SOURCE_DURATION_S,
  SUPPORTED_LANGUAGES,
  breakEvenViews,
  estimateDubCost,
  micros,
  planLanguages,
  transition,
  type DeclineReason,
  type DubState,
  type FailureReason,
  type LanguagePlan,
  type Micros,
  type PlanRole,
  type PostHistory,
  type QcReport,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Creator, Dub, DubbedPost } from '../store/types.js';
import { DubbingTimeoutError } from './dubbing-service.js';

// ---------------------------------------------------------------------------
// Ports: the narrow interfaces this service depends on, so the provider, the
// quality check and the timeline can each be swapped or stubbed.
// ---------------------------------------------------------------------------

export interface DubbingPort {
  createDub(input: {
    sourceUrl: string;
    targetLang: string;
    durationS: number;
  }): Promise<{ providerJobId: string; simulated: boolean }>;
  pollUntilReady(providerJobId: string): Promise<void>;
  downloadDub(providerJobId: string, languageCode: string): Promise<{ localPath: string; simulated: boolean }>;
}

export interface QcPort {
  run(input: {
    dubPath: string;
    sourceDurationS: number;
    targetLang: string;
    simulated: boolean;
    sourceUrl: string;
    /** Demo: fail on purpose, and say so in the report. */
    forceFail: boolean;
  }): Promise<QcReport>;
}

/**
 * Posts a finished dub in the thread under the original. Resolves with nulls
 * when there is no thread to post in (a post seen only through the extension);
 * the dub is then live on Parrot's own page only.
 */
export interface PublisherPort {
  publish(input: {
    sourcePostId: string;
    dub: Dub;
    durationS: number;
  }): Promise<{ postId: string | null; url: string | null }>;
}

/** Says something under a post. Failures are swallowed by the caller. */
export type Announce = (inReplyToId: string, kind: 'qcFailed' | 'failed', lang: string) => Promise<void>;

export interface CampaignDeps {
  readonly store: Store;
  readonly dubbing: DubbingPort;
  readonly qc: QcPort;
  readonly publisher: PublisherPort;
  /** What the creator can spend right now. Null when it cannot be read. */
  readonly available: (creator: Creator) => Promise<Micros | null>;
  readonly announce?: Announce;
  /** Called whenever something a dashboard shows has changed. */
  readonly onChange?: (creator: Creator, reason: 'dub' | 'views') => void;
  readonly now?: () => Date;
  /** How long a post's dubs are watched before the results count. */
  readonly measureWindowMs: number;
  /** Languages tried while still learning. Defaults to the shared setting. */
  readonly exploreCount?: number;
}

export interface StartInput {
  readonly creator: Creator;
  readonly sourcePostId: string;
  readonly sourceUrl: string;
  readonly text: string;
  readonly durationS: number;
  readonly originalViews: number | null;
  /** One language, asked for by name. Omit to let Parrot choose. */
  readonly lang?: string | null;
  /** Demo: languages whose dub should fail the quality check on purpose. */
  readonly qcDemoFail?: readonly string[];
  readonly createdAt?: Date;
}

export type StartResult =
  | { readonly kind: 'started'; readonly post: DubbedPost; readonly dubs: readonly Dub[]; readonly summary: string }
  | { readonly kind: 'duplicate'; readonly post: DubbedPost; readonly dub: Dub }
  | { readonly kind: 'declined'; readonly reason: DeclineReason };

const HARD_FAILURE_COPY: Readonly<Record<FailureReason, string>> = {
  DUBBING_FAILED: 'The dub could not be made.',
  DUBBING_TIMEOUT: 'The dub took too long to make.',
  QC_ERROR: 'The quality check could not be run.',
  PUBLISH_FAILED: 'The dub was made but could not be posted.',
  INTERNAL: 'Something went wrong on our side.',
};

export class CampaignService {
  private readonly now: () => Date;

  constructor(private readonly deps: CampaignDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // What has been learned
  // -------------------------------------------------------------------------

  /** A dub's views, wherever they were counted. */
  static viewsOf(dub: Pick<Dub, 'xViews' | 'pageViews'>): number {
    return dub.xViews + dub.pageViews;
  }

  /** Every measured post of a creator's, oldest first, as the planner reads it. */
  history(creator: Creator): PostHistory[] {
    const { store } = this.deps;
    return store
      .postsForCreator(creator.id)
      .filter((post) => post.measuredAt !== null)
      .map((post) => ({
        results: store
          .dubsForPost(post.id)
          .filter((dub) => dub.state === 'PUBLISHED')
          .map((dub) => ({
            lang: dub.lang,
            views: CampaignService.viewsOf(dub),
            breakEvenViews: breakEvenViews(dub.dubCost),
          })),
      }))
      .filter((post) => post.results.length > 0);
  }

  /** The plan for this creator's next post. */
  plan(creator: Creator): LanguagePlan {
    return planLanguages(this.history(creator), {
      sourceLang: creator.sourceLang,
      ...(this.deps.exploreCount !== undefined ? { exploreCount: this.deps.exploreCount } : {}),
    });
  }

  /**
   * Mark posts whose results now count. A post counts once every dub is
   * finished and either the demo audience has been and gone, or it has been
   * watched for the measuring window. A post nobody has seen yet is given a
   * full day before its zeroes are held against a language.
   */
  refreshMeasured(creatorId?: string): boolean {
    const { store } = this.deps;
    const nowMs = this.now().getTime();
    let changed = false;
    for (const post of store.posts.values()) {
      if (post.measuredAt !== null) continue;
      if (creatorId && post.creatorId !== creatorId) continue;
      const dubs = store.dubsForPost(post.id);
      const live = dubs.filter((d) => d.state === 'PUBLISHED');
      const working = dubs.some((d) => d.state === 'QUEUED' || d.state === 'DUBBING' || d.state === 'QC');
      if (working || live.length === 0) continue;

      const lastPublished = Math.max(...live.map((d) => d.publishedAt?.getTime() ?? 0));
      const age = nowMs - lastPublished;
      const seen = live.some((d) => CampaignService.viewsOf(d) > 0);
      const ready =
        post.demoAudience === 'done' ||
        (post.demoAudience === 'none' && seen && age >= this.deps.measureWindowMs) ||
        age >= 24 * 60 * 60_000;
      if (ready) {
        store.updatePost(post.id, { measuredAt: this.now() });
        changed = true;
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // Starting
  // -------------------------------------------------------------------------

  /**
   * Order the dubs for a post. Creates the records and returns at once; `run`
   * does the slow part.
   */
  async start(input: StartInput): Promise<StartResult> {
    const { store } = this.deps;
    const { creator } = input;

    if (input.durationS > MAX_SOURCE_DURATION_S) return { kind: 'declined', reason: 'TOO_LONG' };
    if (input.durationS < MIN_SOURCE_DURATION_S) return { kind: 'declined', reason: 'TOO_SHORT' };

    const requested = input.lang ? input.lang.toLowerCase() : null;
    if (requested !== null) {
      const known = SUPPORTED_LANGUAGES.some((l) => l.code === requested);
      if (!known || requested === creator.sourceLang) return { kind: 'declined', reason: 'UNSUPPORTED_LANGUAGE' };
    }

    const existing = store.findPostBySource(input.sourcePostId);
    if (existing && requested !== null) {
      const dub = store.findDub(existing.id, requested);
      if (dub) return { kind: 'duplicate', post: existing, dub };
    }

    // Which languages, and why.
    const plan = this.plan(creator);
    const already = new Set(existing ? store.dubsForPost(existing.id).map((d) => d.lang) : []);
    const wanted: { lang: string; role: PlanRole | 'requested' }[] =
      requested !== null
        ? [{ lang: requested, role: 'requested' }]
        : plan.entries.filter((e) => !already.has(e.lang)).map((e) => ({ lang: e.lang, role: e.role }));
    if (wanted.length === 0) return { kind: 'declined', reason: 'ALREADY_DUBBED' };

    // The creator must be able to pay for at least some views. An unreadable
    // balance is not held against them.
    const available = await this.deps.available(creator).catch(() => null);
    if (available !== null && (available as bigint) < (MIN_CHARGE as bigint)) {
      return { kind: 'declined', reason: 'NO_BALANCE' };
    }

    const summary =
      requested !== null
        ? `Dubbed into ${SUPPORTED_LANGUAGES.find((l) => l.code === requested)?.englishName ?? requested} because you asked for it.`
        : plan.summary;
    const post =
      existing ??
      store.createPost({
        creatorId: creator.id,
        sourcePostId: input.sourcePostId,
        sourceUrl: input.sourceUrl,
        text: input.text,
        durationS: input.durationS,
        originalViews: input.originalViews,
        mode: requested !== null ? 'requested' : plan.mode,
        summary,
        budget: creator.postBudget,
        measuredAt: null,
        demoAudience: 'none',
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      });
    // More dubs on a post that was already measured: measure it again.
    if (existing && existing.measuredAt !== null) store.updatePost(existing.id, { measuredAt: null });

    const dubCost = estimateDubCost(input.durationS);
    const failOnPurpose = new Set(input.qcDemoFail ?? []);
    const dubs = wanted.map(({ lang, role }) =>
      store.createDub({
        postId: post.id,
        creatorId: creator.id,
        lang,
        role,
        state: 'QUEUED',
        dubCost,
        simulatedDub: false,
        providerJobId: null,
        mediaPath: null,
        replyPostId: null,
        replyUrl: null,
        qcReport: null,
        failureReason: null,
        problem: null,
        xViews: 0,
        pageViews: 0,
        simulatedViews: 0,
        billedViews: 0,
        paid: micros(0n),
        likes: 0,
        replies: 0,
        reposts: 0,
        countries: {},
        replyLanguages: {},
        qcDemoFail: failOnPurpose.has(lang),
        publishedAt: null,
      }),
    );

    this.deps.onChange?.(creator, 'dub');
    return { kind: 'started', post, dubs, summary };
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  /** Make, check and post every dub of a post that is still waiting. */
  async run(postId: string): Promise<void> {
    const waiting = this.deps.store.dubsForPost(postId).filter((d) => d.state === 'QUEUED');
    // The dubbing service limits how many run at once; here they are simply
    // all started, and one failing never stops the others.
    await Promise.allSettled(waiting.map((dub) => this.runDub(dub.id)));
  }

  private move(dubId: string, to: DubState, patch: Partial<Dub> = {}): Dub {
    const { store } = this.deps;
    const current = store.getDub(dubId);
    if (!current) throw new Error(`unknown dub ${dubId}`);
    const dub = store.updateDub(dubId, { ...patch, state: transition(current.state, to) });
    const creator = store.creators.get(dub.creatorId);
    if (creator) this.deps.onChange?.(creator, 'dub');
    return dub;
  }

  private async fail(dubId: string, reason: FailureReason, sourcePostId: string): Promise<void> {
    const dub = this.move(dubId, 'FAILED', { failureReason: reason, problem: HARD_FAILURE_COPY[reason] });
    await this.deps.announce?.(sourcePostId, 'failed', dub.lang).catch(() => undefined);
  }

  private async runDub(dubId: string): Promise<void> {
    const { store, dubbing, qc, publisher } = this.deps;
    let dub = store.getDub(dubId);
    const post = dub ? store.posts.get(dub.postId) : undefined;
    if (!dub || !post) return;

    // ---- make it -------------------------------------------------------------
    dub = this.move(dub.id, 'DUBBING');
    let localPath: string;
    let simulated: boolean;
    try {
      const created = await dubbing.createDub({
        sourceUrl: post.sourceUrl,
        targetLang: dub.lang,
        durationS: post.durationS,
      });
      // Ordered: from here the dub has been paid for, whatever happens next.
      store.appendLedger({
        accountId: store.houseAccount().id,
        amount: micros(-(dub.dubCost as bigint)),
        kind: 'dub_cost',
        ref: dub.id,
      });
      store.updateDub(dub.id, { providerJobId: created.providerJobId, simulatedDub: created.simulated });
      await dubbing.pollUntilReady(created.providerJobId);
      const downloaded = await dubbing.downloadDub(created.providerJobId, dub.lang);
      localPath = downloaded.localPath;
      simulated = downloaded.simulated;
    } catch (error) {
      console.error(`[campaign] dub ${dub.id} (${dub.lang}) could not be made:`, error);
      await this.fail(dub.id, error instanceof DubbingTimeoutError ? 'DUBBING_TIMEOUT' : 'DUBBING_FAILED', post.sourcePostId);
      return;
    }

    // ---- check it ------------------------------------------------------------
    dub = this.move(dub.id, 'QC', { mediaPath: localPath, simulatedDub: simulated });
    let report: QcReport;
    try {
      report = await qc.run({
        dubPath: localPath,
        sourceDurationS: post.durationS,
        targetLang: dub.lang,
        simulated,
        sourceUrl: post.sourceUrl,
        forceFail: dub.qcDemoFail,
      });
    } catch (error) {
      console.error(`[campaign] dub ${dub.id} (${dub.lang}) could not be checked:`, error);
      await this.fail(dub.id, 'QC_ERROR', post.sourcePostId);
      return;
    }
    if (!report.passed) {
      const failed = report.checks.find((c) => !c.passed);
      this.move(dub.id, 'REJECTED_BY_QC', {
        qcReport: report,
        problem: failed?.detail ?? 'It did not pass the quality check.',
      });
      await this.deps.announce?.(post.sourcePostId, 'qcFailed', dub.lang).catch(() => undefined);
      return;
    }

    // ---- post it -------------------------------------------------------------
    try {
      const published = await publisher.publish({ sourcePostId: post.sourcePostId, dub, durationS: post.durationS });
      this.move(dub.id, 'PUBLISHED', {
        qcReport: report,
        replyPostId: published.postId,
        replyUrl: published.url,
        publishedAt: this.now(),
      });
    } catch (error) {
      console.error(`[campaign] dub ${dub.id} (${dub.lang}) could not be posted:`, error);
      store.updateDub(dub.id, { qcReport: report });
      await this.fail(dub.id, 'PUBLISH_FAILED', post.sourcePostId);
    }
  }
}
