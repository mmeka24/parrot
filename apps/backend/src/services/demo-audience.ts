/**
 * A demo audience, so the numbers have something to move on.
 *
 * A dub posted a minute ago has no views, and nothing can be learned from
 * zeroes. For a demo, this generates an audience for a post's dubs: views on
 * each dub's post, some likes and reposts, a few replies in the dub's language,
 * and a share of viewers who open Parrot's page (which is where a country is
 * recorded).
 *
 * EVERYTHING HERE IS SIMULATED AND LABELLED SO. Views it adds are counted in
 * `dub.simulatedViews`, the post is marked as having had a demo audience, and
 * any payment covering those views carries `simulatedViews`. It only exists
 * when the timeline is the local stand-in; against real X there is no such
 * thing, and real views are the only views.
 *
 * It is deterministic: each creator has a fixed, hidden taste for each
 * language, so the same post always draws the same audience. That hidden taste
 * is the thing the product is supposed to discover - the demo is honest about
 * the mechanism even though the audience is made up.
 */

import { INTERACTIONS_PER_VIEW, SUPPORTED_LANGUAGES, X_AD_REACH_MILLIONS, languageByCode } from '@parrot/shared';
import type { MockXAdapter } from '../bot/mock-x-adapter.js';
import type { Store } from '../store/store.js';
import type { Dub } from '../store/types.js';

/** Share of a language's market that opens a dub in the thread. Demo assumption. */
const DUB_UPTAKE = 0.02;
/**
 * A post with no real reach (a video posted a minute ago has 8 views) is sized
 * as if it had this many, so the demo audience is big enough to show anything.
 * It is a stand-in for the audience a real post would take weeks to collect,
 * and everything it produces is labelled simulated.
 */
const FALLBACK_REACH = 1_200_000;
const MIN_REACH = 20_000;
/** Share of a dub's viewers who also open Parrot's page for it. */
const PAGE_VISIT_SHARE = 0.05;

/** How strongly each seeded creator's audience takes to each language. Hidden from the planner. */
const KNOWN_TASTES: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  maria: { es: 2.2, pt: 1.6, hi: 1.1, fr: 0.3, id: 0.15, ar: 0.08, ja: 0.015, ko: 0.05, de: 0.05 },
  chefkenji: { ja: 1.4, ko: 1.2, es: 0.6, id: 0.5, pt: 0.2, fr: 0.2, ar: 0.05, hi: 0.1, de: 0.3 },
  devtoni: { hi: 2.4, de: 1.7, pt: 0.9, ja: 0.2, es: 0.25, ar: 0.05, id: 0.3, fr: 0.2, ko: 0.4 },
};

const SAMPLE_REPLIES: Readonly<Record<string, readonly string[]>> = {
  es: ['¡Me encanta! Justo lo que necesitaba.', 'Por fin en español, gracias.', 'Increíble, lo voy a probar hoy.', 'Esto es buenísimo, más así por favor.'],
  pt: ['Adorei! Finalmente em português.', 'Muito bom, obrigado por isso.', 'Isso é ótimo, vou fazer hoje.', 'Demais! Faz mais assim.'],
  hi: ['बहुत बढ़िया! हिंदी में देखकर अच्छा लगा।', 'धन्यवाद, यह बहुत काम का है।', 'कमाल है, आज ही आज़माऊँगा।'],
  fr: ['Merci, enfin en français !', "C'est très bien, j'adore.", 'Trop bien cette vidéo.'],
  de: ['Endlich auf Deutsch, danke!', 'Das ist sehr gut, genau richtig.', 'Super, das habe ich gesucht.'],
  ja: ['日本語で見られて嬉しいです！', 'これは便利ですね、ありがとう。', 'すごい、今日やってみます。'],
  ko: ['한국어로 보니까 좋네요!', '정말 유용해요, 감사합니다.', '대박, 오늘 해볼게요.'],
  ar: ['رائع جدا، شكرا لك!', 'أخيرا بالعربية، ممتاز.', 'هذا مفيد جدا.'],
  id: ['Keren banget, terima kasih!', 'Akhirnya ada bahasa Indonesia.', 'Bagus sekali, saya coba hari ini.'],
};

const VIEWER_NAMES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  es: [['lucia_mx', 'Lucía Hernández'], ['dani_ba', 'Daniel Ruiz'], ['carmen_vlc', 'Carmen Ortega']],
  pt: [['rafa_sp', 'Rafael Souza'], ['bia_rio', 'Beatriz Lima'], ['joao_bh', 'João Alves']],
  hi: [['priya_del', 'Priya Sharma'], ['arjun_mum', 'Arjun Mehta'], ['neha_blr', 'Neha Gupta']],
  fr: [['camille_p', 'Camille Martin'], ['hugo_lyon', 'Hugo Bernard']],
  de: [['jonas_b', 'Jonas Weber'], ['lena_muc', 'Lena Fischer']],
  ja: [['haruto_t', 'Haruto Tanaka'], ['yui_osk', 'Yui Sato']],
  ko: [['minjun_s', 'Minjun Kim'], ['seoyeon_b', 'Seoyeon Park']],
  ar: [['omar_ryd', 'Omar Al-Farsi'], ['laila_cai', 'Laila Hassan']],
  id: [['budi_jkt', 'Budi Santoso'], ['sari_bdg', 'Sari Wijaya']],
};

/** FNV-1a. A stable number in [0, 1) from a string. */
export function unit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * How strongly this creator's audience takes to a language. Seeded creators
 * have a fixed profile. Anyone else gets one derived from their handle: their
 * three strongest languages, two middling ones, and the rest weak, like a real
 * audience (and so a demo always has something to find).
 */
export function tasteFor(handle: string, lang: string): number {
  const known = KNOWN_TASTES[handle.toLowerCase()];
  if (known) return known[lang] ?? 0.1;
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code).filter((code) => code !== 'en');
  const ranked = codes.slice().sort((a, b) => unit(`${handle.toLowerCase()}:${b}`) - unit(`${handle.toLowerCase()}:${a}`));
  const rank = ranked.indexOf(lang);
  const jitter = unit(`${handle.toLowerCase()}:${lang}:taste`);
  if (rank < 0) return 0.1;
  if (rank < 3) return 1.6 + jitter * 1.0; // strong
  if (rank < 5) return 0.4 + jitter * 0.4; // middling
  return 0.03 + jitter * 0.15; // weak
}

/** The views a dub draws from the demo audience. */
export function demoViewsFor(input: {
  handle: string;
  lang: string;
  postId: string;
  originalViews: number | null;
}): number {
  const reach = (input.originalViews ?? 0) >= MIN_REACH ? (input.originalViews as number) : FALLBACK_REACH;
  const market = (languageByCode(input.lang)?.xAudienceMillions ?? 5) / X_AD_REACH_MILLIONS;
  const noise = 0.85 + unit(`${input.postId}:${input.lang}`) * 0.3;
  return Math.max(0, Math.round(reach * market * DUB_UPTAKE * tasteFor(input.handle, input.lang) * noise));
}

export interface DemoAudienceDeps {
  readonly store: Store;
  /** The stand-in timeline, when there is one. Without it, only thread-less dubs get an audience. */
  readonly mockX: MockXAdapter | null;
  /** Called after each wave, so view counts and dashboards catch up. */
  readonly afterWave: () => Promise<void>;
}

export class DemoAudience {
  private readonly active = new Set<string>();

  constructor(private readonly deps: DemoAudienceDeps) {}

  /**
   * Send the audience to a post's live dubs. `waves` spreads it out so it can
   * be watched arriving; 1 delivers it all at once (used when seeding).
   * Returns false when the post has none to send to, or already had one.
   */
  async send(postId: string, options: { waves?: number; waveMs?: number } = {}): Promise<boolean> {
    const { store } = this.deps;
    const post = store.posts.get(postId);
    const creator = post ? store.creators.get(post.creatorId) : undefined;
    if (!post || !creator || this.active.has(postId)) return false;

    // Only dubs that have not had their audience yet: more can be added to a
    // post later, and they get theirs without the others being counted twice.
    const dubs = store.dubsForPost(postId).filter((d) => d.state === 'PUBLISHED' && d.simulatedViews === 0);
    if (dubs.length === 0) return false;

    this.active.add(postId);
    store.updatePost(postId, { demoAudience: 'arriving', measuredAt: null });
    try {
      const waves = Math.max(1, options.waves ?? 6);
      const targets = dubs.map((dub) => ({
        dubId: dub.id,
        total: demoViewsFor({ handle: creator.handle, lang: dub.lang, postId: post.sourcePostId, originalViews: post.originalViews }),
        sent: 0,
      }));

      for (let wave = 1; wave <= waves; wave++) {
        for (const target of targets) {
          // Front-loaded, like a real post: most of the audience comes early.
          const due = Math.round(target.total * (1 - (1 - wave / waves) ** 2));
          const add = due - target.sent;
          target.sent = due;
          if (add > 0) this.deliver(target.dubId, add);
        }
        if (wave === waves) for (const target of targets) this.reply(target.dubId, target.total);
        await this.deps.afterWave();
        if (wave < waves && (options.waveMs ?? 0) > 0) await new Promise((r) => setTimeout(r, options.waveMs));
      }
    } finally {
      this.active.delete(postId);
      store.updatePost(postId, { demoAudience: 'done' });
      await this.deps.afterWave();
    }
    return true;
  }

  private deliver(dubId: string, views: number): void {
    const { store, mockX } = this.deps;
    const dub = store.getDub(dubId);
    if (!dub) return;

    // A dub posted in a thread gets its views on that post, which the view
    // sync then reads back. A dub with no thread (a post seen only through the
    // extension on x.com) has no post to count on, so they are counted on the
    // dub directly. Either way they are labelled simulated.
    let direct = 0;
    if (dub.replyPostId && mockX) {
      mockX.addViews(dub.replyPostId, views);
      const interactions = views * INTERACTIONS_PER_VIEW.likely;
      mockX.addEngagement(dub.replyPostId, Math.round(interactions * 0.82), Math.round(interactions * 0.13));
    } else {
      direct = views;
    }

    // Some viewers open Parrot's page; that is where a country is recorded.
    const visits = Math.round(views * PAGE_VISIT_SHARE);
    const countries = { ...dub.countries };
    const markets = languageByCode(dub.lang)?.markets ?? [];
    let placed = 0;
    markets.forEach((market, index) => {
      const share = index === markets.length - 1 ? visits - placed : Math.round(visits * market.weight);
      placed += share;
      if (share > 0) countries[market.code] = (countries[market.code] ?? 0) + share;
    });
    store.updateDub(dub.id, { simulatedViews: dub.simulatedViews + views, xViews: dub.xViews + direct, countries });
  }

  /** A few replies in the dub's language, more for a dub that did well. */
  private reply(dubId: string, views: number): void {
    const { store, mockX } = this.deps;
    const dub = store.getDub(dubId) as Dub | undefined;
    // No thread, nothing to reply under.
    if (!dub?.replyPostId || !mockX) return;
    const lines = SAMPLE_REPLIES[dub.lang] ?? [];
    const names = VIEWER_NAMES[dub.lang] ?? [];
    const count = Math.min(lines.length, names.length, views >= 1_000 ? 3 : views >= 200 ? 2 : views >= 40 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const [handle, displayName] = names[i] as readonly [string, string];
      mockX.createPost({
        text: lines[(i + Math.floor(unit(dub.id) * lines.length)) % lines.length] as string,
        authorHandle: handle,
        displayName,
        inReplyToPostId: dub.replyPostId,
      });
      // The stand-in shows a post's own reply count, so keep it in step.
      const parent = store.botPosts.get(dub.replyPostId);
      if (parent?.metrics) parent.metrics.replies += 1;
    }
  }
}
