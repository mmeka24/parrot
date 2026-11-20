/**
 * Charging a creator for the views their dubs got.
 *
 * The rule: PRICE_PER_VIEW for each view a dub actually had, never more than
 * the post's budget, never more than the creator can pay. Views are counted
 * continuously; money moves in batches, one payment per creator per sweep, so
 * a busy post is one payment on Arc rather than thousands.
 *
 * Two ways a creator pays, behind one `Payer`:
 *   - A signed-in creator pays from their own balance: a real USDC transfer on
 *     Arc from their wallet to Parrot's, with a transaction to verify.
 *   - A demo creator has a test balance in our own books. No money moves, the
 *     charge is marked `testMode`, and it never gets a "verify" link.
 *
 * What makes it safe to run on a timer:
 *   - `billedViews` on a dub only ever advances AFTER its payment confirmed, so
 *     a payment that fails is retried, not lost.
 *   - A sweep never overlaps another, and a creator whose payment just failed
 *     is skipped for a cooling-off period, so a payment that did land but could
 *     not be confirmed is not immediately sent again.
 */

import { MIN_CHARGE, PRICE_PER_VIEW, billableViews, micros, viewCharge, type Micros } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Charge, ChargeLine, Creator } from '../store/types.js';
import { CampaignService } from './campaign-service.js';

export interface PaymentResult {
  /** The transaction, for a real payment. Null in test mode. */
  readonly txHash: string | null;
  readonly testMode: boolean;
}

export interface Payer {
  /** What the creator can spend right now. Null when it cannot be read. */
  available(creator: Creator): Promise<Micros | null>;
  /** Take `amount` from the creator. Resolves only once it has really happened. */
  pay(creator: Creator, amount: Micros, ref: string): Promise<PaymentResult>;
}

export interface BillingDeps {
  readonly store: Store;
  readonly payer: Payer;
  readonly onChange?: (creator: Creator, reason: 'payment') => void;
  readonly now?: () => number;
  /** How long a creator is left alone after a payment fails. */
  readonly retryAfterMs?: number;
}

/** Split `total` across `weights` in whole units, largest remainders first. */
export function allocate(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  if (total >= sum) return [...weights];
  const exact = weights.map((w) => (w * total) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => ({ index, frac: value - Math.floor(value) })).sort((a, b) => b.frac - a.frac);
  for (const { index } of order) {
    if (left <= 0) break;
    out[index] = (out[index] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

export class BillingService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly holdUntil = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: BillingDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => console.error('[billing] sweep failed', error));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * What a creator would be charged right now, dub by dub. `available` caps it
   * at what they can pay; pass null to ignore their balance (to show what is
   * owed rather than what can be collected).
   */
  linesFor(creator: Creator, available: Micros | null): ChargeLine[] {
    const { store } = this.deps;
    const price = PRICE_PER_VIEW as bigint;
    let funds = available === null ? null : (available as bigint);
    const lines: ChargeLine[] = [];

    for (const post of store.postsForCreator(creator.id)) {
      const dubs = store.dubsForPost(post.id).filter((d) => d.state === 'PUBLISHED');
      const spent = dubs.reduce((sum, d) => sum + (d.paid as bigint), 0n);
      const budgetLeft = (post.budget as bigint) - spent;
      if (budgetLeft < price) continue;

      const unbilled = dubs.map((d) => Math.max(0, CampaignService.viewsOf(d) - d.billedViews));
      const wanted = unbilled.reduce((a, b) => a + b, 0);
      if (wanted === 0) continue;

      // The whole post against its budget and the creator's funds, then shared
      // between its dubs in proportion to their views.
      const affordable = billableViews({
        totalViews: wanted,
        billedViews: 0,
        budgetLeft: micros(budgetLeft),
        available: micros(funds ?? budgetLeft),
      });
      const shares = allocate(affordable, unbilled);
      dubs.forEach((dub, index) => {
        const views = shares[index] ?? 0;
        if (views <= 0) return;
        const amount = viewCharge(views);
        lines.push({ dubId: dub.id, lang: dub.lang, views, amount });
        if (funds !== null) funds -= amount as bigint;
      });
    }
    return lines;
  }

  /** Counted but not yet charged, ignoring what the creator can pay. */
  owed(creator: Creator): Micros {
    return micros(this.linesFor(creator, null).reduce((sum, l) => sum + (l.amount as bigint), 0n));
  }

  /** Charge every creator who owes enough to be worth a payment. */
  async sweep(): Promise<Charge[]> {
    if (this.running) return [];
    this.running = true;
    const made: Charge[] = [];
    try {
      for (const creator of [...this.deps.store.creators.values()]) {
        const charge = await this.chargeCreator(creator);
        if (charge) made.push(charge);
      }
    } finally {
      this.running = false;
    }
    return made;
  }

  /** Charge one creator now. Null when there was nothing worth charging. */
  async chargeCreator(creator: Creator): Promise<Charge | null> {
    const { store, payer } = this.deps;
    if ((this.holdUntil.get(creator.id) ?? 0) > this.now()) return null;
    if (this.linesFor(creator, null).length === 0) return null;

    let available: Micros | null;
    try {
      available = await payer.available(creator);
    } catch {
      available = null;
    }
    // A balance that cannot be read is not guessed at: wait for the next sweep.
    if (available === null) return null;

    const lines = this.linesFor(creator, available);
    const amount = micros(lines.reduce((sum, l) => sum + (l.amount as bigint), 0n));
    if ((amount as bigint) < (MIN_CHARGE as bigint)) {
      // Views are owed but cannot be paid for: tell the creator, once.
      const owed = this.owed(creator);
      const short = (owed as bigint) >= (MIN_CHARGE as bigint) && (available as bigint) < (MIN_CHARGE as bigint);
      if (short !== creator.lowBalance) {
        store.updateCreator(creator.id, { lowBalance: short });
        this.deps.onChange?.(creator, 'payment');
      }
      return null;
    }

    const views = lines.reduce((sum, l) => sum + l.views, 0);
    const simulatedViews = lines.some((l) => (store.getDub(l.dubId)?.simulatedViews ?? 0) > 0);
    let charge = store.createCharge({
      creatorId: creator.id,
      amount,
      views,
      lines,
      status: 'pending',
      txHash: null,
      testMode: false,
      simulatedViews,
      error: null,
      confirmedAt: null,
    });
    this.deps.onChange?.(creator, 'payment');

    try {
      const result = await payer.pay(creator, amount, charge.id);
      // Only now do the views count as paid for.
      for (const line of lines) {
        const dub = store.getDub(line.dubId);
        if (!dub) continue;
        store.updateDub(dub.id, {
          billedViews: dub.billedViews + line.views,
          paid: micros((dub.paid as bigint) + (line.amount as bigint)),
        });
      }
      store.appendLedger({ accountId: store.houseAccount().id, amount, kind: 'view_charge', ref: charge.id });
      charge = store.updateCharge(charge.id, {
        status: 'confirmed',
        txHash: result.txHash,
        testMode: result.testMode,
        confirmedAt: new Date(this.now()),
      });
      if (creator.lowBalance) store.updateCreator(creator.id, { lowBalance: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[billing] charging @${creator.handle} ${amount} failed: ${message}`);
      charge = store.updateCharge(charge.id, { status: 'failed', error: message.slice(0, 300) });
      this.holdUntil.set(creator.id, this.now() + (this.deps.retryAfterMs ?? 60_000));
    }
    this.deps.onChange?.(creator, 'payment');
    return charge;
  }
}
