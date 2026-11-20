/**
 * Which languages should the next post be dubbed into?
 *
 * Two phases, and plain rules rather than a black box, so every choice can be
 * explained to the creator in one sentence:
 *
 *   EXPLORE (the first EXPLORE_POSTS posts). Nothing is known yet, so a post is
 *   dubbed into EXPLORE_LANGUAGE_COUNT languages. The first post takes the
 *   languages with the most people on X. The second keeps the half that did
 *   best (one post is noisy; a second confirms it) and swaps the rest for
 *   languages not tried yet.
 *
 *   FOCUS (every post after that). Dub into the proven languages only, plus
 *   one "test" language, so new markets keep being discovered.
 *
 * A language is judged against what its own dub needed to pay for itself
 * (`breakEvenViews`, see pnl.ts), so a short cheap dub and a long expensive one
 * are compared fairly. `coverage` is views / breakEvenViews: 1.0 means the dub
 * exactly paid for itself.
 *
 *   winner    average coverage >= 1
 *   dropped   fell short twice in a row, or missed badly on its first try
 *   testing   fell short once, but not badly: it gets another try
 *   untested  never dubbed
 *
 * Pure: no clock, no randomness, no I/O. Same history in, same plan out.
 */

import {
  CLEAR_MISS_RATIO,
  EXPLORE_LANGUAGE_COUNT,
  EXPLORE_POSTS,
  MAX_WINNERS,
  RETEST_EVERY_POSTS,
  SUPPORTED_LANGUAGES,
  languageName,
} from './constants.js';

/** How one language did on one post. Only dubs that were published count. */
export interface LanguageResult {
  readonly lang: string;
  readonly views: number;
  /** Views that dub needed for what the creator paid to cover what it cost. */
  readonly breakEvenViews: number;
}

/** One post whose dubs have been measured. */
export interface PostHistory {
  readonly results: readonly LanguageResult[];
}

export type LanguageStatus = 'untested' | 'testing' | 'winner' | 'dropped';

export interface LanguageStanding {
  readonly lang: string;
  readonly status: LanguageStatus;
  readonly tries: number;
  readonly totalViews: number;
  readonly avgViews: number;
  /** Mean of views / breakEvenViews over its tries. 0 when untested. */
  readonly avgCoverage: number;
  readonly last: LanguageResult | null;
  /** Index into the history of the last post it was dubbed for. */
  readonly lastTriedPost: number | null;
  /** One sentence for the creator. */
  readonly reason: string;
}

export type PlanRole = 'explore' | 'winner' | 'test';

export interface PlanEntry {
  readonly lang: string;
  readonly role: PlanRole;
  readonly reason: string;
}

export interface LanguagePlan {
  readonly mode: 'explore' | 'focus';
  readonly entries: readonly PlanEntry[];
  /** One sentence describing the whole plan. */
  readonly summary: string;
  /** Every candidate language, best first. */
  readonly standings: readonly LanguageStanding[];
}

export interface PlanOptions {
  /** The language the creator's videos are in; never a dub target. */
  readonly sourceLang?: string;
  readonly exploreCount?: number;
  readonly explorePosts?: number;
  readonly maxWinners?: number;
  readonly retestEvery?: number;
  readonly clearMissRatio?: number;
}

const n = (value: number): string => Math.round(value).toLocaleString('en-US');

const times = (coverage: number): string =>
  coverage >= 10 ? `${Math.round(coverage)}x` : `${(Math.round(coverage * 10) / 10).toString()}x`;

function list(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const coverageOf = (r: LanguageResult): number =>
  r.breakEvenViews > 0 && Number.isFinite(r.breakEvenViews) ? r.views / r.breakEvenViews : 0;

function audienceLine(lang: string): string {
  const spec = SUPPORTED_LANGUAGES.find((l) => l.code === lang);
  return spec
    ? `Not tried yet. About ${spec.xAudienceMillions}M people on X are in ${spec.englishName}-speaking markets.`
    : 'Not tried yet.';
}

/** Where one language stands, from everything measured so far. */
export function standingFor(
  lang: string,
  history: readonly PostHistory[],
  clearMissRatio = CLEAR_MISS_RATIO,
): LanguageStanding {
  const tries: { result: LanguageResult; post: number }[] = [];
  history.forEach((post, index) => {
    for (const result of post.results) if (result.lang === lang) tries.push({ result, post: index });
  });

  if (tries.length === 0) {
    return {
      lang,
      status: 'untested',
      tries: 0,
      totalViews: 0,
      avgViews: 0,
      avgCoverage: 0,
      last: null,
      lastTriedPost: null,
      reason: audienceLine(lang),
    };
  }

  const totalViews = tries.reduce((sum, t) => sum + t.result.views, 0);
  const avgViews = totalViews / tries.length;
  const avgCoverage = tries.reduce((sum, t) => sum + coverageOf(t.result), 0) / tries.length;
  const last = tries[tries.length - 1] as (typeof tries)[number];
  const prev = tries[tries.length - 2];
  const lastCoverage = coverageOf(last.result);
  const posts = tries.length === 1 ? '1 post' : `${tries.length} posts`;

  let status: LanguageStatus;
  let reason: string;
  if (prev && lastCoverage < 1 && coverageOf(prev.result) < 1) {
    status = 'dropped';
    reason = `Fell short two posts in a row (${n(prev.result.views)}, then ${n(last.result.views)} views; a dub needs about ${n(last.result.breakEvenViews)}).`;
  } else if (tries.length === 1 && lastCoverage < clearMissRatio) {
    status = 'dropped';
    reason = `Clear miss: ${n(last.result.views)} views against the ${n(last.result.breakEvenViews)} a dub needs to pay for itself.`;
  } else if (avgCoverage >= 1) {
    status = 'winner';
    reason = `Averages ${n(avgViews)} views a dub over ${posts}: ${times(avgCoverage)} what a dub needs to pay for itself.`;
  } else {
    status = 'testing';
    reason = `Close: ${n(last.result.views)} of the ${n(last.result.breakEvenViews)} views a dub needs. It gets one more try.`;
  }

  return {
    lang,
    status,
    tries: tries.length,
    totalViews,
    avgViews,
    avgCoverage,
    last: last.result,
    lastTriedPost: last.post,
    reason,
  };
}

const STATUS_ORDER: Readonly<Record<LanguageStatus, number>> = { winner: 0, testing: 1, untested: 2, dropped: 3 };

/** Plan the next post. `history` is every measured post so far, oldest first. */
export function planLanguages(history: readonly PostHistory[], options: PlanOptions = {}): LanguagePlan {
  const sourceLang = (options.sourceLang ?? 'en').toLowerCase();
  const exploreCount = options.exploreCount ?? EXPLORE_LANGUAGE_COUNT;
  const explorePosts = options.explorePosts ?? EXPLORE_POSTS;
  const maxWinners = options.maxWinners ?? MAX_WINNERS;
  const retestEvery = options.retestEvery ?? RETEST_EVERY_POSTS;

  // Candidates, biggest audience on X first: the order used whenever nothing
  // measured separates two languages.
  const candidates = SUPPORTED_LANGUAGES.filter((l) => l.code !== sourceLang)
    .slice()
    .sort((a, b) => b.xAudienceMillions - a.xAudienceMillions)
    .map((l) => l.code);
  const prior = (lang: string): number => candidates.indexOf(lang);

  const all = candidates.map((lang) => standingFor(lang, history, options.clearMissRatio));
  const standings = all
    .slice()
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        b.avgViews - a.avgViews ||
        prior(a.lang) - prior(b.lang),
    );
  const byStatus = (status: LanguageStatus): LanguageStanding[] => all.filter((s) => s.status === status);
  const untested = byStatus('untested'); // already in prior order

  // ---- EXPLORE ---------------------------------------------------------------
  if (history.length < explorePosts) {
    if (history.length === 0) {
      const entries = untested.slice(0, exploreCount).map<PlanEntry>((s) => ({
        lang: s.lang,
        role: 'explore',
        reason: s.reason,
      }));
      return {
        mode: 'explore',
        entries,
        summary: `First post: trying ${entries.length} languages to see who watches.`,
        standings,
      };
    }

    const alive = all
      .filter((s) => s.tries > 0 && s.status !== 'dropped')
      .sort((a, b) => b.avgCoverage - a.avgCoverage);
    const keep = alive.slice(0, Math.ceil(exploreCount / 2));
    const fresh = untested.slice(0, exploreCount - keep.length);
    const more = alive.slice(keep.length, keep.length + (exploreCount - keep.length - fresh.length));
    const entries: PlanEntry[] = [
      ...[...keep, ...more].map<PlanEntry>((s) => ({
        lang: s.lang,
        role: 'explore',
        reason: `Got ${n(s.last?.views ?? 0)} views last post. Checking that it holds up.`,
      })),
      ...fresh.map<PlanEntry>((s) => ({ lang: s.lang, role: 'explore', reason: s.reason })),
    ];
    const kept = keep.length + more.length;
    const freshWord = fresh.length === 1 ? 'one' : 'ones';
    return {
      mode: 'explore',
      entries,
      summary:
        kept === 0
          ? `Nothing has paid off yet, so trying ${fresh.length} new ${fresh.length === 1 ? 'language' : 'languages'}.`
          : fresh.length > 0
            ? `Still learning: keeping the ${kept} that did best and trying ${fresh.length} new ${freshWord}.`
            : `Still learning: a second look at the ${kept} that did best.`,
      standings,
    };
  }

  // ---- FOCUS -----------------------------------------------------------------
  const winners = byStatus('winner')
    .sort((a, b) => b.avgViews - a.avgViews)
    .slice(0, maxWinners);
  const entries: PlanEntry[] = winners.map((s) => ({ lang: s.lang, role: 'winner', reason: s.reason }));

  // The test slot, in order of how much there is still to learn.
  const testing = byStatus('testing').sort((a, b) => a.tries - b.tries || b.avgCoverage - a.avgCoverage);
  const dropped = byStatus('dropped').sort(
    (a, b) => (a.lastTriedPost ?? 0) - (b.lastTriedPost ?? 0) || b.avgCoverage - a.avgCoverage,
  );
  const retestDue = history.length % retestEvery === 0;

  const tests: PlanEntry[] = [
    ...untested.map<PlanEntry>((s) => ({ lang: s.lang, role: 'test', reason: s.reason })),
    ...testing.map<PlanEntry>((s) => ({ lang: s.lang, role: 'test', reason: s.reason })),
    ...(retestDue
      ? dropped.map<PlanEntry>((s) => ({
          lang: s.lang,
          role: 'test',
          reason: `Dropped earlier. Audiences change, so it gets another try every ${retestEvery} posts.`,
        }))
      : []),
  ];

  if (winners.length > 0) {
    const test = tests[0];
    if (test) entries.push(test);
    const names = list(winners.map((s) => languageName(s.lang)));
    return {
      mode: 'focus',
      entries,
      summary: test
        ? `Dubbing into ${names}, your proven ${winners.length === 1 ? 'language' : 'languages'}, and trying ${languageName(test.lang)}.`
        : `Dubbing into ${names}, your proven ${winners.length === 1 ? 'language' : 'languages'}.`,
      standings,
    };
  }

  // Nothing has paid for itself yet. Keep looking, two languages at a time,
  // rather than spending on six again or giving up.
  let picks = tests.slice(0, 2);
  if (picks.length === 0) {
    // Everything was tried and dropped: give the least-bad one another go.
    const best = dropped.slice().sort((a, b) => b.avgCoverage - a.avgCoverage)[0];
    if (best) {
      picks = [
        {
          lang: best.lang,
          role: 'test',
          reason: `No language has paid for itself yet. ${languageName(best.lang)} came closest, so it gets another try.`,
        },
      ];
    }
  }
  return {
    mode: 'focus',
    entries: picks,
    summary:
      picks.length > 0
        ? `No language has paid for itself yet, so Parrot keeps testing: ${list(picks.map((p) => languageName(p.lang)))}.`
        : 'No language is left to try.',
    standings,
  };
}
