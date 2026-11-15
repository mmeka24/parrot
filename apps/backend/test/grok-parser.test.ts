/**
 * The parser is the gate between a stranger's sentence and money being spent,
 * so these tests care about two things: that the regex fallback understands the
 * phrasings people actually use, and that NOTHING an LLM says can get past zod.
 *
 * No real network calls: every Grok test injects a fake fetch.
 */

import { describe, it, expect, vi } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES } from '@parrot/shared';
import {
  GROK_INTENT_JSON_SCHEMA,
  parseIntent,
  parseIntentWithGrok,
  parseIntentWithRegex,
  resolveLanguage,
  validateIntent,
} from '../src/bot/grok-parser.js';

const POST_URL = 'https://x.com/maria/status/mock-post-1';

function grokFetch(content: unknown, ok = true): typeof fetch {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
      { status: ok ? 200 : 500, headers: { 'content-type': 'application/json' } },
    ),
  ) as unknown as typeof fetch;
}

describe('regex fallback: dub requests', () => {
  const dubCases: Array<[string, string]> = [
    ['@parrot dub this to Spanish', 'es'],
    ['@parrot dub this in spanish', 'es'],
    ['@PARROT DUB THIS TO SPANISH', 'es'],
    ['dub to es', 'es'],
    ['@parrot dub to ES please', 'es'],
    ['@parrot dub this into Portuguese', 'pt'],
    ['@parrot can you dub this in Hindi?', 'hi'],
    ['@parrot dub this to french', 'fr'],
    ['@parrot please dub into German for my audience', 'de'],
    ['@parrot dub this to ja', 'ja'],
    ['@parrot dub this into Japanese', 'ja'],
    ['@parrot dub this in Korean', 'ko'],
    ['@parrot translate this to Arabic', 'ar'],
    ['@parrot dub this into Indonesian', 'id'],
    ['@parrot dub this into Brazilian Portuguese', 'pt'],
    ['@parrot dubbed version in espanol would be great', 'es'],
    ['@parrot voiceover this to ko', 'ko'],
    ['hey @parrot dub this clip to hi', 'hi'],
  ];

  it.each(dubCases)('reads %j as a dub into %s', (text, code) => {
    const intent = parseIntentWithRegex(text, { targetUrl: POST_URL });
    expect(intent.action).toBe('dub');
    expect(intent.targetLang).toBe(code);
    expect(SUPPORTED_LANGUAGE_CODES).toContain(intent.targetLang);
    expect(intent.confidence).toBeGreaterThanOrEqual(0.5);
    expect(intent.targetUrl).toBe(POST_URL);
  });

  it('asks rather than guesses when no language is named', () => {
    const intent = parseIntentWithRegex('@parrot dub this', { targetUrl: POST_URL });
    expect(intent.action).toBe('dub');
    expect(intent.targetLang).toBeNull();
    expect(intent.confidence).toBeLessThan(0.7);
  });

  it('refuses to invent a code for a language we do not support', () => {
    const intent = parseIntentWithRegex('@parrot dub this to Klingon', { targetUrl: POST_URL });
    expect(intent.action).toBe('dub');
    expect(intent.targetLang).toBeNull();
    expect(intent.interpretation).toContain('klingon');
  });

  it('surfaces the unsupported word so the caller can decline honestly', () => {
    expect(resolveLanguage('dub this to swahili')).toEqual({ code: null, unsupported: 'swahili' });
    expect(resolveLanguage('dub this')).toEqual({ code: null, unsupported: null });
  });

  it('does not read the greeting "hi" as Hindi', () => {
    const intent = parseIntentWithRegex('@parrot hi', {});
    expect(intent.targetLang).toBeNull();
  });
});

describe('regex fallback: other actions', () => {
  it.each([
    '@parrot status',
    '@parrot STATUS',
    '@parrot what is the status of my dub?',
    '@parrot any update on this?',
  ])('reads %j as a status question', (text) => {
    expect(parseIntentWithRegex(text, {}).action).toBe('status');
  });

  it.each([
    '@parrot earnings',
    '@parrot Earnings please',
    '@parrot how much have i earned?',
    '@parrot what is my payout',
  ])('reads %j as an earnings question', (text) => {
    expect(parseIntentWithRegex(text, {}).action).toBe('earnings');
  });

  it.each([
    '@parrot',
    '@parrot ????',
    '@parrot asdkjfhaskdjfh',
    '@parrot lol',
    '@parrot 🦜🦜🦜',
  ])('returns unknown with low confidence for junk like %j', (text) => {
    const intent = parseIntentWithRegex(text, {});
    expect(intent.action).toBe('unknown');
    expect(intent.confidence).toBeLessThanOrEqual(0.2);
  });

  it('picks the url out of the mention text when there is one', () => {
    const intent = parseIntentWithRegex(`@parrot dub ${POST_URL} to es`, {});
    expect(intent.targetUrl).toBe(POST_URL);
  });

  it('always produces something parsedIntentSchema accepts', () => {
    const texts = ['@parrot dub this to es', '@parrot status', '@parrot ???', ''];
    for (const text of texts) {
      expect(validateIntent(parseIntentWithRegex(text, {}))).not.toBeNull();
    }
  });
});

describe('zod is the gate, not a formality', () => {
  it('rejects a hallucinated language code', () => {
    expect(
      validateIntent({
        action: 'dub',
        targetUrl: POST_URL,
        targetLang: 'zz',
        confidence: 0.99,
        interpretation: 'confidently wrong',
      }),
    ).toBeNull();
  });

  it('rejects a real but unsupported language', () => {
    for (const code of ['sw', 'ca', 'zh', 'ru']) {
      expect(
        validateIntent({
          action: 'dub',
          targetUrl: POST_URL,
          targetLang: code,
          confidence: 0.95,
          interpretation: 'not on our list',
        }),
        code,
      ).toBeNull();
    }
  });

  it('rejects a bad shape outright', () => {
    expect(validateIntent({ action: 'launch_rocket', targetLang: 'es' })).toBeNull();
    expect(validateIntent({ action: 'dub', targetUrl: 'not-a-url', targetLang: 'es', confidence: 1, interpretation: '' })).toBeNull();
    expect(validateIntent(null)).toBeNull();
  });

  it('normalises a supported code to lower case', () => {
    const intent = validateIntent({
      action: 'dub',
      targetUrl: null,
      targetLang: 'ES',
      confidence: 0.9,
      interpretation: 'shouty',
    });
    expect(intent?.targetLang).toBe('es');
  });
});

describe('Grok path (fake fetch only)', () => {
  it('uses the documented endpoint, model and structured-output settings', async () => {
    const fetchImpl = grokFetch({
      action: 'dub',
      targetUrl: POST_URL,
      targetLang: 'es',
      confidence: 0.95,
      interpretation: 'Dub into Spanish.',
    });

    const intent = await parseIntent('@parrot dub this to Spanish', {
      apiKey: 'xai-test-key',
      fetchImpl,
      targetUrl: POST_URL,
    });

    expect(intent.targetLang).toBe('es');
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer xai-test-key');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('grok-4.3');
    expect(body['reasoning_effort']).toBe('none');
    expect(body['max_completion_tokens']).toBeTypeOf('number');
    expect(body).not.toHaveProperty('max_tokens');
    const format = body['response_format'] as { json_schema: { strict: boolean } };
    expect(format.json_schema.strict).toBe(true);
    expect(GROK_INTENT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('falls back to the regex when Grok hallucinates a language', async () => {
    const intent = await parseIntent('@parrot dub this to Spanish', {
      apiKey: 'xai-test-key',
      targetUrl: POST_URL,
      fetchImpl: grokFetch({
        action: 'dub',
        targetUrl: POST_URL,
        targetLang: 'xx',
        confidence: 1,
        interpretation: 'made it up',
      }),
    });
    // Regex understood the same sentence correctly, and the bad code never won.
    expect(intent.targetLang).toBe('es');
  });

  it('falls back when Grok returns junk, an error, or nothing', async () => {
    const broken: Array<typeof fetch> = [
      vi.fn(async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
      vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
      vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    ];
    for (const fetchImpl of broken) {
      const intent = await parseIntent('@parrot dub this to es', {
        apiKey: 'xai-test-key',
        fetchImpl,
        targetUrl: POST_URL,
      });
      expect(intent.action).toBe('dub');
      expect(intent.targetLang).toBe('es');
    }
  });

  it('maps a language NAME back to a code when Grok ignores the schema', async () => {
    const intent = await parseIntentWithGrok('@parrot dub this', {
      apiKey: 'xai-test-key',
      targetUrl: POST_URL,
      fetchImpl: grokFetch({
        action: 'dub',
        targetUrl: POST_URL,
        targetLang: 'Spanish',
        confidence: 0.9,
        interpretation: 'Dub into Spanish.',
      }),
    });
    expect(intent?.targetLang).toBe('es');
  });

  it('never calls Grok without a key', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const intent = await parseIntent('@parrot dub this to es', { fetchImpl });
    expect(intent.targetLang).toBe('es');
    expect(fetchImpl as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
