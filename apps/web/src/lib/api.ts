/**
 * The one place the web app talks to the backend.
 *
 * Every endpoint in the contract gets exactly one typed function here. A read
 * that fails resolves to null and the page says the server could not be
 * reached; nothing is ever filled in with made-up data.
 */

import type {
  ApiErrorDto,
  CreatorDashboardDto,
  DubPageDto,
  MeDto,
  StartDubResponseDto,
  SystemStatusDto,
  UpdateSettingsRequestDto,
} from '@parrot/shared';

const RAW_BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? '';
const BASE = RAW_BASE.trim().replace(/\/$/, '');

/** True when a backend address is configured at all. */
export const backendConfigured = BASE.length > 0;

const TIMEOUT_MS = 6_000;

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

function serverBase(): string {
  if (typeof window !== 'undefined') return BASE;
  const direct = process.env.BACKEND_ORIGIN?.trim().replace(/\/$/, '');
  return direct && direct.length > 0 ? direct : BASE;
}

async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T | null> {
  if (!backendConfigured) return null;
  try {
    const forwarded = await serverCookies();
    const res = await fetch(serverBase() + path, {
      ...init,
      cache: 'no-store',
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

export type Failure = { readonly ok: false; readonly title: string; readonly detail: string };

const UNREACHABLE: Failure = {
  ok: false,
  title: 'We could not reach Parrot',
  detail: 'Check your connection and try again.',
};

async function post<T extends { ok: true }>(path: string, body: unknown, timeoutMs = 20_000): Promise<T | Failure> {
  const result = await request<T | ApiErrorDto>(
    path,
    { method: 'POST', body: JSON.stringify(body ?? {}) },
    { passErrors: true, timeoutMs },
  );
  return result ?? UNREACHABLE;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getSystemStatus(): Promise<SystemStatusDto | null> {
  return request<SystemStatusDto>('/api/system');
}

export function getCreator(handle: string): Promise<CreatorDashboardDto | null> {
  return request<CreatorDashboardDto>('/api/creators/' + encodeURIComponent(handle));
}

export function getDub(id: string): Promise<DubPageDto | null> {
  return request<DubPageDto>('/api/dubs/' + encodeURIComponent(id));
}

// ---------------------------------------------------------------------------
// A creator's actions
// ---------------------------------------------------------------------------

const creatorPath = (handle: string): string => '/api/creators/' + encodeURIComponent(handle);

export function updateSettings(handle: string, body: UpdateSettingsRequestDto): Promise<{ ok: true } | Failure> {
  return post<{ ok: true }>(creatorPath(handle) + '/settings', body);
}

export function startDub(handle: string, postId: string, languageCode?: string | null): Promise<StartDubResponseDto | Failure> {
  return post<StartDubResponseDto>(creatorPath(handle) + '/dub', { postId, languageCode: languageCode ?? null });
}

export function sendDemoAudience(handle: string, postId: string): Promise<{ ok: true } | Failure> {
  return post<{ ok: true }>(creatorPath(handle) + '/posts/' + encodeURIComponent(postId) + '/audience', {});
}

export function payNow(handle: string): Promise<{ ok: true } | Failure> {
  // Waits for the payment to confirm, so it gets longer.
  return post<{ ok: true }>(creatorPath(handle) + '/pay', {}, 120_000);
}

/** Count this browser as a viewer of a dub. Safe to call more than once. */
export function recordDubView(id: string): Promise<{ ok: true; counted: boolean } | Failure> {
  return post<{ ok: true; counted: boolean }>('/api/dubs/' + encodeURIComponent(id) + '/view', {});
}

/** The live event stream, or null when there is no backend to stream from. */
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

export type Me = MeDto;

/** Null when this server does not have accounts turned on. */
export async function getAuthConfig(): Promise<AuthConfig | null> {
  const config = await request<AuthConfig>('/api/auth/config');
  return config && config.enabled ? config : null;
}

export async function getMe(): Promise<Me> {
  return (await request<Me>('/api/me')) ?? { signedIn: false };
}

export function startEmailSignIn(email: string): Promise<{ ok: true } | Failure> {
  return post<{ ok: true }>('/api/auth/email/start', { email }, 15_000);
}

export function verifyEmailSignIn(token: string): Promise<{ ok: true; created: boolean } | Failure> {
  return post<{ ok: true; created: boolean }>('/api/auth/email/verify', { token }, 15_000);
}

/** Connect the name you post under to your account. */
export function connectHandle(handle: string): Promise<{ ok: true; handle: string } | Failure> {
  return post<{ ok: true; handle: string }>('/api/me/creator', { handle });
}

export async function signOut(): Promise<void> {
  await request('/api/auth/logout', { method: 'POST', body: '{}' });
}

/** Where the Google button sends the browser. A full navigation, not a fetch. */
export const googleSignInUrl = BASE + '/api/auth/google/start';
