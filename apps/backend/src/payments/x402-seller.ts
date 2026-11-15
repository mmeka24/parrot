/**
 * The SELLER half of the x402 viewer unlock.
 *
 * A viewer asking for a locked dub gets a 402 carrying payment requirements;
 * they come back with a signed authorization; we hand that to Circle Gateway's
 * batch facilitator and, if it is accepted, unlock the dub.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG, all handled here:
 *
 *  1. THE MAINNET DEFAULT. `BatchFacilitatorClient` defaults to
 *     https://gateway-api.circle.com. If we do not pass the testnet URL,
 *     verification silently targets MAINNET and nothing ever works. Every
 *     facilitator we build goes through `defaultFacilitator()`, which takes the
 *     URL from config (GATEWAY_FACILITATOR_URL, defaulted to testnet in
 *     config.ts) - there is no code path here that constructs one without a URL.
 *
 *  2. THE VERIFYING CONTRACT. The buyer signs an EIP-3009
 *     TransferWithAuthorization whose `verifyingContract` is the GATEWAY WALLET
 *     (0x0077...19B9), NOT the USDC token. That is what `extra` advertises.
 *
 *  3. "SETTLED" DOES NOT MEAN "PAID ON-CHAIN". A successful Gateway settle
 *     means the authorization was ACCEPTED and credited to our Gateway balance
 *     (pending -> available). No USDC moved to our wallet. Converting a Gateway
 *     balance into real on-chain USDC needs `GatewayClient.withdraw()` - see
 *     settlement-scheduler.ts. So the reference we return is deliberately named
 *     `paymentRef`, never `txHash`, and `onchain` is false.
 *
 * Everything here is a plain function over plain objects: routes call it, tests
 * call it, nothing needs an Express app to exist.
 */

import {
  GATEWAY_BATCHING_EIP712,
  USDC_ADDRESS,
  ARC_TESTNET,
  X402_HEADERS,
  X402_VERSION,
  X402_MAX_TIMEOUT_SECONDS,
  type Micros,
} from '@parrot/shared';
import { getConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Wire types. These mirror the SDK's own structural types exactly (checked
// against node_modules/@circle-fin/x402-batching/dist/server/index.d.ts), so a
// value of ours can be handed straight to BatchFacilitatorClient.
// ---------------------------------------------------------------------------

export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  /** Atomic units of the asset, as a decimal string. 6dp USDC: "20000" = $0.02. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402PaymentPayload {
  x402Version: number;
  payload: Record<string, unknown>;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** The JSON body we base64 into the PAYMENT-REQUIRED header. */
export interface X402PaymentRequired {
  x402Version: number;
  accepts: X402PaymentRequirements[];
  error?: string;
}

export interface FacilitatorSettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** The slice of the facilitator we use. Lets tests inject a fake. */
export interface BatchFacilitatorLike {
  settle(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<FacilitatorSettleResponse>;
  verify?(
    paymentPayload: X402PaymentPayload,
    paymentRequirements: X402PaymentRequirements,
  ): Promise<FacilitatorVerifyResponse>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type X402FailureCode =
  | 'MISSING_PAYMENT'
  | 'MALFORMED_PAYMENT'
  | 'WRONG_VERSION'
  | 'VERIFY_FAILED'
  | 'SETTLE_FAILED'
  | 'FACILITATOR_ERROR';

export interface X402SettleOk {
  readonly ok: true;
  /** The buyer's EOA. Gateway rejects contract wallets, so this is always an EOA. */
  readonly payer: string;
  /** Atomic units actually authorized, as a decimal string. */
  readonly amount: string;
  /**
   * Gateway's reference for the ACCEPTED AUTHORIZATION. It is not a confirmed
   * on-chain transaction hash and must never be rendered as one.
   */
  readonly paymentRef: string;
  /** Always true on this path: Gateway settles in batches, off the hot path. */
  readonly batched: true;
  /** Always false: no USDC has moved to our wallet yet. See file header. */
  readonly onchain: false;
  readonly network: string;
}

export interface X402SettleFailure {
  readonly ok: false;
  readonly code: X402FailureCode;
  readonly reason: string;
  readonly payer?: string;
}

export type X402SettleResult = X402SettleOk | X402SettleFailure;

// ---------------------------------------------------------------------------
// Payment requirements
// ---------------------------------------------------------------------------

/**
 * The exact object Circle Gateway expects for one batched unlock.
 *
 * `amount` is atomic USDC units. Micros ARE atomic USDC units (units.ts), so
 * this is a stringify and never a conversion: UNLOCK_PRICE (20000n) -> "20000".
 */
export function buildPaymentRequirements(
  priceMicros: Micros,
  payTo: string,
): X402PaymentRequirements {
  if ((priceMicros as bigint) <= 0n) {
    throw new RangeError(`x402 price must be positive, got ${String(priceMicros)}`);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(payTo)) {
    throw new RangeError(`payTo must be a 20-byte hex address, got ${JSON.stringify(payTo)}`);
  }
  return {
    scheme: GATEWAY_BATCHING_EIP712.scheme,
    network: ARC_TESTNET.caip2,
    asset: USDC_ADDRESS,
    amount: (priceMicros as bigint).toString(),
    payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: {
      name: GATEWAY_BATCHING_EIP712.name,
      version: GATEWAY_BATCHING_EIP712.versions[0],
      // THE GATEWAY WALLET, not the USDC token. See file header.
      verifyingContract: GATEWAY_BATCHING_EIP712.verifyingContract,
    },
  };
}

// ---------------------------------------------------------------------------
// Base64 header codec
// ---------------------------------------------------------------------------

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function decodeHeaderJson<T>(encoded: string): T {
  const json = Buffer.from(encoded, 'base64').toString('utf8');
  return JSON.parse(json) as T;
}

export interface X402Response402 {
  readonly status: 402;
  readonly headers: Readonly<Record<string, string>>;
  /** Deliberately empty: the whole challenge lives in the header. */
  readonly body: Record<string, never>;
  /** The decoded challenge, handy for tests and logs. */
  readonly challenge: X402PaymentRequired;
}

/**
 * Build the 402 a locked dub answers with.
 *
 * The challenge goes in the PAYMENT-REQUIRED header as base64 JSON and the body
 * is `{}` - that is what x402 v2 and Circle's seller quickstart do.
 */
export function build402Response(
  requirements: X402PaymentRequirements | X402PaymentRequirements[],
  error?: string,
): X402Response402 {
  const accepts = Array.isArray(requirements) ? requirements : [requirements];
  const challenge: X402PaymentRequired = { x402Version: X402_VERSION, accepts };
  if (error !== undefined) challenge.error = error;
  return {
    status: 402,
    headers: { [X402_HEADERS.required]: encodeHeaderJson(challenge) },
    body: {},
    challenge,
  };
}

/** Decode a PAYMENT-REQUIRED header back into a challenge. */
export function parse402Header(encoded: string): X402PaymentRequired {
  return decodeHeaderJson<X402PaymentRequired>(encoded);
}

/** The receipt header a seller returns alongside the unlocked resource. */
export function buildPaymentResponseHeader(result: X402SettleOk): Record<string, string> {
  return {
    [X402_HEADERS.response]: encodeHeaderJson({
      x402Version: X402_VERSION,
      success: true,
      payer: result.payer,
      amount: result.amount,
      network: result.network,
      // Named `paymentRef`, not `transaction`: it is a batched authorization.
      paymentRef: result.paymentRef,
      batched: true,
      onchain: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Express-friendly helpers (structural: no express types imported)
// ---------------------------------------------------------------------------

interface HeaderBag {
  get?(name: string): string | undefined;
  headers?: Record<string, string | string[] | undefined>;
}

/** Pull the buyer's PAYMENT-SIGNATURE header, case-insensitively. */
export function readPaymentSignatureHeader(req: HeaderBag): string | undefined {
  const name = X402_HEADERS.signature;
  const viaGetter = req.get?.(name);
  if (typeof viaGetter === 'string' && viaGetter.length > 0) return viaGetter;
  const headers = req.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name.toLowerCase()) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === 'string' && raw.length > 0) return raw;
  }
  return undefined;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  set(field: string, value: string): ResponseLike;
  json(body: unknown): unknown;
}

/** Write a 402 challenge onto an Express response. */
export function send402(res: ResponseLike, response: X402Response402): void {
  let out = res.status(response.status);
  for (const [name, value] of Object.entries(response.headers)) out = out.set(name, value);
  out.json(response.body);
}

// ---------------------------------------------------------------------------
// Verify + settle
// ---------------------------------------------------------------------------

export interface VerifyAndSettleOptions {
  /** Inject a fake in tests. Defaults to a testnet-pinned BatchFacilitatorClient. */
  readonly facilitator?: BatchFacilitatorLike;
  /**
   * Call /verify before /settle. Off by default: Gateway's settle repeats every
   * check verify would do, so verifying first only adds a round trip.
   */
  readonly verifyFirst?: boolean;
}

let cachedFacilitator: BatchFacilitatorLike | undefined;

/** The facilitator URL this process will use. Always read, never assumed. */
export function facilitatorUrl(): string {
  return getConfig().env.GATEWAY_FACILITATOR_URL;
}

/**
 * Build (once) a BatchFacilitatorClient pinned to the configured URL.
 *
 * Imported dynamically so that simulated mode, and every test in this repo,
 * never pay the cost of loading the SDK and viem.
 */
export async function defaultFacilitator(): Promise<BatchFacilitatorLike> {
  if (cachedFacilitator) return cachedFacilitator;
  const { BatchFacilitatorClient } = await import('@circle-fin/x402-batching/server');
  // `url` is the whole point: without it the SDK talks to MAINNET.
  cachedFacilitator = new BatchFacilitatorClient({
    url: facilitatorUrl(),
  }) as unknown as BatchFacilitatorLike;
  return cachedFacilitator;
}

/** Test helper: drop the memoised facilitator. */
export function resetFacilitator(): void {
  cachedFacilitator = undefined;
}

/**
 * Verify and settle a buyer's base64 PAYMENT-SIGNATURE against our requirements.
 *
 * Returns a typed result and never throws for an ordinary payment failure: a
 * bad payment is an expected outcome on this route, not an exception.
 */
export async function verifyAndSettle(
  paymentPayloadB64: string | undefined,
  requirements: X402PaymentRequirements,
  options: VerifyAndSettleOptions = {},
): Promise<X402SettleResult> {
  if (!paymentPayloadB64) {
    return { ok: false, code: 'MISSING_PAYMENT', reason: 'no PAYMENT-SIGNATURE header' };
  }

  let payload: X402PaymentPayload;
  try {
    payload = decodeHeaderJson<X402PaymentPayload>(paymentPayloadB64);
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'MALFORMED_PAYMENT',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.payload !== 'object' ||
    payload.payload === null
  ) {
    return { ok: false, code: 'MALFORMED_PAYMENT', reason: 'payment payload is not an object' };
  }
  if (payload.x402Version !== X402_VERSION) {
    return {
      ok: false,
      code: 'WRONG_VERSION',
      reason: `expected x402 version ${X402_VERSION}, got ${String(payload.x402Version)}`,
    };
  }

  const facilitator = options.facilitator ?? (await defaultFacilitator());

  try {
    if (options.verifyFirst && facilitator.verify) {
      const verified = await facilitator.verify(payload, requirements);
      if (!verified.isValid) {
        return {
          ok: false,
          code: 'VERIFY_FAILED',
          reason: verified.invalidReason ?? 'facilitator rejected the authorization',
          ...(verified.payer === undefined ? {} : { payer: verified.payer }),
        };
      }
    }

    const settled = await facilitator.settle(payload, requirements);
    if (!settled.success) {
      return {
        ok: false,
        code: 'SETTLE_FAILED',
        reason: settled.errorReason ?? 'facilitator declined settlement',
        ...(settled.payer === undefined ? {} : { payer: settled.payer }),
      };
    }

    return {
      ok: true,
      payer: settled.payer ?? '',
      amount: requirements.amount,
      paymentRef: settled.transaction,
      batched: true,
      onchain: false,
      network: settled.network || requirements.network,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      code: 'FACILITATOR_ERROR',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
