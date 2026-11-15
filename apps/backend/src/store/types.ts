/**
 * Domain records as the running system holds them.
 *
 * These mirror the Drizzle schema in db/schema.ts but use `bigint` for money
 * and `Date` for times, so the services never touch serialisation concerns.
 * The in-memory store is the default driver (a live demo should not depend on
 * a Postgres container starting); the Drizzle schema is the production path.
 */

import type {
  Category,
  JobState,
  JobEventType,
  DeclineReason,
  FailureReason,
  Micros,
  QcReport,
  Decision,
  EngagementSignals,
} from '@parrot/shared';

export type AccountKind = 'viewer' | 'creator' | 'agent' | 'treasury' | 'revenue' | 'cost_sink';

export type LedgerKind =
  | 'faucet_funding'
  | 'starter_credit'
  | 'unlock_payment'
  | 'unlock_revenue'
  | 'agent_share'
  | 'creator_share'
  | 'dub_cost'
  | 'settlement_out'
  | 'settlement_in'
  | 'creator_payout';

export interface Account {
  id: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  walletAddress: string | null;
  createdAt: Date;
}

export interface Creator {
  id: string;
  xUserId: string;
  handle: string;
  displayName: string;
  accountId: string;
  followers: number;
  claimed: boolean;
  createdAt: Date;
}

export interface Agent {
  id: string;
  name: string;
  persona: string;
  accountId: string;
  walletAddress: string | null;
  floor: Micros;
  minMargin: Micros;
  maxExposurePerJob: Micros;
  dailyCap: Micros;
  /** Restricts this agent to one language, for the specialist persona. */
  languageFocus: string | null;
  /** ppm multiplier applied to its own view estimate; >1e6 is optimistic. */
  optimismPpm: number;
  active: boolean;
}

export interface Job {
  id: string;
  creatorId: string;
  sourceUrl: string;
  sourcePostId: string;
  requestMentionId: string | null;
  targetLang: string;
  durationS: number;
  category: Category;
  state: JobState;
  claimedByAgentId: string | null;
  claimedAt: Date | null;
  splitAgentBps: number;
  splitCreatorBps: number;
  dubCost: Micros;
  decision: Decision | null;
  qcReport: QcReport | null;
  providerJobId: string | null;
  dubUrl: string | null;
  previewUrl: string | null;
  posterUrl: string | null;
  declineReason: DeclineReason | null;
  failureReason: FailureReason | null;
  signals: EngagementSignals | null;
  /** Realised international views. Simulated in demo mode. */
  viewCount: number;
  createdAt: Date;
  publishedAt: Date | null;
}

export interface JobEvent {
  id: string;
  jobId: string | null;
  type: JobEventType;
  fromState: JobState | null;
  toState: JobState | null;
  payload: Record<string, unknown> | null;
  txHash: string | null;
  createdAt: Date;
}

export interface Unlock {
  id: string;
  jobId: string;
  viewerAccountId: string;
  amount: Micros;
  agentShare: Micros;
  creatorShare: Micros;
  paymentRef: string | null;
  simulated: boolean;
  settledAt: Date | null;
  createdAt: Date;
}

export type SettlementStatus = 'pending' | 'confirmed' | 'failed';

export interface Settlement {
  id: string;
  jobId: string | null;
  toAccountId: string;
  amount: Micros;
  kind: LedgerKind;
  txHash: string | null;
  idempotencyKey: string;
  status: SettlementStatus;
  error: string | null;
  simulated: boolean;
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface LedgerEntry {
  id: string;
  accountId: string;
  /** Signed: positive credits, negative debits. */
  amount: Micros;
  kind: LedgerKind;
  jobId: string | null;
  ref: string | null;
  createdAt: Date;
}

export interface PredictionRecord {
  id: string;
  jobId: string;
  category: Category;
  lang: string;
  predictedViews: number;
  predictedConvPpm: number;
  confidencePpm: number;
  engagementScore: number;
  basis: 'bucket' | 'cold_start';
  actualViews: number | null;
  actualUnlocks: number | null;
  actualConvPpm: number | null;
  errorRatio: number | null;
  simulated: boolean;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface BucketStatsRecord {
  category: Category;
  lang: string;
  avgViews: number;
  avgEngagementScore: number;
  conversionPpm: number;
  n: number;
  updatedAt: Date;
}

export interface ChainTransfer {
  id: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  fromAddress: string;
  toAddress: string;
  value: Micros;
  settlementId: string | null;
  receivedAt: Date;
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
  jobId: string | null;
  /** False when this is a mock post rather than a real one from X. */
  posted: boolean;
}

export interface ProcessedMention {
  mentionId: string;
  jobId: string | null;
  outcome: string;
  processedAt: Date;
}
