import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerEventDto, TickerEntryDto } from '@parrot/shared';
import { SseHub, type SseResponse } from '../src/feed/sse.js';
import { RpcFallbackPoller, type ChainLogSource } from '../src/feed/rpc-fallback.js';
import { WebhookIngestor } from '../src/feed/webhook.js';
import { Store } from '../src/store/store.js';

/** A minimal stand-in for an Express response. */
class FakeResponse implements SseResponse {
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];
  ended = false;
  private readonly listeners = new Set<() => void>();

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  on(_event: 'close', listener: () => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'close', listener: () => void): void {
    this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Simulate the browser going away. */
  close(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** The parsed `data:` lines, heartbeats included. */
  events(): ServerEventDto[] {
    return this.chunks
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as ServerEventDto);
  }
}

function tickerEvent(id: string): ServerEventDto {
  const entry: TickerEntryDto = {
    id,
    kind: 'settlement',
    text: 'test',
    amount: null,
    at: '2026-11-15T00:00:00.000Z',
    verifyUrl: null,
    simulated: false,
  };
  return { type: 'ticker', entry };
}

describe('SseHub', () => {
  let hub: SseHub;

  beforeEach(() => {
    vi.useFakeTimers();
    hub = new SseHub({ heartbeatMs: 20_000, bufferSize: 3 });
  });

  afterEach(() => {
    hub.closeAll();
    vi.useRealTimers();
  });

  it('sets the SSE headers a proxy will not mangle', () => {
    const res = new FakeResponse();
    hub.subscribe(res);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    expect(res.chunks[0]).toContain('retry:');
  });

  it('broadcasts to multiple subscribers', () => {
    const a = new FakeResponse();
    const b = new FakeResponse();
    hub.subscribe(a);
    hub.subscribe(b);

    hub.broadcast(tickerEvent('one'));

    expect(a.events()).toHaveLength(1);
    expect(b.events()).toHaveLength(1);
    expect(a.events()[0]).toEqual(tickerEvent('one'));
    expect(a.chunks.at(-1)).toMatch(/^id: \d+\nevent: ticker\ndata: /);
  });

  it('heartbeats on its interval and stops when the last client leaves', () => {
    const res = new FakeResponse();
    hub.subscribe(res);

    vi.advanceTimersByTime(20_000);
    expect(res.events().filter((e) => e.type === 'heartbeat')).toHaveLength(1);

    vi.advanceTimersByTime(40_000);
    expect(res.events().filter((e) => e.type === 'heartbeat')).toHaveLength(3);

    res.close();
    const before = res.chunks.length;
    vi.advanceTimersByTime(60_000);
    expect(res.chunks).toHaveLength(before);
  });

  it('cleans up on disconnect and leaks no listeners', () => {
    const res = new FakeResponse();
    hub.subscribe(res);
    expect(hub.clientCount).toBe(1);
    expect(res.listenerCount).toBe(1);

    res.close();
    expect(hub.clientCount).toBe(0);
    expect(res.listenerCount).toBe(0);

    const chunks = res.chunks.length;
    hub.broadcast(tickerEvent('after-close'));
    expect(res.chunks).toHaveLength(chunks);
  });

  it('unsubscribes via the returned function, and is idempotent', () => {
    const res = new FakeResponse();
    const unsubscribe = hub.subscribe(res);
    unsubscribe();
    unsubscribe();
    res.close();
    expect(hub.clientCount).toBe(0);
  });

  it('replays a bounded buffer of recent events to a late joiner', () => {
    hub.broadcast(tickerEvent('one'));
    hub.broadcast(tickerEvent('two'));
    hub.broadcast(tickerEvent('three'));
    hub.broadcast(tickerEvent('four'));

    const late = new FakeResponse();
    hub.subscribe(late);

    const ids = late.events().map((e) => (e.type === 'ticker' ? e.entry.id : e.type));
    expect(ids).toEqual(['two', 'three', 'four']);
    expect(hub.recent()).toHaveLength(3);
  });

  it('does not buffer heartbeats for replay', () => {
    const first = new FakeResponse();
    hub.subscribe(first);
    vi.advanceTimersByTime(20_000);
    first.close();

    const late = new FakeResponse();
    hub.subscribe(late);
    expect(late.events()).toHaveLength(0);
  });

  it('drops a subscriber whose socket throws on write', () => {
    const broken = new FakeResponse();
    hub.subscribe(broken);
    broken.write = () => {
      throw new Error('EPIPE');
    };
    const healthy = new FakeResponse();
    hub.subscribe(healthy);

    hub.broadcast(tickerEvent('one'));
    expect(hub.clientCount).toBe(1);
    expect(healthy.events()).toHaveLength(1);
  });
});

describe('RpcFallbackPoller', () => {
  let store: Store;
  let hub: SseHub;
  let ingestor: WebhookIngestor;
  let now: Date;

  const logs: ChainLogSource = {
    getBlockNumber: async () => 100n,
    getTransferLogs: async () => [
      {
        blockNumber: 100,
        txHash: `0x${'aa'.repeat(32)}`,
        logIndex: 0,
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        value: '5000',
      },
    ],
  };

  beforeEach(() => {
    now = new Date('2026-11-15T12:00:00.000Z');
    store = new Store();
    hub = new SseHub({ heartbeatMs: 60_000 });
    ingestor = new WebhookIngestor({ store, hub, now: () => now });
  });

  afterEach(() => {
    hub.closeAll();
  });

  function poller(overrides: Partial<ConstructorParameters<typeof RpcFallbackPoller>[0]> = {}) {
    return new RpcFallbackPoller({
      store,
      ingestor,
      source: logs,
      now: () => now,
      ...overrides,
    });
  }

  it('reports source "simulated" when nothing is wired up and nothing has happened', () => {
    const status = poller().status();
    expect(status.source).toBe('simulated');
    expect(status.live).toBe(false);
    expect(status.latestBlock).toBeNull();
  });

  it('polls when no stream is configured and feeds the same ingest path', async () => {
    const p = poller();
    expect(p.isStreamStale()).toBe(true);
    expect(await p.pollOnce()).toBe(1);
    expect(store.latestBlock()).toBe(100n);
    expect(p.status().source).toBe('rpc_polling');
    expect(p.status().latestBlock).toBe('100');
    expect(p.status().live).toBe(true);
  });

  it('dedupes across a poll that overlaps a webhook delivery', async () => {
    const p = poller();
    await p.pollOnce();
    // A second poll re-reads the same block range after the cursor is reset.
    const second = poller();
    expect(await second.pollOnce()).toBe(0);
    expect(store.chainTransfers.size).toBe(1);
  });

  it('stands by while a configured stream is delivering, and takes over when it goes stale', async () => {
    const p = poller({ streamConfigured: true, stalenessMs: 30_000 });
    ingestor.acceptWebhook(JSON.stringify({ movements: [] }));

    expect(p.isStreamStale()).toBe(false);
    expect(await p.pollOnce()).toBe(0);
    expect(p.status().source).toBe('quicknode_stream');

    now = new Date(now.getTime() + 60_000);
    expect(p.isStreamStale()).toBe(true);
    expect(await p.pollOnce()).toBe(1);
    expect(p.status().source).toBe('rpc_polling');
  });

  it('survives an RPC error without throwing', async () => {
    const errors: unknown[] = [];
    const p = poller({
      source: {
        getBlockNumber: async () => {
          throw new Error('rpc down');
        },
        getTransferLogs: async () => [],
      },
      onError: (e) => errors.push(e),
    });
    expect(await p.pollOnce()).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
