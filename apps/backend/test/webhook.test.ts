import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ARC_NATIVE_USDC_SYSTEM_EMITTER,
  TRANSFER_EVENT_TOPIC,
  USDC_ADDRESS,
  type StreamTransfer,
} from '@parrot/shared';
import { Store } from '../src/store/store.js';
import { SseHub } from '../src/feed/sse.js';
import {
  WebhookIngestor,
  WebhookPayloadError,
  verifyQuickNodeSignature,
} from '../src/feed/webhook.js';
import {
  FILTER_FUNCTION_SOURCE,
  describeStreamConfig,
  runFilter,
} from '../src/feed/quicknode-stream.js';

const SECRET = 'qn_security_token_abc123';
const NONCE = '3f1c9b2e';
const TIMESTAMP = '1763208000';

function sign(secret: string, nonce: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(nonce + timestamp + body, 'utf8')
    .digest('hex');
}

function pad(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function hexValue(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;

function usdcTransferLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: USDC_ADDRESS,
    topics: [TRANSFER_EVENT_TOPIC, pad(ALICE), pad(BOB)],
    data: hexValue(20_000n),
    blockNumber: '0x2a',
    transactionHash: TX,
    logIndex: '0x3',
    removed: false,
    ...overrides,
  };
}

describe('verifyQuickNodeSignature', () => {
  const body = JSON.stringify({ movements: [] });

  it('accepts a correctly signed payload', () => {
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: sign(SECRET, NONCE, TIMESTAMP, body),
      }),
    ).toBe(true);
  });

  it('accepts the same payload delivered as a raw Buffer', () => {
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: Buffer.from(body, 'utf8'),
        signature: sign(SECRET, NONCE, TIMESTAMP, body),
      }),
    ).toBe(true);
  });

  it('rejects the wrong secret', () => {
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: sign('not-the-token', NONCE, TIMESTAMP, body),
      }),
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    const signature = sign(SECRET, NONCE, TIMESTAMP, body);
    const tampered = JSON.stringify({ movements: [{ value: '999' }] });
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: tampered,
        signature,
      }),
    ).toBe(false);
  });

  it('rejects nonce and timestamp concatenated in the wrong order', () => {
    const wrongOrder = createHmac('sha256', SECRET)
      .update(TIMESTAMP + NONCE + body, 'utf8')
      .digest('hex');
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: wrongOrder,
      }),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: body,
        signature: 'deadbeef',
      }),
    ).toBe(false);
  });

  it('demonstrates why the route must use express.raw: re-serializing breaks it', () => {
    const asSent = '{"movements": [ ]}';
    const signature = sign(SECRET, NONCE, TIMESTAMP, asSent);
    const reSerialized = JSON.stringify(JSON.parse(asSent));
    expect(reSerialized).not.toBe(asSent);
    expect(
      verifyQuickNodeSignature({
        secret: SECRET,
        nonce: NONCE,
        timestamp: TIMESTAMP,
        rawBody: reSerialized,
        signature,
      }),
    ).toBe(false);
  });
});

describe('filter function', () => {
  it('keeps a real ERC-20 USDC Transfer log', () => {
    const result = runFilter({ data: [[usdcTransferLog()]] });
    expect(result).not.toBeNull();
    expect(result?.movements).toEqual([
      {
        blockNumber: 42,
        txHash: TX,
        logIndex: 3,
        from: ALICE,
        to: BOB,
        value: '20000',
      },
    ]);
  });

  it('drops the EIP-7708 native system emitter (the double-counting trap)', () => {
    const result = runFilter({
      data: [[usdcTransferLog({ address: ARC_NATIVE_USDC_SYSTEM_EMITTER })]],
    });
    expect(result).toBeNull();
  });

  it('drops a non-Transfer topic', () => {
    const result = runFilter({
      data: [[usdcTransferLog({ topics: [`0x${'11'.repeat(32)}`, pad(ALICE), pad(BOB)] })]],
    });
    expect(result).toBeNull();
  });

  it('drops a removed log', () => {
    expect(runFilter({ data: [[usdcTransferLog({ removed: true })]] })).toBeNull();
  });

  it('drops a log with the wrong topic count', () => {
    expect(
      runFilter({ data: [[usdcTransferLog({ topics: [TRANSFER_EVENT_TOPIC, pad(ALICE)] })]] }),
    ).toBeNull();
  });

  it('returns null for an empty batch rather than an empty delivery', () => {
    expect(runFilter({ data: [[], []] })).toBeNull();
  });

  it('orders by (blockNumber, logIndex), not arrival order', () => {
    const result = runFilter({
      data: [
        [
          usdcTransferLog({ blockNumber: '0x2b', logIndex: '0x1' }),
          usdcTransferLog({ blockNumber: '0x2a', logIndex: '0x9' }),
          usdcTransferLog({ blockNumber: '0x2a', logIndex: '0x2' }),
        ],
      ],
    });
    expect(result?.movements.map((m) => [m.blockNumber, m.logIndex])).toEqual([
      [42, 2],
      [42, 9],
      [43, 1],
    ]);
  });

  it('is shipped base64-encoded and is valid standalone JavaScript', () => {
    expect(FILTER_FUNCTION_SOURCE).toContain('function main(stream)');
    const body = describeStreamConfig({ webhookUrl: 'https://example.test/hook' });
    const decoded = Buffer.from(body.filter_function, 'base64').toString('utf8');
    expect(decoded).toContain('function main(stream)');
    expect(body.network).toBe('arc-testnet');
    expect(body.dataset).toBe('logs');
    expect(body.dataset_batch_size).toBeGreaterThanOrEqual(5);
    expect(body.elastic_batch_enabled).toBe(false);
    expect(body.destination).toBe('webhook');
    expect(body.destination_attributes.url).toBe('https://example.test/hook');
  });

  it('narrows to watched addresses when asked', () => {
    const body = describeStreamConfig({
      webhookUrl: 'https://example.test/hook',
      addresses: [ALICE],
    });
    const source = Buffer.from(body.filter_function, 'base64').toString('utf8');
    expect(runFilter({ data: [[usdcTransferLog()]] }, source)?.movements).toHaveLength(1);
    const unrelated = usdcTransferLog({
      topics: [TRANSFER_EVENT_TOPIC, pad(BOB), pad('0x3333333333333333333333333333333333333333')],
    });
    expect(runFilter({ data: [[unrelated]] }, source)).toBeNull();
  });
});

describe('WebhookIngestor', () => {
  let store: Store;
  let hub: SseHub;
  let ingestor: WebhookIngestor;
  let broadcasts: unknown[];

  beforeEach(() => {
    store = new Store();
    hub = new SseHub({ heartbeatMs: 60_000 });
    broadcasts = [];
    const originalBroadcast = hub.broadcast.bind(hub);
    hub.broadcast = (event) => {
      broadcasts.push(event);
      originalBroadcast(event);
    };
    ingestor = new WebhookIngestor({ store, hub });
  });

  const movement: StreamTransfer = {
    blockNumber: 42,
    txHash: TX,
    logIndex: 3,
    from: ALICE,
    to: BOB,
    value: '20000',
  };

  it('validates with the shared schema and rejects garbage', () => {
    expect(() => ingestor.acceptWebhook('not json')).toThrow(WebhookPayloadError);
    expect(() => ingestor.acceptWebhook(JSON.stringify({ movements: [{ value: 1 }] }))).toThrow(
      WebhookPayloadError,
    );
  });

  it('records a movement and emits a ticker event', () => {
    const result = ingestor.ingestWebhook(JSON.stringify({ movements: [movement] }));
    expect(result).toEqual({ recorded: 1, duplicates: 0, reconciled: 0 });
    expect(store.latestBlock()).toBe(42n);
    expect(broadcasts).toHaveLength(1);
    expect(JSON.stringify(broadcasts[0])).toContain('"type":"ticker"');
  });

  it('ignores a redelivered (txHash, logIndex)', () => {
    const body = JSON.stringify({ movements: [movement] });
    expect(ingestor.ingestWebhook(body).recorded).toBe(1);
    const second = ingestor.ingestWebhook(body);
    expect(second).toEqual({ recorded: 0, duplicates: 1, reconciled: 0 });
    expect(store.chainTransfers.size).toBe(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('treats a different logIndex in the same tx as a distinct movement', () => {
    ingestor.ingestWebhook(JSON.stringify({ movements: [movement] }));
    const result = ingestor.ingestWebhook(
      JSON.stringify({ movements: [{ ...movement, logIndex: 4 }] }),
    );
    expect(result.recorded).toBe(1);
    expect(store.chainTransfers.size).toBe(2);
  });

  it('reconciles against a pending settlement with the same tx hash', () => {
    const account = store.createAccount({
      kind: 'creator',
      label: 'Creator',
      email: null,
      walletAddress: null,
    });
    const settlement = store.createSettlement({
      jobId: null,
      toAccountId: account.id,
      amount: 20_000n,
      kind: 'creator_payout',
      txHash: TX.toUpperCase(),
      idempotencyKey: 'payout-1',
      status: 'pending',
      error: null,
      simulated: false,
      confirmedAt: null,
    });

    const result = ingestor.ingestWebhook(JSON.stringify({ movements: [movement] }));
    expect(result.reconciled).toBe(1);

    const updated = store.settlements.get(settlement.id);
    expect(updated?.status).toBe('confirmed');
    expect(updated?.confirmedAt).toBeInstanceOf(Date);
    expect(store.chainTransfers.get(`${TX}:3`)?.settlementId).toBe(settlement.id);
  });

  it('sorts a batch by (blockNumber, logIndex) before processing', () => {
    const body = JSON.stringify({
      movements: [
        { ...movement, blockNumber: 43, logIndex: 0, txHash: `0x${'cd'.repeat(32)}` },
        { ...movement, blockNumber: 42, logIndex: 7, txHash: `0x${'ef'.repeat(32)}` },
      ],
    });
    const accepted = ingestor.acceptWebhook(body);
    expect(accepted.map((m) => [m.blockNumber, m.logIndex])).toEqual([
      [42, 7],
      [43, 0],
    ]);
  });

  it('records the delivery time so the RPC fallback can detect staleness', () => {
    expect(ingestor.lastDeliveryAt()).toBeNull();
    ingestor.acceptWebhook(JSON.stringify({ movements: [] }));
    expect(ingestor.lastDeliveryAt()).toBeInstanceOf(Date);
  });
});
