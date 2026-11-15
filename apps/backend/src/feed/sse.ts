/**
 * Server-Sent Events hub for the live dashboard.
 *
 * Why SSE and not WebSockets: the feed is one-way, it survives proxies that
 * mangle upgrades, and the browser reconnects on its own. The only subtleties
 * worth knowing are in here:
 *
 *  - `X-Accel-Buffering: no` - without it nginx buffers the stream and the
 *    dashboard looks frozen for seconds at a time.
 *  - A heartbeat comment every ~20s keeps idle proxies from killing the
 *    connection. It is sent as a real `heartbeat` event so the client can show
 *    "live" honestly.
 *  - One shared interval for ALL clients, started on the first subscriber and
 *    cleared on the last. Nothing accumulates when nobody is watching.
 *  - A bounded ring of recent events is replayed to late joiners, so a tab
 *    opened mid-demo is not blank.
 */

import type { ServerEventDto } from '@parrot/shared';

/**
 * The slice of an HTTP response the hub needs. Express's `Response` satisfies
 * it structurally, and a test double is three lines.
 */
export interface SseResponse {
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', listener: () => void): unknown;
  off?(event: 'close', listener: () => void): unknown;
  flushHeaders?(): unknown;
}

export interface SseHubOptions {
  /** Heartbeat period. QuickNode-independent; purely proxy keep-alive. */
  readonly heartbeatMs?: number;
  /** How many recent events a late joiner is replayed. */
  readonly bufferSize?: number;
  readonly now?: () => Date;
}

interface Client {
  readonly res: SseResponse;
  readonly onClose: () => void;
}

export class SseHub {
  private readonly clients = new Set<Client>();
  private readonly buffer: { id: number; event: ServerEventDto }[] = [];
  private readonly heartbeatMs: number;
  private readonly bufferSize: number;
  private readonly now: () => Date;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private nextId = 1;

  constructor(opts: SseHubOptions = {}) {
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.bufferSize = opts.bufferSize ?? 50;
    this.now = opts.now ?? (() => new Date());
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Attach a response as a subscriber. Returns an unsubscribe function. */
  subscribe(res: SseResponse): () => void {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Without this nginx buffers the stream and the feed appears frozen.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      // Tell the browser to retry quickly if the connection drops.
      res.write('retry: 2000\n\n');
    } catch {
      // The socket died between accept and first write. Nothing to clean up.
      return () => {};
    }

    const client: Client = {
      res,
      onClose: () => {
        this.remove(client);
      },
    };
    this.clients.add(client);
    res.on('close', client.onClose);

    for (const buffered of this.buffer) this.send(res, buffered.id, buffered.event);

    this.ensureHeartbeat();
    return () => {
      this.remove(client);
    };
  }

  /** Fan an event out to every subscriber and remember it for late joiners. */
  broadcast(event: ServerEventDto): void {
    const id = this.nextId++;
    if (event.type !== 'heartbeat') {
      this.buffer.push({ id, event });
      while (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    for (const client of [...this.clients]) {
      try {
        this.send(client.res, id, event);
      } catch {
        // A write to a half-closed socket must never take the server down.
        this.remove(client);
      }
    }
  }

  /** Close every connection and stop the timer. Used on shutdown and in tests. */
  closeAll(): void {
    for (const client of [...this.clients]) {
      this.remove(client);
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
    this.stopHeartbeat();
  }

  /** The events a late joiner would be replayed. */
  recent(): readonly ServerEventDto[] {
    return this.buffer.map((b) => b.event);
  }

  private send(res: SseResponse, id: number, event: ServerEventDto): void {
    res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    // Drop the listener too, or a long-lived response object leaks it.
    client.res.off?.('close', client.onClose);
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) return;
    this.heartbeat = setInterval(() => {
      this.broadcast({ type: 'heartbeat', at: this.now().toISOString() });
    }, this.heartbeatMs);
    // Never hold the process open for a heartbeat.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
