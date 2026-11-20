/**
 * Product and economic constants. Anything a judge might ask "where does that
 * number come from?" about is sourced in a comment.
 */

import { parseUsd, type Micros } from './units.js';
import { ppm, type Ppm } from './ppm.js';

// ---------------------------------------------------------------------------
// Viewer pricing and the revenue split
// ---------------------------------------------------------------------------

/** What a viewer pays to unlock a dub. */
export const UNLOCK_PRICE: Micros = parseUsd('0.02');

/** Default split: the agent recoups its cost, the creator keeps the larger share. */
export const DEFAULT_SPLIT_AGENT_BPS = 4_000; // 40%
export const DEFAULT_SPLIT_CREATOR_BPS = 6_000; // 60%

/** Test-mode starter credit granted to a new viewer at first unlock. */
export const VIEWER_STARTER_CREDIT: Micros = parseUsd('1.00');

/** Per-viewer unlock cap per rolling window, to stop a runaway script. */
export const VIEWER_UNLOCK_CAP_PER_HOUR = 60;

// ---------------------------------------------------------------------------
// Dubbing cost (ElevenLabs)
// ---------------------------------------------------------------------------

/**
 * ElevenLabs list prices, per minute of SOURCE media, per target language.
 * Source: https://elevenlabs.io/pricing/api (checked 2026-11-15)
 *
 * Dubbing v1 is what we use: it is the only tier whose API returns a muxed
 * audio/video byte stream, and at $0.50/min it keeps a 2-cent unlock economy
 * viable. v2 at $2.20/min would need ~4x the unlocks to break even, which we
 * note in the README rather than hide.
 */
export const ELEVENLABS_PRICE_PER_MINUTE = {
  v1_watermarked: parseUsd('0.33'),
  v1_clean: parseUsd('0.50'),
  v2: parseUsd('2.20'),
} as const;

/** The tier the agent actually buys. */
export const DUBBING_TIER: keyof typeof ELEVENLABS_PRICE_PER_MINUTE = 'v1_clean';

/** Longest clip the agent will consider dubbing. */
export const MAX_SOURCE_DURATION_S = 180;
/** Shortest clip worth dubbing. */
export const MIN_SOURCE_DURATION_S = 5;

/**
 * ElevenLabs allows 3 concurrent dubbing jobs on every self-serve plan.
 * Source: https://elevenlabs.io/docs/capabilities/dubbing
 */
export const ELEVENLABS_MAX_CONCURRENT_DUBS = 3;

// ---------------------------------------------------------------------------
// Agent defaults
// ---------------------------------------------------------------------------

/** Default budget floor: an agent never spends itself below this. */
export const DEFAULT_BUDGET_FLOOR: Micros = parseUsd('1.00');
/** Default minimum EV required to take a bet. */
export const DEFAULT_MIN_MARGIN: Micros = parseUsd('0.10');
/** Most an agent will risk on a single dub. */
export const DEFAULT_MAX_EXPOSURE_PER_JOB: Micros = parseUsd('2.00');
/** Most an agent will spend in a day. */
export const DEFAULT_DAILY_CAP: Micros = parseUsd('10.00');

/** Cold-start p_success before an agent has any QC history. */
export const COLD_START_P_SUCCESS: Ppm = ppm(700_000); // 70%
/** Cold-start view-to-unlock conversion before a bucket has history. */
export const COLD_START_CONVERSION: Ppm = ppm(125_000); // 12.5%

// ---------------------------------------------------------------------------
// The cold-start funnel (predictor.ts). Each step is a low / likely / high
// range, so a cautious agent can plan on the low end and a bold one on the
// high end. Every number says where it comes from; the ones marked ASSUMPTION
// are what the learning loop is there to correct.
// ---------------------------------------------------------------------------

/** One funnel step's range. `low` always means "fewer dub viewers". */
export interface FunnelRange {
  readonly low: number;
  readonly likely: number;
  readonly high: number;
}

/**
 * Step 1 fallback, only when a post's view count is missing (X shows it on
 * every post, so normally step 1 is read, not guessed): interactions per view.
 * A HIGHER rate means FEWER views, so `low` holds the highest rate.
 * Source: quartiles (p75 / median / p25) of 31 real English video posts on X,
 * pulled via Grok X search on 2026-11-20. The sample lives in
 * packages/shared/test/fixtures/real-x-video-posts.json and
 * predictor.test.ts fails if these drift from it.
 */
export const INTERACTIONS_PER_VIEW: FunnelRange = { low: 0.076, likely: 0.027, high: 0.017 };

/** Reach presets Chirp offers for a demo video post (see simulatedEngagement). */
export const DEMO_REACH_PRESETS = [50_000, 250_000, 1_200_000, 5_000_000] as const;

/**
 * Plausible likes / replies / reposts / quotes for a post with this many views,
 * at the MEDIAN interaction rate measured on real X video posts (2.7% of views
 * interact; split roughly as the sample split). Used only for simulated reach.
 */
export function simulatedEngagement(views: number): {
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number;
} {
  const interactions = views * INTERACTIONS_PER_VIEW.likely;
  return {
    likes: Math.round(interactions * 0.82),
    replies: Math.round(interactions * 0.03),
    reposts: Math.round(interactions * 0.13),
    quotes: Math.round(interactions * 0.02),
    views: Math.round(views),
  };
}

/** X's worldwide ad-reachable audience. Source: DataReportal, October 2026. */
export const X_AD_REACH_MILLIONS = 433;

/**
 * Step 3: how well an English post reaches a language's market, relative to
 * that market's share of X. 1.0 would mean the post reached every market in
 * proportion to its size. English posts mostly circulate among English
 * speakers, and the big non-English X markets have low-to-moderate English
 * proficiency (EF English Proficiency Index: Mexico, Brazil, Japan and
 * Indonesia all rank "low" or "moderate"), so a third of the proportional
 * share is the likely case. ASSUMPTION - measured per language once the
 * learning loop has data. (Was 0.25 / 0.5 / 0.75, which assumed half of every
 * market sees a typical English post.)
 */
export const MARKET_REACH: FunnelRange = { low: 0.2, likely: 0.35, high: 0.5 };

/**
 * Step 4: of the viewers in that language market, how many open the dub.
 * ASSUMPTION. Here the dub is a link in a reply, so this is a link
 * click-through: organic link posts on X typically see ~1-3% of impressions
 * click, and only part of a post's audience ever opens its replies. A dub in
 * the viewer's own language should beat a generic link, so 2% is the likely
 * case and 5% the optimistic one. (Was 2% / 5% / 15%; 15% would beat most paid
 * ads.) Upper sanity bound: YouTube reports creators with dubbed audio
 * tracks get over 25% of watch time from those tracks - but there switching is
 * one tap inside the player, while here it is a reply link, so we sit far
 * below. https://blog.youtube/news-and-events/multi-language-audio-mrbeast-interview/
 */
export const DUB_UPTAKE: FunnelRange = { low: 0.01, likely: 0.02, high: 0.05 };

/** Smoothing factor for the learning loop. */
export const LEARNING_ALPHA: Ppm = ppm(300_000); // 0.3
/** Observations needed before a bucket is trusted over the cold-start prior. */
export const BUCKET_CONFIDENCE_N = 5;

// ---------------------------------------------------------------------------
// Settlement cadence
// ---------------------------------------------------------------------------

/** Settle on-chain once this much is owed, whichever comes first... */
export const SETTLEMENT_THRESHOLD: Micros = parseUsd('0.10');
/** ...or once this long has passed with anything owed. */
export const SETTLEMENT_INTERVAL_MS = 60_000;
/** In demo mode, settle fast enough for judges to watch it happen. */
export const DEMO_SETTLEMENT_INTERVAL_MS = 15_000;

/** Demo mode compresses the 24h learning loop into this. */
export const DEMO_LEARNING_DELAY_MS = 60_000;
export const REAL_LEARNING_DELAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Languages Parrot offers. ElevenLabs advertises 90+ but does not publish an
 * enumerated list, so this is a conservative set of common base tags that we
 * validate at request time rather than trusting blindly.
 * Source: https://elevenlabs.io/docs/capabilities/dubbing
 *
 * `xAudienceMillions` is how many of X's ad-reachable accounts sit in markets
 * that prefer the language - step 2 of the cold-start funnel in predictor.ts.
 * Source: DataReportal, X ad reach, October 2026 (433M worldwide; top ten:
 * US 77.3M, Japan 54.8M, India 22.9M, Indonesia 20.1M, Brazil 18.6M,
 * Turkey 16.6M, Mexico 15.5M, UK 15.2M, Saudi Arabia 13.5M, Thailand 11.8M).
 * https://datareportal.com/essential-x-stats
 * `audienceBasis` says how much of the figure is that data and how much is our
 * estimate for countries outside the published top ten (each under 11.8M).
 */
export interface LanguageSpec {
  readonly code: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly xAudienceMillions: number;
  readonly audienceBasis: string;
}

export const SUPPORTED_LANGUAGES: readonly LanguageSpec[] = [
  {
    code: 'es', englishName: 'Spanish', nativeName: 'Espanol', xAudienceMillions: 35,
    audienceBasis: 'Mexico 15.5M (DataReportal) + ~20M estimated for Spain, Argentina, Colombia and the rest of Latin America',
  },
  {
    code: 'pt', englishName: 'Portuguese', nativeName: 'Portugues', xAudienceMillions: 19.5,
    audienceBasis: 'Brazil 18.6M (DataReportal) + ~1M estimated for Portugal',
  },
  {
    code: 'hi', englishName: 'Hindi', nativeName: 'Hindi', xAudienceMillions: 9,
    audienceBasis: 'India 22.9M (DataReportal), of whom we assume ~40% would rather watch in Hindi than English',
  },
  {
    code: 'fr', englishName: 'French', nativeName: 'Francais', xAudienceMillions: 12,
    audienceBasis: 'Estimate: France, Belgium, Quebec and francophone Africa (none in the published top ten)',
  },
  {
    code: 'de', englishName: 'German', nativeName: 'Deutsch', xAudienceMillions: 8,
    audienceBasis: 'Estimate: Germany, Austria and Switzerland (none in the published top ten)',
  },
  {
    code: 'ja', englishName: 'Japanese', nativeName: 'Nihongo', xAudienceMillions: 54.8,
    audienceBasis: 'Japan 54.8M (DataReportal)',
  },
  {
    code: 'ko', englishName: 'Korean', nativeName: 'Hangugeo', xAudienceMillions: 10,
    audienceBasis: 'South Korea ~10.1M (2025 figure; not in the 2026 top ten)',
  },
  {
    code: 'ar', englishName: 'Arabic', nativeName: 'Arabiyya', xAudienceMillions: 23.5,
    audienceBasis: 'Saudi Arabia 13.5M (DataReportal) + ~10M estimated for Egypt, the Gulf and North Africa',
  },
  {
    code: 'id', englishName: 'Indonesian', nativeName: 'Bahasa Indonesia', xAudienceMillions: 20.1,
    audienceBasis: 'Indonesia 20.1M (DataReportal)',
  },
  {
    code: 'en', englishName: 'English', nativeName: 'English', xAudienceMillions: 110,
    audienceBasis: 'US 77.3M + UK 15.2M (DataReportal) + ~17M estimated for Canada, Australia and others',
  },
] as const;

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((l) => l.code);

/**
 * ISO 639-3 / 639-2 codes for the supported languages, mapped to the 639-1
 * codes Parrot uses everywhere. Speech-to-text reports the three-letter form
 * ("spa"), dubbing takes the two-letter one ("es") - found by the first real
 * end-to-end dub, which a correct Spanish dub failed QC over. Both
 * bibliographic and terminological 639-2 forms are listed (fre/fra, ger/deu).
 */
const THREE_TO_TWO: Record<string, string> = {
  spa: 'es',
  por: 'pt',
  hin: 'hi',
  fra: 'fr',
  fre: 'fr',
  deu: 'de',
  ger: 'de',
  jpn: 'ja',
  kor: 'ko',
  ara: 'ar',
  ind: 'id',
  eng: 'en',
};

/**
 * One language code in Parrot's form: lower-case ISO 639-1, region dropped.
 * "spa" -> "es", "es-MX" -> "es", "pt_BR" -> "pt". Unknown codes pass through
 * lower-cased, so they still compare unequal to anything supported.
 */
export function normalizeLanguageCode(code: string): string {
  const base = code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return THREE_TO_TWO[base] ?? base;
}

export function languageByCode(code: string): LanguageSpec | undefined {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code.toLowerCase());
}

export function languageName(code: string): string {
  return languageByCode(code)?.englishName ?? code;
}

// ---------------------------------------------------------------------------
// Content categories (the other half of a prediction bucket)
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  'comedy',
  'education',
  'music',
  'news',
  'sports',
  'tech',
  'lifestyle',
  'gaming',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

/** Seconds of the dub a viewer can watch before being asked to unlock. */
export const PREVIEW_SECONDS = 8;

// ---------------------------------------------------------------------------
// QC thresholds
// ---------------------------------------------------------------------------

/** Dub duration must be within this fraction of the source duration. */
export const QC_DURATION_TOLERANCE = 0.1;
/** ElevenLabs STT must report the target language with at least this confidence. */
export const QC_MIN_LANGUAGE_CONFIDENCE = 0.6;
/** At least this fraction of the dub must be non-silent. */
export const QC_MIN_NON_SILENCE_RATIO = 0.5;
/** Longest acceptable dead gap, in seconds. */
export const QC_MAX_DEAD_GAP_S = 5;
/** Integrated loudness must fall in this LUFS window. */
export const QC_LOUDNESS_RANGE_LUFS: readonly [number, number] = [-40, -8];
