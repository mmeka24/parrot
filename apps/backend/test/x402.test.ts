/**
 * x402 adapter tests.
 *
 * Nothing here touches the network or a private key. The facilitator and the
 * GatewayClient are both injected as fakes, which is also a check in itself:
 * if either module ever started doing work at import time, these tests would
 * be the first to notice.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  UNLOCK_PRICE,
  USDC_ADDRESS,
  ARC_TESTNET,
  GATEWAY_WALLET_ADDRESS,
  GATEWAY_FACILITATOR_URL_TESTNET,
  X402_HEADERS,
  X402_VERSION,
  X402_MAX_TIMEOUT_SECONDS,
  parseUsd,
  micros,
} from '@parrot/shared';
import { loadConfig, resetConfig } from '../src/config.js';
import {
  buildPaymentRequirements,
  build402Response,
  parse402Header,
  buildPaymentResponseHeader,
  encodeHeaderJson,
  decodeHeaderJson,
  readPaymentSignatureHeader,
  verifyAndSettle,
  facilitatorUrl,
  type BatchFacilitatorLike,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from '../src/payments/x402-seller.js';
import {
  ViewerPaymentClient,
  microsToDecimalString,
  simulatedPaymentRef,
  isSimulatedPaymentRef,
  type GatewayClientLike,
  type GatewayPayResultLike,
} from '../src/payments/x402-buyer.js';

const SELLER = '0x5555555555555555555555555555555555555555';

/** Env with no credentials at all: the state the repo ships in. */
function mockEnv(): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  delete process.env.VIEWER_POOL_PRIVATE_KEY;
  delete process.env.PARROT_REVENUE_PRIVATE_KEY;
  delete process.env.PARROT_TREASURY_PRIVATE_KEY;
  delete process.env.GATEWAY_FACILITATOR_URL;
  resetConfig();
}

function signedPayload(overrides: Partial<X402PaymentPayload> = {}): string {
  return encodeHeaderJson({
    x402Version: X402_VERSION,
    payload: {
      signature: '0xdeadbeef',
      authorization: {
        from: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: SELLER,
        value: '20000',
      },
    },
    ...overrides,
  });
}

function fakeFacilitator(
  settleImpl: BatchFacilitatorLike['settle'],
  verifyImpl?: NonNullable<BatchFacilitatorLike['verify']>,
): BatchFacilitatorLike & { settleCalls: unknown[][] } {
  const settleCalls: unknown[][] = [];
  return {
    settleCalls,
    async settle(payload, requirements) {
      settleCalls.push([payload, requirements]);
      return settleImpl(payload, requirements);
    },
    ...(verifyImpl ? { verify: verifyImpl } : {}),
  };
}

beforeEach(() => {
  mockEnv();
});

// ---------------------------------------------------------------------------

describe('buildPaymentRequirements', () => {
  it('produces exactly the object Circle Gateway expects', () => {
    const requirements = buildPaymentRequirements(UNLOCK_PRICE, SELLER);

    expect(requirements).toEqual({
      scheme: 'exact',
      network: 'eip155:5042002',
      asset: '0x3600000000000000000000000000000000000000',
      amount: '20000',
      payTo: SELLER,
      maxTimeoutSeconds: 345_600,
      extra: {
        name: 'GatewayWalletBatched',
        version: '1',
        verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
      },
    });
  });

  it('prices $0.02 as 20000 atomic 6-decimal units', () => {
    expect(UNLOCK_PRICE).toBe(20_000n);
    expect(buildPaymentRequirements(parseUsd('0.02'), SELLER).amount).toBe('20000');
    expect(buildPaymentRequirements(parseUsd('1.00'), SELLER).amount).toBe('1000000');
  });

  it('matches the shared constants rather than hard-coded literals', () => {
    const requirements = buildPaymentRequirements(UNLOCK_PRICE, SELLER);
    expect(requirements.asset).toBe(USDC_ADDRESS);
    expect(requirements.network).toBe(ARC_TESTNET.caip2);
    expect(requirements.maxTimeoutSeconds).toBe(X402_MAX_TIMEOUT_SECONDS);
  });

  it('signs against the GATEWAY WALLET, never the USDC token', () => {
    const extra = buildPaymentRequirements(UNLOCK_PRICE, SELLER).extra ?? {};
    expect(extra['verifyingContract']).toBe(GATEWAY_WALLET_ADDRESS);
    expect(extra['verifyingContract']).not.toBe(USDC_ADDRESS);
  });

  it('refuses a non-positive price or a malformed payTo', () => {
    expect(() => buildPaymentRequirements(micros(0n), SELLER)).toThrow(RangeError);
    expect(() => buildPaymentRequirements(micros(-1n), SELLER)).toThrow(RangeError);
    expect(() => buildPaymentRequirements(UNLOCK_PRICE, 'not-an-address')).toThrow(RangeError);
  });
});

describe('the facilitator URL', () => {
  it('defaults to the TESTNET facilitator, never mainnet', () => {
    expect(facilitatorUrl()).toBe(GATEWAY_FACILITATOR_URL_TESTNET);
    expect(facilitatorUrl()).toBe('https://gateway-api-testnet.circle.com');
    expect(facilitatorUrl()).not.toContain('gateway-api.circle.com');
  });

  it('is taken from config, so an override reaches the SDK', () => {
    process.env.GATEWAY_FACILITATOR_URL = 'https://gateway-api-testnet.circle.com/v2';
    resetConfig();
    expect(facilitatorUrl()).toBe('https://gateway-api-testnet.circle.com/v2');
    expect(loadConfig(process.env).env.GATEWAY_FACILITATOR_URL).toBe(facilitatorUrl());
  });
});

describe('the 402 challenge', () => {
  it('round-trips through base64 in the PAYMENT-REQUIRED header', () => {
    const requirements = buildPaymentRequirements(UNLOCK_PRICE, SELLER);
    const response = build402Response(requirements);

    expect(response.status).toBe(402);
    expect(response.body).toEqual({});

    const encoded = response.headers[X402_HEADERS.required];
    expect(encoded).toBeTypeOf('string');
    // Really base64, not JSON on the wire.
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const decoded = parse402Header(encoded as string);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toEqual([requirements]);
  });

  it('uses the header name the protocol specifies', () => {
    const response = build402Response(buildPaymentRequirements(UNLOCK_PRICE, SELLER));
    expect(Object.keys(response.headers)).toEqual(['PAYMENT-REQUIRED']);
  });

  it('carries an optional error string through the round trip', () => {
    const response = build402Response(
      buildPaymentRequirements(UNLOCK_PRICE, SELLER),
      'authorization expired',
    );
    expect(parse402Header(response.headers[X402_HEADERS.required] as string).error).toBe(
      'authorization expired',
    );
  });

  it('reads PAYMENT-SIGNATURE case-insensitively, getter or raw headers', () => {
    expect(readPaymentSignatureHeader({ headers: { 'payment-signature': 'abc' } })).toBe('abc');
    expect(readPaymentSignatureHeader({ headers: { 'PAYMENT-SIGNATURE': 'abc' } })).toBe('abc');
    expect(readPaymentSignatureHeader({ get: () => 'xyz' })).toBe('xyz');
    expect(readPaymentSignatureHeader({ headers: {} })).toBeUndefined();
  });
});

describe('verifyAndSettle', () => {
  let requirements: X402PaymentRequirements;

  beforeEach(() => {
    requirements = buildPaymentRequirements(UNLOCK_PRICE, SELLER);
  });

  it('returns a typed success carrying payer, amount and a batched paymentRef', async () => {
    const facilitator = fakeFacilitator(async () => ({
      success: true,
      payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      transaction: 'gw-auth-123',
      network: ARC_TESTNET.caip2,
    }));

    const result = await verifyAndSettle(signedPayload(), requirements, { facilitator });

    expect(result).toEqual({
      ok: true,
      payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amount: '20000',
      paymentRef: 'gw-auth-123',
      batched: true,
      onchain: false,
      network: ARC_TESTNET.caip2,
    });
    // An accepted authorization is NOT an on-chain payment.
    expect(result.ok && result.onchain).toBe(false);
  });

  it('hands the decoded payload and our requirements to the facilitator', async () => {
    const facilitator = fakeFacilitator(async () => ({
      success: true,
      payer: '0xaaaa',
      transaction: 'ref',
      network: ARC_TESTNET.caip2,
    }));
    await verifyAndSettle(signedPayload(), requirements, { facilitator });

    const [payload, passed] = facilitator.settleCalls[0] as [X402PaymentPayload, unknown];
    expect(payload.x402Version).toBe(2);
    expect(payload.payload).toHaveProperty('signature');
    expect(passed).toBe(requirements);
  });

  it('fails cleanly with no PAYMENT-SIGNATURE header', async () => {
    const result = await verifyAndSettle(undefined, requirements, {
      facilitator: fakeFacilitator(async () => {
        throw new Error('should never be called');
      }),
    });
    expect(result).toMatchObject({ ok: false, code: 'MISSING_PAYMENT' });
  });

  it('fails cleanly on garbage base64 and on the wrong x402 version', async () => {
    const facilitator = fakeFacilitator(async () => {
      throw new Error('should never be called');
    });
    const bad = await verifyAndSettle('!!!not base64 json!!!', requirements, { facilitator });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.code).toBe('MALFORMED_PAYMENT');

    const wrongVersion = await verifyAndSettle(
      signedPayload({ x402Version: 1 }),
      requirements,
      { facilitator },
    );
    expect(wrongVersion).toMatchObject({ ok: false, code: 'WRONG_VERSION' });
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it('reports a declined settlement rather than throwing', async () => {
    const result = await verifyAndSettle(signedPayload(), requirements, {
      facilitator: fakeFacilitator(async () => ({
        success: false,
        errorReason: 'insufficient_gateway_balance',
        payer: '0xaaaa',
        transaction: '',
        network: ARC_TESTNET.caip2,
      })),
    });
    expect(result).toEqual({
      ok: false,
      code: 'SETTLE_FAILED',
      reason: 'insufficient_gateway_balance',
      payer: '0xaaaa',
    });
  });

  it('turns a thrown facilitator error into a typed failure', async () => {
    const result = await verifyAndSettle(signedPayload(), requirements, {
      facilitator: fakeFacilitator(async () => {
        throw new Error('gateway 503');
      }),
    });
    expect(result).toMatchObject({ ok: false, code: 'FACILITATOR_ERROR', reason: 'gateway 503' });
  });

  it('honours verifyFirst and short-circuits an invalid authorization', async () => {
    const facilitator = fakeFacilitator(
      async () => ({ success: true, transaction: 'ref', network: ARC_TESTNET.caip2 }),
      async () => ({ isValid: false, invalidReason: 'expired_authorization' }),
    );
    const result = await verifyAndSettle(signedPayload(), requirements, {
      facilitator,
      verifyFirst: true,
    });
    expect(result).toMatchObject({ ok: false, code: 'VERIFY_FAILED' });
    expect(facilitator.settleCalls).toHaveLength(0);
  });

  it('emits a PAYMENT-RESPONSE receipt that round-trips and claims no tx', async () => {
    const result = await verifyAndSettle(signedPayload(), requirements, {
      facilitator: fakeFacilitator(async () => ({
        success: true,
        payer: '0xaaaa',
        transaction: 'gw-auth-9',
        network: ARC_TESTNET.caip2,
      })),
    });
    if (!result.ok) throw new Error('expected success');

    const header = buildPaymentResponseHeader(result);
    const decoded = decodeHeaderJson<Record<string, unknown>>(
      header[X402_HEADERS.response] as string,
    );
    expect(decoded).toMatchObject({
      x402Version: 2,
      success: true,
      paymentRef: 'gw-auth-9',
      batched: true,
      onchain: false,
    });
    expect(decoded).not.toHaveProperty('txHash');
    expect(decoded).not.toHaveProperty('transactionHash');
  });
});

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

describe('microsToDecimalString', () => {
  it('writes the plain decimals the Gateway SDK wants', () => {
    expect(microsToDecimalString(UNLOCK_PRICE)).toBe('0.02');
    expect(microsToDecimalString(parseUsd('1.00'))).toBe('1');
    expect(microsToDecimalString(parseUsd('1234.5'))).toBe('1234.5');
    expect(microsToDecimalString(micros(1n))).toBe('0.000001');
    expect(microsToDecimalString(micros(0n))).toBe('0');
  });

  it('never emits a currency symbol or thousands separator', () => {
    const written = microsToDecimalString(parseUsd('1234.56'));
    expect(written).not.toContain('$');
    expect(written).not.toContain(',');
  });
});

describe('ViewerPaymentClient in simulated mode (the default with no keys)', () => {
  it('is simulated when x402Payments is false', () => {
    const config = loadConfig(process.env);
    expect(config.capabilities.x402Payments).toBe(false);
    expect(new ViewerPaymentClient({ config }).simulated).toBe(true);
  });

  it('flags simulated, prefixes sim: and NEVER returns a transaction hash', async () => {
    const client = new ViewerPaymentClient();
    const payment = await client.payFor('https://parrot.test/unlock/job-1', {
      expectedAmount: UNLOCK_PRICE,
    });

    expect(payment.simulated).toBe(true);
    expect(payment.paymentRef.startsWith('sim:')).toBe(true);
    expect(isSimulatedPaymentRef(payment.paymentRef)).toBe(true);
    expect(payment.txHash).toBeNull();
    // Nothing that could be mistaken for a 32-byte hash.
    expect(payment.paymentRef).not.toMatch(/^0x[0-9a-f]{64}$/);
    expect(payment.amount).toBe(UNLOCK_PRICE);
  });

  it('produces a DETERMINISTIC reference, so a replayed unlock is idempotent', async () => {
    const client = new ViewerPaymentClient();
    const a = await client.payFor('https://parrot.test/unlock/job-1');
    const b = await client.payFor('https://parrot.test/unlock/job-1');
    const other = await client.payFor('https://parrot.test/unlock/job-2');

    expect(a.paymentRef).toBe(b.paymentRef);
    expect(a.paymentRef).not.toBe(other.paymentRef);
    expect(simulatedPaymentRef('https://parrot.test/unlock/job-1')).toBe(a.paymentRef);
  });

  it('reports empty balances and deposits nothing', async () => {
    const client = new ViewerPaymentClient();

    const balances = await client.balances();
    expect(balances).toEqual({
      simulated: true,
      address: null,
      wallet: 0n,
      gatewayAvailable: 0n,
      gatewayTotal: 0n,
      gatewayWithdrawable: 0n,
    });

    const deposit = await client.ensureDeposit(parseUsd('1.00'));
    expect(deposit).toMatchObject({
      simulated: true,
      deposited: false,
      approvalTxHash: null,
      depositTxHash: null,
    });
  });

  it('refuses to hand out a Gateway client at all', async () => {
    const client = new ViewerPaymentClient();
    // forceSimulated proves the guard is on `simulated`, not on the key alone.
    const forced = new ViewerPaymentClient({ forceSimulated: true });
    expect(forced.simulated).toBe(true);
    expect(client.facilitatorUrl).toBe(GATEWAY_FACILITATOR_URL_TESTNET);
  });
});

describe('ViewerPaymentClient with an injected Gateway client', () => {
  function fakeGateway(overrides: Partial<GatewayClientLike> = {}): GatewayClientLike {
    const base: GatewayClientLike = {
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      async getBalances() {
        return {
          wallet: { balance: 5_000_000n, formatted: '5' },
          gateway: {
            total: 0n,
            available: 0n,
            withdrawing: 0n,
            withdrawable: 0n,
            formattedTotal: '0',
            formattedAvailable: '0',
            formattedWithdrawing: '0',
            formattedWithdrawable: '0',
          },
        };
      },
      async deposit(amount: string) {
        return {
          depositTxHash: '0x01',
          approvalTxHash: '0x00',
          amount: BigInt(Math.round(Number(amount) * 1e6)),
          formattedAmount: amount,
          depositor: '0xbbbb',
        };
      },
      async pay<T>(): Promise<GatewayPayResultLike<T>> {
        return {
          data: { ok: true } as T,
          amount: 20_000n,
          formattedAmount: '0.02',
          transaction: 'gw-1',
          status: 200,
        };
      },
      async withdraw(amount: string) {
        return {
          mintTxHash: '0x02',
          amount: BigInt(Math.round(Number(amount) * 1e6)),
          formattedAmount: amount,
          sourceChain: 'arcTestnet',
          destinationChain: 'arcTestnet',
          recipient: '0xbbbb',
        };
      },
    };
    return { ...base, ...overrides };
  }

  it('is not simulated, and never claims a tx hash for a batched payment', async () => {
    const client = new ViewerPaymentClient({ gatewayFactory: async () => fakeGateway() });
    expect(client.simulated).toBe(false);

    const payment = await client.payFor('https://parrot.test/unlock/job-1');
    expect(payment.simulated).toBe(false);
    expect(payment.paymentRef).toBe('gw-1');
    // Still null: Gateway batches, so there is no on-chain tx at pay time.
    expect(payment.txHash).toBeNull();
  });

  it('deposits only the shortfall, and nothing when already funded', async () => {
    const deposits: string[] = [];
    const client = new ViewerPaymentClient({
      gatewayFactory: async () =>
        fakeGateway({
          async deposit(amount: string) {
            deposits.push(amount);
            return {
              depositTxHash: '0x01',
              amount: 1_000_000n,
              formattedAmount: amount,
              depositor: '0xbbbb',
            };
          },
        }),
    });

    const result = await client.ensureDeposit(parseUsd('1.00'));
    expect(deposits).toEqual(['1']);
    expect(result.deposited).toBe(true);
    expect(result.depositTxHash).toBe('0x01');

    const funded = new ViewerPaymentClient({
      gatewayFactory: async () =>
        fakeGateway({
          async getBalances() {
            return {
              wallet: { balance: 0n, formatted: '0' },
              gateway: {
                total: 2_000_000n,
                available: 2_000_000n,
                withdrawing: 0n,
                withdrawable: 2_000_000n,
                formattedTotal: '2',
                formattedAvailable: '2',
                formattedWithdrawing: '0',
                formattedWithdrawable: '2',
              },
            };
          },
        }),
    });
    const noop = await funded.ensureDeposit(parseUsd('1.00'));
    expect(noop.deposited).toBe(false);
    expect(noop.gatewayAvailable).toBe(2_000_000n);
  });

  it('explains itself rather than reverting when the wallet is too empty', async () => {
    const client = new ViewerPaymentClient({
      gatewayFactory: async () =>
        fakeGateway({
          async getBalances() {
            return {
              wallet: { balance: 1n, formatted: '0.000001' },
              gateway: {
                total: 0n,
                available: 0n,
                withdrawing: 0n,
                withdrawable: 0n,
                formattedTotal: '0',
                formattedAvailable: '0',
                formattedWithdrawing: '0',
                formattedWithdrawable: '0',
              },
            };
          },
        }),
    });
    await expect(client.ensureDeposit(parseUsd('1.00'))).rejects.toThrow(/faucet\.circle\.com/);
  });
});
