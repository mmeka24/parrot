/**
 * Deploy ParrotSplitter to Arc testnet and approve it to pull USDC from the
 * viewer pool wallet.
 *
 *   npm run deploy:splitter -w @parrot/backend
 *
 * Needs PARROT_REVENUE_PRIVATE_KEY (becomes the operator that records
 * auctions) and VIEWER_POOL_PRIVATE_KEY (pays unlocks), both funded with
 * testnet USDC from https://faucet.circle.com. Prints SPLITTER_ADDRESS to put
 * in .env.
 */
import { maxUint256, parseAbi, type Hex } from 'viem';
import { arcTestnet } from 'viem/chains';
import { ARC_MIN_MAX_FEE_PER_GAS_WEI, USDC_ADDRESS } from '@parrot/shared';
import { getConfig, loadDotEnv } from '../config.js';
import { getPublicClient, walletFromKey } from '../chain/client.js';
import { compileSplitter } from '../chain/compile-splitter.js';

loadDotEnv();
const env = getConfig().env;
const operatorKey = env.PARROT_REVENUE_PRIVATE_KEY as Hex | undefined;
const payerKey = env.VIEWER_POOL_PRIVATE_KEY as Hex | undefined;
if (!operatorKey || !payerKey) {
  console.error('Set PARROT_REVENUE_PRIVATE_KEY and VIEWER_POOL_PRIVATE_KEY in .env first.');
  process.exit(1);
}

const fees = { maxFeePerGas: ARC_MIN_MAX_FEE_PER_GAS_WEI, maxPriorityFeePerGas: 1_000_000_000n };
const publicClient = getPublicClient();
const { abi, bytecode } = compileSplitter();

const operator = walletFromKey(operatorKey);
const deployHash = await operator.deployContract({
  abi,
  bytecode,
  args: [USDC_ADDRESS],
  account: operator.account!,
  chain: arcTestnet,
  ...fees,
});
const deployed = await publicClient.waitForTransactionReceipt({ hash: deployHash });
const splitter = deployed.contractAddress;
if (!splitter) throw new Error(`deploy failed: ${deployHash}`);
console.log(`Deployed ParrotSplitter at ${splitter}`);
console.log(`  ${arcTestnet.blockExplorers.default.url}/tx/${deployHash}`);

const payer = walletFromKey(payerKey);
const approveHash = await payer.writeContract({
  address: USDC_ADDRESS,
  abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
  functionName: 'approve',
  args: [splitter, maxUint256],
  account: payer.account!,
  chain: arcTestnet,
  ...fees,
});
await publicClient.waitForTransactionReceipt({ hash: approveHash });
console.log(`Viewer pool approved the splitter: ${arcTestnet.blockExplorers.default.url}/tx/${approveHash}`);
console.log(`\nAdd to .env:\nSPLITTER_ADDRESS=${splitter}`);
