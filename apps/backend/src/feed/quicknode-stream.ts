/**
 * QuickNode Streams: the filter function we ship, and the REST call that
 * creates the stream.
 *
 * THE DOUBLE-COUNTING TRAP (read before touching the filter):
 * Arc reports every USDC movement TWICE - once as an EIP-7708 system Transfer
 * log emitted by ARC_NATIVE_USDC_SYSTEM_EMITTER (0xffff...fffE) denominated in
 * NATIVE 18-decimal USDC, and once as the ERC-20 mirror at USDC_ADDRESS
 * (0x3600...0000) in 6-decimal units. An indexer that keeps both counts the
 * same dollar twice. Parrot settles by calling `transfer` on the ERC-20
 * interface and its ledger is in 6-decimal micros, so the filter keeps logs
 * from USDC_ADDRESS ONLY and reads 6-decimal values. Never widen the address
 * check to include the system emitter.
 *
 * Ordering: rows are ordered by (blockNumber, logIndex), never by timestamp -
 * Arc's sub-second blocks mean many movements share a timestamp. Dedupe on
 * (txHash, logIndex). Arc has deterministic finality, so there is no reorg
 * handling here by design.
 *
 * Batch size: Arc blocks are sub-second and QuickNode rejects a tip-following
 * stream with dataset_batch_size < 5 (HTTP 422). We use QUICKNODE_BATCH_SIZE
 * (10, as in QuickNode's own Arc guide) with elastic batching off.
 */

import {
  QUICKNODE_BATCH_SIZE,
  QUICKNODE_DATASET,
  QUICKNODE_MIN_BATCH_SIZE,
  QUICKNODE_NETWORK,
  QUICKNODE_STREAMS_API,
  TRANSFER_EVENT_TOPIC,
  USDC_ADDRESS,
  type StreamTransfer,
} from '@parrot/shared';
import { getConfig } from '../config.js';

/** What the filter function delivers to our webhook. */
export interface FilterResult {
  readonly movements: StreamTransfer[];
}

/** The raw payload QuickNode hands `main(stream)`. */
export interface StreamPayload {
  readonly data?: unknown;
  readonly metadata?: unknown;
}

/**
 * The filter function SOURCE, as standalone JavaScript defining
 * `function main(stream)`. QuickNode evaluates this inside their sandbox, so it
 * may not import anything, may not use TypeScript syntax, and must be
 * self-contained - hence the inlined constants below.
 *
 * It returns `{ movements: [...] }` to deliver, or `null` to skip the batch
 * entirely (QuickNode then makes no webhook call at all).
 */
export function buildFilterFunctionSource(watchedAddresses: readonly string[] = []): string {
  const watchlist = JSON.stringify(watchedAddresses.map((a) => a.toLowerCase()));
  return `// Parrot chain feed filter. Generated - edit quicknode-stream.ts, not the console.
// Keeps ONLY ERC-20 USDC Transfer logs (6 decimals). The EIP-7708 system
// emitter 0xffff...fffE reports the SAME movements at 18 decimals; keeping both
// double-counts every dollar.
var USDC_ADDRESS = ${JSON.stringify(USDC_ADDRESS)};
var TRANSFER_TOPIC = ${JSON.stringify(TRANSFER_EVENT_TOPIC)};
var WATCHED = ${watchlist};

function toAddress(topic) {
  // An indexed address is left-padded to 32 bytes: strip the 12-byte pad.
  return '0x' + String(topic).slice(26).toLowerCase();
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return parseInt(value, value.slice(0, 2) === '0x' ? 16 : 10);
  return 0;
}

function toDecimalString(data) {
  if (data === undefined || data === null || data === '0x' || data === '') return '0';
  if (typeof data === 'number') return String(data);
  var text = String(data);
  // 6-decimal ERC-20 base units, i.e. micros. No conversion needed anywhere.
  return BigInt(text.slice(0, 2) === '0x' ? text : '0x' + text).toString(10);
}

function collectLogs(data) {
  var out = [];
  if (!Array.isArray(data)) return out;
  for (var i = 0; i < data.length; i++) {
    var entry = data[i];
    if (Array.isArray(entry)) {
      for (var j = 0; j < entry.length; j++) out.push(entry[j]);
    } else if (entry && Array.isArray(entry.logs)) {
      for (var k = 0; k < entry.logs.length; k++) out.push(entry.logs[k]);
    } else if (entry) {
      out.push(entry);
    }
  }
  return out;
}

function main(stream) {
  var logs = collectLogs(stream && stream.data);
  var movements = [];
  for (var i = 0; i < logs.length; i++) {
    var log = logs[i];
    if (!log || log.removed === true) continue;
    if (typeof log.address !== 'string') continue;
    if (log.address.toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
    var topics = log.topics;
    if (!Array.isArray(topics) || topics.length !== 3) continue;
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;

    var from = toAddress(topics[1]);
    var to = toAddress(topics[2]);
    if (WATCHED.length > 0 && WATCHED.indexOf(from) === -1 && WATCHED.indexOf(to) === -1) continue;

    movements.push({
      blockNumber: toNumber(log.blockNumber),
      txHash: String(log.transactionHash || log.txHash || '').toLowerCase(),
      logIndex: toNumber(log.logIndex),
      from: from,
      to: to,
      value: toDecimalString(log.data),
    });
  }

  if (movements.length === 0) return null;

  // Order by (blockNumber, logIndex). Never by timestamp: Arc's sub-second
  // blocks mean many movements share one.
  movements.sort(function (a, b) {
    return a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber;
  });

  return { movements: movements };
}
`;
}

/** The default source, with no address narrowing (every USDC transfer). */
export const FILTER_FUNCTION_SOURCE = buildFilterFunctionSource();

/**
 * Run the SAME source the stream runs, in-process. This exists so the filter is
 * actually unit-tested rather than shipped as an untested string.
 */
export function runFilter(
  payload: StreamPayload,
  source: string = FILTER_FUNCTION_SOURCE,
): FilterResult | null {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(`${source}\nreturn main;`) as () => (
    stream: StreamPayload,
  ) => FilterResult | null;
  return factory()(payload);
}

export function encodeFilterFunction(source: string = FILTER_FUNCTION_SOURCE): string {
  return Buffer.from(source, 'utf8').toString('base64');
}

export interface CreateStreamOptions {
  readonly webhookUrl: string;
  /** Narrows the filter to transfers touching these addresses. Empty = all. */
  readonly addresses?: readonly string[];
  readonly name?: string;
  readonly region?: string;
}

/** The exact JSON body we POST. Shaped per QuickNode's Streams REST API. */
export interface StreamConfigBody {
  readonly name: string;
  readonly network: string;
  readonly dataset: string;
  readonly region: string;
  readonly dataset_batch_size: number;
  readonly elastic_batch_enabled: boolean;
  readonly destination: 'webhook';
  readonly destination_attributes: {
    readonly url: string;
    readonly compression: 'none' | 'gzip';
    readonly max_retry: number;
    readonly retry_interval_sec: number;
    readonly post_timeout_sec: number;
  };
  /** BASE64-encoded JavaScript defining `function main(stream)`. */
  readonly filter_function: string;
  readonly status: 'active';
}

/**
 * The body we would POST, buildable with no credentials so it is inspectable
 * (and testable) offline.
 */
export function describeStreamConfig(opts: CreateStreamOptions): StreamConfigBody {
  const addresses = opts.addresses ?? [];
  const batchSize = Math.max(QUICKNODE_BATCH_SIZE, QUICKNODE_MIN_BATCH_SIZE);
  return {
    name: opts.name ?? 'parrot-arc-usdc-transfers',
    network: QUICKNODE_NETWORK,
    dataset: QUICKNODE_DATASET,
    region: opts.region ?? 'usa_east',
    // Arc blocks are sub-second: a tip-following stream with a batch size
    // below QUICKNODE_MIN_BATCH_SIZE is rejected with HTTP 422.
    dataset_batch_size: batchSize,
    elastic_batch_enabled: false,
    destination: 'webhook',
    destination_attributes: {
      url: opts.webhookUrl,
      compression: 'none',
      // After max_retry failures QuickNode PAUSES the stream, and it waits for
      // a 2xx before advancing - so the webhook route must ACK fast and do the
      // work afterwards. See webhook.ts.
      max_retry: 3,
      retry_interval_sec: 1,
      post_timeout_sec: 30,
    },
    filter_function: encodeFilterFunction(buildFilterFunctionSource(addresses)),
    status: 'active',
  };
}

export interface CreatedStream {
  readonly id: string;
  readonly name: string;
  readonly status: string;
}

export class QuickNodeCredentialsMissingError extends Error {
  constructor() {
    super('QUICKNODE_API_KEY is not set; the chain feed falls back to RPC polling.');
    this.name = 'QuickNodeCredentialsMissingError';
  }
}

/**
 * Create the stream. Guarded on QUICKNODE_API_KEY: with no key this throws
 * rather than pretending, and the caller degrades to rpc-fallback.ts.
 */
export async function createStream(opts: CreateStreamOptions): Promise<CreatedStream> {
  const apiKey = getConfig().env.QUICKNODE_API_KEY;
  if (apiKey === undefined) throw new QuickNodeCredentialsMissingError();

  const body = describeStreamConfig(opts);
  const response = await fetch(`${QUICKNODE_STREAMS_API}/streams`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`QuickNode stream creation failed (HTTP ${response.status}): ${detail}`);
  }

  const json = (await response.json()) as { id?: string; name?: string; status?: string };
  return {
    id: json.id ?? '',
    name: json.name ?? body.name,
    status: json.status ?? 'unknown',
  };
}
