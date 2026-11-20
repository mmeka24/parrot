/**
 * Messages between the page (content script, popup) and the background worker.
 *
 * Every call to the Parrot server goes through the background worker. A content
 * script's fetch runs under the PAGE's origin and its CORS rules, so on any
 * site other than localhost it could not reach the server at all; the worker
 * runs under the extension's own origin and its host permissions instead.
 */

import type {
  ExtensionAudienceRequestDto,
  ExtensionConfigDto,
  ExtensionDubRequestDto,
  ExtensionObservedPostDto,
  ExtensionResultsDto,
  ExtensionStatusResponseDto,
} from '@parrot/shared';

export type Request =
  | { readonly type: 'config' }
  | { readonly type: 'posts'; readonly ids: readonly string[] }
  | { readonly type: 'observe'; readonly posts: readonly ExtensionObservedPostDto[] }
  | { readonly type: 'request'; readonly body: ExtensionDubRequestDto }
  | { readonly type: 'results'; readonly postId: string }
  | { readonly type: 'audience'; readonly body: ExtensionAudienceRequestDto }
  | { readonly type: 'getServer' }
  | { readonly type: 'setServer'; readonly server: string };

export type Response<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string };

export interface ResponseMap {
  config: ExtensionConfigDto;
  posts: ExtensionStatusResponseDto;
  getServer: string;
  setServer: string;
  observe: unknown;
  request: unknown;
  results: ExtensionResultsDto;
  audience: unknown;
}

declare const __PARROT_SERVER__: string | undefined;

/** Baked in at build time (PARROT_SERVER=...), so a shared build works as-is. */
export const DEFAULT_SERVER =
  typeof __PARROT_SERVER__ === 'string' && __PARROT_SERVER__ !== ''
    ? __PARROT_SERVER__
    : 'http://localhost:8787';

/** Ask the background worker. Never throws: a failure comes back as `ok: false`. */
export async function ask<K extends Request['type']>(
  request: Extract<Request, { type: K }>,
): Promise<Response<ResponseMap[K]>> {
  try {
    const response = await chrome.runtime.sendMessage<Response<ResponseMap[K]> | undefined>(request);
    return response ?? { ok: false, error: 'no response' };
  } catch (error) {
    // Most often: the extension was reloaded and this page still runs the old
    // content script. Its runtime is gone until the page is refreshed.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
