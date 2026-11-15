/**
 * The BUYER half of the x402 viewer unlock.
 *
 * In test mode every viewer shares ONE pooled wallet (VIEWER_POOL_PRIVATE_KEY).
 * That is a deliberate hackathon shortcut and it is labelled as one everywhere
 * it surfaces: we are not pretending each browser tab owns a funded EOA.
 *
 * HOW A REAL BUYER PAYMENT WORKS (and why `ensureDeposit` exists):
 *  - Gateway payments are gasless for the buyer AT PAY TIME, but only because
 *    the buyer has already PRE-DEPOSITED USDC into the Gateway Wallet.
 *  - `deposit()` is approve + deposit: TWO real on-chain transactions, which
 *    need native 18-decimal gas USDC on Arc as well as the ERC-20 balance.
 *  - Gateway verifies EOA signatures only. ERC-1271 / smart-contract wallets
 *    are rejected, so the pooled wallet must be a plain EOA.
 *
 * SIMULATED MODE is the default right now: with no VIEWER_POOL_PRIVATE_KEY,
 * `config.capabilities.x402Payments` is false. We then return a DETERMINISTIC
 * fake reference prefixed `sim:` and set `simulated: true`. We never invent a
 * transaction hash - `txHash` is null on every simulated path, so nothing in
 * the UI can offer a bogus "verify on Arc" link.
 */

import { createHash } from 'node:crypto';
import {
  GATEWAY_CHAIN_NAME,
  micros,
  USDC_ERC20_DECIMALS,
  type Micros,
} from '@parrot/shared';
import { getConfig, type Config } from '../config.js';

type Hex = `0x${string}`;

// ---------------------------------------------------------------------------
// The slice of GatewayClient we use. Structural, so tests inject a fake and
// neither the SDK nor viem is ever loaded in a test run.
// ---------------------------------------------------------------------------

export interface GatewayBalancesLike {
  wallet: { balance: bigint; formatted: string };
  gateway: {
    total: bigint;
    available: bigint;
    withdrawing: bigint;
    withdrawable: bigint;
    formattedTotal: string;
    formattedAvailable: string;
    formattedWithdrawing: string;
    formattedWithdrawable: string;
  };
}

export interface GatewayDepositResultLike {
  approvalTxHash?: Hex;
  depositTxHash: Hex;
  amount: bigint;
  formattedAmount: string;
  depositor: string;
}

export interface GatewayPayResultLike<T = unknown> {
  data: T;
  amount: bigint;
  formattedAmount: string;
  /** Gateway's settlement reference. NOT a confirmed on-chain tx hash. */
  transaction: string;
  status: number;
}

export interface GatewayClientLike {
  readonly address: string;
  getBalances(address?: string): Promise<GatewayBalancesLike>;
  deposit(
    amount: string,
    options?: { approveAmount?: string; skipApprovalCheck?: boolean },
  ): Promise<GatewayDepositResultLike>;
  pay<T = unknown>(
    url: string,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<GatewayPayResultLike<T>>;
  withdraw(
    amount: string,
    options?: { chain?: string; recipient?: string; maxFee?: string },
  ): Promise<{
    mintTxHash: Hex;
    amount: bigint;
    formattedAmount: string;
    sourceChain: string;
    destinationChain: string;
    recipient: string;
  }>;
}

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

/**
 * Micros -> the plain decimal string the Gateway SDK wants ("20000" -> "0.02").
 *
 * NOT formatUsd(): that is for humans and adds "$" and thousands separators,
 * both of which the SDK would choke on.
 */
export function microsToDecimalString(amount: Micros): string {
  const raw = amount as bigint;
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(USDC_ERC20_DECIMALS);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(USDC_ERC20_DECIMALS, '0').replace(/0+$/, '');
  const body = frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ViewerPaymentResult<T = unknown> {
  /** `sim:<hash>` in simulated mode, Gateway's reference otherwise. */
  readonly paymentRef: string;
  readonly amount: Micros;
  readonly simulated: boolean;
  /**
   * ALWAYS null. A Gateway payment credits a batched balance; no on-chain
   * transaction exists at pay time, simulated or not. Kept on the type so
   * callers are not tempted to read `paymentRef` as a hash.
   */
  readonly txHash: null;
  readonly status: number;
  readonly data: T | null;
}

export interface ViewerDepositResult {
  readonly simulated: boolean;
  /** False when the existing Gateway balance already covered `minMicros`. */
  readonly deposited: boolean;
  readonly amount: Micros;
  /** Real approve/deposit hashes, or null when nothing was broadcast. */
  readonly approvalTxHash: string | null;
  readonly depositTxHash: string | null;
  readonly gatewayAvailable: Micros;
}

export interface ViewerBalances {
  readonly simulated: boolean;
  readonly address: string | null;
  /** Plain ERC-20 USDC sitting in the EOA. */
  readonly wallet: Micros;
  /** Deposited into the Gateway Wallet and spendable on x402 payments. */
  readonly gatewayAvailable: Micros;
  readonly gatewayTotal: Micros;
  readonly gatewayWithdrawable: Micros;
}

export interface ViewerPaymentClientOptions {
  readonly config?: Config;
  /** Inject a fake GatewayClient in tests. */
  readonly gatewayFactory?: () => Promise<GatewayClientLike>;
  /** Force simulated mode regardless of capabilities (demos, smoke tests). */
  readonly forceSimulated?: boolean;
}

// ---------------------------------------------------------------------------

const ZERO = micros(0n);

/**
 * The pooled test-mode viewer wallet, wrapped so callers never see the
 * difference between "paid for real" and "simulated" except through the
 * `simulated` flag they are obliged to render.
 */
export class ViewerPaymentClient {
  private readonly cfg: Config;
  private readonly gatewayFactory: (() => Promise<GatewayClientLike>) | undefined;
  private readonly forced: boolean;
  private gatewayPromise: Promise<GatewayClientLike> | undefined;

  constructor(options: ViewerPaymentClientOptions = {}) {
    this.cfg = options.config ?? getConfig();
    this.gatewayFactory = options.gatewayFactory;
    this.forced = options.forceSimulated === true;
  }

  /**
   * True when we cannot take real money: no pooled key, no revenue key, or a
   * caller explicitly asked for a dry run.
   */
  get simulated(): boolean {
    if (this.forced) return true;
    if (this.gatewayFactory) return false;
    return !this.cfg.capabilities.x402Payments;
  }

  /** The facilitator/Gateway API this client talks to. Testnet, from config. */
  get facilitatorUrl(): string {
    return this.cfg.env.GATEWAY_FACILITATOR_URL;
  }

  /**
   * Lazily build the real GatewayClient.
   *
   * `chain: 'arcTestnet'` AND the testnet rpcUrl are both required: the SDK
   * otherwise picks a public default, and its API base defaults to MAINNET.
   */
  private async gateway(): Promise<GatewayClientLike> {
    if (this.simulated) {
      throw new Error('ViewerPaymentClient is in simulated mode: no Gateway client exists');
    }
    this.gatewayPromise ??= this.buildGateway();
    return this.gatewayPromise;
  }

  private async buildGateway(): Promise<GatewayClientLike> {
    if (this.gatewayFactory) return this.gatewayFactory();
    const privateKey = this.cfg.env.VIEWER_POOL_PRIVATE_KEY;
    if (!privateKey) throw new Error('VIEWER_POOL_PRIVATE_KEY is not set');
    const { GatewayClient } = await import('@circle-fin/x402-batching/client');
    return new GatewayClient({
      chain: GATEWAY_CHAIN_NAME,
      privateKey: privateKey as Hex,
      rpcUrl: this.cfg.rpcUrl,
      token: 'USDC',
    }) as unknown as GatewayClientLike;
  }

  /**
   * Make sure the pooled wallet has at least `minMicros` SPENDABLE inside the
   * Gateway Wallet, depositing the shortfall if not.
   *
   * A deposit is two real transactions (approve, then deposit) and needs native
   * gas USDC, so this is a slow, once-per-session call - never put it on the
   * unlock hot path.
   */
  async ensureDeposit(minMicros: Micros): Promise<ViewerDepositResult> {
    if ((minMicros as bigint) < 0n) {
      throw new RangeError('ensureDeposit needs a non-negative minimum');
    }

    if (this.simulated) {
      return {
        simulated: true,
        deposited: false,
        amount: ZERO,
        approvalTxHash: null,
        depositTxHash: null,
        gatewayAvailable: ZERO,
      };
    }

    const gateway = await this.gateway();
    const before = await gateway.getBalances();
    const available = micros(before.gateway.available);
    if ((available as bigint) >= (minMicros as bigint)) {
      return {
        simulated: false,
        deposited: false,
        amount: ZERO,
        approvalTxHash: null,
        depositTxHash: null,
        gatewayAvailable: available,
      };
    }

    const shortfall = micros((minMicros as bigint) - (available as bigint));
    if ((before.wallet.balance as bigint) < (shortfall as bigint)) {
      throw new Error(
        `pooled viewer wallet holds ${microsToDecimalString(micros(before.wallet.balance))} USDC, ` +
          `short of the ${microsToDecimalString(shortfall)} it must deposit. ` +
          'Top it up at https://faucet.circle.com.',
      );
    }

    const result = await gateway.deposit(microsToDecimalString(shortfall));
    const after = await gateway.getBalances();
    return {
      simulated: false,
      deposited: true,
      amount: micros(result.amount),
      approvalTxHash: result.approvalTxHash ?? null,
      depositTxHash: result.depositTxHash,
      gatewayAvailable: micros(after.gateway.available),
    };
  }

  /**
   * Pay for one x402-protected URL.
   *
   * The real path hands the whole 402 dance to the SDK: it requests, reads the
   * PAYMENT-REQUIRED challenge, signs the EIP-3009 authorization against the
   * GATEWAY WALLET, and retries with PAYMENT-SIGNATURE.
   */
  async payFor<T = unknown>(
    url: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      headers?: Record<string, string>;
      /** Expected price, used only to label the simulated result honestly. */
      expectedAmount?: Micros;
    } = {},
  ): Promise<ViewerPaymentResult<T>> {
    if (this.simulated) {
      return {
        paymentRef: simulatedPaymentRef(url),
        amount: options.expectedAmount ?? ZERO,
        simulated: true,
        txHash: null,
        status: 200,
        data: null,
      };
    }

    const gateway = await this.gateway();
    const payOptions: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: unknown;
      headers?: Record<string, string>;
    } = {};
    if (options.method !== undefined) payOptions.method = options.method;
    if (options.body !== undefined) payOptions.body = options.body;
    if (options.headers !== undefined) payOptions.headers = options.headers;

    const result = await gateway.pay<T>(url, payOptions);
    return {
      paymentRef: result.transaction,
      amount: micros(result.amount),
      simulated: false,
      // Still null. Gateway batches; nothing is on-chain yet. See file header.
      txHash: null,
      status: result.status,
      data: result.data,
    };
  }

  /** Wallet and Gateway balances for the pooled wallet. */
  async balances(): Promise<ViewerBalances> {
    if (this.simulated) {
      return {
        simulated: true,
        address: null,
        wallet: ZERO,
        gatewayAvailable: ZERO,
        gatewayTotal: ZERO,
        gatewayWithdrawable: ZERO,
      };
    }
    const gateway = await this.gateway();
    const b = await gateway.getBalances();
    return {
      simulated: false,
      address: gateway.address,
      wallet: micros(b.wallet.balance),
      gatewayAvailable: micros(b.gateway.available),
      gatewayTotal: micros(b.gateway.total),
      gatewayWithdrawable: micros(b.gateway.withdrawable),
    };
  }
}

/**
 * A deterministic, obviously-fake payment reference.
 *
 * Deterministic on purpose: replaying the same simulated unlock produces the
 * same reference, so `recordUnlock` stays idempotent in demo mode exactly as it
 * is with a real Gateway reference. The `sim:` prefix is checked by the UI, and
 * the digest is only 16 hex chars so it can never be mistaken for a 32-byte
 * transaction hash.
 */
export function simulatedPaymentRef(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
  return `sim:${digest.slice(0, 16)}`;
}

/** True for a reference this module fabricated. Never render these as a tx. */
export function isSimulatedPaymentRef(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith('sim:');
}
