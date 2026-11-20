/**
 * Environment configuration, parsed once at boot.
 *
 * Design rule: the app must BOOT without most credentials. Anything missing
 * degrades to a mock adapter and is reported in `capabilities`, which the
 * dashboard renders honestly ("X: mocked", "Payments: live"). Nothing silently
 * pretends to be real - that is the whole point of the test-mode labelling.
 */

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ARC_TESTNET,
  GATEWAY_FACILITATOR_URL_TESTNET,
  CIRCLE_FACILITATOR_URL,
} from '@parrot/shared';

/** apps/backend/src/config.ts -> the repository root. */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

const hexKeySchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte private key');

/** A key that may be absent or a bare "0x" placeholder from .env.example. */
const optionalKeySchema = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' || v === '0x' ? undefined : v))
  .pipe(hexKeySchema.optional());

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const boolish = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  BACKEND_PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3100'),
  PUBLIC_BACKEND_URL: z.string().url().default('http://localhost:8787'),
  /** Where the local X stand-in (apps/x-clone) is served. Used for permalinks. */
  PUBLIC_XCLONE_URL: z.string().url().default('http://localhost:3200'),
  DEMO_MODE: boolish,
  /**
   * Skip the agents' profit-margin test so any job within their spend caps gets
   * dubbed. Budget floors, per-job and daily caps, and language focus still
   * apply. For demos and testing; off by default.
   */
  FORCE_DUB: boolish,

  ARC_RPC_URL: z.string().url().default(ARC_TESTNET.rpcUrl),
  QUICKNODE_ARC_RPC_URL: optionalString,

  PARROT_REVENUE_PRIVATE_KEY: optionalKeySchema,
  PARROT_TREASURY_PRIVATE_KEY: optionalKeySchema,
  AGENT_MAGPIE_PRIVATE_KEY: optionalKeySchema,
  AGENT_KESTREL_PRIVATE_KEY: optionalKeySchema,
  AGENT_FINCH_PRIVATE_KEY: optionalKeySchema,
  VIEWER_POOL_PRIVATE_KEY: optionalKeySchema,
  COST_SINK_ADDRESS: optionalString,

  GATEWAY_FACILITATOR_URL: z.string().url().default(GATEWAY_FACILITATOR_URL_TESTNET),
  CIRCLE_FACILITATOR_URL: z.string().url().default(CIRCLE_FACILITATOR_URL),
  PAYMENT_MODE: z.enum(['gateway', 'facilitator']).default('gateway'),

  CIRCLE_API_KEY: optionalString,
  CIRCLE_ENTITY_SECRET: optionalString,

  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_STT_MODEL: z.string().default('scribe_v3'),
  /** Path to yt-dlp, used to fetch the video behind an x.com post. Optional. */
  YT_DLP_PATH: optionalString,

  X_ENABLED: boolish,
  X_BEARER_TOKEN: optionalString,
  X_API_KEY: optionalString,
  X_API_SECRET: optionalString,
  X_ACCESS_TOKEN: optionalString,
  X_ACCESS_TOKEN_SECRET: optionalString,
  X_BOT_USER_ID: optionalString,
  X_BOT_HANDLE: z.string().default('parrot'),

  XAI_API_KEY: optionalString,
  XAI_BASE_URL: z.string().url().default('https://api.x.ai/v1'),
  XAI_MODEL: z.string().default('grok-4.3'),

  QUICKNODE_API_KEY: optionalString,
  QUICKNODE_STREAM_SECURITY_TOKEN: optionalString,
  QUICKNODE_WEBHOOK_URL: optionalString,

  REASONING_PROVIDER: z.enum(['anthropic', 'gemini', 'none']).default('none'),
  ANTHROPIC_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,

  /**
   * Relative paths are taken from the REPO ROOT, as written in .env.example.
   * npm workspaces run this process from apps/backend, so resolving against
   * the working directory used to land files in apps/backend/apps/backend/.
   */
  MEDIA_STORAGE_DIR: z
    .string()
    .default('./apps/backend/media')
    .transform((dir) => (isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir))),
});

export type Env = z.infer<typeof envSchema>;

let cached: Config | undefined;

export interface Capabilities {
  /** Real USDC transfers on Arc testnet are possible. */
  readonly onchainSettlement: boolean;
  /** Real x402 unlocks can be taken from viewers. */
  readonly x402Payments: boolean;
  /** Real dubs can be produced. */
  readonly dubbing: boolean;
  /** The QC language gate can actually run. */
  readonly qcLanguageDetection: boolean;
  /** Mentions are read from, and replies posted to, the real X API. */
  readonly xApi: boolean;
  /** Grok parses mentions (vs. the regex fallback). */
  readonly grokParsing: boolean;
  /** The live chain feed is wired up. */
  readonly quicknodeStream: boolean;
}

export interface Config {
  readonly env: Env;
  readonly isDemoMode: boolean;
  readonly rpcUrl: string;
  readonly capabilities: Capabilities;
  /** Human-readable list of what is mocked, rendered in the UI and logs. */
  readonly mockedSubsystems: string[];
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  const capabilities: Capabilities = {
    onchainSettlement:
      env.PARROT_REVENUE_PRIVATE_KEY !== undefined &&
      env.PARROT_TREASURY_PRIVATE_KEY !== undefined,
    x402Payments:
      env.PARROT_REVENUE_PRIVATE_KEY !== undefined && env.VIEWER_POOL_PRIVATE_KEY !== undefined,
    dubbing: env.ELEVENLABS_API_KEY !== undefined,
    qcLanguageDetection: env.ELEVENLABS_API_KEY !== undefined,
    xApi:
      env.X_ENABLED &&
      env.X_BEARER_TOKEN !== undefined &&
      env.X_ACCESS_TOKEN !== undefined &&
      env.X_BOT_USER_ID !== undefined,
    grokParsing: env.XAI_API_KEY !== undefined,
    quicknodeStream:
      env.QUICKNODE_API_KEY !== undefined && env.QUICKNODE_STREAM_SECURITY_TOKEN !== undefined,
  };

  const mockedSubsystems: string[] = [];
  if (!capabilities.onchainSettlement) mockedSubsystems.push('on-chain settlement (simulated)');
  if (!capabilities.x402Payments) mockedSubsystems.push('viewer payments (simulated)');
  if (!capabilities.dubbing) mockedSubsystems.push('dubbing (fixture audio)');
  if (!capabilities.qcLanguageDetection) mockedSubsystems.push('QC language detection (heuristic)');
  if (!capabilities.xApi) mockedSubsystems.push('X (local clone, not x.com)');
  if (!capabilities.grokParsing) mockedSubsystems.push('intent parsing (regex fallback)');
  if (!capabilities.quicknodeStream) mockedSubsystems.push('chain feed (RPC polling)');

  return {
    env,
    isDemoMode: env.DEMO_MODE,
    rpcUrl: env.QUICKNODE_ARC_RPC_URL ?? env.ARC_RPC_URL,
    capabilities,
    mockedSubsystems,
  };
}

/**
 * Load the repo-root .env into process.env, if there is one.
 *
 * `npm run dev:backend` used to need the variables exported by hand, because
 * nothing read the file. Variables already set in the environment win, so a
 * deploy that injects real env vars is unaffected. Call before getConfig().
 */
export function loadDotEnv(path = resolve(REPO_ROOT, '.env')): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    // No .env: fine, everything falls back to its documented default.
    return false;
  }
}

/**
 * An agent persona's signing key, if one is configured. The agent fronts its
 * dub cost from this wallet, so its spending is visible on-chain.
 */
export function agentPrivateKey(agentName: string): `0x${string}` | undefined {
  const env = getConfig().env;
  const keys: Record<string, string | undefined> = {
    Magpie: env.AGENT_MAGPIE_PRIVATE_KEY,
    Kestrel: env.AGENT_KESTREL_PRIVATE_KEY,
    Finch: env.AGENT_FINCH_PRIVATE_KEY,
  };
  return keys[agentName] as `0x${string}` | undefined;
}

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: drop the memoised config. */
export function resetConfig(): void {
  cached = undefined;
}
