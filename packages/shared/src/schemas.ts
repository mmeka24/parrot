/**
 * Zod schemas for every boundary: the bot's parsed intent, external API
 * responses, webhook payloads, and our own API surface. Nothing crosses a
 * process boundary without being parsed here first.
 */

import { z } from 'zod';
import { SUPPORTED_LANGUAGE_CODES } from './constants.js';
import { DUB_STATES, DECLINE_REASONS, FAILURE_REASONS } from './state-machine.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const evmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 20-byte hex address');

export const txHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 32-byte hex hash');

/** Money on the wire is a decimal STRING of micros, so JSON never sees a float. */
export const microsSchema = z
  .string()
  .regex(/^-?\d+$/, 'must be an integer string of micro-dollars')
  .transform((s) => BigInt(s));

export const languageCodeSchema = z
  .string()
  .toLowerCase()
  .refine((c) => SUPPORTED_LANGUAGE_CODES.includes(c), {
    message: `unsupported language; supported: ${SUPPORTED_LANGUAGE_CODES.join(', ')}`,
  });

export const dubStateSchema = z.enum(DUB_STATES);
export const declineReasonSchema = z.enum(DECLINE_REASONS);
export const failureReasonSchema = z.enum(FAILURE_REASONS);

// ---------------------------------------------------------------------------
// Bot intent (what Grok must produce from a mention)
// ---------------------------------------------------------------------------

/**
 * The structured intent Grok extracts from a mention. Grok is asked for JSON
 * matching this shape, and we re-validate rather than trusting it: an LLM that
 * hallucinates a language code must not be able to start a paid dubbing job.
 */
export const parsedIntentSchema = z.object({
  action: z.enum(['dub', 'status', 'earnings', 'unknown']),
  /** The post whose video should be dubbed. Null when the mention is a reply. */
  targetUrl: z.string().url().nullable(),
  /**
   * Language the requester asked for, as a base code. Null if not stated, which
   * means "you choose": Parrot then picks the languages itself.
   */
  targetLang: z.string().nullable(),
  /** Grok's confidence that it understood the request, 0..1. */
  confidence: z.number().min(0).max(1),
  /** Grok's one-line restatement, used for the decision log. */
  interpretation: z.string().max(280),
});

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;

/** A mention delivered by either the real X adapter or the mock console. */
export const mentionSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  authorId: z.string().min(1),
  authorHandle: z.string().min(1),
  createdAt: z.coerce.date(),
  /** The post this mention replies to, if any. */
  inReplyToPostId: z.string().nullable(),
  /** Author of the post being replied to - must match authorId to be allowed. */
  parentAuthorId: z.string().nullable(),
  conversationId: z.string().nullable(),
});

export type Mention = z.infer<typeof mentionSchema>;

/** Public engagement metrics on the source post. */
export const postMetricsSchema = z.object({
  likeCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  retweetCount: z.number().int().nonnegative(),
  quoteCount: z.number().int().nonnegative().default(0),
  /** X exposes impression_count in public_metrics; it may still be absent. */
  impressionCount: z.number().int().nonnegative().nullable().default(null),
  bookmarkCount: z.number().int().nonnegative().default(0),
});

export const videoMediaSchema = z.object({
  mediaKey: z.string(),
  type: z.literal('video'),
  durationMs: z.number().int().positive(),
  previewImageUrl: z.string().url().nullable(),
  /** Highest-bitrate playable URL we resolved. */
  url: z.string().url(),
});

export const sourcePostSchema = z.object({
  postId: z.string().min(1),
  authorId: z.string().min(1),
  authorHandle: z.string().min(1),
  /** The author's display name ("Maria Lopez"), when the source provides one. */
  authorDisplayName: z.string().min(1).optional(),
  authorFollowers: z.number().int().nonnegative(),
  text: z.string(),
  createdAt: z.coerce.date(),
  metrics: postMetricsSchema,
  video: videoMediaSchema.nullable(),
  lang: z.string().nullable(),
});

export type SourcePost = z.infer<typeof sourcePostSchema>;

// ---------------------------------------------------------------------------
// QC
// ---------------------------------------------------------------------------

export const qcCheckSchema = z.object({
  name: z.enum(['duration_match', 'language_detect', 'audio_sanity', 'back_translation']),
  /**
   * THE TRUTHFUL FIELD. A check that could not run is `skipped`, never
   * `passed`.
   *
   * `passed` below is a convenience for gating: a skipped check sets it true so
   * it does not block publication (we must not reject a dub because ffmpeg is
   * missing on the machine). But reading `passed` alone would make a skipped
   * check look like a check that ran and succeeded, which is exactly the kind
   * of quiet overclaim this project refuses to make. So `status` is required,
   * it is what the dashboard renders, and it survives parsing.
   */
  status: z.enum(['passed', 'failed', 'skipped']),
  passed: z.boolean(),
  /** Human-readable detail, shown on the dashboard when it fails. */
  detail: z.string(),
  measured: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
});

export const qcReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(qcCheckSchema),
  ranAt: z.coerce.date(),
});

export type QcReport = z.infer<typeof qcReportSchema>;

// ---------------------------------------------------------------------------
// External API responses (parsed, never trusted raw)
// ---------------------------------------------------------------------------

/**
 * ElevenLabs legacy dubbing create response.
 * Source: https://elevenlabs.io/docs/api-reference/dubbing/create
 */
export const elevenLabsCreateDubSchema = z.object({
  dubbing_id: z.string().min(1),
  expected_duration_sec: z.number().nonnegative().optional(),
});

/**
 * ElevenLabs dubbing status. The docs do not enumerate the status values for
 * the legacy endpoint (only "dubbed" appears in an example), so we accept any
 * string and treat the known ones specially rather than failing on a new value.
 * Source: https://elevenlabs.io/docs/api-reference/dubbing/get
 */
export const elevenLabsDubStatusSchema = z.object({
  dubbing_id: z.string(),
  name: z.string().nullable().optional(),
  status: z.string(),
  target_languages: z.array(z.string()).optional(),
  error: z.string().nullable().optional(),
  media_metadata: z
    .object({
      content_type: z.string().optional(),
      duration: z.number().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * ElevenLabs Scribe speech-to-text response. `language_code` and
 * `language_probability` are what the QC language gate reads.
 * Source: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 */
export const elevenLabsSttSchema = z.object({
  language_code: z.string(),
  language_probability: z.number().min(0).max(1),
  text: z.string(),
});

/** Multi-channel STT returns a different top-level shape. */
export const elevenLabsSttResponseSchema = z.union([
  elevenLabsSttSchema,
  z.object({ transcripts: z.array(elevenLabsSttSchema).min(1) }),
]);
