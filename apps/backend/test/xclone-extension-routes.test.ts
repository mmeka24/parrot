/**
 * The X stand-in's routes and the extension's read endpoints, over real HTTP.
 *
 * The bot path is stubbed: these tests are about what the routes accept and
 * report, not about the decision loop (which has its own tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../src/config.js';
import { Store } from '../src/store/store.js';
import { MockXAdapter } from '../src/bot/mock-x-adapter.js';
import { registerXCloneRoutes } from '../src/xclone/routes.js';
import { registerExtensionRoutes } from '../src/extension/routes.js';
import type { ExtensionStatusResponseDto, XPostDto, XThreadDto, XTimelineDto } from '@parrot/shared';

let server: Server;
let base: string;
let store: Store;
let mockX: MockXAdapter;
let processed: string[];
let dubbed: string[] = [];

async function start(enabled = true): Promise<void> {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  delete process.env.ELEVENLABS_API_KEY;
  resetConfig();

  store = new Store();
  mockX = new MockXAdapter(store, { permalinkBase: 'http://localhost:3200' });
  // As the backend does once seeding is done: posts written from here on are
  // stamped with the real time, which is what "pending" is measured against.
  mockX.useWallClock();
  processed = [];
  dubbed = [];

  const app = express();
  app.use(express.json());
  registerXCloneRoutes(app, {
    store,
    mockX,
    enabled,
    processMentionById: async (id) => {
      processed.push(id);
      return null;
    },
  });
  registerExtensionRoutes(app, {
    store,
    adapter: mockX,
    botHandle: 'parrot',
    dubObservedPost: async (post, lang) => {
      dubbed.push(`${post.postId}:${lang}`);
      return `Your ${lang} dub is live.`;
    },
  });

  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the X stand-in', () => {
  beforeEach(() => start());

  it('serves the seeded timeline, newest first, with the bot listed', async () => {
    const { body } = await get<XTimelineDto>('/api/x/timeline');
    expect(body.posts.map((p) => p.author.handle)).toEqual(['linafit', 'chefkenji', 'devtoni', 'maria']);
    expect(body.users.find((u) => u.handle === 'parrot')?.isBot).toBe(true);
    // Seeded posts have a length but no footage, and say so.
    expect(body.posts[0]?.video).toEqual({ durationS: 170, url: null });
  });

  it('builds permalinks on the stand-in, not on x.com', () => {
    expect(mockX.postUrl('mock-post-1')).toBe('http://localhost:3200/maria/status/mock-post-1');
  });

  it('hands a reply that addresses the bot to the bot, and nothing else', async () => {
    const ordinary = await post<XPostDto>('/api/x/posts', {
      text: 'love this',
      authorHandle: 'devtoni',
      inReplyToId: 'mock-post-1',
    });
    expect(ordinary.status).toBe(200);
    expect(processed).toEqual([]);

    const request = await post<XPostDto>('/api/x/posts', {
      text: '@parrot dub this to Hindi',
      authorHandle: 'maria',
      inReplyToId: 'mock-post-1',
    });
    expect(request.status).toBe(200);
    expect(processed).toEqual([request.body.id]);

    const thread = await get<XThreadDto>('/api/x/posts/mock-post-1');
    expect(thread.body.replies.map((r) => r.text)).toEqual(['love this', '@parrot dub this to Hindi']);
  });

  it('refuses to post as the bot, or with no text', async () => {
    expect((await post('/api/x/posts', { text: 'hi', authorHandle: 'parrot' })).status).toBe(400);
    expect((await post('/api/x/posts', { text: '   ', authorHandle: 'maria' })).status).toBe(400);
    expect((await post('/api/x/posts', { text: 'x'.repeat(281), authorHandle: 'maria' })).status).toBe(400);
  });

  it('only accepts a video it stored itself', async () => {
    const res = await post('/api/x/posts', {
      text: 'new clip',
      authorHandle: 'maria',
      video: { mediaId: '../../etc/passwd', durationS: 10 },
    });
    expect(res.status).toBe(400);
  });

  it('switches itself off when the bot is on the real service', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start(false);
    expect((await get('/api/x/timeline')).status).toBe(503);
  });
});

describe('what the extension reads', () => {
  beforeEach(() => start());

  it('reports authorship and video from the server, and stays silent on unknown ids', async () => {
    const { body } = await get<ExtensionStatusResponseDto>(
      '/api/extension/posts?ids=mock-post-1,does-not-exist',
    );
    const [maria, unknown] = body.posts;
    expect(maria).toMatchObject({ known: true, hasVideo: true, authorHandle: 'maria', pending: false });
    expect(unknown).toMatchObject({ known: false, hasVideo: false, authorHandle: null });
  });

  it('shows a request as pending until the bot has answered it', async () => {
    const mention = mockX.injectMention({
      text: '@parrot dub this to Hindi',
      inReplyToPostId: 'mock-post-1',
    });
    let status = (await get<ExtensionStatusResponseDto>('/api/extension/posts?ids=mock-post-1')).body;
    expect(status.posts[0]?.pending).toBe(true);

    await mockX.reply(mention.id, 'Passing on this one for now.');
    store.markMentionProcessed(mention.id, null, 'DECLINED');
    status = (await get<ExtensionStatusResponseDto>('/api/extension/posts?ids=mock-post-1')).body;
    expect(status.posts[0]?.pending).toBe(false);
    expect(status.posts[0]?.lastReply?.text).toBe('Passing on this one for now.');
  });

  it('caps a status call at 50 ids', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `id-${i}`).join(',');
    const { body } = await get<ExtensionStatusResponseDto>(`/api/extension/posts?ids=${ids}`);
    expect(body.posts).toHaveLength(50);
  });

  it('offers every language but the source, and the real split', async () => {
    const { body } = await get<{ languages: { code: string }[]; creatorPercent: number }>(
      '/api/extension/config',
    );
    expect(body.languages.map((l) => l.code)).not.toContain('en');
    expect(body.creatorPercent).toBe(60);
  });
});

describe('real x.com posts, read off the page', () => {
  beforeEach(() => start());

  const seen = {
    postId: '1860042215577',
    authorHandle: 'Maya_Builds',
    authorDisplayName: 'Maya',
    text: 'shipping a parser live',
    metrics: { likes: 900, replies: 80, reposts: 120, views: 15000 },
    durationS: 42,
    createdAt: new Date().toISOString(),
  };

  it('is known only after the page has reported it, and is marked as page-sourced', async () => {
    let status = (await get<ExtensionStatusResponseDto>(`/api/extension/posts?ids=${seen.postId}`)).body;
    expect(status.posts[0]?.known).toBe(false);

    expect((await post('/api/extension/observe', { posts: [seen] })).status).toBe(200);
    status = (await get<ExtensionStatusResponseDto>(`/api/extension/posts?ids=${seen.postId}`)).body;
    expect(status.posts[0]).toMatchObject({
      known: true,
      hasVideo: true,
      authorHandle: 'maya_builds',
      source: 'page',
    });
  });

  it('drops malformed posts one by one, keeping the good ones in the same batch', async () => {
    const bad = { ...seen, postId: '111', metrics: { ...seen.metrics, likes: -5 } };
    const notSnowflake = { ...seen, postId: 'mock-post-1' };
    const res = await post<{ stored: number; rejected: number }>('/api/extension/observe', {
      posts: [bad, notSnowflake, seen],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stored: 1, rejected: 2 });
    expect([...store.observedPosts.keys()]).toEqual([seen.postId]);
    // Not even a list: the request itself is malformed.
    expect((await post('/api/extension/observe', { posts: 'nope' })).status).toBe(400);
  });

  it('only takes a request from the handle that posted the video', async () => {
    await post('/api/extension/observe', { posts: [seen] });
    const stranger = await post('/api/extension/request', {
      postId: seen.postId,
      languageCode: 'es',
      requesterHandle: 'someone_else',
    });
    expect(stranger.status).toBe(403);
    expect(dubbed).toEqual([]);
  });

  it('refuses English, unknown posts, and posts with no known length', async () => {
    await post('/api/extension/observe', { posts: [{ ...seen, durationS: null }] });
    const body = { postId: seen.postId, languageCode: 'es', requesterHandle: 'maya_builds' };
    expect((await post('/api/extension/request', body)).status).toBe(400);
    expect((await post('/api/extension/request', { ...body, postId: '999' })).status).toBe(404);
    await post('/api/extension/observe', { posts: [seen] });
    expect((await post('/api/extension/request', { ...body, languageCode: 'en' })).status).toBe(400);
  });

  it('runs the request, shows it pending, then shows the answer', async () => {
    await post('/api/extension/observe', { posts: [seen] });
    const res = await post('/api/extension/request', {
      postId: seen.postId,
      languageCode: 'fr',
      requesterHandle: '@Maya_Builds',
    });
    expect(res.status).toBe(202);
    expect(dubbed).toEqual([`${seen.postId}:fr`]);

    // The stub resolves on the next tick; give it one.
    await new Promise((r) => setTimeout(r, 20));
    const status = (await get<ExtensionStatusResponseDto>(`/api/extension/posts?ids=${seen.postId}`)).body;
    expect(status.posts[0]?.pending).toBe(false);
    expect(status.posts[0]?.lastReply?.text).toBe('Your fr dub is live.');
  });

  it('keeps an answer and a known length when the post is read again', async () => {
    await post('/api/extension/observe', { posts: [seen] });
    await post('/api/extension/request', {
      postId: seen.postId,
      languageCode: 'fr',
      requesterHandle: 'maya_builds',
    });
    await new Promise((r) => setTimeout(r, 20));
    await post('/api/extension/observe', { posts: [{ ...seen, durationS: null }] });
    const stored = store.observedPosts.get(seen.postId);
    expect(stored?.durationS).toBe(42);
    expect(stored?.lastAnswer?.text).toBe('Your fr dub is live.');
  });
});

describe('simulated reach on a demo video post', () => {
  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    process.env.MEDIA_STORAGE_DIR = await mkdtemp(`${tmpdir()}/parrot-media-`);
    await start();
  });

  afterEach(() => {
    delete process.env.MEDIA_STORAGE_DIR;
  });

  async function upload(): Promise<string> {
    const res = await fetch(`${base}/api/x/media`, {
      method: 'POST',
      headers: { 'content-type': 'video/webm' },
      body: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
    });
    return ((await res.json()) as { mediaId: string }).mediaId;
  }

  it('gives the post the requested views and plausible engagement', async () => {
    const mediaId = await upload();
    const { status, body } = await post<XPostDto>('/api/x/posts', {
      text: 'Budget dinner for four',
      authorHandle: 'maria',
      video: { mediaId, durationS: 13 },
      simulatedViews: 1_200_000,
    });
    expect(status).toBe(200);
    expect(body.metrics.views).toBe(1_200_000);
    // ~2.7% of views interact, as on the real posts; most of them as likes.
    expect(body.metrics.likes).toBeGreaterThan(20_000);
    expect(body.metrics.likes).toBeLessThan(30_000);
  });

  it('leaves a post without simulated reach at zero, as a fresh post is', async () => {
    const mediaId = await upload();
    const { body } = await post<XPostDto>('/api/x/posts', {
      text: 'Budget dinner for four',
      authorHandle: 'maria',
      video: { mediaId, durationS: 13 },
    });
    expect(body.metrics.views).toBe(0);
  });

  it('ignores simulated reach on a text-only post', async () => {
    const { body } = await post<XPostDto>('/api/x/posts', {
      text: 'just text',
      authorHandle: 'maria',
      simulatedViews: 5_000_000,
    });
    expect(body.metrics.views).toBe(0);
  });
});
