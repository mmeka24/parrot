/**
 * ParrotSplitter, deployed to an in-memory chain (ganache) against a mock
 * 6-decimal USDC. Checks the money actually lands where the auction said.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { createPublicClient, createWalletClient, custom, parseAbi, type Address, type Hex } from 'viem';
import { localhost } from 'viem/chains';
import { compileSplitter } from '../src/chain/compile-splitter.js';
import { SPLITTER_ABI, idToBytes32, hashDecisions } from '../src/chain/splitter.js';

const require = createRequire(import.meta.url);

const MOCK_USDC = `
pragma solidity ^0.8.24;
contract MockUSDC {
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;
  function mint(address to, uint256 a) external { balanceOf[to] += a; }
  function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
  function transferFrom(address f, address t, uint256 a) external returns (bool) {
    require(allowance[f][msg.sender] >= a && balanceOf[f] >= a, "insufficient");
    allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
  }
}`;
const USDC_ABI = parseAbi([
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

let pub: ReturnType<typeof createPublicClient>;
let wallet: ReturnType<typeof createWalletClient>;
let operator: Address, viewer: Address, creator: Address, agent: Address, stranger: Address;
let usdc: Address, splitter: Address;

async function deploy(abi: unknown, bytecode: Hex, args: unknown[], from: Address): Promise<Address> {
  const hash = await wallet.deployContract({ abi: abi as never, bytecode, args: args as never, account: from, chain: localhost, gas: 5_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success' || !r.contractAddress) throw new Error('deploy reverted');
  return r.contractAddress;
}
async function call(address: Address, abi: unknown, functionName: string, args: unknown[], from: Address) {
  // Simulate first: a revert then surfaces the contract's own reason string.
  await pub.simulateContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: from });
  const hash = await wallet.writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never, account: from, chain: localhost, gas: 5_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(`${functionName} reverted`);
  return r;
}
const bal = (who: Address) => pub.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [who] });

beforeAll(async () => {
  const ganache = require('ganache');
  const provider = ganache.provider({ logging: { quiet: true }, wallet: { deterministic: true }, chain: { chainId: 1337 } });
  pub = createPublicClient({ chain: localhost, transport: custom(provider) });
  wallet = createWalletClient({ chain: localhost, transport: custom(provider) });
  [operator, viewer, creator, agent, stranger] = (await wallet.getAddresses()) as [Address, Address, Address, Address, Address];

  const solc = require('solc');
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'M.sol': { content: MOCK_USDC } },
    settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  const mock = out.contracts['M.sol'].MockUSDC;
  usdc = await deploy(mock.abi, `0x${mock.evm.bytecode.object}`, [], operator);

  const { abi, bytecode } = compileSplitter();
  splitter = await deploy(abi, bytecode, [usdc], operator);

  await call(usdc, USDC_ABI, 'mint', [viewer, 1_000_000n], operator); // $1.00
  await call(usdc, USDC_ABI, 'approve', [splitter, 2n ** 255n], viewer);
}, 60_000);

describe('ParrotSplitter on a local chain', () => {
  const job = idToBytes32('job-1');

  it('only the operator can record an auction', async () => {
    await expect(
      call(splitter, SPLITTER_ABI, 'recordAuction', [job, creator, agent, 825, 3, hashDecisions([{ a: 1 }])], stranger),
    ).rejects.toThrow(/not operator/);
  });

  it('refuses an unlock for a job with no recorded auction', async () => {
    await expect(
      call(splitter, SPLITTER_ABI, 'unlock', [job, idToBytes32('u-0'), 20_000n], viewer),
    ).rejects.toThrow(/no auction/);
  });

  it('splits a $0.02 unlock at the auction share, straight to both wallets', async () => {
    await call(splitter, SPLITTER_ABI, 'recordAuction', [job, creator, agent, 825, 3, hashDecisions([{ a: 1 }])], operator);
    const receipt = await call(splitter, SPLITTER_ABI, 'unlock', [job, idToBytes32('u-1'), 20_000n], viewer);

    expect(receipt.status).toBe('success');
    expect(await bal(agent)).toBe(1_650n); // 8.25% of $0.02
    expect(await bal(creator)).toBe(18_350n); // the rest
    expect(await bal(viewer)).toBe(980_000n);
  });

  it('never charges twice for the same unlock', async () => {
    await expect(
      call(splitter, SPLITTER_ABI, 'unlock', [job, idToBytes32('u-1'), 20_000n], viewer),
    ).rejects.toThrow(/already paid/);
  });

  it('terms are final: an auction result cannot be rewritten', async () => {
    await expect(
      call(splitter, SPLITTER_ABI, 'recordAuction', [job, creator, stranger, 9_000, 1, hashDecisions([])], operator),
    ).rejects.toThrow(/terms are final/);
  });
});
