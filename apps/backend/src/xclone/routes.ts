/**
 * The local X stand-in's backend: /api/x/*.
 *
 * This is NOT part of Parrot. It is the server side of apps/x-clone, a small
 * social timeline that stands in for x.com because the real X API bills every
 * link-bearing reply (see bot/x-adapter.ts). It lives in this process only
 * because the stand-in's posts and the bot's MockXAdapter share one store -
 * the bot reads the very posts a person writes here, through the same XAdapter
 * interface it would use against the real API.
 *
 * Trust model, stated plainly: there is no sign-in. The clone says who is
 * posting (`authorHandle`) and this server believes it, exactly as the existing
 * bot console does. That is fine for a stand-in on localhost and would be a
 * hole anywhere else. The authorisation rule that matters to Parrot - only a
 * post's author may ask for a dub - still runs in the bot, on the server's own
 * record of who wrote what.
 */

import express, { type Express, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  mentionsHandle,
  simulatedEngagement,
  type ApiErrorDto,
  type XCreatePostRequestDto,
  type XEngageRequestDto,
  type XMediaUploadDto,
  type XPostDto,
  type XThreadDto,
  type XTimelineDto,
  type XUserDto,
  type XViewResponseDto,
  languageByCode,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { BotPost } from '../store/types.js';
import type { MockXAdapter } from '../bot/mock-x-adapter.js';
import { mediaUrl } from '../api/mappers.js';
import { getConfig } from '../config.js';

export interface XCloneDeps {
  store: Store;
  mockX: MockXAdapter;
  /** False when the bot is wired to the real X API; the stand-in is then off. */
  enabled: boolean;
  /** Runs the REAL bot path for a mention that is already in the store. */
  processMentionById: (mentionId: string) => Promise<unknown>;
  /** Told about every new top-level video post, so auto-dub can act on it. */
  onVideoPost?: (postId: string, authorHandle: string) => Promise<void>;
}

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const MAX_POST_LENGTH = 280;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Uploaded source clips. The prefix keeps them apart from rendered dubs. */
const MEDIA_ID_PATTERN = /^src_[a-f0-9-]{36}\.(mp4|webm|mov)$/;

const UPLOAD_TYPES: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

function fail(res: Response, status: number, title: string, detail: string): void {
  const body: ApiErrorDto = {
    ok: false,
    code: status === 404 ? 'NOT_FOUND' : status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
    title,
    detail,
  };
  res.status(status).json(body);
}

export function registerXCloneRoutes(app: Express, deps: XCloneDeps): void {
  const { store, mockX } = deps;

  const userDto = (handle: string): XUserDto => {
    const isBot = handle === mockX.botHandle;
    const user = mockX.userFor(handle);
    return {
      handle,
      displayName: isBot ? 'Parrot' : (user?.displayName ?? handle),
      followers: user?.followers ?? 0,
      isBot,
    };
  };

  const directReplies = (postId: string): BotPost[] =>
    [...store.botPosts.values()].filter((p) => p.inReplyToId === postId);

  const postDto = (post: BotPost): XPostDto => {
    const parent = post.inReplyToId ? store.botPosts.get(post.inReplyToId) : undefined;
    return {
      id: post.id,
      author: userDto(post.authorHandle),
      text: post.text,
      createdAt: post.createdAt.toISOString(),
      inReplyToId: post.inReplyToId,
      inReplyToHandle: parent?.authorHandle ?? null,
      metrics: {
        likes: post.metrics?.likes ?? 0,
        // Seeded posts carry a headline reply count; anything written here is
        // counted from what is actually in the thread.
        replies: post.metrics?.replies ?? directReplies(post.id).length,
        reposts: post.metrics?.reposts ?? 0,
        views: post.metrics?.views ?? null,
      },
      video:
        post.hasVideo && post.videoDurationS !== null
          ? { durationS: post.videoDurationS, url: mediaUrl(post.videoPath ?? null) }
          : null,
      dub: dubInfo(post),
    };
  };

  /** What a dub post carries, so the timeline can label it. */
  const dubInfo = (post: BotPost): XPostDto['dub'] => {
    const dub = post.dubId ? store.getDub(post.dubId) : undefined;
    if (!dub) return null;
    const spec = languageByCode(dub.lang);
    return {
      languageCode: dub.lang,
      languageName: spec?.englishName ?? dub.lang,
      nativeName: spec?.nativeName ?? dub.lang,
      flag: spec?.flag ?? '',
      simulated: dub.simulatedDub,
    };
  };

  // Everything under /api/x is off when the bot talks to the real X API: the
  // stand-in's posts would be invisible to it, and showing a timeline the bot
  // cannot see would be a lie.
  app.use('/api/x', (_req, res, next) => {
    if (deps.enabled) return next();
    fail(
      res,
      503,
      'The stand-in timeline is switched off',
      'This server is connected to the real service, so the local stand-in is not in use.',
    );
  });

  app.get('/api/x/timeline', (_req, res) => {
    const posts = [...store.botPosts.values()]
      .filter((p) => p.inReplyToId === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 100)
      .map(postDto);
    const payload: XTimelineDto = {
      users: mockX.listUsers().map((u) => userDto(u.handle)),
      posts,
      botHandle: mockX.botHandle,
    };
    res.json(payload);
  });

  app.get('/api/x/posts/:id', (req, res) => {
    const post = store.botPosts.get(req.params.id);
    if (!post) return fail(res, 404, 'This post does not exist', 'It may have been removed.');

    const ancestors: BotPost[] = [];
    let cursor = post.inReplyToId ? store.botPosts.get(post.inReplyToId) : undefined;
    while (cursor && ancestors.length < 20) {
      ancestors.unshift(cursor);
      cursor = cursor.inReplyToId ? store.botPosts.get(cursor.inReplyToId) : undefined;
    }

    // Breadth-first over the reply tree, then flattened by time: the thread
    // reads as a conversation, which is how a request and its answer appear.
    const replies: BotPost[] = [];
    const queue = [post.id];
    while (queue.length > 0 && replies.length < 500) {
      const id = queue.shift() as string;
      for (const child of directReplies(id)) {
        replies.push(child);
        queue.push(child.id);
      }
    }
    replies.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const payload: XThreadDto = {
      post: postDto(post),
      ancestors: ancestors.map(postDto),
      replies: replies.map(postDto),
    };
    res.json(payload);
  });

  app.post(
    '/api/x/media',
    express.raw({ type: Object.keys(UPLOAD_TYPES), limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
      const ext = UPLOAD_TYPES[contentType];
      if (!ext || !Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
        return fail(
          res,
          400,
          'That file cannot be posted',
          'Attach a video in MP4, WebM or MOV format.',
        );
      }
      const dir = getConfig().env.MEDIA_STORAGE_DIR;
      const mediaId = `src_${randomUUID()}.${ext}`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, mediaId), req.body);
      } catch {
        return fail(res, 500, 'The video could not be saved', 'Try attaching it again.');
      }
      const payload: XMediaUploadDto = { mediaId, url: mediaUrl(mediaId) ?? '' };
      res.json(payload);
    },
  );

  app.post('/api/x/posts', async (req, res) => {
    const body = (req.body ?? {}) as Partial<XCreatePostRequestDto>;
    const text = String(body.text ?? '').trim();
    const authorHandle = String(body.authorHandle ?? '')
      .replace(/^@/, '')
      .toLowerCase();
    const inReplyToId = body.inReplyToId ? String(body.inReplyToId) : null;

    if (text === '' || text.length > MAX_POST_LENGTH) {
      return fail(
        res,
        400,
        'That post cannot be sent',
        `A post needs some text, and no more than ${MAX_POST_LENGTH} characters.`,
      );
    }
    if (!HANDLE_PATTERN.test(authorHandle) || authorHandle === mockX.botHandle) {
      return fail(res, 400, 'Pick an account first', 'Choose who you are posting as.');
    }
    if (inReplyToId !== null && !store.botPosts.has(inReplyToId)) {
      return fail(res, 404, 'This post does not exist', 'It may have been removed.');
    }

    let video: { durationS: number; path: string | null } | null = null;
    if (body.video) {
      const mediaId = String(body.video.mediaId ?? '');
      const durationS = Number(body.video.durationS);
      if (!MEDIA_ID_PATTERN.test(mediaId) || !Number.isFinite(durationS) || durationS <= 0) {
        return fail(res, 400, 'That video cannot be posted', 'Attach it again and retry.');
      }
      const path = join(getConfig().env.MEDIA_STORAGE_DIR, mediaId);
      try {
        await access(path);
      } catch {
        return fail(res, 400, 'That video cannot be posted', 'Attach it again and retry.');
      }
      video = { durationS: Math.round(durationS * 10) / 10, path };
    }

    // A post that addresses the bot is a mention, and takes the bot's real
    // path. Everything else is an ordinary post the bot never sees.
    if (mentionsHandle(text, mockX.botHandle) && video === null) {
      const mention = mockX.injectMention({ text, inReplyToPostId: inReplyToId, authorHandle });
      const created = store.botPosts.get(mention.id);
      if (!created) return fail(res, 500, 'That post could not be sent', 'Try again.');
      bumpReplies(inReplyToId);
      // Answer the composer immediately; the bot works in the background and
      // its reply appears in the thread when it has one.
      void deps.processMentionById(mention.id).catch((error: unknown) => {
        console.error('[x-clone] mention failed', error);
      });
      return res.json(postDto(created));
    }

    // Demo reach: only for a top-level video post, and bounded. A fresh post
    // has no views; this gives it some, labelled as simulated.
    const requestedViews = Number(body.simulatedViews ?? 0);
    const metrics =
      video !== null && inReplyToId === null && Number.isFinite(requestedViews) && requestedViews > 0
        ? simulatedEngagement(Math.min(requestedViews, 50_000_000))
        : null;

    const created = mockX.createPost({ text, authorHandle, inReplyToPostId: inReplyToId, video, metrics });
    bumpReplies(inReplyToId);
    if (video !== null && inReplyToId === null && deps.onVideoPost) {
      void deps.onVideoPost(created.id, authorHandle).catch((error: unknown) => {
        console.error('[x-clone] auto-dub failed', error);
      });
    }
    res.json(postDto(created));
  });

  // The stand-in's own view counter. A view is counted when a post's video is
  // played, which is roughly what the real service counts.
  app.post('/api/x/posts/:id/view', (req, res) => {
    const post = store.botPosts.get(req.params.id);
    if (!post) return fail(res, 404, 'This post does not exist', 'It may have been removed.');
    const payload: XViewResponseDto = { views: mockX.addViews(post.id, 1) };
    res.json(payload);
  });

  function bumpReplies(parentId: string | null): void {
    const parent = parentId ? store.botPosts.get(parentId) : undefined;
    if (parent?.metrics) parent.metrics.replies += 1;
  }

  app.post('/api/x/posts/:id/engage', (req, res) => {
    const post = store.botPosts.get(req.params.id);
    if (!post) return fail(res, 404, 'This post does not exist', 'It may have been removed.');
    const body = (req.body ?? {}) as Partial<XEngageRequestDto>;
    const delta = body.delta === -1 ? -1 : 1;
    if (body.kind !== 'like' && body.kind !== 'repost') {
      return fail(res, 400, 'That did not work', 'Try again.');
    }
    post.metrics ??= { likes: 0, replies: directReplies(post.id).length, reposts: 0, quotes: 0, views: null };
    if (body.kind === 'like') post.metrics.likes = Math.max(0, post.metrics.likes + delta);
    else post.metrics.reposts = Math.max(0, post.metrics.reposts + delta);
    res.json(postDto(post));
  });
}
