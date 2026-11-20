/**
 * The one place the web app talks to the backend.
 *
 * Every endpoint in the contract gets exactly one typed function here. If
 * NEXT_PUBLIC_BACKEND_URL is unset, or the request fails or times out, the
 * function falls back to the local fixtures. That is what makes
 * `npm run dev -w @parrot/web` a complete, browsable product with nothing else
 * running.
 */

import type {
  AgentDashboardDto,
  ApiErrorDto,
  BotConsoleDto,
  BotPostDto,
  CreatorDashboardDto,
  DemoStateDto,
  DubPageDto,
  InjectMentionRequestDto,
  InjectMentionResponseDto,
  MoneyDto,
  ReceiptDto,
  SystemStatusDto,
  UnlockResponseDto,
} from '@parrot/shared';
import * as fixtures from './fixtures';
import { money } from './money';

const RAW_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? '';
const BASE = RAW_BASE.trim().replace(/\/$/, '');

/** True when a backend address is configured at all. */
export const backendConfigured = BASE.length > 0;

const TIMEOUT_MS = 2500;
/** An unlock waits for its payment to confirm on-chain, so it gets longer. */
const UNLOCK_TIMEOUT_MS = 20_000;

export type Sourced<T> = { readonly data: T; readonly live: boolean };

interface RequestOptions {
  readonly timeoutMs?: number;
  /** Return the backend's own error body instead of null on a non-2xx. */
  readonly passErrors?: boolean;
}

/**
 * On the server (a page being rendered), the browser's cookies are not sent to
 * the backend by themselves. Without forwarding the session cookie, every page
 * would render as if nobody were signed in. In the browser this is a no-op:
 * `credentials: 'include'` already sends them.
 */
async function serverCookies(): Promise<string | null> {
  if (typeof window !== 'undefined') return null;
  try {
    const { cookies } = await import('next/headers');
    const all = (await cookies()).toString();
    return all === '' ? null : all;
  } catch {
    return null; // not inside a request (build time)
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options: RequestOptions = {},
): Promise<T | null> {
  if (!backendConfigured) return null;
  try {
    const forwarded = await serverCookies();
    const res = await fetch(BASE + path, {
      ...init,
      cache: 'no-store',
      // The viewer is identified by a cookie the backend sets; without this the
      // browser neither sends nor keeps it, and every unlock is a new viewer.
      credentials: 'include',
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(forwarded ? { cookie: forwarded } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      if (!options.passErrors) return null;
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      return body && body.ok === false ? (body as T) : null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function getOr<T>(path: string, fallback: () => T): Promise<Sourced<T>> {
  const live = await request<T>(path);
  return live === null ? { data: fallback(), live: false } : { data: live, live: true };
}

// ---------------------------------------------------------------------------
// GET /api/system
// ---------------------------------------------------------------------------

export function getSystemStatus(): Promise<Sourced<SystemStatusDto>> {
  return getOr<SystemStatusDto>('/api/system', () => fixtures.systemStatus);
}

// ---------------------------------------------------------------------------
// GET /api/dubs/:id
// ---------------------------------------------------------------------------

export function getDub(id: string): Promise<Sourced<DubPageDto>> {
  return getOr<DubPageDto>('/api/dubs/' + encodeURIComponent(id), () => fixtures.dubPage(id));
}

// ---------------------------------------------------------------------------
// POST /api/dubs/:id/unlock
// ---------------------------------------------------------------------------

/**
 * Ids that make the offline demo reproduce a specific failure, so every error
 * state in the contract is reachable without a backend.
 */
const OFFLINE_FAILURES: Readonly<Record<string, ApiErrorDto>> = {
  demo_no_credit: {
    ok: false,
    code: 'INSUFFICIENT_BALANCE',
    title: 'Not enough credit',
    detail: 'Your test credit has run out. In the real thing you would top up here.',
  },
  demo_payment_failed: {
    ok: false,
    code: 'PAYMENT_FAILED',
    title: 'The unlock did not go through',
    detail: 'You have not been charged. Tap to try once more.',
  },
  demo_rate_limited: {
    ok: false,
    code: 'RATE_LIMITED',
    title: 'One moment',
    detail: 'That is a lot of unlocks very quickly. Give it a few seconds and try again.',
  },
};

export async function unlockDub(
  id: string,
  dub?: DubPageDto,
): Promise<UnlockResponseDto | ApiErrorDto> {
  const live = await request<UnlockResponseDto | ApiErrorDto>(
    '/api/dubs/' + encodeURIComponent(id) + '/unlock',
    { method: 'POST', body: '{}' },
    { timeoutMs: UNLOCK_TIMEOUT_MS, passErrors: true },
  );
  if (live !== null) return live;

  // A real backend that did not answer is NOT the offline demo: the payment
  // may or may not have gone through, so never show a made-up "Unlock paid".
  // Retrying is safe - the backend never charges twice for the same dub.
  if (backendConfigured) {
    return {
      ok: false,
      code: 'PAYMENT_FAILED',
      title: 'The unlock did not go through',
      detail: 'We could not reach Parrot. Try again - you will not be charged twice.',
    };
  }

  const forced = OFFLINE_FAILURES[id];
  if (forced) return forced;

  const page = dub ?? fixtures.dubPage(id);
  if (page.previewUrl === null) {
    return {
      ok: false,
      code: 'NOT_PUBLISHED',
      title: 'This dub is not ready',
      detail: 'It may still be rendering, or it did not pass our quality checks.',
    };
  }

  const receipt: ReceiptDto = {
    id: 'rcpt_unlock_now',
    title: 'Unlock paid',
    detail: 'You paid ' + page.price.display + ' to watch this in ' + page.targetLanguageName + '.',
    amount: page.price,
    at: new Date().toISOString(),
    status: 'pending',
    verifyUrl: null,
    simulated: true,
  };

  return {
    ok: true,
    fullUrl: page.previewUrl,
    // Pre-formatted by the server in the real thing; the UI never computes it.
    viewerBalance: money('980000', '$0.98'),
    receipt,
  };
}

// ---------------------------------------------------------------------------
// GET /api/creators/:handle
// ---------------------------------------------------------------------------

export function getCreator(handle: string): Promise<Sourced<CreatorDashboardDto>> {
  return getOr<CreatorDashboardDto>('/api/creators/' + encodeURIComponent(handle), () =>
    handle.toLowerCase() === 'newcomer'
      ? fixtures.emptyCreatorDashboard(handle)
      : fixtures.creatorDashboard(handle),
  );
}

// ---------------------------------------------------------------------------
// GET /api/agents
// ---------------------------------------------------------------------------

export function getAgents(): Promise<Sourced<AgentDashboardDto>> {
  return getOr<AgentDashboardDto>('/api/agents', () => fixtures.agentDashboard);
}

// ---------------------------------------------------------------------------
// GET /api/bot  and  POST /api/bot/mention
// ---------------------------------------------------------------------------

export function getBotConsole(): Promise<Sourced<BotConsoleDto>> {
  return getOr<BotConsoleDto>('/api/bot', () => fixtures.botConsole);
}

export async function injectMention(
  body: InjectMentionRequestDto,
): Promise<readonly BotPostDto[] | null> {
  const live = await request<InjectMentionResponseDto>('/api/bot/mention', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return live?.posts ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/demo  and  POST /api/demo/traffic
// ---------------------------------------------------------------------------

export function getDemoState(): Promise<Sourced<DemoStateDto>> {
  return getOr<DemoStateDto>('/api/demo', () => fixtures.demoState);
}

export async function setDemoTraffic(running: boolean): Promise<DemoStateDto | null> {
  return request<DemoStateDto>('/api/demo/traffic', {
    method: 'POST',
    body: JSON.stringify({ running }),
  });
}

// ---------------------------------------------------------------------------
// GET /api/stream (SSE)
// ---------------------------------------------------------------------------

/** The stream address, or null when there is no backend to stream from. */
export function streamUrl(): string | null {
  return backendConfigured ? BASE + '/api/stream' : null;
}


// ---------------------------------------------------------------------------
// Accounts: /api/auth/config, /api/me, sign in, sign out
// ---------------------------------------------------------------------------

export interface AuthConfig {
  readonly enabled: boolean;
  readonly providers: { readonly email: boolean; readonly google: boolean };
  /** What a new account starts with, for display ("$1.00"). */
  readonly bonus: string;
}

export interface Me {
  readonly signedIn: boolean;
  readonly email?: string;
  readonly balance?: MoneyDto | null;
  /** 'funded' once the starting balance has arrived. */
  readonly funding?: 'none' | 'pending' | 'funded' | 'failed';
}

/** Null when this server does not have accounts turned on. */
export async function getAuthConfig(): Promise<AuthConfig | null> {
  const config = await request<AuthConfig>('/api/auth/config');
  return config && config.enabled ? config : null;
}

export async function getMe(): Promise<Me> {
  return (await request<Me>('/api/me')) ?? { signedIn: false };
}

type Failure = { readonly ok: false; readonly title: string; readonly detail: string };

export async function startEmailSignIn(email: string): Promise<{ ok: true } | Failure> {
  const result = await request<{ ok: true } | Failure>(
    '/api/auth/email/start',
    { method: 'POST', body: JSON.stringify({ email }) },
    { passErrors: true, timeoutMs: 15_000 },
  );
  return (
    result ?? { ok: false, title: 'We could not reach Parrot', detail: 'Check your connection and try again.' }
  );
}

export async function verifyEmailSignIn(token: string): Promise<{ ok: true; created: boolean } | Failure> {
  const result = await request<{ ok: true; created: boolean } | Failure>(
    '/api/auth/email/verify',
    { method: 'POST', body: JSON.stringify({ token }) },
    { passErrors: true, timeoutMs: 15_000 },
  );
  return (
    result ?? { ok: false, title: 'We could not reach Parrot', detail: 'Check your connection and try again.' }
  );
}

export async function signOut(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', body: '{}' });
}

/** Where the Google button sends the browser. A full navigation, not a fetch. */
export const googleSignInUrl = BASE + '/api/auth/google/start';
