/**
 * Domain records as the running system holds them.
 *
 * Money is `bigint` micro-dollars and times are `Date`, so the services never
 * touch serialisation concerns. Everything lives in memory (see store.ts): a
 * live demo should not depend on a database container starting. Signed-in users
 * and their wallets are the one thing kept on disk (users/user-db.ts).
 */

import type { DubState, FailureReason, Micros, PlanRole, QcReport } from '@parrot/shared';

export type AccountKind = 'creator' | 'house';

export type LedgerKind =
  /** Test balance given to a demo creator who has no account of their own. */
  | 'demo_credit'
  /** A creator paying for views (negative on the creator, positive on the house). */
  | 'view_charge'
  /** What a dub cost to make (negative on the house). */
  | 'dub_cost'
  /** Aligns a signed-in user's ledger with their real balance. */
  | 'wallet_sync';

export interface Account {
  id: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  walletAddress: string | null;
  createdAt: Date;
}

export interface LedgerEntry {
  id: string;
  accountId: string;
  /** Signed: positive credits, negative debits. */
  amount: Micros;
  kind: LedgerKind;
  ref: string | null;
  createdAt: Date;
}

export interface Creator {
  id: string;
  xUserId: string;
  handle: string;
  displayName: string;
  accountId: string;
  followers: number;
  /** The signed-in user this page belongs to. Null for a demo creator. */
  userId: string | null;
  /** What a view is worth to them, per 1,000 views. Their own number. */
  valuePerThousand: Micros;
  /** True until they set `valuePerThousand` themselves. */
  valueIsDefault: boolean;
  /** The most one post's dubs can cost them. */
  postBudget: Micros;
  /** Dub every new video post without being asked. */
  autoDub: boolean;
  /** The language their videos are in; never a dub target. */
  sourceLang: string;
  /** Set when a charge could not be covered; cleared when one goes through. */
  lowBalance: boolean;
  createdAt: Date;
}

/** One post of a creator's that Parrot dubbed, and the plan it was dubbed under. */
export interface DubbedPost {
  id: string;
  creatorId: string;
  sourcePostId: string;
  sourceUrl: string;
  text: string;
  durationS: number;
  /** Views on the original when it was dubbed. */
  originalViews: number | null;
  mode: 'explore' | 'focus' | 'requested';
  /** The plan's one-line summary at the time. */
  summary: string;
  /** The creator's per-post budget when the dubs were ordered. */
  budget: Micros;
  /** When its results started counting toward the next plan. */
  measuredAt: Date | null;
  demoAudience: 'none' | 'arriving' | 'done';
  createdAt: Date;
}

export interface Dub {
  id: string;
  postId: string;
  creatorId: string;
  lang: string;
  role: PlanRole | 'requested';
  state: DubState;
  /** What it cost to make. Parrot pays this. */
  dubCost: Micros;
  /** True when no real dub was bought: the audio is a stand-in. */
  simulatedDub: boolean;
  providerJobId: string | null;
  /** Local path of the rendered dub. */
  mediaPath: string | null;
  /** The dub as posted in the thread. */
  replyPostId: string | null;
  replyUrl: string | null;
  qcReport: QcReport | null;
  failureReason: FailureReason | null;
  /** Why it did not go live, worded for the creator. */
  problem: string | null;
  /** Views on the dub's post, as the timeline reports them. */
  xViews: number;
  /** Unique viewers on Parrot's own page for the dub. */
  pageViews: number;
  /** Of `xViews`, how many came from the demo audience. */
  simulatedViews: number;
  /** Views already charged for. Never more than xViews + pageViews. */
  billedViews: number;
  /** What the creator has been charged for this dub. */
  paid: Micros;
  likes: number;
  replies: number;
  reposts: number;
  /** Country code -> viewers, from Parrot's page (and the demo audience). */
  countries: Record<string, number>;
  /** Language code -> replies written in it. */
  replyLanguages: Record<string, number>;
  /** Demo: fail this dub at the quality check on purpose, and say so. */
  qcDemoFail: boolean;
  createdAt: Date;
  publishedAt: Date | null;
}

export type ChargeStatus = 'pending' | 'confirmed' | 'failed';

export interface ChargeLine {
  dubId: string;
  lang: string;
  views: number;
  amount: Micros;
}

/** One payment from a creator for a batch of views across their dubs. */
export interface Charge {
  id: string;
  creatorId: string;
  amount: Micros;
  views: number;
  lines: ChargeLine[];
  status: ChargeStatus;
  /** Set only for a payment that was really sent and confirmed. */
  txHash: string | null;
  /** True when no real money moved (a demo balance). */
  testMode: boolean;
  /** True when some of the views came from the demo audience. */
  simulatedViews: boolean;
  error: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface BotPost {
  id: string;
  authorHandle: string;
  authorDisplayName: string;
  authorXUserId: string;
  text: string;
  createdAt: Date;
  isBot: boolean;
  inReplyToId: string | null;
  parentAuthorXUserId: string | null;
  metrics: {
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    views: number | null;
  } | null;
  hasVideo: boolean;
  videoDurationS: number | null;
  /**
   * Local path of the media behind the post: an uploaded source clip, or a
   * rendered dub. Absent on the seeded demo posts, which have a duration but
   * no media behind them.
   */
  videoPath?: string | null;
  /** The dub this post carries, when it is one of Parrot's dub posts. */
  dubId: string | null;
  /** False when this is a mock post rather than a real one from X. */
  posted: boolean;
}

/**
 * A post on real x.com, as the browser extension read it off the page.
 *
 * There is no X API behind this (see bot/x-adapter.ts), so the page is the
 * only source - and every field here is UNVERIFIED: whoever is looking at the
 * page can edit it. It is labelled as such wherever it is shown.
 */
export interface ObservedPost {
  postId: string;
  authorHandle: string;
  authorDisplayName: string;
  text: string;
  metrics: { likes: number; replies: number; reposts: number; views: number | null };
  /** Null when the page did not reveal the length. */
  durationS: number | null;
  createdAt: Date | null;
  observedAt: Date;
  /** Set while a dub request for this post is being worked on. */
  pendingSince: Date | null;
  /** Parrot's last answer, worded as the bot would have replied. */
  lastAnswer: { text: string; at: Date } | null;
}

export interface ProcessedMention {
  mentionId: string;
  postId: string | null;
  outcome: string;
  processedAt: Date;
}
