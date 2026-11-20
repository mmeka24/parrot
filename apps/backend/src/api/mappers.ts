/**
 * Domain records -> the DTOs in @parrot/shared. The only place a record is
 * turned into something the front ends read, so every label and every money
 * figure is formatted here and nowhere else.
 */

import {
  ARC_TESTNET,
  DEFAULT_POST_BUDGET,
  DEFAULT_VALUE_PER_THOUSAND_VIEWS,
  DUBBING_TIER,
  ELEVENLABS_PRICE_PER_MINUTE,
  EXPLORE_LANGUAGE_COUNT,
  EXPLORE_POSTS,
  MAX_WINNERS,
  PRICE_PER_VIEW,
  USDC_ADDRESS,
  addPnl,
  addressUrl,
  TAKE_OFF_VIEWS,
  breakEvenViews,
  copy,
  estimateDubCost,
  expectedCharge,
  forecastViews,
  languageEconomics,
  learnedForecast,
  viewValue,
  fill,
  formatUsd,
  languageByCode,
  micros,
  pnlLine,
  txUrl,
  viewsCostMoreThanTheyAreWorth,
  type CreatorDashboardDto,
  type DubDto,
  type DubPageDto,
  type ExtensionResultsDto,
  type ExtensionForecastDto,
  type LanguagePlan,
  type LanguageRefDto,
  type LanguageRowDto,
  type LanguageStatus,
  type Micros,
  type MoneyDto,
  type PaymentDto,
  type PlanDto,
  type PlanRole,
  type PnlLine,
  type PostDto,
  type QcCheckDto,
  type ShareDto,
  type SystemStatusDto,
  type UndubbedPostDto,
} from '@parrot/shared';
import { getConfig } from '../config.js';
import { statusPhrase } from '../bot/bot-service.js';
import { CampaignService } from '../services/campaign-service.js';
import type { Insight, InsightFacts } from '../services/insight-service.js';
import { OTHER_LANGUAGE } from '../services/reply-languages.js';
import type { Store } from '../store/store.js';
import type { BotPost, Charge, Creator, Dub, DubbedPost } from '../store/types.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Below a dime, a third decimal carries real information ("$0.008"). */
export function money(amount: Micros): MoneyDto {
  const raw = amount as bigint;
  const abs = raw < 0n ? -raw : raw;
  const small = abs !== 0n && abs < 100_000n;
  return { micros: raw.toString(), display: formatUsd(amount, { maxDecimals: small ? 3 : 2 }) };
}

/**
 * A stored media path -> the address it is served at. Stored paths are local
 * file paths; handing one to a <video src> would 404. Everything is served
 * from /media.
 */
export function mediaUrl(storedPath: string | null | undefined): string | null {
  if (!storedPath) return null;
  if (/^https?:\/\//i.test(storedPath)) return storedPath;
  const base = getConfig().env.PUBLIC_BACKEND_URL.replace(/\/$/, '');
  // Split on BOTH separators: these paths may have been written on Windows.
  const file = storedPath.split(/[\\/]/).pop();
  return file ? `${base}/media/${encodeURIComponent(file)}` : null;
}

export function languageRef(code: string): LanguageRefDto {
  const spec = languageByCode(code);
  return {
    code,
    name: spec?.englishName ?? code,
    nativeName: spec?.nativeName ?? code,
    flag: spec?.flag ?? '',
  };
}

const COUNTRY_NAMES = new Map<string, string>();
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
function countryName(code: string): string {
  const cached = COUNTRY_NAMES.get(code);
  if (cached) return cached;
  let name = code;
  try {
    name = regionNames.of(code) ?? code;
  } catch {
    // Not a region code: show it as it came.
  }
  COUNTRY_NAMES.set(code, name);
  return name;
}

/** A tally -> shares of its total, largest first. */
export function shares(tally: Readonly<Record<string, number>>, nameOf: (code: string) => string, limit = 6): ShareDto[] {
  const total = Object.values(tally).reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  return Object.entries(tally)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, count]) => ({ code, name: nameOf(code), count, percent: Math.round((count / total) * 100) }));
}

const replyLanguageName = (code: string): string => (code === OTHER_LANGUAGE ? 'Other' : languageRef(code).name);

function mergeTallies(tallies: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tally of tallies) for (const [code, count] of Object.entries(tally)) out[code] = (out[code] ?? 0) + count;
  return out;
}

const STATUS_LABEL: Readonly<Record<LanguageStatus, string>> = {
  winner: copy.language.winner,
  testing: copy.language.testing,
  untested: copy.language.untested,
  dropped: copy.language.dropped,
};

const ROLE_LABEL: Readonly<Record<PlanRole | 'requested', string>> = {
  winner: copy.language.roleWinner,
  test: copy.language.roleTest,
  explore: copy.language.roleExplore,
  requested: 'You asked',
};

const MODE_LABEL = {
  explore: copy.language.modeExplore,
  focus: copy.language.modeFocus,
  requested: 'Dubbed on request',
} as const;

// ---------------------------------------------------------------------------
// Dubs and posts
// ---------------------------------------------------------------------------

function linePnl(dub: Dub, creator: Creator): PnlLine {
  return pnlLine({
    views: CampaignService.viewsOf(dub),
    paid: dub.paid,
    valuePerThousand: creator.valuePerThousand,
    dubCost: dub.dubCost,
  });
}

function qcChecks(dub: Dub): DubDto['qc'] {
  if (!dub.qcReport) return null;
  const checks: QcCheckDto[] = dub.qcReport.checks.map((check) => ({
    name: check.name,
    label: copy.qc[check.name],
    status: check.status,
    statusLabel: copy.qc[check.status],
    detail: check.detail,
  }));
  return { passed: dub.qcReport.passed, checks };
}

export function dubDto(dub: Dub, creator: Creator): DubDto {
  const views = CampaignService.viewsOf(dub);
  const pnl = linePnl(dub, creator);
  const needed = breakEvenViews(dub.dubCost);
  const live = dub.state === 'PUBLISHED';
  return {
    ...languageRef(dub.lang),
    id: dub.id,
    state: dub.state,
    statusLabel: statusPhrase(dub.state),
    role: dub.role,
    roleLabel: ROLE_LABEL[dub.role],
    simulatedDub: dub.simulatedDub,
    views,
    simulatedViews: dub.simulatedViews,
    likes: dub.likes,
    replies: dub.replies,
    reposts: dub.reposts,
    breakEvenViews: needed,
    breakEvenPercent: needed > 0 ? Math.min(100, Math.round((views / needed) * 100)) : 0,
    paidForItself: live && views >= needed,
    value: money(pnl.value),
    paid: money(pnl.paid),
    net: money(pnl.net),
    dubCost: money(dub.dubCost),
    watchPath: live ? `/dub/${dub.id}` : null,
    threadUrl: live ? dub.replyUrl : null,
    qc: qcChecks(dub),
    problem: dub.problem,
    countries: shares(dub.countries, countryName),
    replyLanguages: shares(dub.replyLanguages, replyLanguageName),
  };
}

export function postDto(store: Store, post: DubbedPost, creator: Creator): PostDto {
  const dubs = store.dubsForPost(post.id);
  const total = addPnl(dubs.filter((d) => d.state === 'PUBLISHED').map((d) => linePnl(d, creator)));
  const budget = post.budget as bigint;
  const paid = total.paid as bigint;
  return {
    id: post.id,
    text: post.text,
    postUrl: post.sourceUrl,
    createdAt: post.createdAt.toISOString(),
    durationS: post.durationS,
    originalViews: post.originalViews,
    mode: post.mode,
    modeLabel: MODE_LABEL[post.mode],
    summary: post.summary,
    working: dubs.some((d) => d.state === 'QUEUED' || d.state === 'DUBBING' || d.state === 'QC'),
    measured: post.measuredAt !== null,
    demoAudience: post.demoAudience,
    views: dubs.reduce((sum, d) => sum + (d.state === 'PUBLISHED' ? CampaignService.viewsOf(d) : 0), 0),
    value: money(total.value),
    paid: money(total.paid),
    net: money(total.net),
    budget: money(post.budget),
    budgetPercent: budget > 0n ? Math.min(100, Number((paid * 100n) / budget)) : 0,
    // Within one view's price of the budget counts as reached.
    budgetReached: budget > 0n && budget - paid < (PRICE_PER_VIEW as bigint),
    dubs: dubs.map((d) => dubDto(d, creator)),
  };
}

// ---------------------------------------------------------------------------
// Plan and languages
// ---------------------------------------------------------------------------

export function planDto(plan: LanguagePlan, basedOnPosts: number): PlanDto {
  return {
    mode: plan.mode,
    modeLabel: MODE_LABEL[plan.mode],
    summary: plan.summary,
    basedOnPosts,
    entries: plan.entries.map((entry) => ({
      ...languageRef(entry.lang),
      role: entry.role,
      roleLabel: ROLE_LABEL[entry.role],
      reason: entry.reason,
    })),
  };
}

function languageRows(store: Store, creator: Creator, plan: LanguagePlan): LanguageRowDto[] {
  const live = store.dubsForCreator(creator.id).filter((d) => d.state === 'PUBLISHED');
  return plan.standings.map((standing) => {
    const dubs = live.filter((d) => d.lang === standing.lang);
    const total = addPnl(dubs.map((d) => linePnl(d, creator)));
    return {
      ...languageRef(standing.lang),
      status: standing.status,
      statusLabel: STATUS_LABEL[standing.status],
      // Every live dub is shown, including ones on a post not yet measured;
      // `status` and `reason` come only from what has been measured.
      tries: dubs.length,
      views: dubs.reduce((sum, d) => sum + CampaignService.viewsOf(d), 0),
      avgViews: Math.round(standing.avgViews),
      coverage: Math.round(standing.avgCoverage * 10) / 10,
      value: money(total.value),
      paid: money(total.paid),
      net: money(total.net),
      dubCost: money(total.dubCost),
      reason: standing.reason,
    };
  });
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

const PAYMENT_STATUS = {
  pending: copy.payment.pending,
  confirmed: copy.payment.confirmed,
  failed: copy.payment.failed,
} as const;

export function paymentDto(charge: Charge): PaymentDto {
  const languages = [...new Set(charge.lines.map((l) => languageRef(l.lang).name))];
  const languageText = languages.length <= 2 ? languages.join(' and ') : `${languages.length} languages`;
  const real = charge.status === 'confirmed' && !charge.testMode && charge.txHash !== null;
  const notes: string[] = [];
  if (charge.testMode) notes.push(copy.payment.demoBalanceNote);
  if (charge.simulatedViews) notes.push(copy.payment.simulatedViewsNote);
  return {
    id: charge.id,
    at: (charge.confirmedAt ?? charge.createdAt).toISOString(),
    title: fill(copy.payment.title, { views: charge.views.toLocaleString('en-US') }),
    detail: fill(copy.payment.detail, {
      views: charge.views.toLocaleString('en-US'),
      languages: languageText,
      price: formatUsd(micros((PRICE_PER_VIEW as bigint) * 1_000n)),
    }),
    amount: money(charge.amount),
    views: charge.views,
    status: charge.status,
    statusLabel: PAYMENT_STATUS[charge.status],
    // A link exists only for a payment that really happened.
    verifyUrl: real ? txUrl(charge.txHash as string) : null,
    testMode: charge.testMode,
    simulatedViews: charge.simulatedViews,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/creators/:handle
// ---------------------------------------------------------------------------

export interface DashboardInput {
  readonly store: Store;
  readonly creator: Creator;
  readonly plan: LanguagePlan;
  readonly postsMeasured: number;
  /** Null when it could not be read. */
  readonly balance: Micros | null;
  readonly owed: Micros;
  readonly canEdit: boolean;
  readonly demo: boolean;
  /** The creator's video posts on the timeline, newest first. */
  readonly videoPosts: readonly BotPost[];
  readonly postUrl: (postId: string) => string;
  readonly insightFor: (facts: InsightFacts) => Insight | null;
}

export function creatorDashboard(input: DashboardInput): CreatorDashboardDto {
  const { store, creator, plan } = input;
  const posts = store.postsForCreator(creator.id);
  const dubs = store.dubsForCreator(creator.id);
  const live = dubs.filter((d) => d.state === 'PUBLISHED');
  const total = addPnl(live.map((d) => linePnl(d, creator)));
  const languages = languageRows(store, creator, plan);
  const totalViews = live.reduce((sum, d) => sum + CampaignService.viewsOf(d), 0);

  const dubbedSources = new Set(posts.map((p) => p.sourcePostId));
  const undubbed: UndubbedPostDto[] = input.videoPosts
    .filter((p) => !dubbedSources.has(p.id) && p.videoDurationS !== null)
    .map((p) => ({
      postId: p.id,
      text: p.text,
      postUrl: input.postUrl(p.id),
      createdAt: p.createdAt.toISOString(),
      durationS: p.videoDurationS as number,
      views: p.metrics?.views ?? null,
    }));

  const countries = shares(mergeTallies(live.map((d) => d.countries)), countryName, 8);
  const replyLanguages = shares(mergeTallies(live.map((d) => d.replyLanguages)), replyLanguageName, 8);

  const facts: InsightFacts = {
    handle: creator.handle,
    postsMeasured: input.postsMeasured,
    planSummary: plan.summary,
    languages: languages.map((row) => {
      const mine = live.filter((d) => d.lang === row.code);
      const replies = mergeTallies(mine.map((d) => d.replyLanguages));
      const replyTotal = Object.values(replies).reduce((a, b) => a + b, 0);
      return {
        name: row.name,
        status: row.statusLabel,
        tries: row.tries,
        avgViews: row.avgViews,
        coverage: row.coverage,
        topCountry: shares(mergeTallies(mine.map((d) => d.countries)), countryName, 1)[0]?.name ?? null,
        repliesInLanguagePercent: replyTotal > 0 ? Math.round(((replies[row.code] ?? 0) / replyTotal) * 100) : null,
      };
    }),
    totalViews,
    paid: formatUsd(total.paid),
    value: formatUsd(total.value),
    net: formatUsd(total.net),
  };
  const insight = input.insightFor(facts);

  const warnings: string[] = [];
  if (creator.lowBalance) warnings.push(copy.warnings.lowBalance);
  if (viewsCostMoreThanTheyAreWorth(creator.valuePerThousand)) {
    warnings.push(
      fill(copy.warnings.valueBelowPrice, {
        value: formatUsd(creator.valuePerThousand),
        price: formatUsd(micros((PRICE_PER_VIEW as bigint) * 1_000n)),
      }),
    );
  }

  return {
    handle: creator.handle,
    displayName: creator.displayName,
    balanceKind: creator.userId ? 'account' : 'demo',
    balance: input.balance === null ? null : money(input.balance),
    owed: money(input.owed),
    canEdit: input.canEdit,
    claimed: creator.userId !== null,
    settings: {
      valuePerThousand: money(creator.valuePerThousand),
      valueIsDefault: creator.valueIsDefault,
      postBudget: money(creator.postBudget),
      autoDub: creator.autoDub,
      pricePerThousand: money(micros((PRICE_PER_VIEW as bigint) * 1_000n)),
    },
    totals: {
      views: totalViews,
      value: money(total.value),
      paid: money(total.paid),
      net: money(total.net),
      postsDubbed: posts.length,
      dubsLive: live.length,
      languagesTried: new Set(live.map((d) => d.lang)).size,
      dubCostCovered: money(micros(dubs.reduce((sum, d) => sum + (d.dubCost as bigint), 0n))),
    },
    nextPlan: planDto(plan, input.postsMeasured),
    languages,
    posts: posts
      .slice()
      .reverse()
      .map((p) => postDto(store, p, creator)),
    undubbed,
    payments: store.chargesForCreator(creator.id).map(paymentDto),
    audience: {
      countries,
      replyLanguages,
      insight: insight?.text ?? null,
      insightBy: insight?.by ?? null,
    },
    warnings,
    demo: input.demo,
  };
}

// ---------------------------------------------------------------------------
// GET /api/dubs/:id
// ---------------------------------------------------------------------------

export function dubPage(store: Store, dub: Dub): DubPageDto | null {
  const post = store.posts.get(dub.postId);
  const creator = store.creators.get(dub.creatorId);
  if (!post || !creator) return null;
  const live = dub.state === 'PUBLISHED';
  const file = dub.mediaPath ?? '';
  return {
    ...languageRef(dub.lang),
    id: dub.id,
    state: dub.state,
    statusLabel: statusPhrase(dub.state),
    creatorHandle: creator.handle,
    creatorDisplayName: creator.displayName,
    originalText: post.text,
    originalUrl: post.sourceUrl,
    mediaUrl: live ? mediaUrl(dub.mediaPath) : null,
    mediaKind: /\.(mp4|webm|mov|mkv)$/i.test(file) ? 'video' : 'audio',
    durationS: post.durationS,
    simulatedDub: dub.simulatedDub,
    views: CampaignService.viewsOf(dub),
    alsoIn: store
      .dubsForPost(post.id)
      .filter((d) => d.id !== dub.id && d.state === 'PUBLISHED')
      .map((d) => ({ ...languageRef(d.lang), watchPath: `/dub/${d.id}` })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/system
// ---------------------------------------------------------------------------

export function systemStatus(store: Store, accounts: boolean, revenueAddress: string | null): SystemStatusDto {
  const config = getConfig();
  const house = store.houseAccount();
  const spend = -(store.ledgerTotal(house.id, 'dub_cost') as bigint);
  const collected = store.ledgerTotal(house.id, 'view_charge') as bigint;
  return {
    demoMode: config.isDemoMode,
    simulated: config.mockedSubsystems,
    accounts,
    pricing: {
      pricePerThousand: money(micros((PRICE_PER_VIEW as bigint) * 1_000n)),
      defaultValuePerThousand: money(DEFAULT_VALUE_PER_THOUSAND_VIEWS),
      dubCostPerMinute: money(ELEVENLABS_PRICE_PER_MINUTE[DUBBING_TIER]),
      defaultPostBudget: money(DEFAULT_POST_BUDGET),
      exploreLanguages: EXPLORE_LANGUAGE_COUNT,
      explorePosts: EXPLORE_POSTS,
      maxWinners: MAX_WINNERS,
    },
    chain: {
      name: ARC_TESTNET.name,
      explorerUrl: ARC_TESTNET.explorerUrl,
      usdcAddress: USDC_ADDRESS,
      revenueAddress,
      revenueAddressUrl: revenueAddress ? addressUrl(revenueAddress) : null,
    },
    house: {
      dubsMade: [...store.dubs.values()].filter((d) => d.providerJobId !== null).length,
      dubSpend: money(micros(spend)),
      collected: money(micros(collected)),
      net: money(micros(collected - spend)),
    },
    creators: [...store.creators.values()]
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .map((c) => ({ handle: c.handle, displayName: c.displayName })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/extension/results
// ---------------------------------------------------------------------------

export function extensionResults(input: {
  readonly store: Store;
  readonly creator: Creator;
  readonly post: DubbedPost;
  readonly plan: LanguagePlan;
  readonly postsMeasured: number;
  readonly canSendAudience: boolean;
  readonly webUrl: string;
}): ExtensionResultsDto {
  const { store, creator, post, plan } = input;
  const dto = postDto(store, post, creator);
  const dubs = store.dubsForPost(post.id);
  const live = dubs.filter((d) => d.state === 'PUBLISHED');
  const total = addPnl(live.map((d) => linePnl(d, creator)));
  const webUrl = input.webUrl.replace(/\/$/, '');

  return {
    postId: post.sourcePostId,
    handle: creator.handle,
    modeLabel: dto.modeLabel,
    summary: post.summary,
    working: dto.working,
    measured: dto.measured,
    demoAudience: post.demoAudience,
    canSendAudience:
      input.canSendAudience && !dto.working && post.demoAudience !== 'arriving' && live.some((d) => d.simulatedViews === 0),
    dubs: dto.dubs.map((d) => ({
      code: d.code,
      name: d.name,
      flag: d.flag,
      state: d.state,
      statusLabel: d.statusLabel,
      views: d.views,
      breakEvenViews: d.breakEvenViews,
      breakEvenPercent: d.breakEvenPercent,
      paidForItself: d.paidForItself,
      paid: d.paid,
      watchUrl: d.watchPath ? `${webUrl}${d.watchPath}` : null,
      problem: d.problem,
      simulatedDub: d.simulatedDub,
    })),
    totals: {
      views: dto.views,
      value: money(total.value),
      paid: money(total.paid),
      net: money(total.net),
      dubCost: money(micros(dubs.reduce((sum, d) => sum + (d.dubCost as bigint), 0n))),
      budget: money(post.budget),
    },
    learned: {
      basedOnPosts: input.postsMeasured,
      nextSummary: plan.summary,
      languages: plan.standings
        .filter((s) => s.tries > 0)
        .map((s) => ({
          name: languageRef(s.lang).name,
          flag: languageRef(s.lang).flag,
          status: s.status,
          statusLabel: STATUS_LABEL[s.status],
          avgViews: Math.round(s.avgViews),
        })),
    },
    dashboardUrl: `${webUrl}/creator/${creator.handle}`,
    includesSimulated: live.some((d) => d.simulatedViews > 0),
  };
}

// ---------------------------------------------------------------------------
// GET /api/extension/forecast
// ---------------------------------------------------------------------------

export function extensionForecast(input: {
  readonly creator: Creator;
  readonly plan: LanguagePlan;
  readonly postId: string;
  readonly originalViews: number | null;
  readonly durationS: number;
}): ExtensionForecastDto {
  const { creator, plan } = input;
  const dubCost = estimateDubCost(input.durationS);
  const budget = creator.postBudget;
  const original = input.originalViews;

  let likely = 0;
  let low = 0;
  let high = 0;
  let pay = { low: 0n, likely: 0n, high: 0n };
  let worth = 0n;
  let takeOffViews = 0;

  const languages = plan.entries.map((entry) => {
    const standing = plan.standings.find((s) => s.lang === entry.lang);
    const learned = standing !== undefined && standing.tries > 0;
    const views = learned
      ? learnedForecast(standing.avgViews)
      : forecastViews(original ?? 0, entry.lang);
    const eco = languageEconomics({ forecast: views, dubCost, valuePerThousand: creator.valuePerThousand, budget });
    low += views.low;
    likely += views.likely;
    high += views.high;
    pay = {
      low: pay.low + (eco.youPay.low as bigint),
      likely: pay.likely + (eco.youPay.likely as bigint),
      high: pay.high + (eco.youPay.high as bigint),
    };
    worth += eco.worthLikely as bigint;
    takeOffViews += forecastViews(TAKE_OFF_VIEWS, entry.lang).likely;
    return {
      code: entry.lang,
      name: languageRef(entry.lang).name,
      flag: languageRef(entry.lang).flag,
      roleLabel: ROLE_LABEL[entry.role],
      source: learned ? ('learned' as const) : ('estimate' as const),
      views,
      breakEvenViews: eco.breakEven,
      youPay: money(eco.youPay.likely),
      worth: money(eco.worthLikely),
    };
  });

  // One post's budget is shared by all its dubs, so the totals are capped by it.
  const cap = (amount: bigint): Micros => micros(amount > (budget as bigint) ? (budget as bigint) : amount);
  const totalPay = cap(pay.likely);
  const takeOffPay = expectedCharge(takeOffViews, budget);
  const takeOffWorth = viewValue(takeOffViews, creator.valuePerThousand);
  const totalDubCost = micros((dubCost as bigint) * BigInt(plan.entries.length));
  const anyLearned = languages.some((l) => l.source === 'learned');

  return {
    postId: input.postId,
    handle: creator.handle,
    originalViews: original,
    durationS: input.durationS,
    modeLabel: MODE_LABEL[plan.mode],
    summary: plan.summary,
    pricePerThousand: money(micros((PRICE_PER_VIEW as bigint) * 1_000n)),
    valuePerThousand: money(creator.valuePerThousand),
    valueIsDefault: creator.valueIsDefault,
    postBudget: money(budget),
    languages,
    totals: {
      dubCost: money(totalDubCost),
      views: { low, likely, high },
      youPayLow: money(cap(pay.low)),
      youPayLikely: money(totalPay),
      youPayHigh: money(cap(pay.high)),
      worth: money(micros(worth)),
      net: money(micros(worth - (totalPay as bigint))),
    },
    takeOff: {
      views: TAKE_OFF_VIEWS,
      dubViews: takeOffViews,
      youPay: money(takeOffPay),
      worth: money(takeOffWorth),
      net: money(micros((takeOffWorth as bigint) - (takeOffPay as bigint))),
    },
    basis: anyLearned
      ? 'Languages Parrot has already measured use your own earlier results. The rest use X audience figures by language (DataReportal) and stated assumptions on reach and uptake.'
      : 'X audience figures by language (DataReportal) times your video\'s views, with stated assumptions on how many of them are reached and watch. Parrot replaces this with your real numbers after your first post.',
  };
}
