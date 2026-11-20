/**
 * In-memory store. The default driver.
 *
 * Why not Postgres by default: a live demo must not depend on a container
 * starting. The Drizzle schema in db/schema.ts is the production path and
 * mirrors these records exactly; swapping drivers means implementing this same
 * surface against it.
 *
 * Two invariants this file is responsible for:
 *  1. An account's balance is ALWAYS the sum of its ledger rows. There is no
 *     separately-mutated balance field to drift.
 *  2. `claimJob` is atomic. Node is single-threaded between awaits, and this
 *     method contains no await, so the compare-and-set cannot interleave. That
 *     is what makes agent competition fair.
 */

import { randomUUID } from 'node:crypto';
import {
  micros,
  COLD_START_CONVERSION,
  type Micros,
  type Category,
  type JobState,
} from '@parrot/shared';
import type {
  Account,
  Agent,
  BotPost,
  BucketStatsRecord,
  ChainTransfer,
  Creator,
  Job,
  JobEvent,
  LedgerEntry,
  LedgerKind,
  PredictionRecord,
  ObservedPost,
  ProcessedMention,
  Settlement,
  Unlock,
} from './types.js';

export class Store {
  readonly accounts = new Map<string, Account>();
  readonly creators = new Map<string, Creator>();
  readonly agents = new Map<string, Agent>();
  readonly jobs = new Map<string, Job>();
  readonly events: JobEvent[] = [];
  readonly unlocks = new Map<string, Unlock>();
  readonly settlements = new Map<string, Settlement>();
  readonly ledger: LedgerEntry[] = [];
  readonly predictions = new Map<string, PredictionRecord>();
  readonly buckets = new Map<string, BucketStatsRecord>();
  readonly chainTransfers = new Map<string, ChainTransfer>();
  readonly botPosts = new Map<string, BotPost>();
  readonly processedMentions = new Map<string, ProcessedMention>();
  /** Real x.com posts, as the extension read them. Unverified; see ObservedPost. */
  readonly observedPosts = new Map<string, ObservedPost>();

  // -------------------------------------------------------------------------
  // Accounts and balances
  // -------------------------------------------------------------------------

  createAccount(input: Omit<Account, 'id' | 'createdAt'> & { id?: string }): Account {
    const account: Account = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      label: input.label,
      email: input.email ?? null,
      walletAddress: input.walletAddress ?? null,
      createdAt: new Date(),
    };
    this.accounts.set(account.id, account);
    return account;
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  findAccountByWallet(address: string): Account | undefined {
    const needle = address.toLowerCase();
    for (const account of this.accounts.values()) {
      if (account.walletAddress?.toLowerCase() === needle) return account;
    }
    return undefined;
  }

  /** The authoritative balance: the sum of the account's ledger rows. */
  balanceOf(accountId: string): Micros {
    let total = 0n;
    for (const entry of this.ledger) {
      if (entry.accountId === accountId) total += entry.amount as bigint;
    }
    return micros(total);
  }

  /** Append a ledger row. The ONLY way an account's balance changes. */
  appendLedger(input: {
    accountId: string;
    amount: Micros;
    kind: LedgerKind;
    jobId?: string | null;
    ref?: string | null;
  }): LedgerEntry {
    if (!this.accounts.has(input.accountId)) {
      throw new Error(`ledger entry for unknown account ${input.accountId}`);
    }
    const entry: LedgerEntry = {
      id: randomUUID(),
      accountId: input.accountId,
      amount: input.amount,
      kind: input.kind,
      jobId: input.jobId ?? null,
      ref: input.ref ?? null,
      createdAt: new Date(),
    };
    this.ledger.push(entry);
    return entry;
  }

  ledgerFor(accountId: string): LedgerEntry[] {
    return this.ledger.filter((e) => e.accountId === accountId);
  }

  /** True when a row with this (ref, kind) already exists. */
  hasLedgerRef(ref: string, kind: LedgerKind): boolean {
    return this.ledger.some((e) => e.ref === ref && e.kind === kind);
  }

  /**
   * Append a ledger row at most once for a given (ref, kind).
   *
   * Idempotent money movement needs this: `settle()` returns the ORIGINAL
   * settlement when a payout is retried, so any caller that writes its own
   * ledger row afterwards would write it twice and debit the account twice.
   * Routing those writes through here makes the retry a no-op.
   */
  appendLedgerOnce(input: {
    accountId: string;
    amount: Micros;
    kind: LedgerKind;
    jobId?: string | null;
    ref: string;
  }): LedgerEntry | null {
    if (this.hasLedgerRef(input.ref, input.kind)) return null;
    return this.appendLedger(input);
  }

  /** Total debits of a given kind for an account, as a positive number. */
  totalSpend(accountId: string, kind: LedgerKind): Micros {
    let total = 0n;
    for (const entry of this.ledger) {
      if (entry.accountId === accountId && entry.kind === kind && (entry.amount as bigint) < 0n) {
        total += -(entry.amount as bigint);
      }
    }
    return micros(total);
  }

  /** Total credits of a given kind for an account. */
  totalEarned(accountId: string, kinds: readonly LedgerKind[]): Micros {
    let total = 0n;
    for (const entry of this.ledger) {
      if (
        entry.accountId === accountId &&
        kinds.includes(entry.kind) &&
        (entry.amount as bigint) > 0n
      ) {
        total += entry.amount as bigint;
      }
    }
    return micros(total);
  }

  /** What an agent has spent on dubs since the given instant. */
  spentSince(accountId: string, since: Date): Micros {
    let total = 0n;
    for (const entry of this.ledger) {
      if (
        entry.accountId === accountId &&
        entry.kind === 'dub_cost' &&
        entry.createdAt >= since &&
        (entry.amount as bigint) < 0n
      ) {
        total += -(entry.amount as bigint);
      }
    }
    return micros(total);
  }

  // -------------------------------------------------------------------------
  // Creators and agents
  // -------------------------------------------------------------------------

  createCreator(input: Omit<Creator, 'id' | 'createdAt'> & { id?: string }): Creator {
    const creator: Creator = { ...input, id: input.id ?? randomUUID(), createdAt: new Date() };
    this.creators.set(creator.id, creator);
    return creator;
  }

  findCreatorByXUserId(xUserId: string): Creator | undefined {
    for (const creator of this.creators.values()) {
      if (creator.xUserId === xUserId) return creator;
    }
    return undefined;
  }

  findCreatorByHandle(handle: string): Creator | undefined {
    const needle = handle.toLowerCase().replace(/^@/, '');
    for (const creator of this.creators.values()) {
      if (creator.handle.toLowerCase().replace(/^@/, '') === needle) return creator;
    }
    return undefined;
  }

  createAgent(input: Omit<Agent, 'id'> & { id?: string }): Agent {
    const agent: Agent = { ...input, id: input.id ?? randomUUID() };
    this.agents.set(agent.id, agent);
    return agent;
  }

  activeAgents(): Agent[] {
    return [...this.agents.values()].filter((a) => a.active);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  createJob(input: Omit<Job, 'id' | 'createdAt'> & { id?: string }): Job {
    const job: Job = { ...input, id: input.id ?? randomUUID(), createdAt: new Date() };
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  updateJob(id: string, patch: Partial<Job>): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    const updated = { ...job, ...patch, id: job.id };
    this.jobs.set(id, updated);
    return updated;
  }

  /** Enforces the dedupe rule: one dub per (source video, target language). */
  findJobBySourceAndLang(sourcePostId: string, targetLang: string): Job | undefined {
    for (const job of this.jobs.values()) {
      if (job.sourcePostId === sourcePostId && job.targetLang === targetLang) return job;
    }
    return undefined;
  }

  jobsInState(state: JobState): Job[] {
    return [...this.jobs.values()].filter((j) => j.state === state);
  }

  jobsForCreator(creatorId: string): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.creatorId === creatorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  jobsForAgent(agentId: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.claimedByAgentId === agentId);
  }

  allJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Atomically claim a job for an agent. Returns false if someone already has
   * it. Contains no `await`, so under Node's single-threaded model this is a
   * genuine compare-and-set and two agents cannot both win the same job.
   */
  claimJob(jobId: string, agentId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.claimedByAgentId !== null) return false;
    this.jobs.set(jobId, { ...job, claimedByAgentId: agentId, claimedAt: new Date() });
    return true;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  appendEvent(input: Omit<JobEvent, 'id' | 'createdAt'>): JobEvent {
    const event: JobEvent = { ...input, id: randomUUID(), createdAt: new Date() };
    this.events.push(event);
    return event;
  }

  eventsForJob(jobId: string): JobEvent[] {
    return this.events.filter((e) => e.jobId === jobId);
  }

  recentEvents(limit = 50): JobEvent[] {
    return this.events.slice(-limit).reverse();
  }

  // -------------------------------------------------------------------------
  // Unlocks and settlements
  // -------------------------------------------------------------------------

  createUnlock(input: Omit<Unlock, 'id' | 'createdAt'>): Unlock {
    const unlock: Unlock = { ...input, id: randomUUID(), createdAt: new Date() };
    this.unlocks.set(unlock.id, unlock);
    return unlock;
  }

  unlocksForJob(jobId: string): Unlock[] {
    return [...this.unlocks.values()].filter((u) => u.jobId === jobId);
  }

  findUnlock(jobId: string, viewerAccountId: string): Unlock | undefined {
    for (const unlock of this.unlocks.values()) {
      if (unlock.jobId === jobId && unlock.viewerAccountId === viewerAccountId) return unlock;
    }
    return undefined;
  }

  allUnlocks(): Unlock[] {
    return [...this.unlocks.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  unlockCountSince(viewerAccountId: string, since: Date): number {
    let count = 0;
    for (const unlock of this.unlocks.values()) {
      if (unlock.viewerAccountId === viewerAccountId && unlock.createdAt >= since) count++;
    }
    return count;
  }

  createSettlement(input: Omit<Settlement, 'id' | 'createdAt'>): Settlement {
    const settlement: Settlement = { ...input, id: randomUUID(), createdAt: new Date() };
    this.settlements.set(settlement.id, settlement);
    return settlement;
  }

  /** Idempotency lookup. Every payout checks this before spending anything. */
  findSettlementByKey(idempotencyKey: string): Settlement | undefined {
    for (const settlement of this.settlements.values()) {
      if (settlement.idempotencyKey === idempotencyKey) return settlement;
    }
    return undefined;
  }

  updateSettlement(id: string, patch: Partial<Settlement>): Settlement {
    const settlement = this.settlements.get(id);
    if (!settlement) throw new Error(`unknown settlement ${id}`);
    const updated = { ...settlement, ...patch, id: settlement.id };
    this.settlements.set(id, updated);
    return updated;
  }

  allSettlements(): Settlement[] {
    return [...this.settlements.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  settlementsForJob(jobId: string): Settlement[] {
    return [...this.settlements.values()].filter((s) => s.jobId === jobId);
  }

  // -------------------------------------------------------------------------
  // Learning
  // -------------------------------------------------------------------------

  bucketKey(category: Category, lang: string): string {
    return `${category}:${lang}`;
  }

  getBucket(category: Category, lang: string): BucketStatsRecord | undefined {
    return this.buckets.get(this.bucketKey(category, lang));
  }

  upsertBucket(record: BucketStatsRecord): BucketStatsRecord {
    this.buckets.set(this.bucketKey(record.category, record.lang), {
      ...record,
      updatedAt: new Date(),
    });
    return record;
  }

  seedBucketIfMissing(category: Category, lang: string): BucketStatsRecord {
    const existing = this.getBucket(category, lang);
    if (existing) return existing;
    const seeded: BucketStatsRecord = {
      category,
      lang,
      avgViews: 0,
      avgEngagementScore: 0,
      conversionPpm: COLD_START_CONVERSION,
      n: 0,
      updatedAt: new Date(),
    };
    this.buckets.set(this.bucketKey(category, lang), seeded);
    return seeded;
  }

  createPrediction(input: Omit<PredictionRecord, 'id' | 'createdAt'>): PredictionRecord {
    const record: PredictionRecord = { ...input, id: randomUUID(), createdAt: new Date() };
    this.predictions.set(record.jobId, record);
    return record;
  }

  getPrediction(jobId: string): PredictionRecord | undefined {
    return this.predictions.get(jobId);
  }

  updatePrediction(jobId: string, patch: Partial<PredictionRecord>): PredictionRecord {
    const record = this.predictions.get(jobId);
    if (!record) throw new Error(`unknown prediction for job ${jobId}`);
    const updated = { ...record, ...patch };
    this.predictions.set(jobId, updated);
    return updated;
  }

  resolvedPredictions(): PredictionRecord[] {
    return [...this.predictions.values()]
      .filter((p) => p.resolvedAt !== null)
      .sort((a, b) => (a.resolvedAt?.getTime() ?? 0) - (b.resolvedAt?.getTime() ?? 0));
  }

  // -------------------------------------------------------------------------
  // Chain feed
  // -------------------------------------------------------------------------

  /** Returns false when this log was already recorded (QuickNode redelivers). */
  recordChainTransfer(input: Omit<ChainTransfer, 'id' | 'receivedAt'>): boolean {
    const key = `${input.txHash.toLowerCase()}:${input.logIndex}`;
    if (this.chainTransfers.has(key)) return false;
    this.chainTransfers.set(key, { ...input, id: randomUUID(), receivedAt: new Date() });
    return true;
  }

  latestBlock(): bigint | null {
    let latest: bigint | null = null;
    for (const transfer of this.chainTransfers.values()) {
      if (latest === null || transfer.blockNumber > latest) latest = transfer.blockNumber;
    }
    return latest;
  }

  // -------------------------------------------------------------------------
  // Bot
  // -------------------------------------------------------------------------

  createBotPost(input: Omit<BotPost, 'id'> & { id?: string }): BotPost {
    const post: BotPost = { ...input, id: input.id ?? randomUUID() };
    this.botPosts.set(post.id, post);
    return post;
  }

  timeline(limit = 60): BotPost[] {
    return [...this.botPosts.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(-limit);
  }

  markMentionProcessed(mentionId: string, jobId: string | null, outcome: string): void {
    this.processedMentions.set(mentionId, {
      mentionId,
      jobId,
      outcome,
      processedAt: new Date(),
    });
  }

  wasMentionProcessed(mentionId: string): boolean {
    return this.processedMentions.has(mentionId);
  }

  /** Wipe everything. Used by the demo reset and by tests. */
  clear(): void {
    this.accounts.clear();
    this.creators.clear();
    this.agents.clear();
    this.jobs.clear();
    this.events.length = 0;
    this.unlocks.clear();
    this.settlements.clear();
    this.ledger.length = 0;
    this.predictions.clear();
    this.buckets.clear();
    this.chainTransfers.clear();
    this.botPosts.clear();
    this.processedMentions.clear();
    this.observedPosts.clear();
  }
}

let storeInstance: Store | undefined;

export function getStore(): Store {
  storeInstance ??= new Store();
  return storeInstance;
}

export function resetStore(): Store {
  storeInstance = new Store();
  return storeInstance;
}
