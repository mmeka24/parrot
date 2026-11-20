/**
 * Domain record -> wire DTO mappers.
 *
 * Two rules enforced here so the UI cannot break them:
 *  1. Money crosses as BOTH an integer micros string and a pre-formatted
 *     display string. The UI renders the display string and never does money
 *     arithmetic.
 *  2. A "Verify on Arc" link is emitted ONLY for a settlement that is genuinely
 *     confirmed on-chain with a real transaction hash. A simulated settlement
 *     gets `verifyUrl: null` and `simulated: true`, so the UI physically cannot
 *     show a verification link for something that did not happen.
 */

import {
  formatUsd,
  formatPpmPercent,
  languageName,
  roiPpm,
  txUrl,
  addressUrl,
  copy,
  fill,
  ppm,
  micros,
  PREVIEW_SECONDS,
  UNLOCK_PRICE,
  ARC_TESTNET,
  USDC_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
  type Micros,
  type JobState,
  type MoneyDto,
  type ReceiptDto,
  type DubPageDto,
  type CreatorDashboardDto,
  type CreatorDubRowDto,
  type AgentSummaryDto,
  type AgentJobRowDto,
  type DecisionLogEntryDto,
  type EvMathDto,
  type TickerEntryDto,
  type AccuracyPointDto,
  type SystemStatusDto,
  type BotPostDto,
  type FeedStatusDto,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type {
  Agent,
  BotPost,
  Creator,
  Job,
  Settlement,
  Unlock,
  PredictionRecord,
} from '../store/types.js';
import { getConfig } from '../config.js';

/**
 * Turn a stored media path into something a browser can actually fetch.
 *
 * DubbingService writes a FILESYSTEM path (on Windows, with backslashes). Handing
 * that to an <audio src> yields a 404 and a dub that cannot play - which is the
 * one thing the viewer page exists to do. Everything is served from /media.
 */
export function mediaUrl(storedPath: string | null): string | null {
  if (!storedPath) return null;
  if (/^https?:\/\//i.test(storedPath)) return storedPath;
  const base = getConfig().env.PUBLIC_BACKEND_URL.replace(/\/$/, '');
  // Split on BOTH separators: these paths are written by Node on Windows, so
  // they arrive with backslashes.
  const file = storedPath.split(/[\\/]/).pop();
  if (!file) return null;
  return `${base}/media/${encodeURIComponent(file)}`;
}

export function money(amount: Micros, maxDecimals: 2 | 3 = 2): MoneyDto {
  return {
    micros: (amount as bigint).toString(),
    display: formatUsd(amount, { maxDecimals: displayDecimals(amount, maxDecimals) }),
  };
}

/** Below this, a third decimal carries real information ("$0.008"). */
const SUB_CENT_DISPLAY_LIMIT = 100_000n; // $0.10 in micros

/**
 * Sub-cent precision only where it matters. An agent's 40% of one unlock is
 * $0.008 and must not read as $0.00, but a running total like "$1.032" just
 * looks like a typo, so anything from 10 cents up is shown in whole cents.
 */
function displayDecimals(amount: Micros, requested: 2 | 3): 2 | 3 {
  if (requested === 2) return 2;
  const raw = amount as bigint;
  const abs = raw < 0n ? -raw : raw;
  return abs < SUB_CENT_DISPLAY_LIMIT ? 3 : 2;
}

/** Plain-language status label. Never leaks a state machine name to a user. */
export function statusLabel(state: JobState): string {
  const map: Record<JobState, string> = {
    REQUESTED: copy.status.requested,
    PARSED: copy.status.parsed,
    EVALUATING: copy.status.evaluating,
    DECLINED: copy.status.declined,
    APPROVED: copy.status.approved,
    DUBBING: copy.status.dubbing,
    QC: copy.status.qc,
    REJECTED_BY_QC: copy.status.rejectedByQc,
    PUBLISHED: copy.status.published,
    EARNING: copy.status.earning,
    SETTLED: copy.status.settled,
    FAILED: copy.status.failed,
  };
  return map[state];
}

/**
 * A settlement as a receipt. The verify link appears only when there is
 * something real to verify.
 */
export function settlementReceipt(settlement: Settlement, store: Store): ReceiptDto {
  const recipient = store.getAccount(settlement.toAccountId);
  const confirmed = settlement.status === 'confirmed';
  const verifiable = confirmed && !settlement.simulated && settlement.txHash !== null;

  const titles: Record<string, { title: string; detail: string }> = {
    creator_payout: {
      title: copy.receipt.payoutSent,
      detail: fill(copy.receipt.payoutSentDetail, {
        amount: formatUsd(settlement.amount),
      }),
    },
    creator_share: {
      title: copy.receipt.creatorSharePaid,
      detail: fill(copy.receipt.creatorSharePaidDetail, {
        amount: formatUsd(settlement.amount),
        handle: recipient?.label ?? 'the creator',
      }),
    },
    agent_share: {
      title: copy.receipt.parrotSharePaid,
      detail: fill(copy.receipt.parrotSharePaidDetail, {
        amount: formatUsd(settlement.amount, { maxDecimals: displayDecimals(settlement.amount, 3) }),
      }),
    },
    dub_cost: {
      title: copy.receipt.dubCost,
      detail: fill(copy.receipt.dubCostDetail, { amount: formatUsd(settlement.amount) }),
    },
  };

  const chosen = titles[settlement.kind] ?? {
    title: copy.receipt.payoutSent,
    detail: fill(copy.receipt.payoutSentDetail, { amount: formatUsd(settlement.amount) }),
  };

  return {
    id: settlement.id,
    title: chosen.title,
    detail: chosen.detail,
    amount: money(settlement.amount, 3),
    at: settlement.createdAt.toISOString(),
    status: settlement.status,
    verifyUrl: verifiable ? txUrl(settlement.txHash as string) : null,
    simulated: settlement.simulated,
  };
}

/** An unlock as a receipt, from the paying viewer's point of view. */
export function unlockReceipt(unlock: Unlock, job: Job): ReceiptDto {
  return {
    id: unlock.id,
    title: copy.receipt.unlockPaid,
    detail: fill(copy.receipt.unlockPaidDetail, {
      amount: formatUsd(unlock.amount),
      language: languageName(job.targetLang),
    }),
    amount: money(unlock.amount),
    at: unlock.createdAt.toISOString(),
    status: 'confirmed',
    // An unlock paid on-chain carries its transaction hash as the payment
    // reference, so it links to the explorer. A ledger-only (simulated) unlock
    // has no transaction of its own, and gets no link rather than a made-up one.
    verifyUrl: unlockTxUrl(unlock),
    simulated: unlock.simulated,
  };
}

/** The explorer link for an unlock paid on-chain, or null when there is none. */
export function unlockTxUrl(unlock: Unlock): string | null {
  return !unlock.simulated && unlock.paymentRef !== null && /^0x[0-9a-fA-F]{64}$/.test(unlock.paymentRef)
    ? txUrl(unlock.paymentRef)
    : null;
}

export function dubPage(
  store: Store,
  job: Job,
  viewerAccountId: string | null,
): DubPageDto {
  const creator = store.creators.get(job.creatorId);
  const unlocks = store.unlocksForJob(job.id);
  const viewerUnlock = viewerAccountId ? store.findUnlock(job.id, viewerAccountId) : undefined;
  const unlocked = viewerUnlock !== undefined;

  const receipts: ReceiptDto[] = [];
  if (viewerUnlock) receipts.push(unlockReceipt(viewerUnlock, job));
  for (const settlement of store.settlementsForJob(job.id)) {
    receipts.push(settlementReceipt(settlement, store));
  }

  return {
    jobId: job.id,
    state: job.state,
    targetLang: job.targetLang,
    targetLanguageName: languageName(job.targetLang),
    sourceLanguageName: null,
    creator: {
      handle: creator?.handle ?? 'unknown',
      displayName: creator?.displayName ?? 'Unknown creator',
    },
    sourceUrl: job.sourceUrl,
    durationS: job.durationS,
    posterUrl: mediaUrl(job.posterUrl),
    previewUrl: mediaUrl(job.previewUrl),
    fullUrl: unlocked ? mediaUrl(job.dubUrl) : null,
    previewSeconds: PREVIEW_SECONDS,
    price: money(UNLOCK_PRICE),
    unlocked,
    unlockCount: unlocks.length,
    viewCount: job.viewCount,
    viewerBalance: viewerAccountId ? money(store.balanceOf(viewerAccountId)) : null,
    receipts,
    simulated: unlocks.some((u) => u.simulated),
  };
}

export function creatorDashboard(store: Store, creator: Creator): CreatorDashboardDto {
  const jobs = store.jobsForCreator(creator.id);
  const balance = store.balanceOf(creator.accountId);
  const earned = store.totalEarned(creator.accountId, ['creator_share']);
  const paidOut = store.totalSpend(creator.accountId, 'creator_payout');

  const dubs: CreatorDubRowDto[] = jobs.map((job) => {
    const unlocks = store.unlocksForJob(job.id);
    const earnedOnJob = unlocks.reduce((sum, u) => sum + (u.creatorShare as bigint), 0n);
    return {
      jobId: job.id,
      targetLanguageName: languageName(job.targetLang),
      state: job.state,
      statusLabel: statusLabel(job.state),
      views: job.viewCount,
      unlocks: unlocks.length,
      earned: money(micros(earnedOnJob), 3),
      publishedAt: job.publishedAt?.toISOString() ?? null,
      dubPath: `/dub/${job.id}`,
    };
  });

  const receipts = store
    .allSettlements()
    .filter((s) => s.toAccountId === creator.accountId)
    .map((s) => settlementReceipt(s, store));

  return {
    handle: creator.handle,
    displayName: creator.displayName,
    signedIn: creator.claimed,
    totalEarned: money(earned, 3),
    readyToClaim: money(balance, 3),
    paidOut: money(paidOut, 3),
    creatorSharePercent: formatPpmPercent(ppm(600_000), 0),
    dubs,
    receipts,
  };
}

function evMath(job: Job): EvMathDto | null {
  const decision = job.decision;
  if (!decision) return null;
  return {
    predictedViews: decision.inputs.predictedViews,
    conversionPercent: formatPpmPercent(ppm(decision.inputs.conversionPpm)).replace('%', ''),
    pSuccessPercent: formatPpmPercent(ppm(decision.inputs.pSuccessPpm)),
    rPerView: money(micros(BigInt(decision.result.rPerViewMicros)), 3),
    agentTakePerUnlock: money(
      micros(
        (BigInt(decision.inputs.unlockPriceMicros) * BigInt(decision.inputs.agentBps)) / 10_000n,
      ),
      3,
    ),
    unlockPrice: money(micros(BigInt(decision.inputs.unlockPriceMicros))),
    agentSharePercent: `${decision.inputs.agentBps / 100}%`,
    expectedRevenue: money(micros(BigInt(decision.result.expectedRevenueMicros)), 3),
    dubCost: money(micros(BigInt(decision.inputs.dubCostMicros))),
    ev: money(micros(BigInt(decision.result.evMicros)), 3),
    minMargin: money(micros(BigInt(decision.inputs.minMarginMicros))),
    confidencePercent: formatPpmPercent(ppm(decision.result.confidencePpm)).replace('%', ''),
    basis: decision.result.basis,
  };
}

export function decisionLog(store: Store, limit = 40): DecisionLogEntryDto[] {
  const entries: DecisionLogEntryDto[] = [];

  for (const event of [...store.events].reverse()) {
    if (event.type !== 'APPROVED' && event.type !== 'DECLINED') continue;
    const payload = event.payload as {
      decision?: Record<string, unknown>;
      won?: boolean;
      claimedByAgentName?: string | null;
    } | null;
    const decision = payload?.decision as
      | {
          agentName: string;
          decision: 'APPROVE' | 'DECLINE';
          declineReason: string | null;
          rationale: string;
          inputs: Record<string, string | number>;
          result: Record<string, string | number>;
          decidedAt: string | Date;
        }
      | undefined;
    if (!decision || !event.jobId) continue;

    const job = store.getJob(event.jobId);
    if (!job) continue;
    const creator = store.creators.get(job.creatorId);

    entries.push({
      jobId: job.id,
      agentName: decision.agentName,
      decision: decision.decision,
      won: payload?.won ?? decision.decision === 'APPROVE',
      claimedByAgentName: payload?.claimedByAgentName ?? null,
      declineReason: decision.declineReason,
      // An agent that approved but lost the race reasoned its way to "I would
      // dub this" - which is true, and worth showing - but the log must not
      // leave a reader thinking it did. The winner's name is appended rather
      // than the reasoning being rewritten, because the reasoning is real.
      rationale:
        decision.decision === 'APPROVE' && payload?.won === false && payload?.claimedByAgentName
          ? `${decision.rationale} (${payload.claimedByAgentName} claimed this one first.)`
          : decision.rationale,
      math: {
        predictedViews: Number(decision.inputs.predictedViews ?? 0),
        conversionPercent: formatPpmPercent(ppm(Number(decision.inputs.conversionPpm ?? 0))).replace('%', ''),
        pSuccessPercent: formatPpmPercent(ppm(Number(decision.inputs.pSuccessPpm ?? 0))),
        rPerView: money(micros(BigInt(String(decision.result.rPerViewMicros ?? '0'))), 3),
        agentTakePerUnlock: money(
          micros(
            (BigInt(String(decision.inputs.unlockPriceMicros ?? '0')) *
              BigInt(Number(decision.inputs.agentBps ?? 0))) /
              10_000n,
          ),
          3,
        ),
        unlockPrice: money(micros(BigInt(String(decision.inputs.unlockPriceMicros ?? '0')))),
        agentSharePercent: `${Number(decision.inputs.agentBps ?? 0) / 100}%`,
        expectedRevenue: money(
          micros(BigInt(String(decision.result.expectedRevenueMicros ?? '0'))),
          3,
        ),
        dubCost: money(micros(BigInt(String(decision.inputs.dubCostMicros ?? '0')))),
        ev: money(micros(BigInt(String(decision.result.evMicros ?? '0'))), 3),
        minMargin: money(micros(BigInt(String(decision.inputs.minMarginMicros ?? '0')))),
        confidencePercent: formatPpmPercent(ppm(Number(decision.result.confidencePpm ?? 0))).replace('%', ''),
        basis: (decision.result.basis as 'bucket' | 'cold_start') ?? 'cold_start',
      },
      decidedAt: new Date(decision.decidedAt).toISOString(),
      creatorHandle: creator?.handle ?? 'unknown',
      targetLanguageName: languageName(job.targetLang),
    });

    if (entries.length >= limit) break;
  }

  return entries;
}

export function agentSummary(store: Store, agent: Agent): AgentSummaryDto {
  const jobs = store.jobsForAgent(agent.id);
  const balance = store.balanceOf(agent.accountId);
  const spend = store.totalSpend(agent.accountId, 'dub_cost');
  const revenue = store.totalEarned(agent.accountId, ['agent_share']);

  const finished = jobs.filter((j) =>
    ['PUBLISHED', 'EARNING', 'SETTLED', 'REJECTED_BY_QC'].includes(j.state),
  );
  const published = finished.filter((j) =>
    ['PUBLISHED', 'EARNING', 'SETTLED'].includes(j.state),
  ).length;

  const errors = jobs
    .map((j) => store.getPrediction(j.id))
    .filter((p): p is PredictionRecord => p !== undefined && p.errorRatio !== null)
    .map((p) => Math.abs(p.errorRatio as number));
  const meanError =
    errors.length > 0 ? (errors.reduce((a, b) => a + b, 0) / errors.length) * 100 : null;

  const roi = roiPpm(revenue, spend);

  return {
    id: agent.id,
    name: agent.name,
    persona: agent.persona,
    balance: money(balance),
    lifetimeSpend: money(spend),
    lifetimeRevenue: money(revenue, 3),
    profit: money(micros((revenue as bigint) - (spend as bigint)), 3),
    roiPercent: roi === null ? null : `${(roi / 10_000).toFixed(1)}%`,
    jobsWon: jobs.length,
    jobsDeclined: 0,
    qcPassRate: finished.length === 0 ? 'n/a' : `${Math.round((published / finished.length) * 100)}%`,
    predictionErrorPercent: meanError === null ? null : `${meanError.toFixed(0)}%`,
    walletAddress: agent.walletAddress,
    verifyUrl: agent.walletAddress ? addressUrl(agent.walletAddress) : null,
  };
}

export function agentJobRow(store: Store, job: Job): AgentJobRowDto {
  const creator = store.creators.get(job.creatorId);
  const unlocks = store.unlocksForJob(job.id);
  const revenue = unlocks.reduce((sum, u) => sum + (u.agentShare as bigint), 0n);
  const cost = job.dubCost as bigint;
  const roi = roiPpm(micros(revenue), micros(cost));

  return {
    jobId: job.id,
    creatorHandle: creator?.handle ?? 'unknown',
    targetLanguageName: languageName(job.targetLang),
    state: job.state,
    statusLabel: statusLabel(job.state),
    cost: money(micros(cost)),
    revenue: money(micros(revenue), 3),
    profit: money(micros(revenue - cost), 3),
    roiPercent: roi === null ? null : `${(roi / 10_000).toFixed(1)}%`,
    unlocks: unlocks.length,
    qcPassed: job.qcReport ? job.qcReport.passed : null,
  };
}

export function accuracySeries(store: Store): AccuracyPointDto[] {
  return store.resolvedPredictions().map((p) => ({
    at: (p.resolvedAt as Date).toISOString(),
    predicted: p.predictedViews,
    actual: p.actualViews ?? 0,
    errorPercent: Math.round((p.errorRatio ?? 0) * 100),
    simulated: p.simulated,
  }));
}

/**
 * The feed line for a settlement. Shares of an unlock are BANKED into the
 * recipient's balance; only a claimed creator payout is "paid out". Saying
 * "paid to @maria" for a share made her dashboard ("Already paid out: $0.00")
 * look wrong when it was right.
 */
function tickerText(settlement: Settlement, name: string): string {
  const amount = formatUsd(settlement.amount, {
    maxDecimals: displayDecimals(settlement.amount, 3),
  });
  switch (settlement.kind) {
    case 'creator_payout':
      return fill(copy.ticker.paidOut, { amount, name });
    case 'dub_cost':
      return fill(copy.ticker.dubCost, { amount });
    default:
      return fill(copy.ticker.shareBanked, { amount, name });
  }
}

export function tickerFromSettlement(settlement: Settlement, store: Store): TickerEntryDto {
  const account = store.getAccount(settlement.toAccountId);
  const verifiable =
    settlement.status === 'confirmed' && !settlement.simulated && settlement.txHash !== null;
  return {
    id: settlement.id,
    kind: 'settlement',
    text: tickerText(settlement, account?.label ?? copy.ticker.someone),
    amount: money(settlement.amount, 3),
    at: settlement.createdAt.toISOString(),
    verifyUrl: verifiable ? txUrl(settlement.txHash as string) : null,
    simulated: settlement.simulated,
  };
}

export function tickerFromUnlock(unlock: Unlock, store: Store): TickerEntryDto {
  const job = store.getJob(unlock.jobId);
  return {
    id: unlock.id,
    kind: 'unlock',
    text: `Someone unlocked a ${job ? languageName(job.targetLang) : ''} dub`.trim(),
    amount: money(unlock.amount),
    at: unlock.createdAt.toISOString(),
    verifyUrl: unlockTxUrl(unlock),
    simulated: unlock.simulated,
  };
}

export function botPostDto(post: BotPost): BotPostDto {
  return {
    id: post.id,
    authorHandle: post.authorHandle,
    authorDisplayName: post.authorDisplayName,
    text: post.text,
    createdAt: post.createdAt.toISOString(),
    isBot: post.isBot,
    inReplyToId: post.inReplyToId,
    metrics: post.metrics
      ? {
          likes: post.metrics.likes,
          replies: post.metrics.replies,
          reposts: post.metrics.reposts,
          views: post.metrics.views,
        }
      : null,
    hasVideo: post.hasVideo,
    jobId: post.jobId,
  };
}

export function systemStatus(store: Store, feed: FeedStatusDto): SystemStatusDto {
  const config = getConfig();
  const revenue = [...store.accounts.values()].find((a) => a.kind === 'revenue');
  const treasury = [...store.accounts.values()].find((a) => a.kind === 'treasury');

  return {
    demoMode: config.isDemoMode,
    network: ARC_TESTNET.name,
    explorerUrl: ARC_TESTNET.explorerUrl,
    capabilities: config.capabilities,
    mocked: config.mockedSubsystems,
    addresses: {
      usdc: USDC_ADDRESS,
      gatewayWallet: GATEWAY_WALLET_ADDRESS,
      revenue: revenue?.walletAddress ?? null,
      treasury: treasury?.walletAddress ?? null,
    },
  };
}
