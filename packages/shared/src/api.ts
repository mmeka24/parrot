/**
 * THE API CONTRACT between apps/web and apps/backend.
 *
 * This file is the single source of truth for every payload crossing that
 * boundary. The web app imports these types and never invents a shape; the
 * backend's route handlers are typed against them.
 *
 * Money rule for the wire: amounts cross as BOTH an integer string of micros
 * (authoritative, for any arithmetic) and a pre-formatted display string
 * (what the UI renders). The UI must never do money arithmetic itself, and
 * must never parse the micros string into a Number.
 */

import type { JobState } from './state-machine.js';
import type { Category } from './constants.js';

/** Money as it appears on the wire. */
export interface MoneyDto {
  /** Integer micro-dollars as a string. Authoritative. */
  readonly micros: string;
  /** Pre-formatted for display, e.g. "$0.02" or "$0.008". */
  readonly display: string;
}

/** A plain-language receipt line. The UI never shows a raw hash. */
export interface ReceiptDto {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly amount: MoneyDto;
  readonly at: string;
  readonly status: 'pending' | 'confirmed' | 'failed';
  /** Present only once confirmed on-chain. Rendered as a small secondary link. */
  readonly verifyUrl: string | null;
  /** True when this movement was simulated rather than broadcast. */
  readonly simulated: boolean;
}

// ---------------------------------------------------------------------------
// GET /api/dubs/:id  - the viewer's dub page
// ---------------------------------------------------------------------------

export interface DubPageDto {
  readonly jobId: string;
  readonly state: JobState;
  readonly targetLang: string;
  readonly targetLanguageName: string;
  readonly sourceLanguageName: string | null;
  readonly creator: {
    readonly handle: string;
    readonly displayName: string;
  };
  readonly sourceUrl: string;
  readonly durationS: number;
  /** Poster image for the player. */
  readonly posterUrl: string | null;
  /** Always available: the free preview. */
  readonly previewUrl: string | null;
  /** Only present once this viewer has unlocked. */
  readonly fullUrl: string | null;
  readonly previewSeconds: number;
  readonly price: MoneyDto;
  readonly unlocked: boolean;
  readonly unlockCount: number;
  readonly viewCount: number;
  /** The viewer's remaining test-mode credit, if they have an account. */
  readonly viewerBalance: MoneyDto | null;
  readonly receipts: readonly ReceiptDto[];
  readonly simulated: boolean;
}

// ---------------------------------------------------------------------------
// POST /api/dubs/:id/unlock
// ---------------------------------------------------------------------------

export interface UnlockResponseDto {
  readonly ok: true;
  readonly fullUrl: string;
  readonly viewerBalance: MoneyDto;
  readonly receipt: ReceiptDto;
}

export type UnlockErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'PAYMENT_FAILED'
  | 'NOT_PUBLISHED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED';

export interface ApiErrorDto {
  readonly ok: false;
  readonly code: UnlockErrorCode | 'INTERNAL' | 'BAD_REQUEST' | 'NOT_FOUND';
  /** Already human-readable and free of forbidden vocabulary. */
  readonly title: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// GET /api/creators/:handle - the creator dashboard
// ---------------------------------------------------------------------------

export interface CreatorDubRowDto {
  readonly jobId: string;
  readonly targetLanguageName: string;
  readonly state: JobState;
  readonly statusLabel: string;
  readonly views: number;
  readonly unlocks: number;
  readonly earned: MoneyDto;
  readonly publishedAt: string | null;
  readonly dubPath: string;
}

export interface CreatorDashboardDto {
  readonly handle: string;
  readonly displayName: string;
  readonly signedIn: boolean;
  readonly totalEarned: MoneyDto;
  readonly readyToClaim: MoneyDto;
  readonly paidOut: MoneyDto;
  readonly creatorSharePercent: string;
  readonly dubs: readonly CreatorDubRowDto[];
  readonly receipts: readonly ReceiptDto[];
}

// ---------------------------------------------------------------------------
// GET /api/agents - the P&L dashboard (the demo hero)
// ---------------------------------------------------------------------------

export interface EvMathDto {
  readonly predictedViews: number;
  readonly conversionPercent: string;
  readonly pSuccessPercent: string;
  readonly rPerView: MoneyDto;
  readonly agentTakePerUnlock: MoneyDto;
  readonly unlockPrice: MoneyDto;
  readonly agentSharePercent: string;
  readonly expectedRevenue: MoneyDto;
  readonly dubCost: MoneyDto;
  readonly ev: MoneyDto;
  readonly minMargin: MoneyDto;
  readonly confidencePercent: string;
  readonly basis: 'bucket' | 'cold_start';
}

export interface DecisionLogEntryDto {
  readonly jobId: string;
  readonly agentName: string;
  readonly decision: 'APPROVE' | 'DECLINE';
  /**
   * Whether this agent actually got the job.
   *
   * Several agents can approve the same job; only the first to win the atomic
   * claim pays for it. Without this flag the log reads as though every
   * approver dubbed the video, which is wrong and makes the P&L look
   * inconsistent with the reasoning next to it.
   */
  readonly won: boolean;
  /** The agent that actually claimed it, for context on a losing bid. */
  readonly claimedByAgentName: string | null;
  readonly declineReason: string | null;
  /** One or two sentences a non-technical person can read. */
  readonly rationale: string;
  readonly math: EvMathDto;
  readonly decidedAt: string;
  readonly creatorHandle: string;
  readonly targetLanguageName: string;
}

export interface AgentJobRowDto {
  readonly jobId: string;
  readonly creatorHandle: string;
  readonly targetLanguageName: string;
  readonly state: JobState;
  readonly statusLabel: string;
  readonly cost: MoneyDto;
  readonly revenue: MoneyDto;
  readonly profit: MoneyDto;
  /** Null when nothing was spent. */
  readonly roiPercent: string | null;
  readonly unlocks: number;
  readonly qcPassed: boolean | null;
}

export interface AgentSummaryDto {
  readonly id: string;
  readonly name: string;
  readonly persona: string;
  readonly balance: MoneyDto;
  readonly lifetimeSpend: MoneyDto;
  readonly lifetimeRevenue: MoneyDto;
  readonly profit: MoneyDto;
  readonly roiPercent: string | null;
  readonly jobsWon: number;
  readonly jobsDeclined: number;
  readonly qcPassRate: string;
  /** Mean absolute percentage error of its view predictions. */
  readonly predictionErrorPercent: string | null;
  readonly walletAddress: string | null;
  readonly verifyUrl: string | null;
}

export interface AccuracyPointDto {
  readonly at: string;
  readonly predicted: number;
  readonly actual: number;
  readonly errorPercent: number;
  readonly simulated: boolean;
}

export interface TickerEntryDto {
  readonly id: string;
  readonly kind: 'unlock' | 'settlement' | 'decision' | 'qc' | 'dub';
  readonly text: string;
  readonly amount: MoneyDto | null;
  readonly at: string;
  readonly verifyUrl: string | null;
  readonly simulated: boolean;
}

export interface AgentDashboardDto {
  readonly agents: readonly AgentSummaryDto[];
  readonly jobs: readonly AgentJobRowDto[];
  readonly decisions: readonly DecisionLogEntryDto[];
  readonly ticker: readonly TickerEntryDto[];
  readonly accuracy: readonly AccuracyPointDto[];
  readonly totals: {
    readonly balance: MoneyDto;
    readonly spend: MoneyDto;
    readonly revenue: MoneyDto;
    readonly profit: MoneyDto;
    readonly unlocks: number;
    readonly dubsPublished: number;
    readonly dubsRejected: number;
  };
  readonly feed: FeedStatusDto;
}

export interface FeedStatusDto {
  readonly live: boolean;
  readonly source: 'quicknode_stream' | 'rpc_polling' | 'simulated';
  readonly latestBlock: string | null;
  readonly lastEventAt: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/system - honesty surface, rendered as "test mode" badges
// ---------------------------------------------------------------------------

export interface SystemStatusDto {
  readonly demoMode: boolean;
  readonly network: string;
  readonly explorerUrl: string;
  readonly capabilities: {
    readonly onchainSettlement: boolean;
    readonly x402Payments: boolean;
    readonly dubbing: boolean;
    readonly qcLanguageDetection: boolean;
    readonly xApi: boolean;
    readonly grokParsing: boolean;
    readonly quicknodeStream: boolean;
  };
  /** Plain-language list of what is simulated right now. */
  readonly mocked: readonly string[];
  readonly addresses: {
    readonly usdc: string;
    readonly gatewayWallet: string;
    readonly revenue: string | null;
    readonly treasury: string | null;
  };
}

// ---------------------------------------------------------------------------
// Bot console (the mock X adapter)
// ---------------------------------------------------------------------------

export interface BotPostDto {
  readonly id: string;
  readonly authorHandle: string;
  readonly authorDisplayName: string;
  readonly text: string;
  readonly createdAt: string;
  readonly isBot: boolean;
  readonly inReplyToId: string | null;
  readonly metrics: {
    readonly likes: number;
    readonly replies: number;
    readonly reposts: number;
    readonly views: number | null;
  } | null;
  readonly hasVideo: boolean;
  readonly jobId: string | null;
}

export interface BotConsoleDto {
  readonly posts: readonly BotPostDto[];
  readonly live: boolean;
  /** True when these are mock posts rather than real X data. */
  readonly simulated: boolean;
}

export interface InjectMentionRequestDto {
  readonly text: string;
  readonly authorHandle?: string;
  readonly parentPostId?: string;
}

// ---------------------------------------------------------------------------
// The local X stand-in (apps/x-clone)  -  /api/x/*
//
// These routes are the stand-in's OWN backend, hosted in the Parrot process for
// convenience. Parrot's bot reads the same posts through its XAdapter; the
// browser extension never calls anything under /api/x.
// ---------------------------------------------------------------------------

export interface XUserDto {
  readonly handle: string;
  readonly displayName: string;
  readonly followers: number;
  readonly isBot: boolean;
}

export interface XPostDto {
  readonly id: string;
  readonly author: XUserDto;
  readonly text: string;
  readonly createdAt: string;
  readonly inReplyToId: string | null;
  /** Handle of the post being replied to, for "Replying to @x". */
  readonly inReplyToHandle: string | null;
  readonly metrics: {
    readonly likes: number;
    readonly replies: number;
    readonly reposts: number;
    readonly views: number | null;
  };
  readonly video: {
    readonly durationS: number;
    /** Null for the seeded demo posts, which have no media behind them. */
    readonly url: string | null;
  } | null;
}

export interface XTimelineDto {
  readonly users: readonly XUserDto[];
  /** Top-level posts, newest first. */
  readonly posts: readonly XPostDto[];
  readonly botHandle: string;
}

export interface XThreadDto {
  readonly post: XPostDto;
  /** The chain of posts above this one, oldest first. Empty for a top-level post. */
  readonly ancestors: readonly XPostDto[];
  /** Everything below this post, oldest first. */
  readonly replies: readonly XPostDto[];
}

export interface XCreatePostRequestDto {
  readonly text: string;
  readonly authorHandle: string;
  readonly inReplyToId?: string | null;
  readonly video?: { readonly mediaId: string; readonly durationS: number } | null;
}

export interface XMediaUploadDto {
  readonly mediaId: string;
  readonly url: string;
}

export interface XEngageRequestDto {
  readonly kind: 'like' | 'repost';
  /** +1 to add, -1 to undo. */
  readonly delta: 1 | -1;
}

// ---------------------------------------------------------------------------
// The browser extension  -  /api/extension/*
//
// The extension is UI only. It sends post IDS it found in the page and renders
// what comes back; it is never a source of truth. Authorship, engagement and
// the video itself are always resolved by the backend through its XAdapter,
// because anything scraped from a page can be forged by the person viewing it.
// ---------------------------------------------------------------------------

export interface ExtensionConfigDto {
  readonly botHandle: string;
  /** e.g. "@{handle} dub this to {language}" - what the extension types for you. */
  readonly requestTemplate: string;
  readonly languages: readonly { readonly code: string; readonly englishName: string }[];
  readonly unlockPrice: MoneyDto;
  /** The creator's share of each unlock, as a whole percentage. */
  readonly creatorPercent: number;
  readonly webUrl: string;
  /** Plain-language list of what is simulated right now, as in SystemStatusDto. */
  readonly simulated: readonly string[];
}

export interface ExtensionDubDto {
  readonly jobId: string;
  readonly languageCode: string;
  readonly languageName: string;
  readonly state: JobState;
  readonly statusLabel: string;
  /** True once a viewer can actually watch it. */
  readonly watchable: boolean;
  /** Present only when watchable. */
  readonly watchUrl: string | null;
}

export interface ExtensionPostStatusDto {
  readonly postId: string;
  /** False when the backend cannot resolve this post; the extension then stays silent. */
  readonly known: boolean;
  readonly hasVideo: boolean;
  readonly authorHandle: string | null;
  readonly dubs: readonly ExtensionDubDto[];
  /** A request under this post is being worked on right now. */
  readonly pending: boolean;
  /** Parrot's most recent answer under this post, in its own words. */
  readonly lastReply: { readonly text: string; readonly at: string } | null;
  /**
   * Where Parrot's picture of this post came from: its own records ('server'),
   * or numbers read off a real x.com page that it cannot check ('page').
   */
  readonly source: 'server' | 'page';
}

/**
 * A real x.com post as the extension read it. On x.com there is no X API, so
 * this is the only source - unverified, and labelled so wherever it is shown.
 */
export interface ExtensionObservedPostDto {
  readonly postId: string;
  readonly authorHandle: string;
  readonly authorDisplayName: string;
  readonly text: string;
  readonly metrics: {
    readonly likes: number;
    readonly replies: number;
    readonly reposts: number;
    readonly views: number | null;
  };
  readonly durationS: number | null;
  readonly createdAt: string | null;
}

export interface ExtensionObserveRequestDto {
  readonly posts: readonly ExtensionObservedPostDto[];
}

/** POST /api/extension/request - x.com only, where no bot reads replies. */
export interface ExtensionDubRequestDto {
  readonly postId: string;
  readonly languageCode: string;
  /** The signed-in handle, as the page shows it. */
  readonly requesterHandle: string;
}

export interface ExtensionDubAcceptedDto {
  readonly ok: true;
}

export interface ExtensionStatusResponseDto {
  readonly posts: readonly ExtensionPostStatusDto[];
}

// ---------------------------------------------------------------------------
// Demo controls
// ---------------------------------------------------------------------------

export interface DemoStateDto {
  readonly seeded: boolean;
  readonly trafficRunning: boolean;
  readonly ratePerMinute: number;
  readonly compressedLearning: boolean;
}

// ---------------------------------------------------------------------------
// SSE event envelope (GET /api/stream)
// ---------------------------------------------------------------------------

export type ServerEventDto =
  | { readonly type: 'ticker'; readonly entry: TickerEntryDto }
  | { readonly type: 'agents'; readonly dashboard: AgentDashboardDto }
  | { readonly type: 'job'; readonly jobId: string; readonly state: JobState }
  | { readonly type: 'feed'; readonly status: FeedStatusDto }
  | { readonly type: 'bot'; readonly post: BotPostDto }
  | { readonly type: 'heartbeat'; readonly at: string };

/** Shape of a job as the dashboards list it. */
export interface JobSummaryDto {
  readonly jobId: string;
  readonly creatorHandle: string;
  readonly targetLanguageName: string;
  readonly category: Category;
  readonly state: JobState;
  readonly statusLabel: string;
  readonly createdAt: string;
}
