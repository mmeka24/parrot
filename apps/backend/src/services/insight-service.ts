/**
 * A short read of a creator's numbers, in plain words.
 *
 * With XAI_API_KEY set, Grok writes it from the same figures the dashboard
 * shows (nothing else is sent: no post text, no handles of viewers). Without a
 * key, or when the call fails, a built-in summary is used instead - so the
 * dashboard always has something true to say, and it always says who wrote it.
 *
 * Never blocks a page: `get` returns what is cached and refreshes in the
 * background when the figures have changed, at most once per `minIntervalMs`.
 */

export interface InsightFacts {
  readonly handle: string;
  readonly postsMeasured: number;
  readonly planSummary: string;
  readonly languages: readonly {
    readonly name: string;
    readonly status: string;
    readonly tries: number;
    readonly avgViews: number;
    readonly coverage: number;
    readonly topCountry: string | null;
    /** Share of the replies to this language's dubs written in that language, 0-100. */
    readonly repliesInLanguagePercent: number | null;
  }[];
  readonly totalViews: number;
  readonly paid: string;
  readonly value: string;
  readonly net: string;
}

export interface Insight {
  readonly text: string;
  /** "Grok", or "Parrot" for the built-in summary. */
  readonly by: string;
}

export interface InsightOptions {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
  /** Called when a fresh insight has arrived for a creator. */
  readonly onReady?: (handle: string) => void;
}

/** The summary used when there is no model to ask. Deterministic. */
export function builtInInsight(facts: InsightFacts): string | null {
  if (facts.postsMeasured === 0 || facts.languages.every((l) => l.tries === 0)) return null;
  const tried = facts.languages.filter((l) => l.tries > 0).sort((a, b) => b.avgViews - a.avgViews);
  const best = tried[0];
  if (!best) return null;
  const winners = tried.filter((l) => l.coverage >= 1);
  const misses = tried.filter((l) => l.coverage < 0.25);
  const parts: string[] = [];
  parts.push(
    winners.length > 0
      ? `${best.name} is your strongest language so far, at about ${Math.round(best.avgViews).toLocaleString('en-US')} views a dub` +
          (best.topCountry ? `, mostly from ${best.topCountry}.` : '.')
      : `Nothing has paid for itself yet. ${best.name} came closest, at about ${Math.round(best.avgViews).toLocaleString('en-US')} views a dub.`,
  );
  if (winners.length > 1) {
    parts.push(`${winners.slice(1, 3).map((l) => l.name).join(' and ')} also paid for ${winners.length > 2 ? 'themselves' : 'itself'}.`);
  }
  if (misses.length > 0) {
    parts.push(`${misses.slice(0, 3).map((l) => l.name).join(', ')} barely registered, so Parrot has stopped dubbing ${misses.length === 1 ? 'it' : 'them'}.`);
  }
  return parts.join(' ');
}

export class InsightService {
  private readonly cache = new Map<string, { key: string; insight: Insight | null; at: number }>();
  private readonly pending = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: InsightOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get usesGrok(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** The current insight for a creator. Refreshes in the background if stale. */
  get(facts: InsightFacts): Insight | null {
    const key = JSON.stringify(facts);
    const cached = this.cache.get(facts.handle);
    const fallbackText = builtInInsight(facts);
    const fallback: Insight | null = fallbackText ? { text: fallbackText, by: 'Parrot' } : null;

    if (!this.options.apiKey || fallback === null) return fallback;
    if (cached?.key === key) return cached.insight ?? fallback;

    const due = !cached || this.now() - cached.at >= (this.options.minIntervalMs ?? 20_000);
    if (due && !this.pending.has(facts.handle)) {
      this.pending.add(facts.handle);
      void this.askGrok(facts)
        .catch(() => null)
        .then((text) => {
          this.cache.set(facts.handle, { key, insight: text ? { text, by: 'Grok' } : null, at: this.now() });
          if (text) this.options.onReady?.(facts.handle);
        })
        .finally(() => this.pending.delete(facts.handle));
    }
    // Until the fresh one lands, the built-in summary of the CURRENT figures
    // beats a model's summary of old ones.
    return fallback;
  }

  private async askGrok(facts: InsightFacts): Promise<string | null> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? 'https://api.x.ai/v1').replace(/\/$/, '');
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.model ?? 'grok-4.3',
        temperature: 0.2,
        max_completion_tokens: 220,
        messages: [
          {
            role: 'system',
            content: [
              'You explain a video creator\'s dubbing results to them, in at most three short sentences.',
              'Use only the figures you are given. Never invent a number, a country or a reason.',
              'Say which languages their audience watches, which did not work, and what happens on the next post.',
              '"coverage" is views divided by the views a dub needs to pay for itself: 1 or more means it paid for itself.',
              'Plain words. No jargon, no hype, no emoji, no markdown. Do not mention wallets, crypto or blockchains.',
              'Write to them as "you".',
            ].join(' '),
          },
          { role: 'user', content: JSON.stringify(facts) },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    // Bounded, and never a wall of text on a dashboard card.
    return text && text.length > 0 ? text.slice(0, 600) : null;
  }
}
