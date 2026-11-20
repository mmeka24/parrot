/** Compiles contracts/ParrotSplitter.sol with solc-js. Used by the deploy script and tests. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { Abi, Hex } from 'viem';

const SOURCE = fileURLToPath(new URL('../../contracts/ParrotSplitter.sol', import.meta.url));

export function compileSplitter(): { abi: Abi; bytecode: Hex } {
  const solc = createRequire(import.meta.url)('solc');
  const input = {
    language: 'Solidity',
    sources: { 'ParrotSplitter.sol': { content: readFileSync(SOURCE, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const c = out.contracts['ParrotSplitter.sol'].ParrotSplitter;
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}
