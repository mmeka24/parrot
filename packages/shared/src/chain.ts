/**
 * Arc testnet and Circle Gateway constants.
 *
 * Every value here was verified against official docs on 2026-11-15. Sources are
 * inline. Do not "fix" one of these from memory - re-check the source first.
 *
 * The 6-vs-18 decimal trap is handled in units.ts, not here.
 */

/** Source: https://docs.arc.io/arc/references/connect-to-arc.md */
export const ARC_TESTNET = {
  chainId: 5042002,
  name: 'Arc Testnet',
  rpcUrl: 'https://rpc.testnet.arc.io',
  wsUrl: 'wss://rpc.testnet.arc.io',
  /**
   * Canonical per Arc's own docs. (testnet.arcscan.app is a third-party
   * explorer that appears only in Circle's starter repo; we do not use it.)
   */
  explorerUrl: 'https://explorer.testnet.arc.io',
  faucetUrl: 'https://faucet.circle.com',
  /** CAIP-2 identifier used by x402 payment requirements. */
  caip2: 'eip155:5042002',
  /** Circle CCTP/Gateway domain for Arc. */
  gatewayDomain: 26,
} as const;

/**
 * USDC on Arc. The SAME address on mainnet and testnet.
 * ERC-20 interface: 6 decimals. Native gas USDC: 18 decimals. See units.ts.
 * Source: https://docs.arc.io/arc/references/contract-addresses.md
 */
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;

/**
 * Circle Gateway contracts on Arc TESTNET.
 * Source: https://docs.arc.io/arc/references/contract-addresses.md
 */
export const GATEWAY_WALLET_ADDRESS = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;
export const GATEWAY_MINTER_ADDRESS = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const;

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

/**
 * Arc's mempool enforces a 20 Gwei maxFeePerGas floor; under-priced
 * transactions are rejected outright. Source: https://docs.arc.io
 */
export const ARC_MIN_MAX_FEE_PER_GAS_WEI = 20_000_000_000n;

/**
 * Testnet-only blocklisted address (Anvil private key index 1). All value
 * transfers to or from it revert. Guarded against in PaymentService so a
 * copy-pasted demo key cannot produce a confusing on-chain failure.
 * Source: https://docs.arc.io/arc/references/contract-addresses.md
 */
export const ARC_BLOCKLISTED_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

/**
 * Circle Gateway Nanopayments facilitator.
 *
 * GOTCHA: @circle-fin/x402-batching defaults to the MAINNET facilitator. We must
 * pass the testnet URL explicitly everywhere, or verification silently targets
 * mainnet and nothing works.
 * Source: https://developers.circle.com/gateway-nanopayments/quickstarts/seller.md
 */
export const GATEWAY_FACILITATOR_URL_TESTNET = 'https://gateway-api-testnet.circle.com' as const;
export const GATEWAY_FACILITATOR_URL_MAINNET = 'https://gateway-api.circle.com' as const;

/**
 * Circle's per-payment (non-batched) Facilitator Service. Our documented
 * fallback if Gateway batching is unavailable: it settles each payment on-chain
 * from the buyer's own USDC, needs no deposit, but costs gas per payment.
 * Supports eip155:5042002 with the `exact` and `upto` schemes.
 * Source: https://developers.circle.com/facilitator-service/supported-networks.md
 */
export const CIRCLE_FACILITATOR_URL = 'https://api.circle.com/v1/facilitator/x402' as const;

/**
 * EIP-712 parameters the buyer signs for a batched Gateway payment.
 *
 * The important subtlety: this is an EIP-3009 TransferWithAuthorization, but the
 * verifyingContract is the GATEWAY WALLET contract, not the USDC token.
 * Version "2" additionally sets `salt` to the asset address left-padded to 32
 * bytes. Source: @circle-fin/x402-batching type definitions +
 * https://developers.circle.com/gateway-nanopayments/concepts/batched-settlement.md
 */
export const GATEWAY_BATCHING_EIP712 = {
  name: 'GatewayWalletBatched',
  scheme: 'exact',
  versions: ['1', '2'],
  verifyingContract: GATEWAY_WALLET_ADDRESS,
} as const;

/** x402 protocol version Circle Gateway uses, and its header names. */
export const X402_VERSION = 2 as const;
export const X402_HEADERS = {
  /** Seller -> buyer: base64 JSON describing what is required. */
  required: 'PAYMENT-REQUIRED',
  /** Buyer -> seller: base64 JSON of the signed payment payload. */
  signature: 'PAYMENT-SIGNATURE',
  /** Seller -> buyer: base64 JSON receipt. */
  response: 'PAYMENT-RESPONSE',
} as const;

/** Longest a payment authorization stays valid. Matches Circle's starter repo. */
export const X402_MAX_TIMEOUT_SECONDS = 345_600;

/** Chain name string the @circle-fin/x402-batching GatewayClient expects. */
export const GATEWAY_CHAIN_NAME = 'arcTestnet' as const;

/** Build an explorer link for a transaction. Used only in receipts and judge views. */
export function txUrl(txHash: string): string {
  return `${ARC_TESTNET.explorerUrl}/tx/${txHash}`;
}

/** Build an explorer link for an address. */
export function addressUrl(address: string): string {
  return `${ARC_TESTNET.explorerUrl}/address/${address}`;
}

/**
 * Minimal ERC-20 ABI. Settlements are plain `transfer` calls on the USDC
 * interface; we never need more than this.
 */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** keccak256("Transfer(address,address,uint256)") - the QuickNode Stream filter topic. */
export const TRANSFER_EVENT_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;

/**
 * THE DOUBLE-COUNTING TRAP. Read this before touching the QuickNode filter.
 *
 * Arc reports USDC movement in TWO places:
 *   1. EIP-7708 system Transfer logs emitted by the native system address
 *      below, denominated in NATIVE 18-decimal USDC. This covers every USDC
 *      movement on the chain, including plain native transfers.
 *   2. The ERC-20 interface at USDC_ADDRESS, which mirrors movements in
 *      6-decimal ERC-20 units.
 *
 * An indexer that watches both counts the same dollar twice.
 *
 * Parrot settles by calling `transfer` on the ERC-20 interface, and its ledger
 * is denominated in 6-decimal micros, so we filter on USDC_ADDRESS ONLY and
 * read 6-decimal values. That makes stream amounts directly comparable to
 * ledger rows with no conversion. The trade-off we accept: a pure native-USDC
 * transfer (one that never touches the ERC-20 interface) would not appear in
 * our feed. Parrot never makes one, and gas is deducted with no Transfer event
 * at all, so this costs us nothing.
 *
 * Sources: https://docs.arc.io/arc/references/usdc-system-events and
 * https://www.quicknode.com/guides/arc/index-arc-usdc-movements-with-streams
 */
export const ARC_NATIVE_USDC_SYSTEM_EMITTER =
  '0xfffffffffffffffffffffffffffffffffffffffe' as const;

/** QuickNode Streams network slug for Arc testnet. Source: QuickNode OpenAPI spec enum. */
export const QUICKNODE_NETWORK = 'arc-testnet' as const;
/** The dataset the Arc USDC guide uses. */
export const QUICKNODE_DATASET = 'logs' as const;
/**
 * Arc blocks are sub-second, and QuickNode rejects a tip-following stream with
 * dataset_batch_size < 5 (HTTP 422). The Arc guide uses 10.
 * Source: https://www.quicknode.com/docs/streams/rest-api
 */
export const QUICKNODE_MIN_BATCH_SIZE = 5;
export const QUICKNODE_BATCH_SIZE = 10;
export const QUICKNODE_STREAMS_API = 'https://api.quicknode.com/streams/rest/v1' as const;

/**
 * Order stream rows by (blockNumber, logIndex), never by timestamp: Arc's
 * sub-second blocks mean many movements share a timestamp. Dedupe on this key.
 */
export function streamDedupeKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}
