import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerEventDto } from '@parrot/shared';
import { SseHub, type SseResponse } from '../src/feed/sse.js';

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

/** An event a dashboard would act on; `id` stands in for a creator's name. */
function tickerEvent(id: string): ServerEventDto {
  return { type: 'creator', handle: id, reason: 'views' };
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
    expect(a.chunks.at(-1)).toMatch(/^id: \d+\nevent: creator\ndata: /);
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

    const ids = late.events().map((e) => (e.type === 'creator' ? e.handle : e.type));
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
