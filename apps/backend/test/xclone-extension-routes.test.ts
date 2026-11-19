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
  registerExtensionRoutes(app, { store, adapter: mockX, botHandle: 'parrot' });

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
