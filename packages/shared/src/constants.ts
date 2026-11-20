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
 * `marketSize` is a rough relative weight for the cold-start view predictor
 * (speakers online, normalised so Spanish = 1.0). It is a prior, not a fact,
 * and the learning loop overwrites its influence as real data arrives.
 */
export interface LanguageSpec {
  readonly code: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly marketSize: number;
}

export const SUPPORTED_LANGUAGES: readonly LanguageSpec[] = [
  { code: 'es', englishName: 'Spanish', nativeName: 'Espanol', marketSize: 1.0 },
  { code: 'pt', englishName: 'Portuguese', nativeName: 'Portugues', marketSize: 0.55 },
  { code: 'hi', englishName: 'Hindi', nativeName: 'Hindi', marketSize: 0.8 },
  { code: 'fr', englishName: 'French', nativeName: 'Francais', marketSize: 0.5 },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch', marketSize: 0.35 },
  { code: 'ja', englishName: 'Japanese', nativeName: 'Nihongo', marketSize: 0.4 },
  { code: 'ko', englishName: 'Korean', nativeName: 'Hangugeo', marketSize: 0.25 },
  { code: 'ar', englishName: 'Arabic', nativeName: 'Arabiyya', marketSize: 0.6 },
  { code: 'id', englishName: 'Indonesian', nativeName: 'Bahasa Indonesia', marketSize: 0.45 },
  { code: 'en', englishName: 'English', nativeName: 'English', marketSize: 1.2 },
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
