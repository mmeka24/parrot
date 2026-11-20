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
import { ARC_TESTNET, EXPLORE_LANGUAGE_COUNT } from '@parrot/shared';

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
  BACKEND_PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3100'),
  PUBLIC_BACKEND_URL: z.string().url().default('http://localhost:8787'),
  /** Where the local X stand-in (apps/x-clone) is served. Used for permalinks. */
  PUBLIC_XCLONE_URL: z.string().url().default('http://localhost:3200'),
  DEMO_MODE: boolish,

  // --- Accounts: sign-in and per-user wallets -------------------------------
  /** SQLite file for users and sessions. On Fly this lives on the /data volume. */
  USERS_DB_PATH: z.string().default('./data/users.db'),
  /**
   * 32 bytes as 64 hex characters. Encrypts every user's wallet key at rest.
   * Accounts are switched off without it. Generate: `openssl rand -hex 32`.
   * Losing it makes every user wallet unrecoverable, so back it up.
   */
  WALLET_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .refine((v) => v === undefined || /^[0-9a-fA-F]{64}$/.test(v), {
      message: 'WALLET_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)',
    }),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /** Sends the sign-in link. Without it, links are only logged outside production. */
  RESEND_API_KEY: optionalString,
  EMAIL_FROM: optionalString,
  /** Testnet USDC sent to a new user's wallet at signup, once, in USD ("1.00"). */
  SIGNUP_BONUS_USD: z.string().default('1.00'),
  /**
   * How many languages a creator's first posts are dubbed into while Parrot is
   * still learning. Each real dub costs ElevenLabs money (about $0.50 a minute
   * of video, per language), so lower this when testing on long videos.
   */
  EXPLORE_LANGUAGES: z.coerce.number().int().min(1).max(9).default(EXPLORE_LANGUAGE_COUNT),
  /** At most this many new wallets are funded per UTC day, so the Treasury is bounded. */
  SIGNUP_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(25),
  /**
   * In production the demo controls are closed unless this is set,
   * and then require it in an `x-admin-token` header. Unset in development.
   */
  DEMO_ADMIN_TOKEN: optionalString,
  /**
   * The most Parrot will spend on dubs in one UTC day, in USD ("3.00"). Bounds
   * the worst-case ElevenLabs bill of a public deployment. Unset = no limit.
   */
  DAILY_DUB_SPEND_CAP_USD: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .refine((v) => v === undefined || /^\d{1,6}(\.\d{1,2})?$/.test(v), {
      message: 'DAILY_DUB_SPEND_CAP_USD must be a dollar amount like "3.00"',
    }),

  ARC_RPC_URL: z.string().url().default(ARC_TESTNET.rpcUrl),
  /** A faster RPC endpoint for Arc, if you have one. Used instead of ARC_RPC_URL. */
  QUICKNODE_ARC_RPC_URL: optionalString,

  /**
   * Parrot's own wallet: where creators' payments for views arrive. Only its
   * address is used for that; the key is never used to spend.
   */
  PARROT_REVENUE_PRIVATE_KEY: optionalKeySchema,
  /** Funds each new account's starting balance (see users/wallet-service.ts). */
  PARROT_TREASURY_PRIVATE_KEY: optionalKeySchema,

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
  /** xAI speech-to-text model, used by QC to hear dubs it did not make. */
  XAI_STT_MODEL: z.string().default('grok-voice-transcribe-2.0'),
  /**
   * Path to ffmpeg (ffprobe must sit next to it). QC measures every dub's real
   * length and audio with these; without them a real dub is not published.
   */
  FFMPEG_PATH: optionalString,

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
  /** Real USDC payments on Arc testnet are possible. */
  readonly onchainPayments: boolean;
  /** Real dubs can be produced. */
  readonly dubbing: boolean;
  /** The quality check can actually hear a dub. */
  readonly qcSpeechChecks: boolean;
  /** Mentions are read from, and replies posted to, the real X API. */
  readonly xApi: boolean;
  /** Grok reads requests, replies and results (vs. the built-in fallbacks). */
  readonly grok: boolean;
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
    onchainPayments:
      env.PARROT_REVENUE_PRIVATE_KEY !== undefined && env.PARROT_TREASURY_PRIVATE_KEY !== undefined,
    dubbing: env.ELEVENLABS_API_KEY !== undefined,
    // QC hears dubs through xAI, never through the company that made them.
    qcSpeechChecks: env.XAI_API_KEY !== undefined,
    xApi:
      env.X_ENABLED &&
      env.X_BEARER_TOKEN !== undefined &&
      env.X_ACCESS_TOKEN !== undefined &&
      env.X_BOT_USER_ID !== undefined,
    grok: env.XAI_API_KEY !== undefined,
  };

  const mockedSubsystems: string[] = [];
  if (!capabilities.onchainPayments) mockedSubsystems.push('payments (demo balances only, nothing sent on Arc)');
  if (!capabilities.dubbing) mockedSubsystems.push('dubbing (stand-in audio, not real dubs)');
  if (!capabilities.qcSpeechChecks) mockedSubsystems.push('quality check (cannot hear dubs, so real dubs cannot go live)');
  if (!capabilities.xApi) mockedSubsystems.push('X (the local stand-in timeline, not x.com)');
  if (!capabilities.grok) mockedSubsystems.push('Grok (built-in fallbacks read requests and replies)');

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

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test helper: drop the memoised config. */
export function resetConfig(): void {
  cached = undefined;
}
