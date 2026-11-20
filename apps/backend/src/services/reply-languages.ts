/**
 * What language did people reply in?
 *
 * A platform shows who replied to a post, not who watched it. So the replies
 * under each dub are the one direct look at its audience: a Spanish dub that
 * draws replies in Spanish reached the people it was made for.
 *
 * Two readers, same answer shape:
 *   1. A local heuristic, always and at once: the writing system first
 *      (Japanese, Korean, Arabic, Hindi are unmistakable), then common words
 *      for the Latin-script languages.
 *   2. Grok (xAI), when XAI_API_KEY is set: batched calls IN THE BACKGROUND for
 *      replies not seen before. When its answers arrive they replace the
 *      heuristic's, and `version` goes up so callers know to re-count. Its
 *      answers are checked against the supported codes; anything else becomes
 *      "other".
 *
 * Nothing ever waits on the model: counting views must not stall because a
 * model is slow. Answers are cached per reply id, so a reply is read once.
 */

import { SUPPORTED_LANGUAGE_CODES } from '@parrot/shared';

export const OTHER_LANGUAGE = 'other';

const SCRIPT_TESTS: readonly (readonly [RegExp, string])[] = [
  [/[぀-ヿ]/, 'ja'], // kana: Japanese, not Chinese
  [/[가-힯]/, 'ko'],
  [/[؀-ۿ]/, 'ar'],
  [/[ऀ-ॿ]/, 'hi'],
];

/** A few very common words per language. Enough to tell a short reply apart. */
const WORDS: Readonly<Record<string, readonly string[]>> = {
  es: ['que', 'el', 'la', 'los', 'las', 'por', 'para', 'gracias', 'muy', 'esto', 'esta', 'pero', 'como', 'una', 'del', 'me', 'encanta', 'buenisimo', 'buenísimo', 'increible', 'increíble', 'genial', 'español', 'espanol', 'mas', 'más', 'asi', 'así', 'tambien', 'también', 'justo', 'necesitaba'],
  pt: ['que', 'não', 'nao', 'uma', 'você', 'voce', 'obrigado', 'obrigada', 'muito', 'isso', 'esse', 'essa', 'para', 'com', 'em', 'adorei', 'demais', 'português', 'portugues', 'também', 'tambem', 'agora', 'ótimo', 'otimo', 'finalmente', 'meu', 'vou', 'fazer', 'bom'],
  fr: ['le', 'la', 'les', 'des', 'est', 'une', 'merci', 'très', 'tres', 'pour', 'avec', 'pas', 'mais', 'trop', 'bien', 'génial', 'genial', 'français', 'francais', 'cette', "c'est", 'enfin', 'vidéo', 'je', 'ça'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'danke', 'sehr', 'mit', 'für', 'fur', 'auf', 'ein', 'eine', 'endlich', 'deutsch', 'gut', 'super', 'auch', 'genau', 'habe'],
  id: ['yang', 'dan', 'ini', 'itu', 'tidak', 'terima', 'kasih', 'banget', 'sangat', 'saya', 'aku', 'bisa', 'untuk', 'dengan', 'bagus', 'keren', 'akhirnya', 'ada', 'mantap', 'bahasa'],
  en: ['the', 'this', 'that', 'and', 'is', 'you', 'for', 'thanks', 'thank', 'love', 'great', 'with', 'not', 'what', 'so', 'finally', 'really', 'my', 'it'],
};

/** A best guess from the text alone. Never throws; unsure means "other". */
export function guessLanguage(text: string): string {
  for (const [pattern, code] of SCRIPT_TESTS) if (pattern.test(text)) return code;

  const tokens = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .split(/[^a-zà-ÿ']+/i)
    .filter(Boolean);
  if (tokens.length === 0) return OTHER_LANGUAGE;

  let best = OTHER_LANGUAGE;
  let bestScore = 0;
  for (const [code, words] of Object.entries(WORDS)) {
    const set = new Set(words);
    const score = tokens.reduce((sum, token) => sum + (set.has(token) ? 1 : 0), 0);
    if (score > bestScore) {
      best = code;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : OTHER_LANGUAGE;
}

export interface ReplyText {
  readonly id: string;
  readonly text: string;
}

export interface ReplyLanguageOptions {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['languages'],
  properties: {
    languages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'language'],
        properties: { id: { type: 'string' }, language: { type: 'string' } },
      },
    },
  },
} as const;

export class ReplyLanguageReader {
  private readonly cache = new Map<string, string>();
  /** Replies waiting for the model, by id. */
  private readonly queue = new Map<string, ReplyText>();
  private draining = false;
  private bumped = 0;

  constructor(private readonly options: ReplyLanguageOptions & { readonly onUpdate?: () => void } = {}) {}

  /** True when replies are read by Grok rather than only the local heuristic. */
  get usesGrok(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** Goes up whenever earlier answers were improved. Re-count when it changes. */
  get version(): number {
    return this.bumped;
  }

  /** The language of each reply, by id. Never waits on the network. */
  read(replies: readonly ReplyText[]): Map<string, string> {
    for (const reply of replies) {
      if (this.cache.has(reply.id)) continue;
      this.cache.set(reply.id, guessLanguage(reply.text));
      if (this.options.apiKey) this.queue.set(reply.id, reply);
    }
    if (this.queue.size > 0) void this.drain();
    return new Map(replies.map((r) => [r.id, this.cache.get(r.id) ?? OTHER_LANGUAGE]));
  }

  /** Resolves once the model has been asked about everything queued. For tests. */
  async settled(): Promise<void> {
    await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.size > 0) {
        const batch = [...this.queue.values()].slice(0, 60);
        for (const reply of batch) this.queue.delete(reply.id);
        const judged = await this.askGrok(batch).catch(() => null);
        if (!judged) continue; // the heuristic's answers stand
        let changed = false;
        for (const [id, language] of judged) {
          if (this.cache.get(id) !== language) {
            this.cache.set(id, language);
            changed = true;
          }
        }
        if (changed) {
          this.bumped += 1;
          this.options.onUpdate?.();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async askGrok(replies: readonly ReplyText[]): Promise<Map<string, string> | null> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? 'https://api.x.ai/v1').replace(/\/$/, '');
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model ?? 'grok-4.3',
        temperature: 0,
        max_completion_tokens: 1_500,
        messages: [
          {
            role: 'system',
            content:
              'You are given short replies to a video post. For each, give the ISO 639-1 code of the language it is ' +
              'written in. Use "other" when you cannot tell (emoji only, a name, a link). Reply with JSON only.',
          },
          {
            role: 'user',
            // Bounded: at most 60 replies of at most 280 characters each.
            content: JSON.stringify(replies.slice(0, 60).map((r) => ({ id: r.id, text: r.text.slice(0, 280) }))),
          },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'reply_languages', strict: true, schema: SCHEMA } },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content) as { languages?: { id?: unknown; language?: unknown }[] };
    const out = new Map<string, string>();
    for (const row of parsed.languages ?? []) {
      if (typeof row.id !== 'string' || typeof row.language !== 'string') continue;
      const code = row.language.trim().toLowerCase().split(/[-_]/)[0] ?? '';
      // Only ever a code we know, or "other": the model cannot invent a row.
      out.set(row.id, SUPPORTED_LANGUAGE_CODES.includes(code) ? code : OTHER_LANGUAGE);
    }
    return out;
  }
}
