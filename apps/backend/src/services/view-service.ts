/**
 * Counting who watched.
 *
 * A dub is watched in two places, and they are counted separately:
 *
 *   1. In the thread, as a post. Its view count is read back from the timeline
 *      through the same adapter the bot uses - the platform's own number, not
 *      ours. This is where most views are, and it is what the creator is
 *      charged on. It says how many, never who.
 *   2. On Parrot's own page for the dub. Here each viewer is counted once, and
 *      their browser says what language it is set to and (through the proxy in
 *      front of us) what country they are in. This is the only real look at
 *      where an audience is.
 *
 * Replies under a dub are read for the language they were written in (see
 * reply-languages.ts).
 */

import { normalizeLanguageCode } from '@parrot/shared';
import type { XAdapter } from '../bot/x-adapter.js';
import type { Store } from '../store/store.js';
import type { Creator, Dub } from '../store/types.js';
import type { CampaignService } from './campaign-service.js';
import { OTHER_LANGUAGE, type ReplyLanguageReader } from './reply-languages.js';

export interface ViewServiceDeps {
  readonly store: Store;
  readonly adapter: XAdapter;
  readonly campaigns: CampaignService;
  readonly replyLanguages: ReplyLanguageReader;
  readonly onChange?: (creator: Creator, reason: 'views') => void;
}

export interface PageViewer {
  /** Stable per browser, from a cookie. */
  readonly key: string;
  /** Two-letter country, when the proxy told us. */
  readonly country: string | null;
  /** The browser's Accept-Language header. */
  readonly acceptLanguage: string | null;
}

/** "es-MX,es;q=0.9,en;q=0.8" -> { lang: "es", region: "MX" } */
export function parseAcceptLanguage(header: string | null): { lang: string | null; region: string | null } {
  const first = header?.split(',')[0]?.split(';')[0]?.trim();
  if (!first) return { lang: null, region: null };
  const [lang, region] = first.split(/[-_]/);
  return {
    lang: lang ? normalizeLanguageCode(lang) : null,
    region: region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : null,
  };
}

export class ViewService {
  /** dub id -> viewer keys already counted on its page. */
  private readonly seen = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** The reply reader's version when each dub's replies were last tallied. */
  private readonly talliedAt = new Map<string, number>();

  constructor(private readonly deps: ViewServiceDeps) {}

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.sync().catch((error: unknown) => console.error('[views] sync failed', error));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Count one viewer on Parrot's page for a dub. Returns false when they were
   * already counted, or the dub is not live.
   */
  recordPageView(dubId: string, viewer: PageViewer): boolean {
    const { store } = this.deps;
    const dub = store.getDub(dubId);
    if (!dub || dub.state !== 'PUBLISHED') return false;

    const seen = this.seen.get(dubId) ?? new Set<string>();
    this.seen.set(dubId, seen);
    if (seen.has(viewer.key)) return false;
    // Bounded: one very popular dub must not grow this without limit. Past the
    // cap, new viewers are still counted, just no longer de-duplicated.
    if (seen.size < 50_000) seen.add(viewer.key);

    const country = viewer.country ?? parseAcceptLanguage(viewer.acceptLanguage).region;
    const countries = { ...dub.countries };
    if (country) countries[country] = (countries[country] ?? 0) + 1;
    store.updateDub(dubId, { pageViews: dub.pageViews + 1, countries });

    const creator = store.creators.get(dub.creatorId);
    if (creator) this.deps.onChange?.(creator, 'views');
    return true;
  }

  /** Read every live dub's numbers back from the timeline. */
  async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { store, adapter, campaigns } = this.deps;
      const changed = new Set<string>();

      for (const dub of [...store.dubs.values()]) {
        if (dub.state !== 'PUBLISHED' || !dub.replyPostId) continue;
        const post = await adapter.getPost(dub.replyPostId).catch(() => null);
        if (!post) continue;

        const patch: Partial<Dub> = {};
        const views = post.metrics.impressionCount ?? 0;
        // A count that went down is a glitch on the other side; never un-count.
        if (views > dub.xViews) patch.xViews = views;
        if (post.metrics.likeCount !== dub.likes) patch.likes = post.metrics.likeCount;
        if (post.metrics.retweetCount !== dub.reposts) patch.reposts = post.metrics.retweetCount;

        if (adapter.listReplies) {
          const replies = await adapter.listReplies(dub.replyPostId).catch(() => []);
          // Re-count when there are new replies, or when earlier answers were
          // improved by the model since this dub was last tallied.
          const version = this.deps.replyLanguages.version;
          if (replies.length !== dub.replies || (replies.length > 0 && this.talliedAt.get(dub.id) !== version)) {
            const languages = this.deps.replyLanguages.read(replies);
            const tally: Record<string, number> = {};
            for (const code of languages.values()) tally[code || OTHER_LANGUAGE] = (tally[code || OTHER_LANGUAGE] ?? 0) + 1;
            this.talliedAt.set(dub.id, version);
            if (replies.length !== dub.replies) patch.replies = replies.length;
            if (JSON.stringify(tally) !== JSON.stringify(dub.replyLanguages)) patch.replyLanguages = tally;
          }
        }

        if (Object.keys(patch).length > 0) {
          store.updateDub(dub.id, patch);
          changed.add(dub.creatorId);
        }
      }

      if (campaigns.refreshMeasured()) for (const creator of store.creators.values()) changed.add(creator.id);

      for (const creatorId of changed) {
        const creator = store.creators.get(creatorId);
        if (creator) this.deps.onChange?.(creator, 'views');
      }
    } finally {
      this.running = false;
    }
  }
}
