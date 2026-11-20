/**
 * The independent QC judge.
 *
 * The rule: the company that MADE a dub never gives the verdict on it. A
 * speech-to-text service only writes down what is said (a measurement); the
 * verdict - is this the right language, and does it mean the same as the
 * original - comes from Grok (xAI), which is not a dubbing provider for any
 * agent.
 *
 * The meaning check is a back-translation: the judge translates the dub's
 * transcript back to English and scores how closely it matches what the
 * original said, 0-100.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4.3';

export const JUDGE_NAME = 'Grok (xAI)';

export interface JudgeVerdict {
  /** ISO 639-1 code of the language the dub transcript is in. */
  readonly language: string;
  /** The dub, translated back to English. */
  readonly backTranslation: string;
  /** 0-100: how closely the back-translation matches the original's meaning. */
  readonly meaningScore: number;
  /** One plain sentence explaining the score. */
  readonly reason: string;
}

export interface JudgeOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'backTranslation', 'meaningScore', 'reason'],
  properties: {
    language: { type: 'string', description: 'ISO 639-1 code of the DUB transcript language' },
    backTranslation: { type: 'string' },
    meaningScore: { type: 'integer', minimum: 0, maximum: 100 },
    reason: { type: 'string' },
  },
} as const;

const SYSTEM_PROMPT = [
  'You are an independent quality judge for video dubs.',
  'You get the transcript of an ORIGINAL clip and the transcript of its DUB, which should be in a target language.',
  'Identify the language the DUB transcript is actually in (ISO 639-1 code).',
  'Translate the DUB back to English, faithfully - do not fix its mistakes.',
  'Score 0-100 how well the back-translation preserves the meaning of the original:',
  '90+ same meaning, 70-89 minor losses, 40-69 important parts wrong or missing, below 40 a different message.',
  'Judge meaning, not word order or style. Give one short plain sentence as the reason.',
].join(' ');

/** Ask the judge. Returns null on any failure, so QC reports the check as skipped. */
export async function judgeDub(
  input: { sourceText: string; dubText: string; targetLang: string },
  options: JudgeOptions,
): Promise<JudgeVerdict | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        temperature: 0,
        max_completion_tokens: 1_200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              targetLanguage: input.targetLang,
              original: input.sourceText.slice(0, 6_000),
              dub: input.dubText.slice(0, 6_000),
            }),
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'dub_verdict', strict: true, schema: SCHEMA },
        },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const raw = JSON.parse(content) as Partial<JudgeVerdict>;
    if (
      typeof raw.language !== 'string' ||
      typeof raw.backTranslation !== 'string' ||
      typeof raw.meaningScore !== 'number' ||
      typeof raw.reason !== 'string'
    ) {
      return null;
    }
    return {
      language: raw.language.trim().toLowerCase(),
      backTranslation: raw.backTranslation,
      meaningScore: Math.max(0, Math.min(100, Math.round(raw.meaningScore))),
      reason: raw.reason,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
