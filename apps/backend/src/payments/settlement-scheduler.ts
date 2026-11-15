/**
 * The settlement scheduler: the thing that turns batched unlocks into money
 * in somebody's wallet.
 *
 * WHY THIS EXISTS AT ALL. A viewer unlock is an x402 payment settled by Circle
 * Gateway in a BATCH. Gateway accepting an authorization credits OUR Gateway
 * balance (pending -> available); it does not pay the agent or the creator, and
 * it does not put USDC in our wallet. Two separate steps are needed:
 *
 *   1. `withdrawFromGateway()` - Gateway balance -> real on-chain USDC in the
 *      revenue wallet. Same-chain, instant. THIS IS THE STEP THAT TURNS
 *      BATCHED UNLOCKS INTO REAL MONEY.
 *   2. `runOnce()` - sweep the ledger, work out what each agent and creator is
 *      owed for each job, and once a job owes more than SETTLEMENT_THRESHOLD in
 *      total, hand each side's amount to `PaymentService.settle()`, which does
 *      the audited on-chain transfer.
 *
 * SAFETY PROPERTIES, each one deliberate:
 *
 *  - NEVER OVER-PAYS. `owed` is computed as (everything this account has ever
 *    earned on this job) minus (everything we have already CONFIRMED paying it
 *    for this job). It is never "sum of some rows I happened to pick up", so a
 *    partial failure, a crash or a double run cannot pay the same cent twice.
 *    Everything paid is bounded above by what the ledger says was earned.
 *  - IDEMPOTENT. Each payout carries `PaymentService.settlementKey(job,
 *    account, sequence)`; PaymentService refuses to broadcast twice for one
 *    key. The sequence is derived from the settlement rows already on the job,
 *    so a retry after a FAILED attempt gets a fresh key (a failed key stays
 *    claimed forever) while a repeat of a SUCCESSFUL run finds owed == 0 and
 *    does nothing at all.
 *  - SAFE AGAINST ITSELF. An in-flight flag means a slow run overlapping its
 *    own timer returns the running promise instead of starting a second sweep.
 *  - MARKS UNLOCKS SETTLED EXACTLY ONCE, and only once BOTH legs of the job
 *    (agent and creator) are fully paid. A half-paid job stays open.
 */

import {
  SETTLEMENT_THRESHOLD,
  SETTLEMENT_INTERVAL_MS,
  DEMO_SETTLEMENT_INTERVAL_MS,
  GATEWAY_CHAIN_NAME,
  micros,
  formatUsd,
  type Micros,
} from '@parrot/shared';
import { getConfig, type Config } from '../config.js';
import type { Store } from '../store/store.js';
import type { LedgerKind, Settlement, Unlock } from '../store/types.js';
import { PaymentService } from '../services/payment-service.js';
import { microsToDecimalString, type GatewayClientLike } from './x402-buyer.js';

type Hex = `0x${string}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One payable side of a job: the agent that produced it, or the creator. */
export interface SettlementLeg {
  readonly jobId: string;
  readonly accountId: string;
  readonly role: 'agent' | 'creator';
  readonly kind: LedgerKind;
  /** Everything this account has ever earned on this job, from the ledger. */
  readonly earned: Micros;
  /** Everything we have CONFIRMED paying it for this job. */
  readonly paid: Micros;
  /** earned - paid. Never negative. */
  readonly owed: Micros;
}

export interface SettlementRunResult {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  /** Set when a concurrent run was already in flight and this call joined it. */
  readonly reentered: boolean;
  readonly jobsConsidered: number;
  readonly legsConsidered: number;
  /** Legs owed something on a job whose TOTAL was under SETTLEMENT_THRESHOLD. */
  readonly legsBelowThreshold: number;
  readonly settlements: readonly Settlement[];
  readonly totalPaid: Micros;
  readonly unlocksMarkedSettled: number;
  readonly errors: readonly string[];
}

export interface GatewayWithdrawalResult {
  readonly simulated: boolean;
  readonly amount: Micros;
  /** The mint tx on Arc. Null in simulated mode - we never invent one. */
  readonly txHash: string | null;
  readonly recipient: string | null;
}

export interface SettlementSchedulerOptions {
  readonly store: Store;
  readonly payments: PaymentService;
  readonly config?: Config;
  /** Overrides the demo/normal cadence. Mostly for tests. */
  readonly intervalMs?: number;
  /** Inject a fake Gateway client; also forces `withdrawFromGateway` live. */
  readonly gatewayFactory?: () => Promise<GatewayClientLike>;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------

export class SettlementScheduler {
  private readonly store: Store;
  private readonly payments: PaymentService;
  private readonly cfg: Config;
  private readonly gatewayFactory: (() => Promise<GatewayClientLike>) | undefined;
  private readonly now: () => Date;
  private readonly onError: ((error: unknown) => void) | undefined;

  private timer: ReturnType<typeof setInterval> | undefined;
  /** The in-flight guard. Non-undefined means a sweep is running right now. */
  private inFlight: Promise<SettlementRunResult> | undefined;
  private gatewayPromise: Promise<GatewayClientLike> | undefined;

  readonly intervalMs: number;

  constructor(options: SettlementSchedulerOptions) {
    this.store = options.store;
    this.payments = options.payments;
    this.cfg = options.config ?? getConfig();
    this.gatewayFactory = options.gatewayFactory;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
    this.intervalMs =
      options.intervalMs ??
      (this.cfg.isDemoMode ? DEMO_SETTLEMENT_INTERVAL_MS : SETTLEMENT_INTERVAL_MS);
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Start the periodic sweep. Idempotent: starting twice is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => this.report(error));
    }, this.intervalMs);
    // Never hold the process open for a settlement timer.
    this.timer.unref?.();
  }

  /** Stop the periodic sweep. Does not wait for an in-flight run. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stop, then wait for any in-flight sweep to finish. */
  async drain(): Promise<void> {
    this.stop();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * One pass over everything unsettled. Exposed so tests (and the demo script)
   * can drive settlement deterministically rather than waiting on a timer.
   *
   * Concurrency: if a sweep is already running, this JOINS it rather than
   * starting a second one, and the result is flagged `reentered`.
   */
  async runOnce(): Promise<SettlementRunResult> {
    if (this.inFlight) {
      const joined = await this.inFlight;
      return { ...joined, reentered: true };
    }
    const run = this.sweep();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async sweep(): Promise<SettlementRunResult> {
    const startedAt = this.now();
    const settlements: Settlement[] = [];
    const errors: string[] = [];
    let totalPaidRaw = 0n;
    let legsConsidered = 0;
    let legsBelowThreshold = 0;
    let unlocksMarkedSettled = 0;

    const jobIds = this.jobsWithUnsettledUnlocks();

    for (const jobId of jobIds) {
      let legs: SettlementLeg[];
      try {
        legs = this.legsForJob(jobId);
      } catch (error: unknown) {
        errors.push(describe(error));
        continue;
      }
      legsConsidered += legs.length;

      // THE THRESHOLD IS PER JOB, NOT PER LEG. Amounts are still aggregated per
      // (job, recipient) - that is what each payout is - but the decision to
      // pay at all is made on the job's TOTAL outstanding.
      //
      // Why: the two legs of a job cross a per-leg threshold at different
      // unlock counts (at 40/60 the creator crosses $0.10 at 9 unlocks, the
      // agent at 13). Gating each leg separately lets them leapfrog forever, so
      // a job never reaches "both sides fully paid" and its unlocks could never
      // be closed out. Gating on the job total keeps the economic intent of
      // SETTLEMENT_THRESHOLD - no transfer for less than $0.10 of revenue - and
      // always leaves the job reachable from open to settled.
      const jobOwed = legs.reduce((total, leg) => total + (leg.owed as bigint), 0n);
      if (jobOwed > 0n && jobOwed < (SETTLEMENT_THRESHOLD as bigint)) {
        legsBelowThreshold += legs.filter((leg) => (leg.owed as bigint) > 0n).length;
        continue;
      }

      for (const leg of legs) {
        if ((leg.owed as bigint) <= 0n) continue;
        try {
          const settlement = await this.settleLeg(leg);
          settlements.push(settlement);
          if (settlement.status === 'confirmed') {
            totalPaidRaw += settlement.amount as bigint;
          } else if (settlement.status === 'failed') {
            errors.push(
              `job ${leg.jobId} ${leg.role} payout of ${formatUsd(leg.owed)} failed: ` +
                `${settlement.error ?? 'unknown error'}`,
            );
          }
        } catch (error: unknown) {
          errors.push(describe(error));
        }
      }

      // Re-derive owed AFTER the payouts. Only when nothing at all is
      // outstanding on either side does the job's backlog of unlocks close.
      try {
        const after = this.legsForJob(jobId);
        if (after.every((leg) => (leg.owed as bigint) <= 0n)) {
          unlocksMarkedSettled += this.markUnlocksSettled(jobId);
        }
      } catch (error: unknown) {
        errors.push(describe(error));
      }
    }

    return {
      startedAt,
      finishedAt: this.now(),
      reentered: false,
      jobsConsidered: jobIds.length,
      legsConsidered,
      legsBelowThreshold,
      settlements,
      totalPaid: micros(totalPaidRaw),
      unlocksMarkedSettled,
      errors,
    };
  }

  // -------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------

  /** Jobs that still have at least one unlock we have not closed out. */
  private jobsWithUnsettledUnlocks(): string[] {
    const ids = new Set<string>();
    for (const unlock of this.store.allUnlocks()) {
      if (unlock.settledAt === null) ids.add(unlock.jobId);
    }
    return [...ids];
  }

  /**
   * What each side of one job is owed right now.
   *
   * Both halves come from durable state - the unlock rows and the settlement
   * rows - never from whatever this particular run happened to look at. That is
   * what makes a repeat run a no-op instead of a second payout.
   */
  legsForJob(jobId: string): SettlementLeg[] {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`settlement sweep: unknown job ${jobId}`);

    const unlocks = this.store.unlocksForJob(jobId);
    let agentEarned = 0n;
    let creatorEarned = 0n;
    for (const unlock of unlocks) {
      agentEarned += unlock.agentShare as bigint;
      creatorEarned += unlock.creatorShare as bigint;
    }

    const legs: SettlementLeg[] = [];

    const agentAccountId = job.claimedByAgentId
      ? this.store.agents.get(job.claimedByAgentId)?.accountId
      : undefined;
    if (agentAccountId !== undefined && agentEarned > 0n) {
      legs.push(this.buildLeg(jobId, agentAccountId, 'agent', 'agent_share', micros(agentEarned)));
    }

    const creatorAccountId = this.store.creators.get(job.creatorId)?.accountId;
    if (creatorAccountId !== undefined && creatorEarned > 0n) {
      legs.push(
        this.buildLeg(jobId, creatorAccountId, 'creator', 'creator_share', micros(creatorEarned)),
      );
    }

    return legs;
  }

  private buildLeg(
    jobId: string,
    accountId: string,
    role: 'agent' | 'creator',
    kind: LedgerKind,
    earned: Micros,
  ): SettlementLeg {
    const paidRaw = this.confirmedPaid(jobId, accountId, kind);
    const owedRaw = (earned as bigint) - paidRaw;
    return {
      jobId,
      accountId,
      role,
      kind,
      earned,
      paid: micros(paidRaw),
      // Clamped: a manual top-up should never make the next sweep negative.
      owed: micros(owedRaw > 0n ? owedRaw : 0n),
    };
  }

  /** Sum of CONFIRMED settlements on this job for this account and kind. */
  private confirmedPaid(jobId: string, accountId: string, kind: LedgerKind): bigint {
    let total = 0n;
    for (const settlement of this.store.settlementsForJob(jobId)) {
      if (settlement.toAccountId !== accountId) continue;
      if (settlement.kind !== kind) continue;
      if (settlement.status !== 'confirmed') continue;
      total += settlement.amount as bigint;
    }
    return total;
  }

  /**
   * How many payout attempts this leg has already made, confirmed or failed.
   *
   * Used as the idempotency sequence. Counting FAILED attempts too is the
   * point: PaymentService keeps a failed key claimed forever, so a retry needs
   * a new sequence or it would silently return the old failure.
   */
  private attemptCount(jobId: string, accountId: string, kind: LedgerKind): number {
    let n = 0;
    for (const settlement of this.store.settlementsForJob(jobId)) {
      if (settlement.toAccountId === accountId && settlement.kind === kind) n++;
    }
    return n;
  }

  private async settleLeg(leg: SettlementLeg): Promise<Settlement> {
    const sequence = this.attemptCount(leg.jobId, leg.accountId, leg.kind);
    const idempotencyKey = PaymentService.settlementKey(leg.jobId, leg.accountId, sequence);
    const revenueKey = this.cfg.env.PARROT_REVENUE_PRIVATE_KEY;
    return this.payments.settle({
      toAccountId: leg.accountId,
      amount: leg.owed,
      kind: leg.kind,
      jobId: leg.jobId,
      idempotencyKey,
      // Undefined without a funded key: settle() then records an honest
      // `simulated: true` row with no transaction hash.
      ...(revenueKey === undefined ? {} : { fromPrivateKey: revenueKey as Hex }),
      // Deliberately NO fromAccountId: recordUnlock already credited these
      // shares to the ledger at unlock time. Crediting again here would
      // manufacture money out of a payout.
    });
  }

  /**
   * Close out a job's unlocks.
   *
   * The Store has no `updateUnlock` (it is append-plus-reference by design, and
   * this file is not allowed to change it), so we stamp the live record. Every
   * accessor returns the same object, so this is the same mutation an
   * `updateUnlock` would perform.
   */
  private markUnlocksSettled(jobId: string): number {
    const at = this.now();
    let marked = 0;
    for (const unlock of this.store.unlocksForJob(jobId)) {
      if (unlock.settledAt !== null) continue;
      (unlock as Unlock).settledAt = at;
      marked++;
    }
    return marked;
  }

  // -------------------------------------------------------------------------
  // Gateway balance -> real USDC
  // -------------------------------------------------------------------------

  /**
   * THE STEP THAT TURNS BATCHED UNLOCKS INTO REAL MONEY.
   *
   * Every accepted x402 unlock credited a Circle Gateway BALANCE, not our
   * wallet. `withdraw()` is what converts that balance into actual on-chain
   * USDC in the revenue wallet - same-chain, so it is instant with no 7-day
   * delay - and only then is there anything for `PaymentService.settle()` to
   * transfer to an agent or a creator. Run it before (or alongside) a sweep
   * whenever the Gateway balance has grown.
   *
   * Batch cadence on Circle's side is undocumented, so treat an unlock as
   * "authorized" until a withdrawal has actually landed.
   */
  async withdrawFromGateway(
    amount: Micros,
    options: { recipient?: string } = {},
  ): Promise<GatewayWithdrawalResult> {
    if ((amount as bigint) <= 0n) {
      throw new RangeError(`refusing to withdraw ${formatUsd(amount)} from Gateway`);
    }

    if (!this.canWithdraw()) {
      // No funded key: say so, and invent nothing.
      return { simulated: true, amount, txHash: null, recipient: null };
    }

    const gateway = await this.gateway();
    const result = await gateway.withdraw(microsToDecimalString(amount), {
      // Same chain on purpose: instant, and no destination gas needed.
      chain: GATEWAY_CHAIN_NAME,
      ...(options.recipient === undefined ? {} : { recipient: options.recipient }),
    });
    return {
      simulated: false,
      amount: micros(result.amount),
      txHash: result.mintTxHash,
      recipient: result.recipient,
    };
  }

  /** Gateway balances for the revenue wallet, or null when not configured. */
  async gatewayBalance(): Promise<Micros | null> {
    if (!this.canWithdraw()) return null;
    const gateway = await this.gateway();
    const balances = await gateway.getBalances();
    return micros(balances.gateway.available);
  }

  private canWithdraw(): boolean {
    if (this.gatewayFactory) return true;
    return (
      this.cfg.capabilities.onchainSettlement &&
      this.cfg.env.PARROT_REVENUE_PRIVATE_KEY !== undefined
    );
  }

  private async gateway(): Promise<GatewayClientLike> {
    this.gatewayPromise ??= this.buildGateway();
    return this.gatewayPromise;
  }

  private async buildGateway(): Promise<GatewayClientLike> {
    if (this.gatewayFactory) return this.gatewayFactory();
    const privateKey = this.cfg.env.PARROT_REVENUE_PRIVATE_KEY;
    if (!privateKey) throw new Error('PARROT_REVENUE_PRIVATE_KEY is not set');
    const { GatewayClient } = await import('@circle-fin/x402-batching/client');
    return new GatewayClient({
      chain: GATEWAY_CHAIN_NAME,
      privateKey: privateKey as Hex,
      rpcUrl: this.cfg.rpcUrl,
      token: 'USDC',
    }) as unknown as GatewayClientLike;
  }

  private report(error: unknown): void {
    if (this.onError) this.onError(error);
    else console.error('[settlement] sweep failed:', describe(error));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Convenience for dashboards: total owed across every open job. */
export function totalOutstanding(scheduler: SettlementScheduler, store: Store): Micros {
  const jobIds = new Set<string>();
  for (const unlock of store.allUnlocks()) {
    if (unlock.settledAt === null) jobIds.add(unlock.jobId);
  }
  let total = 0n;
  for (const jobId of jobIds) {
    for (const leg of scheduler.legsForJob(jobId)) total += leg.owed as bigint;
  }
  return micros(total);
}
