/**
 * THE API CONTRACT between the front ends and apps/backend.
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

import type { DubState } from './state-machine.js';
import type { LanguageStatus, PlanRole } from './language-plan.js';

/** Money as it appears on the wire. */
export interface MoneyDto {
  /** Integer micro-dollars as a string. Authoritative. */
  readonly micros: string;
  /** Pre-formatted, e.g. "$0.02". Render this verbatim. */
  readonly display: string;
}

export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'SIGN_IN_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_PUBLISHED'
  | 'DECLINED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ApiErrorDto {
  readonly ok: false;
  readonly code: ApiErrorCode;
  /** Short, human, no jargon. */
  readonly title: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export interface LanguageRefDto {
  readonly code: string;
  readonly name: string;
  readonly nativeName: string;
  readonly flag: string;
}

/** A share of some total, e.g. a country's share of a dub's viewers. */
export interface ShareDto {
  readonly code: string;
  readonly name: string;
  readonly count: number;
  /** 0-100, whole number. */
  readonly percent: number;
}

/** One language's record for a creator, over every post it was dubbed for. */
export interface LanguageRowDto extends LanguageRefDto {
  readonly status: LanguageStatus;
  readonly statusLabel: string;
  /** Posts it was dubbed for and published on. */
  readonly tries: number;
  readonly views: number;
  readonly avgViews: number;
  /** Average of views / the views a dub needed to pay for itself. 1 = broke even. */
  readonly coverage: number;
  /** What those views are worth at the creator's own rate. */
  readonly value: MoneyDto;
  /** What the creator was charged for them. */
  readonly paid: MoneyDto;
  /** value - paid. */
  readonly net: MoneyDto;
  /** What the dubs cost to make. Parrot paid this, not the creator. */
  readonly dubCost: MoneyDto;
  /** One sentence: why it stands where it does. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// The plan for the next post
// ---------------------------------------------------------------------------

export interface PlanEntryDto extends LanguageRefDto {
  readonly role: PlanRole;
  readonly roleLabel: string;
  readonly reason: string;
}

export interface PlanDto {
  readonly mode: 'explore' | 'focus';
  readonly modeLabel: string;
  readonly summary: string;
  readonly entries: readonly PlanEntryDto[];
  /** Posts measured so far: what the plan is based on. */
  readonly basedOnPosts: number;
}

// ---------------------------------------------------------------------------
// Dubs and posts
// ---------------------------------------------------------------------------

export interface QcCheckDto {
  readonly name: string;
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly statusLabel: string;
  readonly detail: string;
}

export interface DubDto extends LanguageRefDto {
  readonly id: string;
  readonly state: DubState;
  readonly statusLabel: string;
  readonly role: PlanRole | 'requested';
  readonly roleLabel: string;
  /** True when no real dub was bought: the audio is a stand-in. */
  readonly simulatedDub: boolean;
  readonly views: number;
  /** Of `views`, how many came from the demo audience. */
  readonly simulatedViews: number;
  readonly likes: number;
  readonly replies: number;
  readonly reposts: number;
  /** Views this dub needs for what the creator pays to cover what it cost. */
  readonly breakEvenViews: number;
  /** views / breakEvenViews, capped at 1, as 0-100. For a progress bar. */
  readonly breakEvenPercent: number;
  readonly paidForItself: boolean;
  readonly value: MoneyDto;
  readonly paid: MoneyDto;
  readonly net: MoneyDto;
  /** What Parrot paid to make it. */
  readonly dubCost: MoneyDto;
  /** Parrot's page for the dub. Null until it is live. */
  readonly watchPath: string | null;
  /** The dub as posted in the thread. Null until it is live. */
  readonly threadUrl: string | null;
  readonly qc: { readonly passed: boolean; readonly checks: readonly QcCheckDto[] } | null;
  /** Why it did not go live, when it did not. */
  readonly problem: string | null;
  /** Where its viewers were, when known. */
  readonly countries: readonly ShareDto[];
  /** The languages people replied in. */
  readonly replyLanguages: readonly ShareDto[];
}

export interface PostDto {
  readonly id: string;
  readonly text: string;
  readonly postUrl: string;
  readonly createdAt: string;
  readonly durationS: number;
  /** Views on the original post. */
  readonly originalViews: number | null;
  readonly mode: 'explore' | 'focus' | 'requested';
  readonly modeLabel: string;
  /** The plan's one-line summary at the time. */
  readonly summary: string;
  /** Still dubbing or checking at least one language. */
  readonly working: boolean;
  /** Counted toward what Parrot has learned. */
  readonly measured: boolean;
  /** A demo audience has been sent to it. */
  readonly demoAudience: 'none' | 'arriving' | 'done';
  readonly views: number;
  readonly value: MoneyDto;
  readonly paid: MoneyDto;
  readonly net: MoneyDto;
  readonly budget: MoneyDto;
  /** paid / budget as 0-100. */
  readonly budgetPercent: number;
  readonly budgetReached: boolean;
  readonly dubs: readonly DubDto[];
}

/** A video post that has not been dubbed yet. */
export interface UndubbedPostDto {
  readonly postId: string;
  readonly text: string;
  readonly postUrl: string;
  readonly createdAt: string;
  readonly durationS: number;
  readonly views: number | null;
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface PaymentDto {
  readonly id: string;
  readonly at: string;
  readonly title: string;
  readonly detail: string;
  readonly amount: MoneyDto;
  readonly views: number;
  readonly status: 'pending' | 'confirmed' | 'failed';
  readonly statusLabel: string;
  /**
   * Explorer link. Present ONLY for a payment that was really sent and
   * confirmed. The UI offers "Verify on Arc" only when this is set, so it can
   * never offer to verify something that did not happen.
   */
  readonly verifyUrl: string | null;
  /** True when no real money moved (a demo balance). */
  readonly testMode: boolean;
  /** True when some of the views paid for came from the demo audience. */
  readonly simulatedViews: boolean;
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// GET /api/creators/:handle
// ---------------------------------------------------------------------------

export interface CreatorSettingsDto {
  /** What a view is worth to the creator, per 1,000 views. Their own number. */
  readonly valuePerThousand: MoneyDto;
  /** True until the creator sets their own rate. */
  readonly valueIsDefault: boolean;
  /** The most one post's dubs can cost them. */
  readonly postBudget: MoneyDto;
  /** Dub every new video post without being asked. */
  readonly autoDub: boolean;
  /** What a view costs, per 1,000. Set by Parrot, the same for everyone. */
  readonly pricePerThousand: MoneyDto;
}

export interface CreatorDashboardDto {
  readonly handle: string;
  readonly displayName: string;
  /** 'account': a signed-in person's own balance. 'demo': a test balance. */
  readonly balanceKind: 'account' | 'demo';
  /** Null when it could not be read just now. */
  readonly balance: MoneyDto | null;
  /** Owed for views counted but not yet charged. */
  readonly owed: MoneyDto;
  /** The person looking at the page may change settings and start dubs. */
  readonly canEdit: boolean;
  /** This creator page belongs to a signed-in account. */
  readonly claimed: boolean;
  readonly settings: CreatorSettingsDto;
  readonly totals: {
    readonly views: number;
    readonly value: MoneyDto;
    readonly paid: MoneyDto;
    readonly net: MoneyDto;
    readonly postsDubbed: number;
    readonly dubsLive: number;
    readonly languagesTried: number;
    /** What Parrot spent making the dubs, which the creator did not pay. */
    readonly dubCostCovered: MoneyDto;
  };
  readonly nextPlan: PlanDto;
  readonly languages: readonly LanguageRowDto[];
  /** Dubbed posts, newest first. */
  readonly posts: readonly PostDto[];
  /** Video posts not dubbed yet, newest first. */
  readonly undubbed: readonly UndubbedPostDto[];
  readonly payments: readonly PaymentDto[];
  readonly audience: {
    /** Where viewers who opened a dub page were. */
    readonly countries: readonly ShareDto[];
    /** The languages people replied to the dubs in. */
    readonly replyLanguages: readonly ShareDto[];
    /** A short read of the numbers, in plain words. */
    readonly insight: string | null;
    /** Who wrote the insight: "Grok", or "Parrot" for the built-in summary. */
    readonly insightBy: string | null;
  };
  /** Things the creator should know, already worded. */
  readonly warnings: readonly string[];
  /** Demo controls are available on this server. */
  readonly demo: boolean;
}

export interface UpdateSettingsRequestDto {
  /** Dollars, e.g. "8" or "2.50". */
  readonly valuePerThousandUsd?: string;
  readonly postBudgetUsd?: string;
  readonly autoDub?: boolean;
}

/** POST /api/creators/:handle/dub */
export interface StartDubRequestDto {
  readonly postId: string;
  /** Omit to let Parrot choose the languages. */
  readonly languageCode?: string | null;
}

export interface StartDubResponseDto {
  readonly ok: true;
  readonly postId: string;
  readonly languages: readonly LanguageRefDto[];
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// GET /api/dubs/:id   (the public watch page - free, no sign-in)
// ---------------------------------------------------------------------------

export interface DubPageDto extends LanguageRefDto {
  readonly id: string;
  readonly state: DubState;
  readonly statusLabel: string;
  readonly creatorHandle: string;
  readonly creatorDisplayName: string;
  readonly originalText: string;
  readonly originalUrl: string;
  /** Null until the dub is live. */
  readonly mediaUrl: string | null;
  readonly mediaKind: 'video' | 'audio';
  readonly durationS: number;
  readonly simulatedDub: boolean;
  readonly views: number;
  /** The same post in other languages. */
  readonly alsoIn: readonly (LanguageRefDto & { readonly watchPath: string })[];
}

// ---------------------------------------------------------------------------
// GET /api/system
// ---------------------------------------------------------------------------

export interface SystemStatusDto {
  readonly demoMode: boolean;
  /** Plain-language list of what is simulated right now. Empty when all real. */
  readonly simulated: readonly string[];
  /** People can sign in and get their own balance. */
  readonly accounts: boolean;
  readonly pricing: {
    readonly pricePerThousand: MoneyDto;
    readonly defaultValuePerThousand: MoneyDto;
    readonly dubCostPerMinute: MoneyDto;
    readonly defaultPostBudget: MoneyDto;
    readonly exploreLanguages: number;
    readonly explorePosts: number;
    readonly maxWinners: number;
  };
  readonly chain: {
    readonly name: string;
    readonly explorerUrl: string;
    readonly usdcAddress: string;
    /** Where creators' payments go. Null when no key is configured. */
    readonly revenueAddress: string | null;
    readonly revenueAddressUrl: string | null;
  };
  /** Parrot's own side of the deal, across every creator. */
  readonly house: {
    readonly dubsMade: number;
    readonly dubSpend: MoneyDto;
    readonly collected: MoneyDto;
    readonly net: MoneyDto;
  };
  readonly creators: readonly { readonly handle: string; readonly displayName: string }[];
}

// ---------------------------------------------------------------------------
// GET /api/me  (when accounts are on)
// ---------------------------------------------------------------------------

export interface MeDto {
  readonly signedIn: boolean;
  readonly email?: string;
  readonly balance?: MoneyDto | null;
  readonly funding?: 'none' | 'pending' | 'funded' | 'failed';
  readonly address?: string | null;
  /** The name they post under, once connected. */
  readonly creatorHandle?: string | null;
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
  /** Set on a post that carries one of Parrot's dubs. */
  readonly dub: {
    readonly languageCode: string;
    readonly languageName: string;
    readonly nativeName: string;
    readonly flag: string;
    /** True when the audio is a stand-in rather than a real dub. */
    readonly simulated: boolean;
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
  /**
   * Demo only: the reach to give a video post, since a post written a moment
   * ago has no views. Chirp labels it as simulated. Likes, replies and reposts
   * are derived from it, and the demo audience is sized from it.
   */
  readonly simulatedViews?: number | null;
}

export interface XMediaUploadDto {
  readonly mediaId: string;
  readonly url: string;
}

/** POST /api/x/posts/:id/view - the stand-in's own view counter, as X counts views. */
export interface XViewResponseDto {
  readonly views: number;
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
  /** What the creator pays per 1,000 views a dub gets. */
  readonly pricePerThousand: MoneyDto;
  readonly webUrl: string;
  /** Plain-language list of what is simulated right now, as in SystemStatusDto. */
  readonly simulated: readonly string[];
}

export interface ExtensionDubDto {
  readonly jobId: string;
  readonly languageCode: string;
  readonly languageName: string;
  readonly state: DubState;
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

/**
 * GET /api/extension/results?postId=  -  everything the strip under a video
 * shows once it has been dubbed: each language's numbers, what the creator has
 * paid, and what Parrot has learned. Pre-formatted, like every other payload.
 */
export interface ExtensionResultsDto {
  readonly postId: string;
  readonly handle: string;
  readonly modeLabel: string;
  /** One line: why these languages. */
  readonly summary: string;
  /** Still dubbing or checking at least one language. */
  readonly working: boolean;
  readonly measured: boolean;
  readonly demoAudience: 'none' | 'arriving' | 'done';
  /** The demo audience can be sent now (demo servers only). */
  readonly canSendAudience: boolean;
  readonly dubs: readonly {
    readonly code: string;
    readonly name: string;
    readonly flag: string;
    readonly state: DubState;
    readonly statusLabel: string;
    readonly views: number;
    readonly breakEvenViews: number;
    /** 0-100, for a progress bar. */
    readonly breakEvenPercent: number;
    readonly paidForItself: boolean;
    readonly paid: MoneyDto;
    readonly watchUrl: string | null;
    /** Why it did not go live, when it did not. */
    readonly problem: string | null;
    readonly simulatedDub: boolean;
  }[];
  readonly totals: {
    readonly views: number;
    readonly value: MoneyDto;
    readonly paid: MoneyDto;
    readonly net: MoneyDto;
    /** What Parrot spent making these dubs. The creator did not pay it. */
    readonly dubCost: MoneyDto;
    readonly budget: MoneyDto;
  };
  /** What the creator's earlier posts have taught Parrot. */
  readonly learned: {
    readonly basedOnPosts: number;
    readonly nextSummary: string;
    readonly languages: readonly {
      readonly name: string;
      readonly flag: string;
      readonly status: 'untested' | 'testing' | 'winner' | 'dropped';
      readonly statusLabel: string;
      readonly avgViews: number;
    }[];
  };
  readonly dashboardUrl: string;
  /** Views from the demo audience are included in the numbers above. */
  readonly includesSimulated: boolean;
}

export interface ExtensionObserveRequestDto {
  readonly posts: readonly ExtensionObservedPostDto[];
}

/** POST /api/extension/request - x.com only, where no bot reads replies. */
export interface ExtensionDubRequestDto {
  readonly postId: string;
  /** Omit to let Parrot choose the languages. */
  readonly languageCode?: string | null;
  /** The signed-in handle, as the page shows it. */
  readonly requesterHandle: string;
}

export interface ExtensionDubAcceptedDto {
  readonly ok: true;
}

/** POST /api/extension/audience - demo servers only. */
export interface ExtensionAudienceRequestDto {
  readonly postId: string;
  readonly requesterHandle: string;
}

export interface ExtensionStatusResponseDto {
  readonly posts: readonly ExtensionPostStatusDto[];
}

// ---------------------------------------------------------------------------
// SSE event envelope (GET /api/stream)
// ---------------------------------------------------------------------------

export type ServerEventDto =
  /** Something about this creator changed: refetch their dashboard. */
  | { readonly type: 'creator'; readonly handle: string; readonly reason: 'dub' | 'views' | 'payment' | 'settings' }
  | { readonly type: 'heartbeat'; readonly at: string };
