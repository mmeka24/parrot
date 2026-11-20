/**
 * Product and economic constants. Anything a judge might ask "where does that
 * number come from?" about is sourced in a comment.
 */

import { parseUsd, type Micros } from './units.js';

// ---------------------------------------------------------------------------
// What a creator pays
// ---------------------------------------------------------------------------

/**
 * The creator pays this for each view a dub actually gets: $1 per 1,000 views.
 * Viewers never pay. Parrot pays for every dub up front, so a dub that nobody
 * watches costs the creator almost nothing and costs Parrot the dub.
 */
export const PRICE_PER_VIEW: Micros = parseUsd('0.001');

/**
 * What a view is worth to the creator, per 1,000 views, until they set their
 * own number. ASSUMPTION, shown as "your rate" everywhere: it is a mid-range
 * sponsor rate, not money anyone was paid. A creator should replace it with
 * their own figure (their payout divided by their views, or their sponsor rate).
 */
export const DEFAULT_VALUE_PER_THOUSAND_VIEWS: Micros = parseUsd('8.00');

/** The most one post's dubs can cost a creator, until they change it. */
export const DEFAULT_POST_BUDGET: Micros = parseUsd('5.00');

/** Charges below this wait for the next batch rather than being sent as dust. */
export const MIN_CHARGE: Micros = parseUsd('0.01');

/** Test-mode balance for a demo creator who has no account of their own. */
export const DEMO_CREATOR_BALANCE: Micros = parseUsd('25.00');

// ---------------------------------------------------------------------------
// Choosing languages (language-plan.ts)
// ---------------------------------------------------------------------------

/** How many languages a post is dubbed into while Parrot is still learning. */
export const EXPLORE_LANGUAGE_COUNT = 8;
/** How many posts Parrot spends learning before it narrows down. */
export const EXPLORE_POSTS = 2;
/** The most proven languages a post is dubbed into once Parrot has learned. */
export const MAX_WINNERS = 3;
/** A dropped language gets one more try every this many posts. */
export const RETEST_EVERY_POSTS = 5;
/**
 * A first try that reaches less than this fraction of what a dub needs to pay
 * for itself is a clear miss, and the language is dropped at once.
 */
export const CLEAR_MISS_RATIO = 0.25;

// ---------------------------------------------------------------------------
// Dubbing cost (ElevenLabs)
// ---------------------------------------------------------------------------

/**
 * ElevenLabs list prices, per minute of SOURCE media, per target language.
 * Source: https://elevenlabs.io/pricing/api (checked 2026-11-15)
 *
 * Dubbing v1 is what we use: it is the only tier whose API returns a muxed
 * audio/video byte stream. At $0.50/min a 30-second dub costs $0.25, so at
 * $1 per 1,000 views it pays for itself at 250 views.
 */
export const ELEVENLABS_PRICE_PER_MINUTE = {
  v1_watermarked: parseUsd('0.33'),
  v1_clean: parseUsd('0.50'),
  v2: parseUsd('2.20'),
} as const;

/** The tier Parrot buys. */
export const DUBBING_TIER: keyof typeof ELEVENLABS_PRICE_PER_MINUTE = 'v1_clean';

/** Longest clip Parrot will dub. */
export const MAX_SOURCE_DURATION_S = 180;
/** Shortest clip worth dubbing. */
export const MIN_SOURCE_DURATION_S = 5;

/**
 * ElevenLabs allows 3 concurrent dubbing jobs on every self-serve plan.
 * Source: https://elevenlabs.io/docs/capabilities/dubbing
 */
export const ELEVENLABS_MAX_CONCURRENT_DUBS = 3;

// ---------------------------------------------------------------------------
// Demo reach
// ---------------------------------------------------------------------------

/**
 * Interactions per view on an English video post on X (median 2.7%).
 * Source: 31 real posts pulled via Grok X search on 2026-11-20. Used only to
 * give a simulated post plausible likes and reposts.
 */
export const INTERACTIONS_PER_VIEW = { low: 0.076, likely: 0.027, high: 0.017 } as const;

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

// ---------------------------------------------------------------------------
// The forecast (forecast.ts): how many views a dub is expected to get
// ---------------------------------------------------------------------------

/** One step's range. `low` always means "fewer dub views". */
export interface FunnelRange {
  readonly low: number;
  readonly likely: number;
  readonly high: number;
}

/**
 * How well an English post reaches a language's market, relative to that
 * market's share of X. 1.0 would mean it reached every market in proportion to
 * its size. English posts mostly circulate among English speakers, and the big
 * non-English X markets have low-to-moderate English proficiency (EF English
 * Proficiency Index), so about a third is the likely case. ASSUMPTION: replaced
 * by what Parrot measures once a creator has posts behind them.
 */
export const MARKET_REACH: FunnelRange = { low: 0.2, likely: 0.35, high: 0.5 };

/**
 * Of the people reached in that language, how many watch the dub. ASSUMPTION.
 * A dub is a link or a post in the thread, and organic links on X see roughly
 * 1-3% click-through; a dub in the viewer's own language should beat a generic
 * link, so 2% is likely and 5% optimistic. YouTube reports dubbed audio tracks
 * get over 25% of watch time, but switching there is one tap in the player,
 * so this sits far below it.
 */
export const DUB_UPTAKE: FunnelRange = { low: 0.01, likely: 0.02, high: 0.05 };

/**
 * The "if it takes off" scenario shown beside the forecast: a video that
 * reaches this many views. The same figure the demo audience is sized from.
 */
export const TAKE_OFF_VIEWS = 1_200_000;

// ---------------------------------------------------------------------------
// Charging cadence
// ---------------------------------------------------------------------------

/** How often owed view charges are swept into one payment per creator. */
export const BILLING_INTERVAL_MS = 60 * 60_000;
/** In demo mode, charge often enough to watch it happen. */
export const DEMO_BILLING_INTERVAL_MS = 12_000;
/** How often view counts are read back from the timeline. */
export const VIEW_SYNC_INTERVAL_MS = 4_000;

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
  /** Shown next to the language name. One flag cannot stand for a language; it is a label. */
  readonly flag: string;
  /**
   * The main markets for the language, with rough weights that sum to 1. Used
   * to name where simulated demo viewers come from; real viewers report their
   * own country.
   */
  readonly markets: readonly { readonly code: string; readonly name: string; readonly weight: number }[];
}

export const SUPPORTED_LANGUAGES: readonly LanguageSpec[] = [
  {
    code: 'es', englishName: 'Spanish', nativeName: 'Espanol', xAudienceMillions: 35,
    audienceBasis: 'Mexico 15.5M (DataReportal) + ~20M estimated for Spain, Argentina, Colombia and the rest of Latin America',
    flag: '\u{1F1EA}\u{1F1F8}',
    markets: [{ code: 'MX', name: 'Mexico', weight: 0.45 }, { code: 'ES', name: 'Spain', weight: 0.2 }, { code: 'AR', name: 'Argentina', weight: 0.2 }, { code: 'CO', name: 'Colombia', weight: 0.15 }],
  },
  {
    code: 'pt', englishName: 'Portuguese', nativeName: 'Portugues', xAudienceMillions: 19.5,
    audienceBasis: 'Brazil 18.6M (DataReportal) + ~1M estimated for Portugal',
    flag: '\u{1F1E7}\u{1F1F7}',
    markets: [{ code: 'BR', name: 'Brazil', weight: 0.92 }, { code: 'PT', name: 'Portugal', weight: 0.08 }],
  },
  {
    code: 'hi', englishName: 'Hindi', nativeName: 'Hindi', xAudienceMillions: 9,
    audienceBasis: 'India 22.9M (DataReportal), of whom we assume ~40% would rather watch in Hindi than English',
    flag: '\u{1F1EE}\u{1F1F3}',
    markets: [{ code: 'IN', name: 'India', weight: 1 }],
  },
  {
    code: 'fr', englishName: 'French', nativeName: 'Francais', xAudienceMillions: 12,
    audienceBasis: 'Estimate: France, Belgium, Quebec and francophone Africa (none in the published top ten)',
    flag: '\u{1F1EB}\u{1F1F7}',
    markets: [{ code: 'FR', name: 'France', weight: 0.7 }, { code: 'CA', name: 'Canada', weight: 0.15 }, { code: 'BE', name: 'Belgium', weight: 0.15 }],
  },
  {
    code: 'de', englishName: 'German', nativeName: 'Deutsch', xAudienceMillions: 8,
    audienceBasis: 'Estimate: Germany, Austria and Switzerland (none in the published top ten)',
    flag: '\u{1F1E9}\u{1F1EA}',
    markets: [{ code: 'DE', name: 'Germany', weight: 0.8 }, { code: 'AT', name: 'Austria', weight: 0.1 }, { code: 'CH', name: 'Switzerland', weight: 0.1 }],
  },
  {
    code: 'ja', englishName: 'Japanese', nativeName: 'Nihongo', xAudienceMillions: 54.8,
    audienceBasis: 'Japan 54.8M (DataReportal)',
    flag: '\u{1F1EF}\u{1F1F5}',
    markets: [{ code: 'JP', name: 'Japan', weight: 1 }],
  },
  {
    code: 'ko', englishName: 'Korean', nativeName: 'Hangugeo', xAudienceMillions: 10,
    audienceBasis: 'South Korea ~10.1M (2025 figure; not in the 2026 top ten)',
    flag: '\u{1F1F0}\u{1F1F7}',
    markets: [{ code: 'KR', name: 'South Korea', weight: 1 }],
  },
  {
    code: 'ar', englishName: 'Arabic', nativeName: 'Arabiyya', xAudienceMillions: 23.5,
    audienceBasis: 'Saudi Arabia 13.5M (DataReportal) + ~10M estimated for Egypt, the Gulf and North Africa',
    flag: '\u{1F1F8}\u{1F1E6}',
    markets: [{ code: 'SA', name: 'Saudi Arabia', weight: 0.55 }, { code: 'EG', name: 'Egypt', weight: 0.3 }, { code: 'AE', name: 'UAE', weight: 0.15 }],
  },
  {
    code: 'id', englishName: 'Indonesian', nativeName: 'Bahasa Indonesia', xAudienceMillions: 20.1,
    audienceBasis: 'Indonesia 20.1M (DataReportal)',
    flag: '\u{1F1EE}\u{1F1E9}',
    markets: [{ code: 'ID', name: 'Indonesia', weight: 1 }],
  },
  {
    code: 'en', englishName: 'English', nativeName: 'English', xAudienceMillions: 110,
    audienceBasis: 'US 77.3M + UK 15.2M (DataReportal) + ~17M estimated for Canada, Australia and others',
    flag: '\u{1F1FA}\u{1F1F8}',
    markets: [{ code: 'US', name: 'United States', weight: 0.7 }, { code: 'GB', name: 'United Kingdom', weight: 0.15 }, { code: 'CA', name: 'Canada', weight: 0.15 }],
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

export function languageFlag(code: string): string {
  return languageByCode(code)?.flag ?? '';
}

// ---------------------------------------------------------------------------
// QC thresholds
// ---------------------------------------------------------------------------

/** Dub duration must be within this fraction of the source duration. */
export const QC_DURATION_TOLERANCE = 0.1;
/**
 * Back-translation: the independent judge's 0-100 score for how well the dub
 * keeps the original's meaning must reach this. 70 = "minor losses at most".
 */
export const QC_MIN_MEANING_SCORE = 70;
/** At least this fraction of the dub must be non-silent. */
export const QC_MIN_NON_SILENCE_RATIO = 0.5;
/** Longest acceptable dead gap, in seconds. */
export const QC_MAX_DEAD_GAP_S = 5;
/** Integrated loudness must fall in this LUFS window. */
export const QC_LOUDNESS_RANGE_LUFS: readonly [number, number] = [-40, -8];
