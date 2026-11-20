/**
 * The background worker: the extension's only route to the Parrot server.
 *
 * It reads the extension's settings, what Parrot knows about a batch of posts,
 * and the results under a dubbed post. It writes only three things: what a page
 * showed (observe), a dub request from the post's author (request), and, on a
 * demo server, the simulated audience (audience).
 */

import type { ExtensionConfigDto, ExtensionForecastDto, ExtensionResultsDto, ExtensionStatusResponseDto } from '@parrot/shared';
import { DEFAULT_SERVER, type Request, type Response } from './messages';

const SERVER_KEY = 'server';
const MAX_IDS = 50;

async function server(): Promise<string> {
  try {
    const stored = (await chrome.storage.local.get(SERVER_KEY))[SERVER_KEY];
    if (typeof stored === 'string' && /^https?:\/\//.test(stored)) return stored.replace(/\/$/, '');
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SERVER;
}

async function getJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${await server()}${path}`, {
    // Parrot identifies a viewer by cookie; the extension has no business
    // creating or reading one.
    credentials: 'omit',
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!res.ok) {
    // Parrot's errors are already plain language; pass the detail through.
    const error = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(error?.detail ?? `server answered ${res.status}`);
  }
  return (await res.json()) as T;
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'config':
      return getJson<ExtensionConfigDto>('/api/extension/config');
    case 'posts': {
      const ids = request.ids
        .filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id))
        .slice(0, MAX_IDS);
      if (ids.length === 0) return { posts: [] } satisfies ExtensionStatusResponseDto;
      return getJson<ExtensionStatusResponseDto>(
        `/api/extension/posts?ids=${encodeURIComponent(ids.join(','))}`,
      );
    }
    case 'observe':
      return getJson('/api/extension/observe', { posts: request.posts.slice(0, MAX_IDS) });
    case 'request':
      return getJson('/api/extension/request', request.body);
    case 'forecast':
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.postId)) throw new Error('not a post id');
      return getJson<ExtensionForecastDto>(`/api/extension/forecast?postId=${encodeURIComponent(request.postId)}`);
    case 'results':
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.postId)) throw new Error('not a post id');
      return getJson<ExtensionResultsDto>(`/api/extension/results?postId=${encodeURIComponent(request.postId)}`);
    case 'audience':
      return getJson('/api/extension/audience', request.body);
    case 'getServer':
      return server();
    case 'setServer': {
      const next = request.server.trim().replace(/\/$/, '');
      if (!/^https?:\/\/[^\s/]+$/.test(next)) throw new Error('not a server address');
      await chrome.storage.local.set({ [SERVER_KEY]: next });
      return next;
    }
  }
}

function isRequest(message: unknown): message is Request {
  return typeof message === 'object' && message !== null && 'type' in message;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRequest(message)) return false;
  handle(message).then(
    (data) => sendResponse({ ok: true, data } satisfies Response<unknown>),
    (error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies Response<unknown>),
  );
  // Keep the channel open for the async answer.
  return true;
});
