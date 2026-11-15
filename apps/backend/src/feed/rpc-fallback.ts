/**
 * RPC polling fallback for the chain feed.
 *
 * The stream is the fast path. This takes over when there is no stream at all
 * (no QuickNode credentials) or when one exists but has gone quiet - QuickNode
 * pauses a stream after 3 failed deliveries, and a paused stream looks exactly
 * like a healthy one from here except that nothing arrives. So staleness is
 * measured in seconds since the last accepted webhook, not in stream status.
 *
 * It polls the SAME shape the webhook ingests (6-decimal ERC-20 micros from
 * USDC_ADDRESS only - never the 18-decimal EIP-7708 system emitter, which would
 * double-count) and feeds the SAME ingest path, so dedupe on (txHash, logIndex)
 * covers the overlap when a stream recovers mid-poll.
 *
 * `FeedStatusDto.source` is reported honestly: whatever actually produced the
 * last event, including 'simulated' when nothing on-chain is happening at all.
 */

import {
  ARC_NATIVE_USDC_SYSTEM_EMITTER,
  TRANSFER_EVENT_TOPIC,
  USDC_ADDRESS,
  type FeedStatusDto,
  type StreamTransfer,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { WebhookIngestor } from './webhook.js';

/** `ARC_NATIVE_USDC_SYSTEM_EMITTER` is imported only to assert we exclude it. */
const EXCLUDED_EMITTER = ARC_NATIVE_USDC_SYSTEM_EMITTER.toLowerCase();

/** The minimum of a chain client this poller needs. Trivially faked in tests. */
export interface ChainLogSource {
  getBlockNumber(): Promise<bigint>;
  getTransferLogs(opts: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
    readonly addresses: readonly string[];
  }): Promise<StreamTransfer[]>;
}

export interface RpcFallbackOptions {
  readonly store: Store;
  readonly ingestor: WebhookIngestor;
  readonly source: ChainLogSource;
  /** Addresses we care about. Empty = every USDC transfer. */
  readonly addresses?: readonly string[];
  readonly pollIntervalMs?: number;
  /** No webhook for this long and we consider the stream stale. */
  readonly stalenessMs?: number;
  /** True when a QuickNode stream was actually created. */
  readonly streamConfigured?: boolean;
  /** Blocks to look back on the very first poll. */
  readonly lookbackBlocks?: bigint;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export class RpcFallbackPoller {
  private readonly store: Store;
  private readonly ingestor: WebhookIngestor;
  private readonly logSource: ChainLogSource;
  private readonly addresses: readonly string[];
  private readonly pollIntervalMs: number;
  private readonly stalenessMs: number;
  private readonly streamConfigured: boolean;
  private readonly lookbackBlocks: bigint;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor: bigint | null = null;
  private polling = false;
  private lastPollEventAt: Date | null = null;

  constructor(opts: RpcFallbackOptions) {
    this.store = opts.store;
    this.ingestor = opts.ingestor;
    this.logSource = opts.source;
    this.addresses = opts.addresses ?? [];
    this.pollIntervalMs = opts.pollIntervalMs ?? 4_000;
    this.stalenessMs = opts.stalenessMs ?? 30_000;
    this.streamConfigured = opts.streamConfigured ?? false;
    this.lookbackBlocks = opts.lookbackBlocks ?? 200n;
    this.now = opts.now ?? (() => new Date());
    this.onError =
      opts.onError ??
      ((error) => {
        console.warn('[feed] RPC poll failed:', error);
      });
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** True when the stream is absent or has not delivered recently. */
  isStreamStale(): boolean {
    if (!this.streamConfigured) return true;
    const last = this.ingestor.lastDeliveryAt();
    if (last === null) return true;
    return this.now().getTime() - last.getTime() > this.stalenessMs;
  }

  /**
   * One poll. A no-op while the stream is healthy, so starting the poller
   * unconditionally is safe - it simply stands by.
   */
  async pollOnce(): Promise<number> {
    if (this.polling) return 0;
    if (!this.isStreamStale()) return 0;
    this.polling = true;
    try {
      const head = await this.logSource.getBlockNumber();
      const from =
        this.cursor ?? (head > this.lookbackBlocks ? head - this.lookbackBlocks : 0n);
      if (from > head) return 0;

      const logs = await this.logSource.getTransferLogs({
        fromBlock: from,
        toBlock: head,
        addresses: this.addresses,
      });
      this.cursor = head + 1n;

      // Belt and braces: the source is already narrowed to USDC_ADDRESS, but a
      // system-emitter log leaking in here would double-count every dollar.
      const movements = logs.filter((log) => log.from.toLowerCase() !== EXCLUDED_EMITTER);
      if (movements.length === 0) return 0;

      const result = this.ingestor.processMovements(
        [...movements].sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber - b.blockNumber,
        ),
      );
      if (result.recorded > 0) this.lastPollEventAt = this.now();
      return result.recorded;
    } catch (error) {
      this.onError(error);
      return 0;
    } finally {
      this.polling = false;
    }
  }

  /** Honest status for the dashboard. */
  status(): FeedStatusDto {
    const webhookAt = this.ingestor.lastDeliveryAt();
    const pollAt = this.lastPollEventAt;
    const stale = this.isStreamStale();

    let source: FeedStatusDto['source'];
    if (!stale && webhookAt !== null) {
      source = 'quicknode_stream';
    } else if (pollAt !== null) {
      source = 'rpc_polling';
    } else if (this.streamConfigured || this.timer !== null) {
      // Wired up, nothing seen yet: still honestly RPC polling, not "live".
      source = 'rpc_polling';
    } else {
      source = 'simulated';
    }

    const lastEventAt = latest(webhookAt, pollAt);
    const block = this.store.latestBlock();
    return {
      live: lastEventAt !== null && this.now().getTime() - lastEventAt.getTime() <= this.stalenessMs,
      source,
      latestBlock: block === null ? null : block.toString(),
      lastEventAt: lastEventAt === null ? null : lastEventAt.toISOString(),
    };
  }
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * The real viem-backed source. Imported lazily so tests (and a credential-free
 * boot) never construct an RPC client.
 */
export function createViemLogSource(): ChainLogSource {
  return {
    async getBlockNumber(): Promise<bigint> {
      const { getPublicClient } = await import('../chain/client.js');
      return getPublicClient().getBlockNumber();
    },
    async getTransferLogs({ fromBlock, toBlock, addresses }): Promise<StreamTransfer[]> {
      const { getPublicClient } = await import('../chain/client.js');
      const client = getPublicClient();
      const watched = addresses.map((a) => a.toLowerCase());
      // USDC_ADDRESS only. The native system emitter mirrors these movements at
      // 18 decimals; indexing both double-counts.
      const logs = await client.getLogs({
        address: USDC_ADDRESS,
        fromBlock,
        toBlock,
      });
      const out: StreamTransfer[] = [];
      for (const log of logs) {
        const topics = log.topics as readonly string[];
        if (topics.length !== 3) continue;
        if (topics[0]?.toLowerCase() !== TRANSFER_EVENT_TOPIC) continue;
        if (log.removed) continue;
        if (log.transactionHash === null || log.logIndex === null || log.blockNumber === null) {
          continue;
        }
        const from = topicToAddress(topics[1]);
        const to = topicToAddress(topics[2]);
        if (watched.length > 0 && !watched.includes(from) && !watched.includes(to)) continue;
        out.push({
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash.toLowerCase(),
          logIndex: log.logIndex,
          from,
          to,
          // 6-decimal base units, exactly as the ledger stores them.
          value: BigInt(log.data === '0x' ? '0x0' : log.data).toString(10),
        });
      }
      return out;
    },
  };
}

function topicToAddress(topic: string | undefined): string {
  return `0x${(topic ?? '').slice(26).toLowerCase()}`;
}
