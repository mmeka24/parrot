/** Print each configured wallet's address and USDC balances on Arc testnet. Never prints keys. */
import type { Hex } from 'viem';
import { formatUsd } from '@parrot/shared';
import { getConfig, loadDotEnv } from '../config.js';
import { addressFromKey, getGasBalance, getUsdcBalance } from '../chain/client.js';

loadDotEnv();
const env = getConfig().env as unknown as Record<string, string | undefined>;
const names = [
  'PARROT_REVENUE_PRIVATE_KEY',
  'VIEWER_POOL_PRIVATE_KEY',
  'PARROT_TREASURY_PRIVATE_KEY',
  'AGENT_MAGPIE_PRIVATE_KEY',
  'AGENT_KESTREL_PRIVATE_KEY',
  'AGENT_FINCH_PRIVATE_KEY',
];
for (const name of names) {
  const key = env[name];
  if (!key) {
    console.log(`${name.replace('_PRIVATE_KEY', '')}: not set`);
    continue;
  }
  const address = addressFromKey(key as Hex);
  const [usdc, gas] = await Promise.all([getUsdcBalance(address), getGasBalance(address)]);
  console.log(`${name.replace('_PRIVATE_KEY', '')}: ${address}  USDC ${formatUsd(usdc)}  (gas balance ${formatUsd(gas)})`);
}
