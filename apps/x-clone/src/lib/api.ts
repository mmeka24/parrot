/**
 * The clone's client for its own backend (/api/x/*).
 *
 * Every shape comes from @parrot/shared. Note what is NOT here: nothing under
 * /api/extension. A dub request is just a reply, and each of Parrot's dubs is
 * just another video reply - with its own view count, like any other post.
 */

import type {
  ApiErrorDto,
  XCreatePostRequestDto,
  XEngageRequestDto,
  XMediaUploadDto,
  XPostDto,
  XThreadDto,
  XTimelineDto,
  XViewResponseDto,
} from '@parrot/shared';

export const BACKEND_URL = (
  process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8787'
).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly title: string,
    readonly detail: string,
    readonly status: number,
  ) {
    super(`${title}. ${detail}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError('Chirp cannot reach its server', 'Check that the backend is running.', 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiErrorDto | null;
    throw new ApiError(
      body?.title ?? 'Something went wrong',
      body?.detail ?? 'Try again in a moment.',
      res.status,
    );
  }
  return (await res.json()) as T;
}

export function getTimeline(): Promise<XTimelineDto> {
  return request<XTimelineDto>('/api/x/timeline');
}

export function getThread(id: string): Promise<XThreadDto> {
  return request<XThreadDto>(`/api/x/posts/${encodeURIComponent(id)}`);
}

export function createPost(body: XCreatePostRequestDto): Promise<XPostDto> {
  return request<XPostDto>('/api/x/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function engage(id: string, body: XEngageRequestDto): Promise<XPostDto> {
  return request<XPostDto>(`/api/x/posts/${encodeURIComponent(id)}/engage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function uploadVideo(file: File): Promise<XMediaUploadDto> {
  return request<XMediaUploadDto>('/api/x/media', {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
}

/** Count a view on a post, as the timeline itself would when its video plays. */
export function recordView(id: string): Promise<XViewResponseDto> {
  return request<XViewResponseDto>(`/api/x/posts/${encodeURIComponent(id)}/view`, { method: 'POST' });
}
