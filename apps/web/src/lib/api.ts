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

export type Sourced<T> = { readonly data: T; readonly live: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!backendConfigured) return null;
  try {
    const res = await fetch(BASE + path, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) return null;
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
  );
  if (live !== null) return live;

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
