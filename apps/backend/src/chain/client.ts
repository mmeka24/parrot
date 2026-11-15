/**
 * Arc testnet clients (viem).
 *
 * viem ships an `arcTestnet` chain definition, so we use it rather than hand-
 * rolling one - but we override the RPC URL from config, because the public
 * endpoint is rate-limited and a QuickNode endpoint is preferred when present.
 *
 * Note the chain's nativeCurrency is USDC with 18 decimals. That is the GAS
 * token. The ERC-20 USDC we move around has 6. units.ts is the only place
 * allowed to convert between them.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet } from 'viem/chains';
import {
  ARC_BLOCKLISTED_ADDRESS,
  ARC_MIN_MAX_FEE_PER_GAS_WEI,
  ERC20_ABI,
  USDC_ADDRESS,
  erc20UnitsToMicros,
  microsToErc20Units,
  nativeWeiToMicros,
  type Micros,
} from '@parrot/shared';
import { getConfig } from '../config.js';

export type { Address, Hex };

let publicClientCache: PublicClient | undefined;

export function getPublicClient(): PublicClient {
  if (!publicClientCache) {
    const { rpcUrl } = getConfig();
    publicClientCache = createPublicClient({
      chain: arcTestnet,
      transport: http(rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 20_000 }),
    }) as PublicClient;
  }
  return publicClientCache;
}

export function walletFromKey(privateKey: Hex): WalletClient {
  const { rpcUrl } = getConfig();
  return createWalletClient({
    account: privateKeyToAccount(privateKey),
    chain: arcTestnet,
    transport: http(rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 20_000 }),
  });
}

export function addressFromKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

export class BlocklistedAddressError extends Error {
  constructor(address: string) {
    super(
      `${address} is blocklisted on Arc testnet; all value transfers to or from it revert. ` +
        'This is usually a copy-pasted Anvil key (index 1).',
    );
    this.name = 'BlocklistedAddressError';
  }
}

/**
 * Arc testnet blocklists one well-known address (Anvil key index 1) and reverts
 * every transfer touching it. Catching it here turns a confusing on-chain
 * revert into an actionable error at call time.
 */
export function assertNotBlocklisted(address: string): void {
  if (getAddress(address) === getAddress(ARC_BLOCKLISTED_ADDRESS)) {
    throw new BlocklistedAddressError(address);
  }
}

/** ERC-20 USDC balance, in micros (6-decimal base units). */
export async function getUsdcBalance(address: Address): Promise<Micros> {
  const raw = await getPublicClient().readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
  return erc20UnitsToMicros(raw);
}

/** Native (gas) USDC balance, converted to micros for display. */
export async function getGasBalance(address: Address): Promise<Micros> {
  const wei = await getPublicClient().getBalance({ address });
  return nativeWeiToMicros(wei);
}

/**
 * Sanity check that the ERC-20 interface really is 6 decimals before we move
 * money through it. Cheap insurance against the single worst bug available to
 * us: a 10^12 misdenomination.
 */
export async function assertUsdcDecimals(): Promise<void> {
  const decimals = await getPublicClient().readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  if (decimals !== 6) {
    throw new Error(
      `USDC ERC-20 at ${USDC_ADDRESS} reports ${decimals} decimals, expected 6. ` +
        'Refusing to move money until this is understood.',
    );
  }
}

export interface TransferResult {
  readonly txHash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly amount: Micros;
}

/**
 * Send USDC on the ERC-20 interface and wait for the receipt.
 *
 * This is the ONLY place in the codebase that broadcasts a value transfer.
 * Everything that moves money goes through PaymentService, which goes through
 * here, so there is exactly one function to audit.
 *
 * Arc's mempool rejects transactions below a 20 Gwei maxFeePerGas, so the floor
 * is applied explicitly rather than trusting the RPC's fee estimate.
 */
export async function transferUsdc(
  privateKey: Hex,
  to: Address,
  amount: Micros,
): Promise<TransferResult> {
  if ((amount as bigint) <= 0n) {
    throw new RangeError(`refusing to transfer a non-positive amount: ${amount}`);
  }

  const wallet = walletFromKey(privateKey);
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  const from = account.address;

  assertNotBlocklisted(from);
  assertNotBlocklisted(to);

  const publicClient = getPublicClient();
  const fees = await publicClient.estimateFeesPerGas().catch(() => undefined);
  const maxFeePerGas =
    fees?.maxFeePerGas && fees.maxFeePerGas > ARC_MIN_MAX_FEE_PER_GAS_WEI
      ? fees.maxFeePerGas
      : ARC_MIN_MAX_FEE_PER_GAS_WEI;
  const maxPriorityFeePerGas =
    fees?.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
      ? fees.maxPriorityFeePerGas
      : 1_000_000_000n;

  const txHash = await wallet.writeContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, microsToErc20Units(amount)],
    chain: arcTestnet,
    account,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: 90_000,
  });

  if (receipt.status !== 'success') {
    throw new Error(`USDC transfer reverted on-chain: ${txHash}`);
  }

  return { txHash, from, to, amount };
}

/**
 * Retry wrapper for the nonce races that happen when several agents fund from
 * the same wallet. Circle's own starter repo ships an equivalent helper, which
 * is a decent signal that this is a real and expected failure mode on Arc.
 */
const NONCE_ERRORS = [
  'replacement transaction underpriced',
  'nonce too low',
  'already known',
  'nonce has already been used',
];

export async function withNonceRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const message = error instanceof Error ? error.message.toLowerCase() : String(error);
      const retriable = NONCE_ERRORS.some((needle) => message.includes(needle));
      if (!retriable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError;
}

/** Reset memoised clients. Test helper. */
export function resetChainClients(): void {
  publicClientCache = undefined;
}
