/**
 * In-memory store.
 *
 * Why not a database: a live demo must not depend on a container starting, and
 * the demo world is rebuilt on every boot anyway. Signed-in users and their
 * wallets are the exception and live on disk (users/user-db.ts).
 *
 * The invariant this file is responsible for: an account's balance is ALWAYS
 * the sum of its ledger rows. There is no separately-mutated balance field to
 * drift.
 */

import { randomUUID } from 'node:crypto';
import { micros, type Micros } from '@parrot/shared';
import type {
  Account,
  BotPost,
  Charge,
  Creator,
  Dub,
  DubbedPost,
  LedgerEntry,
  LedgerKind,
  ObservedPost,
  ProcessedMention,
} from './types.js';

export class Store {
  readonly accounts = new Map<string, Account>();
  readonly ledger: LedgerEntry[] = [];
  readonly creators = new Map<string, Creator>();
  readonly posts = new Map<string, DubbedPost>();
  readonly dubs = new Map<string, Dub>();
  readonly charges = new Map<string, Charge>();
  readonly botPosts = new Map<string, BotPost>();
  readonly processedMentions = new Map<string, ProcessedMention>();
  /** Real x.com posts, as the extension read them. Unverified; see ObservedPost. */
  readonly observedPosts = new Map<string, ObservedPost>();

  // -------------------------------------------------------------------------
  // Accounts and balances
  // -------------------------------------------------------------------------

  createAccount(input: Omit<Account, 'id' | 'createdAt'> & { id?: string }): Account {
    const account: Account = { ...input, id: input.id ?? randomUUID(), createdAt: new Date() };
    this.accounts.set(account.id, account);
    return account;
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  /** The one account that stands for Parrot itself. Created on first use. */
  houseAccount(): Account {
    for (const account of this.accounts.values()) if (account.kind === 'house') return account;
    return this.createAccount({ kind: 'house', label: 'Parrot', email: null, walletAddress: null });
  }

  balanceOf(accountId: string): Micros {
    let total = 0n;
    for (const entry of this.ledger) if (entry.accountId === accountId) total += entry.amount as bigint;
    return micros(total);
  }

  appendLedger(input: { accountId: string; amount: Micros; kind: LedgerKind; ref?: string | null }): LedgerEntry {
    const entry: LedgerEntry = {
      id: randomUUID(),
      accountId: input.accountId,
      amount: input.amount,
      kind: input.kind,
      ref: input.ref ?? null,
      createdAt: new Date(),
    };
    this.ledger.push(entry);
    return entry;
  }

  /** Sum of one kind of entry on an account. Signed, as stored. */
  ledgerTotal(accountId: string, kind: LedgerKind): Micros {
    let total = 0n;
    for (const entry of this.ledger) {
      if (entry.accountId === accountId && entry.kind === kind) total += entry.amount as bigint;
    }
    return micros(total);
  }

  // -------------------------------------------------------------------------
  // Creators
  // -------------------------------------------------------------------------

  createCreator(input: Omit<Creator, 'id' | 'createdAt'> & { id?: string }): Creator {
    const creator: Creator = { ...input, id: input.id ?? randomUUID(), createdAt: new Date() };
    this.creators.set(creator.id, creator);
    return creator;
  }

  updateCreator(id: string, patch: Partial<Creator>): Creator {
    const current = this.creators.get(id);
    if (!current) throw new Error(`unknown creator ${id}`);
    const next = { ...current, ...patch };
    this.creators.set(id, next);
    return next;
  }

  findCreatorByXUserId(xUserId: string): Creator | undefined {
    for (const creator of this.creators.values()) if (creator.xUserId === xUserId) return creator;
    return undefined;
  }

  findCreatorByHandle(handle: string): Creator | undefined {
    const wanted = handle.replace(/^@/, '').toLowerCase();
    for (const creator of this.creators.values()) {
      if (creator.handle.toLowerCase() === wanted) return creator;
    }
    return undefined;
  }

  findCreatorByUserId(userId: string): Creator | undefined {
    for (const creator of this.creators.values()) if (creator.userId === userId) return creator;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Dubbed posts and dubs
  // -------------------------------------------------------------------------

  createPost(input: Omit<DubbedPost, 'id' | 'createdAt'> & { id?: string; createdAt?: Date }): DubbedPost {
    const post: DubbedPost = { ...input, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? new Date() };
    this.posts.set(post.id, post);
    return post;
  }

  updatePost(id: string, patch: Partial<DubbedPost>): DubbedPost {
    const current = this.posts.get(id);
    if (!current) throw new Error(`unknown post ${id}`);
    const next = { ...current, ...patch };
    this.posts.set(id, next);
    return next;
  }

  /** A creator's dubbed posts, oldest first. */
  postsForCreator(creatorId: string): DubbedPost[] {
    return [...this.posts.values()]
      .filter((p) => p.creatorId === creatorId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  findPostBySource(sourcePostId: string): DubbedPost | undefined {
    for (const post of this.posts.values()) if (post.sourcePostId === sourcePostId) return post;
    return undefined;
  }

  createDub(input: Omit<Dub, 'id' | 'createdAt'> & { id?: string }): Dub {
    const dub: Dub = { ...input, id: input.id ?? randomUUID(), createdAt: new Date() };
    this.dubs.set(dub.id, dub);
    return dub;
  }

  getDub(id: string): Dub | undefined {
    return this.dubs.get(id);
  }

  updateDub(id: string, patch: Partial<Dub>): Dub {
    const current = this.dubs.get(id);
    if (!current) throw new Error(`unknown dub ${id}`);
    const next = { ...current, ...patch };
    this.dubs.set(id, next);
    return next;
  }

  /** A post's dubs, in the order they were ordered. */
  dubsForPost(postId: string): Dub[] {
    return [...this.dubs.values()]
      .filter((d) => d.postId === postId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  dubsForCreator(creatorId: string): Dub[] {
    return [...this.dubs.values()].filter((d) => d.creatorId === creatorId);
  }

  /** One dub per (post, language): a repeat request finds the existing one. */
  findDub(postId: string, lang: string): Dub | undefined {
    for (const dub of this.dubs.values()) if (dub.postId === postId && dub.lang === lang) return dub;
    return undefined;
  }

  findDubByReplyPost(replyPostId: string): Dub | undefined {
    for (const dub of this.dubs.values()) if (dub.replyPostId === replyPostId) return dub;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Charges
  // -------------------------------------------------------------------------

  createCharge(input: Omit<Charge, 'id' | 'createdAt'>): Charge {
    const charge: Charge = { ...input, id: randomUUID(), createdAt: new Date() };
    this.charges.set(charge.id, charge);
    return charge;
  }

  updateCharge(id: string, patch: Partial<Charge>): Charge {
    const current = this.charges.get(id);
    if (!current) throw new Error(`unknown charge ${id}`);
    const next = { ...current, ...patch };
    this.charges.set(id, next);
    return next;
  }

  /** A creator's charges, newest first. */
  chargesForCreator(creatorId: string): Charge[] {
    return [...this.charges.values()]
      .filter((c) => c.creatorId === creatorId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // -------------------------------------------------------------------------
  // The timeline (the bot's view of X, and the stand-in's own posts)
  // -------------------------------------------------------------------------

  createBotPost(input: Omit<BotPost, 'id'> & { id?: string }): BotPost {
    const post: BotPost = { ...input, id: input.id ?? randomUUID() };
    this.botPosts.set(post.id, post);
    return post;
  }

  markMentionProcessed(mentionId: string, postId: string | null, outcome: string): void {
    this.processedMentions.set(mentionId, { mentionId, postId, outcome, processedAt: new Date() });
  }

  wasMentionProcessed(mentionId: string): boolean {
    return this.processedMentions.has(mentionId);
  }

  /** Wipe everything. Used by tests. */
  clear(): void {
    this.accounts.clear();
    this.ledger.length = 0;
    this.creators.clear();
    this.posts.clear();
    this.dubs.clear();
    this.charges.clear();
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
