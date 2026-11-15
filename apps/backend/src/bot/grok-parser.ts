/**
 * Turning "@parrot dub this to Spanish" into a structured, VALIDATED intent.
 *
 * Two paths, same output contract:
 *
 *  1. Grok (xAI), when XAI_API_KEY is set. Base `https://api.x.ai/v1`, endpoint
 *     POST /v1/chat/completions (OpenAI-compatible), header
 *     `Authorization: Bearer $XAI_API_KEY`. Model `grok-4.3` with
 *     `reasoning_effort: "none"` - this is cheap, fast slot-filling, not
 *     reasoning. Structured output via
 *     `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }`
 *     with `additionalProperties: false`. `max_tokens` is deprecated; we send
 *     `max_completion_tokens`.
 *     (`grok-4-fast` and `grok-3-mini` were RETIRED 2026-05-15. Do not use them.)
 *
 *  2. A regex fallback otherwise. It is not a toy: the demo runs on it, since
 *     config.capabilities.grokParsing is false without a key.
 *
 * THE SAFETY RULE: whatever Grok returns is re-validated with zod before it can
 * do anything. An LLM that hallucinates a language code must not be able to
 * start a dubbing job we pay ElevenLabs for. `validateIntent` therefore checks
 * the code against SUPPORTED_LANGUAGES as well as the shape - a plausible-but-
 * unsupported "ca" or "zz" is rejected, not quietly accepted.
 *
 * When we are not sure, we say so: action 'unknown' with low confidence beats a
 * guess, because a guess spends money.
 */

import {
  SUPPORTED_LANGUAGES,
  languageByCode,
  languageName,
  parsedIntentSchema,
  type ParsedIntent,
} from '@parrot/shared';

export interface ParseContext {
  /** The bot's handle, stripped from the text before parsing. */
  readonly botHandle?: string;
  /** The post the mention replies to, used to fill targetUrl when absent. */
  readonly targetUrl?: string | null;
  /** Present => try Grok. Absent => regex only. */
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4.3';
const DEFAULT_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Language resolution
// ---------------------------------------------------------------------------

/** name/native-name/code -> base code. Names only; bare codes need a preposition. */
const NAME_TO_CODE = new Map<string, string>();
for (const spec of SUPPORTED_LANGUAGES) {
  NAME_TO_CODE.set(spec.englishName.toLowerCase(), spec.code);
  NAME_TO_CODE.set(spec.nativeName.toLowerCase(), spec.code);
}
// A few spellings people actually type.
for (const [alias, code] of [
  ['español', 'es'],
  ['castellano', 'es'],
  ['português', 'pt'],
  ['français', 'fr'],
  ['japanese', 'ja'],
  ['nihongo', 'ja'],
  ['bahasa', 'id'],
  ['mandarin', ''], // deliberately unmapped: we do not support it yet
] as const) {
  if (code) NAME_TO_CODE.set(alias, code);
}

/** Words that follow "to"/"in" without naming a language. */
const CANDIDATE_STOPWORDS = new Set([
  'this',
  'that',
  'it',
  'the',
  'my',
  'our',
  'your',
  'me',
  'us',
  'them',
  'here',
  'there',
  'now',
  'please',
  'video',
  'clip',
  'post',
  'reel',
  'thread',
  'one',
  'another',
  'something',
  'anything',
  'everyone',
  'order',
  'fact',
  'case',
  'time',
  'about',
  'and',
  'for',
  'with',
  'all',
  'both',
  'more',
  'other',
  'languages',
  'language',
]);

export interface LanguageGuess {
  /** A SUPPORTED base code, or null. */
  readonly code: string | null;
  /** A language-shaped word we recognised as a request but cannot serve. */
  readonly unsupported: string | null;
}

/**
 * Find the requested language. Full names are matched anywhere in the text;
 * bare two-letter codes only after to/in/into, because "hi" is a greeting and
 * "id", "de", "ar" are ordinary fragments.
 */
export function resolveLanguage(text: string): LanguageGuess {
  const lower = text.toLowerCase();

  // 1. "to es", "in spanish", "into Japanese"
  const candidates: string[] = [];
  const prepositional = /\b(?:in|into|to)\s+([a-zÀ-ɏ][a-zÀ-ɏ'-]*)/gi;
  for (const match of lower.matchAll(prepositional)) {
    const word = match[1];
    if (word) candidates.push(word);
  }
  for (const word of candidates) {
    const byName = NAME_TO_CODE.get(word);
    if (byName) return { code: byName, unsupported: null };
    if (word.length === 2 && languageByCode(word)) return { code: word, unsupported: null };
  }

  // 2. A language name anywhere: "spanish dub please".
  for (const [name, code] of NAME_TO_CODE) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(lower)) {
      return { code, unsupported: null };
    }
  }

  // 3. Something was asked for that we do not offer. The caller turns this into
  //    an honest UNSUPPORTED_LANGUAGE decline rather than a silent no-op.
  for (const word of candidates) {
    if (word.length >= 2 && !CANDIDATE_STOPWORDS.has(word)) {
      return { code: null, unsupported: word };
    }
  }
  return { code: null, unsupported: null };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Validation - the gate everything passes through
// ---------------------------------------------------------------------------

/**
 * Parse with zod AND check the language is one we actually support. Returns
 * null when the candidate cannot be trusted; callers fall back rather than act.
 */
export function validateIntent(candidate: unknown): ParsedIntent | null {
  const parsed = parsedIntentSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const intent = parsed.data;
  if (intent.targetLang !== null) {
    const code = intent.targetLang.toLowerCase();
    // The hallucination gate: an unsupported code cannot start a paid job.
    if (!languageByCode(code)) return null;
    return { ...intent, targetLang: code };
  }
  return intent;
}

function unknownIntent(reason: string, targetUrl: string | null): ParsedIntent {
  return {
    action: 'unknown',
    targetUrl,
    targetLang: null,
    confidence: 0.1,
    interpretation: truncate(reason),
  };
}

function truncate(value: string): string {
  return value.length <= 280 ? value : `${value.slice(0, 277)}...`;
}

const URL_PATTERN = /https?:\/\/[^\s<>"')]+/i;

function extractUrl(text: string, context: ParseContext): string | null {
  const match = URL_PATTERN.exec(text);
  if (match?.[0]) {
    try {
      return new URL(match[0]).toString();
    } catch {
      /* fall through to the context url */
    }
  }
  return context.targetUrl ?? null;
}

// ---------------------------------------------------------------------------
// Regex fallback
// ---------------------------------------------------------------------------

const STATUS_PATTERN = /\b(status|progress|how['’]?s it going|any update|where is it)\b/i;
const EARNINGS_PATTERN =
  /\b(earnings?|earned|payout|paid|revenue|how much (?:have i|did i|do i)\b)/i;
const DUB_PATTERN = /\b(dub|dubs|dubbed|dubbing|translate|translated|voice ?over|localis[ez]e)\b/i;

/**
 * The fallback the demo actually runs on. Handles, at minimum:
 *   "@parrot dub this to Spanish", "@parrot dub this in spanish", "dub to es",
 *   "@parrot status", "@parrot earnings" - names and codes, any case.
 */
export function parseIntentWithRegex(
  mentionText: string,
  context: ParseContext = {},
): ParsedIntent {
  const handle = (context.botHandle ?? 'parrot').replace(/^@/, '');
  const stripped = mentionText.replace(new RegExp(`@${escapeRegExp(handle)}\\b`, 'gi'), ' ').trim();
  const targetUrl = extractUrl(mentionText, context);

  if (stripped.length === 0) {
    return unknownIntent('Mentioned with no instruction.', targetUrl);
  }

  // Status and earnings are checked first: "what is the status of my dub"
  // contains "dub" but is plainly a status question.
  if (STATUS_PATTERN.test(stripped)) {
    return {
      action: 'status',
      targetUrl,
      targetLang: resolveLanguage(stripped).code,
      confidence: 0.85,
      interpretation: truncate('Asked for the status of a dub.'),
    };
  }
  if (EARNINGS_PATTERN.test(stripped)) {
    return {
      action: 'earnings',
      targetUrl,
      targetLang: resolveLanguage(stripped).code,
      confidence: 0.85,
      interpretation: truncate('Asked how much their dubs have earned.'),
    };
  }

  const language = resolveLanguage(stripped);
  if (DUB_PATTERN.test(stripped)) {
    if (language.code) {
      return {
        action: 'dub',
        targetUrl,
        targetLang: language.code,
        confidence: 0.9,
        interpretation: truncate(`Asked for a dub into ${languageName(language.code)}.`),
      };
    }
    if (language.unsupported) {
      return {
        action: 'dub',
        targetUrl,
        targetLang: null,
        confidence: 0.5,
        interpretation: truncate(
          `Asked for a dub into "${language.unsupported}", which is not on the supported list.`,
        ),
      };
    }
    return {
      action: 'dub',
      targetUrl,
      targetLang: null,
      confidence: 0.55,
      interpretation: truncate('Asked for a dub but did not say which language.'),
    };
  }

  // A bare language with no verb ("@parrot spanish") is still probably a dub
  // request, but we say so with low confidence rather than acting confidently.
  if (language.code) {
    return {
      action: 'dub',
      targetUrl,
      targetLang: language.code,
      confidence: 0.45,
      interpretation: truncate(
        `Named ${languageName(language.code)} without saying what to do with it.`,
      ),
    };
  }

  return unknownIntent('Could not tell what was being asked for.', targetUrl);
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

/** strict:true requires every property listed in `required` and no extras. */
export const GROK_INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['dub', 'status', 'earnings', 'unknown'] },
    targetUrl: { type: ['string', 'null'] },
    targetLang: {
      type: ['string', 'null'],
      enum: [...SUPPORTED_LANGUAGES.map((l) => l.code), null],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    interpretation: { type: 'string' },
  },
  required: ['action', 'targetUrl', 'targetLang', 'confidence', 'interpretation'],
} as const;

const SYSTEM_PROMPT = [
  'You extract the intent of a mention addressed to a dubbing bot.',
  'Reply with JSON only, matching the provided schema.',
  `targetLang must be one of: ${SUPPORTED_LANGUAGES.map((l) => `${l.code} (${l.englishName})`).join(', ')}.`,
  'If the requested language is not on that list, set targetLang to null.',
  'If you are not sure what is being asked, use action "unknown" and a low confidence.',
  'Never invent a language code.',
].join(' ');

/**
 * Ask Grok, then throw the answer at zod. Returns null on any failure - a bad
 * network, a bad JSON body, or an answer that does not survive validation - so
 * the caller falls back to the regex path instead of acting on garbage.
 */
export async function parseIntentWithGrok(
  mentionText: string,
  context: ParseContext,
): Promise<ParsedIntent | null> {
  const apiKey = context.apiKey;
  if (!apiKey) return null;
  const fetchImpl = context.fetchImpl ?? globalThis.fetch;
  const baseUrl = (context.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: context.model ?? DEFAULT_MODEL,
        // Slot-filling, not reasoning: cheapest and fastest setting.
        reasoning_effort: 'none',
        // max_tokens is deprecated on this API.
        max_completion_tokens: 300,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              mention: mentionText,
              postUrl: context.targetUrl ?? null,
              botHandle: context.botHandle ?? 'parrot',
            }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'parrot_intent', strict: true, schema: GROK_INTENT_JSON_SCHEMA },
        },
      }),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') return null;

    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      return null;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      // Grok sometimes answers with a language NAME despite the schema.
      if (typeof record['targetLang'] === 'string') {
        const named = NAME_TO_CODE.get(record['targetLang'].toLowerCase());
        if (named) record['targetLang'] = named;
      }
      if (record['targetUrl'] === undefined) record['targetUrl'] = context.targetUrl ?? null;
      if (record['targetUrl'] === '') record['targetUrl'] = null;
    }
    // The gate. Anything that fails here is discarded, not repaired.
    return validateIntent(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The entry point. Grok when we have a key and it answers something valid,
 * regex otherwise. The result is always a validated ParsedIntent.
 */
export async function parseIntent(
  mentionText: string,
  context: ParseContext = {},
): Promise<ParsedIntent> {
  if (context.apiKey) {
    const fromGrok = await parseIntentWithGrok(mentionText, context);
    if (fromGrok) return fromGrok;
  }
  const fallback = parseIntentWithRegex(mentionText, context);
  // Belt and braces: the fallback goes through the same gate as the LLM.
  return validateIntent(fallback) ?? unknownIntent('Could not parse the mention.', null);
}
