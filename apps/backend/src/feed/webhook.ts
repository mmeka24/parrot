/**
 * QuickNode Streams webhook: signature verification and ingest.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 * 1. The HMAC is computed over the DECODED payload string exactly as it
 *    arrived. The Express route MUST mount `express.raw({ type: () => true })`
 *    for this path - `express.json()` parses and the re-serialized body no
 *    longer matches byte-for-byte, so every signature fails.
 *
 *    message = nonce + timestamp + payload   (UTF-8, in that exact order)
 *    key     = the stream's security token
 *    digest  = HMAC-SHA256, hex, compared with timingSafeEqual.
 *
 * 2. ACK FAST. QuickNode waits for a 2xx before advancing the stream, retries
 *    3 times at 1s, and then PAUSES the stream outright. So the route verifies,
 *    parses, responds 200, and only then processes. `acceptWebhook` is the
 *    before-the-response half; `processMovements` is the after half.
 *
 * Correctness note inherited from the filter: movements arrive from the ERC-20
 * USDC interface only (6-decimal micros). Arc's EIP-7708 system emitter reports
 * the same dollars at 18 decimals and is deliberately excluded upstream -
 * ingesting both would double-count. Dedupe is on (txHash, logIndex); ordering
 * is (blockNumber, logIndex), never timestamp. Arc finality is deterministic,
 * so there is no reorg path.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  formatUsd,
  micros,
  streamDedupeKey,
  streamWebhookPayloadSchema,
  txUrl,
  type ServerEventDto,
  type StreamTransfer,
  type TickerEntryDto,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { SseHub } from './sse.js';

/** Header names QuickNode sends with every delivery. */
export const QUICKNODE_HEADERS = {
  nonce: 'x-qn-nonce',
  timestamp: 'x-qn-timestamp',
  signature: 'x-qn-signature',
} as const;

export interface SignatureInput {
  readonly secret: string;
  readonly nonce: string;
  readonly timestamp: string;
  /** The raw body EXACTLY as received. Never a re-serialized object. */
  readonly rawBody: string | Buffer;
  readonly signature: string;
}

/**
 * Verify a QuickNode delivery. Constant-time on the compare, and constant-time
 * in its failure shape: a wrong-length signature still performs a comparison
 * before returning false.
 */
export function verifyQuickNodeSignature(input: SignatureInput): boolean {
  const { secret, nonce, timestamp, rawBody, signature } = input;
  if (secret === '' || signature === '') return false;

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret)
    .update(nonce + timestamp + payload, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    // Still do the work, so a length mismatch is not distinguishable by timing.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

/** Pull the three QuickNode headers out of a request-like header bag. */
export function readSignatureHeaders(headers: Record<string, unknown>): {
  nonce: string;
  timestamp: string;
  signature: string;
} {
  const get = (name: string): string => {
    const value = headers[name] ?? headers[name.toUpperCase()];
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return '';
  };
  return {
    nonce: get(QUICKNODE_HEADERS.nonce),
    timestamp: get(QUICKNODE_HEADERS.timestamp),
    signature: get(QUICKNODE_HEADERS.signature),
  };
}

export interface IngestResult {
  /** Movements that were new to the store. */
  readonly recorded: number;
  /** Redeliveries we ignored. */
  readonly duplicates: number;
  /** Movements matched to one of our own settlements by tx hash. */
  readonly reconciled: number;
}

export interface WebhookIngestorDeps {
  readonly store: Store;
  readonly hub: SseHub;
  readonly now?: () => Date;
}

export class WebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookPayloadError';
  }
}

export class WebhookIngestor {
  private readonly store: Store;
  private readonly hub: SseHub;
  private readonly now: () => Date;
  private lastEventAt: Date | null = null;

  constructor(deps: WebhookIngestorDeps) {
    this.store = deps.store;
    this.hub = deps.hub;
    this.now = deps.now ?? (() => new Date());
  }

  /** When we last accepted a delivery. rpc-fallback.ts uses this for staleness. */
  lastDeliveryAt(): Date | null {
    return this.lastEventAt;
  }

  /**
   * The BEFORE-the-response half: validate only. Cheap and synchronous, so the
   * route can call this, respond 200, and hand the result to
   * `processMovements` afterwards.
   */
  acceptWebhook(rawBody: string | Buffer): StreamTransfer[] {
    const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new WebhookPayloadError('body is not valid JSON');
    }
    const parsed = streamWebhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new WebhookPayloadError(parsed.error.issues.map((i) => i.message).join('; '));
    }
    this.lastEventAt = this.now();
    return [...parsed.data.movements].sort(
      (a, b) =>
        a.blockNumber === b.blockNumber
          ? a.logIndex - b.logIndex
          : a.blockNumber - b.blockNumber,
    );
  }

  /**
   * The AFTER-the-response half: dedupe, reconcile against our settlements, and
   * push ticker events. Safe to call repeatedly with the same movements.
   */
  processMovements(movements: readonly StreamTransfer[]): IngestResult {
    let recorded = 0;
    let duplicates = 0;
    let reconciled = 0;

    for (const movement of movements) {
      const settlement = this.findSettlement(movement.txHash);
      const isNew = this.store.recordChainTransfer({
        blockNumber: BigInt(movement.blockNumber),
        txHash: movement.txHash,
        logIndex: movement.logIndex,
        fromAddress: movement.from,
        toAddress: movement.to,
        // Already 6-decimal micros: the ERC-20 interface, not the 18-decimal
        // native system emitter. No conversion, ever.
        value: micros(BigInt(movement.value)),
        settlementId: settlement?.id ?? null,
      });

      if (!isNew) {
        duplicates++;
        continue;
      }
      recorded++;

      if (settlement && settlement.status !== 'confirmed') {
        this.store.updateSettlement(settlement.id, {
          status: 'confirmed',
          confirmedAt: this.now(),
        });
        reconciled++;
      } else if (settlement) {
        reconciled++;
      }

      this.hub.broadcast(this.tickerEvent(movement, settlement !== undefined));
    }

    return { recorded, duplicates, reconciled };
  }

  /** Convenience for tests and for the RPC fallback: both halves in one call. */
  ingestWebhook(rawBody: string | Buffer): IngestResult {
    return this.processMovements(this.acceptWebhook(rawBody));
  }

  private findSettlement(txHash: string) {
    const needle = txHash.toLowerCase();
    return this.store
      .allSettlements()
      .find((s) => s.txHash !== null && s.txHash.toLowerCase() === needle);
  }

  private tickerEvent(movement: StreamTransfer, matched: boolean): ServerEventDto {
    const amount = micros(BigInt(movement.value));
    const entry: TickerEntryDto = {
      id: streamDedupeKey(movement.txHash, movement.logIndex),
      kind: 'settlement',
      text: matched
        ? `Payment of ${formatUsd(amount, { maxDecimals: 4 })} confirmed on Arc`
        : `${formatUsd(amount, { maxDecimals: 4 })} moved on Arc`,
      amount: { micros: (amount as bigint).toString(), display: formatUsd(amount) },
      at: this.now().toISOString(),
      verifyUrl: txUrl(movement.txHash),
      simulated: false,
    };
    return { type: 'ticker', entry };
  }
}
