/**
 * Zod schemas for every boundary: the bot's parsed intent, external API
 * responses, webhook payloads, and our own API surface. Nothing crosses a
 * process boundary without being parsed here first.
 */

import { z } from 'zod';
import { SUPPORTED_LANGUAGE_CODES, CATEGORIES, MAX_SOURCE_DURATION_S } from './constants.js';
import { JOB_STATES, DECLINE_REASONS, FAILURE_REASONS, JOB_EVENT_TYPES } from './state-machine.js';

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

export const categorySchema = z.enum(CATEGORIES);
export const jobStateSchema = z.enum(JOB_STATES);
export const jobEventTypeSchema = z.enum(JOB_EVENT_TYPES);
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
  /** Language the requester asked for, as a base code. Null if not stated. */
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

/** A fully-validated dubbing request, ready for the decision loop. */
export const dubRequestSchema = z.object({
  sourceUrl: z.string().url(),
  sourcePostId: z.string().min(1),
  targetLang: languageCodeSchema,
  durationS: z.number().positive().max(MAX_SOURCE_DURATION_S),
  requesterXUserId: z.string().min(1),
});

export type DubRequest = z.infer<typeof dubRequestSchema>;

// ---------------------------------------------------------------------------
// Decision record (what the dashboard renders in plain language)
// ---------------------------------------------------------------------------

export const decisionSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  decision: z.enum(['APPROVE', 'DECLINE']),
  declineReason: declineReasonSchema.nullable(),
  inputs: z.object({
    predictedViews: z.number().int().nonnegative(),
    conversionPpm: z.number().int().nonnegative(),
    pSuccessPpm: z.number().int().nonnegative(),
    unlockPriceMicros: z.string(),
    agentBps: z.number().int(),
    dubCostMicros: z.string(),
    balanceMicros: z.string(),
    floorMicros: z.string(),
    minMarginMicros: z.string(),
  }),
  result: z.object({
    rPerViewMicros: z.string(),
    expectedRevenueMicros: z.string(),
    evMicros: z.string(),
    confidencePpm: z.number().int().nonnegative(),
    basis: z.enum(['bucket', 'cold_start']),
  }),
  /** One or two sentences a non-technical person can read. */
  rationale: z.string(),
  decidedAt: z.coerce.date(),
});

export type Decision = z.infer<typeof decisionSchema>;

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

/**
 * One USDC ERC-20 Transfer log, as our QuickNode filter emits it.
 * Values are 6-decimal ERC-20 units (see the double-counting note in chain.ts).
 */
export const streamTransferSchema = z.object({
  blockNumber: z.number().int().nonnegative(),
  txHash: txHashSchema,
  logIndex: z.number().int().nonnegative(),
  from: evmAddressSchema,
  to: evmAddressSchema,
  /** 6-decimal base units as a string, i.e. micros. */
  value: z.string().regex(/^\d+$/),
});

export const streamWebhookPayloadSchema = z.object({
  movements: z.array(streamTransferSchema),
});

export type StreamTransfer = z.infer<typeof streamTransferSchema>;

// ---------------------------------------------------------------------------
// Our own API surface
// ---------------------------------------------------------------------------

export const unlockRequestSchema = z.object({
  jobId: z.string().uuid(),
  viewerAccountId: z.string().uuid().nullable(),
});

export const claimEarningsRequestSchema = z.object({
  creatorId: z.string().uuid(),
  /** Idempotency key - every payout requires one. */
  requestId: z.string().uuid(),
});

export const demoTrafficRequestSchema = z.object({
  jobId: z.string().uuid().optional(),
  /** Simulated unlocks per minute. */
  ratePerMinute: z.number().int().min(1).max(600).default(60),
  enabled: z.boolean(),
});
