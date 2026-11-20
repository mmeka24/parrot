/**
 * What the browser extension talks to: /api/extension/*.
 *
 * TWO SURFACES, TWO TRUST LEVELS - kept apart on purpose.
 *
 * On the stand-in (Chirp), the extension is read-only UI. It sends post ids,
 * Parrot resolves everything through its XAdapter, and a dub is requested the
 * way it always was: the creator's reply, which the extension only types for
 * them. Nothing read off the page is trusted.
 *
 * On real x.com there is no X API (it bills per call; see bot/x-adapter.ts), so
 * there is nothing to resolve against and no bot reading replies. The page is
 * the only source, so the extension reports what it reads (/observe) and asks
 * directly (/request). That data is UNVERIFIED - the person viewing a page can
 * edit it - and it is labelled `source: 'page'` all the way to the strip. What
 * bounds the damage a forged page can do: Parrot's own daily spend cap, and the
 * fact that a creator is only ever charged for views that are counted here,
 * never for numbers a page claimed.
 */

import type { Express } from 'express';
import { z } from 'zod';
import {
  PRICE_PER_VIEW,
  SUPPORTED_LANGUAGES,
  isPublished,
  micros,
  languageName,
  mentionsHandle,
  type ApiErrorDto,
  type ExtensionConfigDto,
  type ExtensionDubAcceptedDto,
  type ExtensionDubDto,
  type ExtensionResultsDto,
  type ExtensionForecastDto,
  type ExtensionPostStatusDto,
  type ExtensionStatusResponseDto,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { ObservedPost } from '../store/types.js';
import type { XAdapter } from '../bot/x-adapter.js';
import { money } from '../api/mappers.js';
import { statusPhrase } from '../bot/bot-service.js';
import { getConfig } from '../config.js';

export interface ExtensionDeps {
  store: Store;
  adapter: XAdapter;
  botHandle: string;
  /**
   * Order dubs for a page-read x.com post. `targetLang` null lets Parrot choose.
   * Resolves with what Parrot would have replied. Omitted where x.com requests
   * are not wanted (tests).
   */
  dubObservedPost?: (post: ObservedPost, targetLang: string | null) => Promise<string>;
  /** What a post is expected to get, before it is dubbed. Null when it cannot be worked out. */
  forecast?: (post: ObservedPost) => ExtensionForecastDto | null;
  /** The numbers under a dubbed post. Null when the post has not been dubbed. */
  results?: (postId: string) => ExtensionResultsDto | null;
  /**
   * Send the simulated demo audience to a dubbed post. Absent on a server that
   * is not a demo. Resolves false when there is nothing to send to.
   */
  sendAudience?: (postId: string) => Promise<boolean>;
}

const handleSchema = z
  .string()
  .regex(/^@?[A-Za-z0-9_]{1,15}$/)
  .transform((h) => h.replace(/^@/, '').toLowerCase());

const countSchema = z.number().int().nonnegative().max(10_000_000_000);

const observedSchema = z.object({
  // Real x.com ids are numeric snowflakes.
  postId: z.string().regex(/^[0-9]{1,25}$/),
  authorHandle: handleSchema,
  authorDisplayName: z.string().max(100),
  text: z.string().max(2_000),
  metrics: z.object({
    likes: countSchema,
    replies: countSchema,
    reposts: countSchema,
    views: countSchema.nullable(),
  }),
  durationS: z.number().positive().max(4 * 3600).nullable(),
  createdAt: z.string().datetime().nullable(),
});

/** Shape only; each post is validated on its own (see /observe). */
const observeSchema = z.object({ posts: z.array(z.unknown()).max(50) });

const audienceSchema = z.object({
  postId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  requesterHandle: handleSchema,
});

const requestSchema = z.object({
  postId: z.string().regex(/^[0-9]{1,25}$/),
  languageCode: z.string().nullish(),
  requesterHandle: handleSchema,
});

/** Observed posts kept at most; the oldest are dropped past this. */
const MAX_OBSERVED = 5_000;

function badRequest(title: string, detail: string): ApiErrorDto {
  return { ok: false, code: 'BAD_REQUEST', title, detail };
}

/** How many post ids one status call may carry. A timeline page, with room. */
const MAX_IDS = 50;

/** A request with no answer after this long is no longer shown as in progress. */
const PENDING_WINDOW_MS = 15 * 60_000;

export function registerExtensionRoutes(app: Express, deps: ExtensionDeps): void {
  const { store, adapter, botHandle } = deps;

  app.get('/api/extension/config', (_req, res) => {
    const config = getConfig();
    const payload: ExtensionConfigDto = {
      botHandle,
      requestTemplate: '@{handle} dub this to {language}',
      // English is the source language of the demo posts, not a dub target.
      languages: SUPPORTED_LANGUAGES.filter((l) => l.code !== 'en').map((l) => ({
        code: l.code,
        englishName: l.englishName,
      })),
      pricePerThousand: money(micros((PRICE_PER_VIEW as bigint) * 1_000n)),
      webUrl: config.env.PUBLIC_WEB_URL.replace(/\/$/, ''),
      simulated: config.mockedSubsystems,
    };
    res.json(payload);
  });

  app.get('/api/extension/posts', async (req, res) => {
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '' && id.length <= 64)
      .slice(0, MAX_IDS);

    const posts = await Promise.all([...new Set(ids)].map((id) => statusFor(id)));
    const payload: ExtensionStatusResponseDto = { posts };
    res.json(payload);
  });

  app.get('/api/extension/forecast', (req, res) => {
    const postId = String(req.query.postId ?? '');
    const nothing = badRequest('No estimate yet', 'Parrot needs to have seen the video, and know how long it is.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(postId) || !deps.forecast) return res.status(404).json(nothing);
    const post = store.observedPosts.get(postId);
    if (!post) return res.status(404).json(nothing);
    const forecast = deps.forecast(post);
    if (!forecast) return res.status(404).json(nothing);
    res.json(forecast);
  });

  app.get('/api/extension/results', (req, res) => {
    const postId = String(req.query.postId ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(postId) || !deps.results) {
      return res.status(404).json(badRequest('Nothing to show', 'Parrot has no dubs for that post.'));
    }
    const results = deps.results(postId);
    if (!results) return res.status(404).json(badRequest('Nothing to show', 'Parrot has no dubs for that post.'));
    res.json(results);
  });

  // Demo only: simulated viewers, so the numbers have something to move on.
  // Authorship is the same page-read check as a dub request.
  app.post('/api/extension/audience', (req, res) => {
    if (!deps.sendAudience || !deps.results) {
      return res.status(404).json(badRequest('Not available here', 'This server does not run the demo audience.'));
    }
    const parsed = audienceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(badRequest('That could not be read', 'Try again.'));
    const results = deps.results(parsed.data.postId);
    if (!results || results.handle.toLowerCase() !== parsed.data.requesterHandle) {
      return res.status(403).json(badRequest('Not your video', 'Only the person who posted the video can do that.'));
    }
    if (!results.canSendAudience) {
      return res.status(409).json(badRequest('Not yet', 'Wait until the dubs are live, and send the audience once.'));
    }
    void deps.sendAudience(parsed.data.postId).catch((error: unknown) => console.error('[extension] audience failed', error));
    res.status(202).json({ ok: true });
  });

  // ---- x.com only -----------------------------------------------------------

  app.post('/api/extension/observe', (req, res) => {
    const parsed = observeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(badRequest('That could not be read', 'The page sent something unexpected.'));
    }
    const now = new Date();
    // Each post on its own: one odd post on a page (an ad, a missing count)
    // must not stop Parrot seeing the rest of the timeline.
    const valid = parsed.data.posts
      .map((raw) => observedSchema.safeParse(raw))
      .filter((r) => r.success)
      .map((r) => r.data);
    for (const post of valid) {
      const previous = store.observedPosts.get(post.postId);
      store.observedPosts.set(post.postId, {
        postId: post.postId,
        authorHandle: post.authorHandle,
        authorDisplayName: post.authorDisplayName,
        text: post.text,
        metrics: post.metrics,
        // A length read once stays known when a later read misses it.
        durationS: post.durationS ?? previous?.durationS ?? null,
        createdAt: post.createdAt ? new Date(post.createdAt) : (previous?.createdAt ?? null),
        observedAt: now,
        pendingSince: previous?.pendingSince ?? null,
        lastAnswer: previous?.lastAnswer ?? null,
      });
    }
    // Bounded: a long scroll session must not grow memory without limit.
    while (store.observedPosts.size > MAX_OBSERVED) {
      const oldest = store.observedPosts.keys().next().value;
      if (oldest === undefined) break;
      store.observedPosts.delete(oldest);
    }
    res.json({ ok: true, stored: valid.length, rejected: parsed.data.posts.length - valid.length });
  });

  app.post('/api/extension/request', (req, res) => {
    if (!deps.dubObservedPost) {
      return res.status(404).json(badRequest('Not available here', 'This server does not take requests from X.'));
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json(badRequest('That could not be read', 'Pick a language and try again.'));
    }
    const { postId, languageCode, requesterHandle } = parsed.data;
    const post = store.observedPosts.get(postId);
    if (!post) {
      return res
        .status(404)
        .json(badRequest('Parrot has not seen that post', 'Scroll back to it and try again.'));
    }
    if (post.durationS === null) {
      // Without a length the cost of the dub cannot be known.
      return res
        .status(400)
        .json(badRequest('Parrot could not tell how long the video is', 'Play it for a moment and try again.'));
    }
    // Authorship, on the only evidence there is: the page. Unverified, and
    // labelled so - but it still stops the honest mistake of dubbing someone
    // else's video and charging them for it.
    if (requesterHandle !== post.authorHandle) {
      return res.status(403).json({
        ok: false,
        code: 'BAD_REQUEST',
        title: 'Not your video',
        detail: 'Only the person who posted the video can ask for a dub.',
      } satisfies ApiErrorDto);
    }
    // No language means "you choose".
    const language = languageCode ? SUPPORTED_LANGUAGES.find((l) => l.code === languageCode && l.code !== 'en') : null;
    if (languageCode && !language) {
      return res.status(400).json(badRequest('Parrot does not speak that one yet', 'Pick another language.'));
    }
    if (post.pendingSince && Date.now() - post.pendingSince.getTime() < PENDING_WINDOW_MS) {
      return res
        .status(409)
        .json(badRequest('Parrot is already on it', 'Wait for the answer to the last request.'));
    }

    post.pendingSince = new Date();
    const run = deps.dubObservedPost;
    void run(post, language?.code ?? null)
      .then((answer) => {
        post.lastAnswer = { text: answer, at: new Date() };
      })
      .catch((error: unknown) => {
        console.error('[extension] x.com request failed', error);
        post.lastAnswer = {
          text: 'Something went wrong on my side. Nothing was charged to you. Try again shortly.',
          at: new Date(),
        };
      })
      .finally(() => {
        post.pendingSince = null;
      });

    // Answer at once; the strip shows progress by polling the post's status.
    const payload: ExtensionDubAcceptedDto = { ok: true };
    res.status(202).json(payload);
  });

  async function statusFor(postId: string): Promise<ExtensionPostStatusDto> {
    const webUrl = getConfig().env.PUBLIC_WEB_URL.replace(/\/$/, '');

    const dubbed = store.findPostBySource(postId);
    const records = dubbed ? store.dubsForPost(dubbed.id) : [];
    const working = records.some((d) => d.state === 'QUEUED' || d.state === 'DUBBING' || d.state === 'QC');
    const dubs: ExtensionDubDto[] = records.map((dub) => {
      const watchable = isPublished(dub.state);
      return {
        jobId: dub.id,
        languageCode: dub.lang,
        languageName: languageName(dub.lang),
        state: dub.state,
        statusLabel: statusPhrase(dub.state),
        watchable,
        watchUrl: watchable ? `${webUrl}/dub/${dub.id}` : null,
      };
    });

    // The authoritative read. With no dubs yet this is the only way to know
    // whether the post exists, has a video, and who wrote it.
    let source = null;
    try {
      source = await adapter.getPost(postId);
    } catch {
      source = null;
    }

    // A real x.com post: all Parrot has is what a page told it.
    const observed = source === null ? store.observedPosts.get(postId) : undefined;
    if (observed) {
      const recent =
        observed.pendingSince !== null &&
        Date.now() - observed.pendingSince.getTime() < PENDING_WINDOW_MS;
      return {
        postId,
        known: true,
        hasVideo: true,
        authorHandle: observed.authorHandle,
        dubs,
        pending: recent || working,
        lastReply: observed.lastAnswer
          ? { text: observed.lastAnswer.text, at: observed.lastAnswer.at.toISOString() }
          : null,
        source: 'page',
      };
    }

    // Requests and answers under the post, from the bot's own timeline record.
    const requests = [...store.botPosts.values()].filter(
      (p) => !p.isBot && p.inReplyToId === postId && mentionsHandle(p.text, botHandle),
    );
    const requestIds = new Set(requests.map((r) => r.id));
    const answers = [...store.botPosts.values()]
      .filter((p) => p.isBot && p.inReplyToId !== null && requestIds.has(p.inReplyToId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const answered = new Set(answers.map((a) => a.inReplyToId));

    const now = Date.now();
    const pending = requests.some((request) => {
      if (answered.has(request.id)) return false;
      if (now - request.createdAt.getTime() > PENDING_WINDOW_MS) return false;
      const record = store.processedMentions.get(request.id);
      // Not picked up yet, or picked up and still being worked on.
      return record === undefined || record.outcome === 'claimed';
    });

    const last = answers[answers.length - 1];

    return {
      postId,
      known: source !== null || dubs.length > 0,
      hasVideo: source?.video != null,
      authorHandle: source?.authorHandle.toLowerCase() ?? null,
      dubs,
      pending: pending || working,
      lastReply: last ? { text: last.text, at: last.createdAt.toISOString() } : null,
      source: 'server',
    };
  }
}
