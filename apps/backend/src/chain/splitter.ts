/**
 * ParrotSplitter (contracts/ParrotSplitter.sol) client.
 *
 * Two calls, both optional - with no SPLITTER_ADDRESS configured the app
 * behaves exactly as before:
 *   - recordAuctionOnchain: the auction's result + a hash of every bid.
 *   - splitUnlockOnchain:   a viewer's payment, split by the contract straight
 *                           to the creator and the winning agent.
 */

import { keccak256, toHex, type Address, type Hex } from 'viem';
import { arcTestnet } from 'viem/chains';
import { ARC_MIN_MAX_FEE_PER_GAS_WEI, microsToErc20Units, type Micros } from '@parrot/shared';
import { getPublicClient, walletFromKey, withNonceRetry } from './client.js';

export const SPLITTER_ABI = [
  {
    type: 'function',
    name: 'recordAuction',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'creator', type: 'address' },
      { name: 'agent', type: 'address' },
      { name: 'agentBps', type: 'uint16' },
      { name: 'bidders', type: 'uint8' },
      { name: 'decisionsHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'recordQc',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'passed', type: 'bool' },
      { name: 'meaningScore', type: 'uint8' },
      { name: 'reportHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reputation',
    stateMutability: 'view',
    inputs: [{ name: 'agent', type: 'address' }],
    outputs: [
      { name: 'passed', type: 'uint32' },
      { name: 'failed', type: 'uint32' },
    ],
  },
  {
    type: 'function',
    name: 'unlock',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'unlockId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/** Parrot ids are strings; on-chain they are their keccak256. */
export const idToBytes32 = (id: string): Hex => keccak256(toHex(id));

/** Hash of the full decision log, so a published log can be checked against the chain. */
export function hashDecisions(decisions: unknown): Hex {
  return keccak256(
    toHex(JSON.stringify(decisions, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
  );
}

async function send(
  privateKey: Hex,
  splitter: Address,
  functionName: 'recordAuction' | 'unlock' | 'recordQc',
  args: readonly unknown[],
): Promise<Hex> {
  const publicClient = getPublicClient();
  const wallet = walletFromKey(privateKey);
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  return withNonceRetry(async () => {
    const hash = await wallet.writeContract({
      address: splitter,
      abi: SPLITTER_ABI,
      functionName,
      args: args as never,
      account,
      chain: arcTestnet,
      maxFeePerGas: ARC_MIN_MAX_FEE_PER_GAS_WEI,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== 'success') throw new Error(`splitter ${functionName} reverted: ${hash}`);
    return hash;
  });
}

export function recordAuctionOnchain(input: {
  operatorKey: Hex;
  splitter: Address;
  jobId: string;
  creator: Address;
  agent: Address;
  agentBps: number;
  bidders: number;
  decisions: unknown;
}): Promise<Hex> {
  return send(input.operatorKey, input.splitter, 'recordAuction', [
    idToBytes32(input.jobId),
    input.creator,
    input.agent,
    input.agentBps,
    Math.min(input.bidders, 255),
    hashDecisions(input.decisions),
  ]);
}

export function splitUnlockOnchain(input: {
  payerKey: Hex;
  splitter: Address;
  jobId: string;
  unlockKey: string;
  amount: Micros;
}): Promise<Hex> {
  return send(input.payerKey, input.splitter, 'unlock', [
    idToBytes32(input.jobId),
    idToBytes32(input.unlockKey),
    microsToErc20Units(input.amount),
  ]);
}

/** The QC verdict on a job's dub, written next to its auction record. */
export function recordQcOnchain(input: {
  operatorKey: Hex;
  splitter: Address;
  jobId: string;
  passed: boolean;
  /** 0-100, or null when the meaning check did not run. */
  meaningScore: number | null;
  report: unknown;
}): Promise<Hex> {
  const score = input.meaningScore === null ? 255 : Math.max(0, Math.min(100, Math.round(input.meaningScore)));
  return send(input.operatorKey, input.splitter, 'recordQc', [
    idToBytes32(input.jobId),
    input.passed,
    score,
    hashDecisions(input.report),
  ]);
}
