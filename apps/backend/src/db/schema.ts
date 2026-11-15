/**
 * Database schema (Drizzle / Postgres).
 *
 * Money is stored as `bigint` micro-dollars, matching packages/shared/units.ts.
 * Postgres bigint tops out around 9.2e18, i.e. ~$9.2 trillion, so there is no
 * overflow risk and no reason to reach for numeric/decimal and its float traps.
 *
 * The ledger is append-only and double-entry-ish: every movement of value gets
 * a row, and an account's balance is the sum of its rows. Cached balances exist
 * only for display and are always reconcilable against the ledger.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  bigint,
  doublePrecision,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { JOB_STATES, JOB_EVENT_TYPES, CATEGORIES } from '@parrot/shared';

export const jobStateEnum = pgEnum('job_state', JOB_STATES);
export const jobEventTypeEnum = pgEnum('job_event_type', JOB_EVENT_TYPES);
export const categoryEnum = pgEnum('category', CATEGORIES);

/** What kind of actor an account represents. */
export const accountKindEnum = pgEnum('account_kind', [
  'viewer',
  'creator',
  'agent',
  'treasury',
  'revenue',
  'cost_sink',
]);

/** Why a ledger row exists. */
export const ledgerKindEnum = pgEnum('ledger_kind', [
  'faucet_funding',
  'starter_credit',
  'unlock_payment',
  'unlock_revenue',
  'agent_share',
  'creator_share',
  'dub_cost',
  'settlement_out',
  'settlement_in',
  'creator_payout',
]);

// ---------------------------------------------------------------------------
// Accounts and identities
// ---------------------------------------------------------------------------

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: accountKindEnum('kind').notNull(),
    /** Display label, e.g. "Magpie" or a creator handle. Never shown as a wallet. */
    label: text('label').notNull(),
    email: text('email'),
    /**
     * On-chain address. Custodial in test mode: the key lives in env or in the
     * server's keystore, never in this table. Nullable because a creator earns
     * before they have ever signed in.
     */
    walletAddress: text('wallet_address'),
    /** Cached balance for display. Authoritative value is sum(ledger.amount). */
    balanceCache: bigint('balance_cache', { mode: 'bigint' }).notNull().default(0n),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: uniqueIndex('accounts_email_idx').on(t.email),
    walletIdx: index('accounts_wallet_idx').on(t.walletAddress),
    kindIdx: index('accounts_kind_idx').on(t.kind),
  }),
);

export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Match key for earnings that accrue before the creator ever signs in. */
    xUserId: text('x_user_id').notNull(),
    handle: text('handle').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    /** True once a human has actually claimed this identity. */
    claimed: boolean('claimed').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    xUserIdx: uniqueIndex('creators_x_user_idx').on(t.xUserId),
  }),
);

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Short description of the risk profile, shown on the leaderboard. */
  persona: text('persona').notNull(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  walletAddress: text('wallet_address').notNull(),
  /** Budget rules, in micros. */
  floor: bigint('floor', { mode: 'bigint' }).notNull(),
  minMargin: bigint('min_margin', { mode: 'bigint' }).notNull(),
  maxExposurePerJob: bigint('max_exposure_per_job', { mode: 'bigint' }).notNull(),
  dailyCap: bigint('daily_cap', { mode: 'bigint' }).notNull(),
  /** Restricts this agent to one language, for the specialist persona. */
  languageFocus: text('language_focus'),
  /** How eagerly this agent bids, as a ppm multiplier on its view estimate. */
  optimismPpm: integer('optimism_ppm').notNull().default(1_000_000),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    creatorId: uuid('creator_id')
      .notNull()
      .references(() => creators.id),
    sourceUrl: text('source_url').notNull(),
    sourcePostId: text('source_post_id').notNull(),
    /** The mention that triggered this job, for replying and for dedupe. */
    requestMentionId: text('request_mention_id'),
    targetLang: text('target_lang').notNull(),
    durationS: doublePrecision('duration_s').notNull(),
    category: categoryEnum('category').notNull().default('other'),
    state: jobStateEnum('state').notNull().default('REQUESTED'),
    /** Set atomically by the first agent to approve; this is the race lock. */
    claimedByAgentId: uuid('claimed_by_agent_id').references(() => agents.id),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    splitAgentBps: integer('split_agent_bps').notNull(),
    splitCreatorBps: integer('split_creator_bps').notNull(),
    /** What the agent paid to produce this dub, in micros. */
    dubCost: bigint('dub_cost', { mode: 'bigint' }).notNull().default(0n),
    decisionJson: jsonb('decision_json'),
    qcReportJson: jsonb('qc_report_json'),
    /** Provider job id, e.g. an ElevenLabs dubbing_id. */
    providerJobId: text('provider_job_id'),
    dubUrl: text('dub_url'),
    previewUrl: text('preview_url'),
    declineReason: text('decline_reason'),
    failureReason: text('failure_reason'),
    /** Engagement snapshot taken at decision time, for the learning loop. */
    signalsJson: jsonb('signals_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    /** One dub per (source video, target language). Enforces the dedupe rule. */
    dedupeIdx: uniqueIndex('jobs_dedupe_idx').on(t.sourcePostId, t.targetLang),
    stateIdx: index('jobs_state_idx').on(t.state),
    creatorIdx: index('jobs_creator_idx').on(t.creatorId),
    agentIdx: index('jobs_agent_idx').on(t.claimedByAgentId),
  }),
);

/** Append-only transition log. Powers the dashboard timeline and bot replies. */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').references(() => jobs.id),
    type: jobEventTypeEnum('type').notNull(),
    fromState: jobStateEnum('from_state'),
    toState: jobStateEnum('to_state'),
    payload: jsonb('payload'),
    txHash: text('tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('events_job_idx').on(t.jobId),
    createdIdx: index('events_created_idx').on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export const unlocks = pgTable(
  'unlocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    viewerAccountId: uuid('viewer_account_id')
      .notNull()
      .references(() => accounts.id),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    agentShare: bigint('agent_share', { mode: 'bigint' }).notNull(),
    creatorShare: bigint('creator_share', { mode: 'bigint' }).notNull(),
    /**
     * x402 payment reference. For Gateway this identifies the batched
     * authorization, NOT a confirmed on-chain transfer - see settlements.
     */
    paymentRef: text('payment_ref'),
    /** True when the payment was simulated rather than taken via x402. */
    simulated: boolean('simulated').notNull().default(false),
    /** Set when the batch containing this unlock became on-chain money. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: index('unlocks_job_idx').on(t.jobId),
    viewerIdx: index('unlocks_viewer_idx').on(t.viewerAccountId),
    /** A viewer pays once per dub; re-watching is free. */
    oncePerViewerIdx: uniqueIndex('unlocks_once_per_viewer_idx').on(t.jobId, t.viewerAccountId),
  }),
);

export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').references(() => jobs.id),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => accounts.id),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    kind: ledgerKindEnum('kind').notNull(),
    txHash: text('tx_hash'),
    /**
     * Every payout is idempotent on this key. A retry with the same key must
     * never produce a second transfer.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('pending'),
    error: text('error'),
    /** True when this settlement was simulated rather than broadcast. */
    simulated: boolean('simulated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => ({
    idempotencyIdx: uniqueIndex('settlements_idempotency_idx').on(t.idempotencyKey),
    jobIdx: index('settlements_job_idx').on(t.jobId),
    txIdx: index('settlements_tx_idx').on(t.txHash),
  }),
);

/** Append-only. An account's true balance is the sum of its rows. */
export const ledger = pgTable(
  'ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Signed: positive credits the account, negative debits it. */
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    kind: ledgerKindEnum('kind').notNull(),
    jobId: uuid('job_id').references(() => jobs.id),
    /** Free-form pointer to the unlock/settlement that caused this row. */
    ref: text('ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index('ledger_account_idx').on(t.accountId),
    jobIdx: index('ledger_job_idx').on(t.jobId),
    refIdx: index('ledger_ref_idx').on(t.ref),
  }),
);

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export const predictions = pgTable(
  'predictions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    category: categoryEnum('category').notNull(),
    lang: text('lang').notNull(),
    predictedViews: integer('predicted_views').notNull(),
    predictedConvPpm: integer('predicted_conv_ppm').notNull(),
    confidencePpm: integer('confidence_ppm').notNull(),
    engagementScore: doublePrecision('engagement_score').notNull(),
    basis: text('basis').notNull(),
    /** Filled in by the learning loop once outcomes are known. */
    actualViews: integer('actual_views'),
    actualUnlocks: integer('actual_unlocks'),
    actualConvPpm: integer('actual_conv_ppm'),
    errorRatio: doublePrecision('error_ratio'),
    /** True when outcomes were simulated rather than observed. */
    simulated: boolean('simulated').notNull().default(false),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    jobIdx: uniqueIndex('predictions_job_idx').on(t.jobId),
  }),
);

export const bucketStats = pgTable(
  'bucket_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: categoryEnum('category').notNull(),
    lang: text('lang').notNull(),
    avgViews: doublePrecision('avg_views').notNull(),
    avgEngagementScore: doublePrecision('avg_engagement_score').notNull(),
    conversionPpm: integer('conversion_ppm').notNull(),
    n: integer('n').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bucketIdx: uniqueIndex('bucket_stats_idx').on(t.category, t.lang),
  }),
);

// ---------------------------------------------------------------------------
// Chain feed
// ---------------------------------------------------------------------------

/** Raw USDC Transfer logs from the QuickNode Stream, deduped. */
export const chainTransfers = pgTable(
  'chain_transfers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    /** 6-decimal ERC-20 units, i.e. micros. See the double-count note in chain.ts. */
    value: bigint('value', { mode: 'bigint' }).notNull(),
    /** Matched against a settlement row, when we recognise it. */
    settlementId: uuid('settlement_id').references(() => settlements.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Dedupe key: QuickNode can redeliver, and retries are expected. */
    dedupeIdx: uniqueIndex('chain_transfers_dedupe_idx').on(t.txHash, t.logIndex),
    blockIdx: index('chain_transfers_block_idx').on(t.blockNumber),
  }),
);

/** Mentions we have already handled, so a redelivery cannot double-dub. */
export const processedMentions = pgTable('processed_mentions', {
  mentionId: text('mention_id').primaryKey(),
  jobId: uuid('job_id').references(() => jobs.id),
  outcome: text('outcome').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Replies the bot has posted (or would have posted, in mock mode). */
export const botReplies = pgTable('bot_replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').references(() => jobs.id),
  inReplyToId: text('in_reply_to_id'),
  text: text('text').notNull(),
  kind: text('kind').notNull(),
  /** False when this was a mock reply rather than a real post. */
  posted: boolean('posted').notNull().default(false),
  externalId: text('external_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
