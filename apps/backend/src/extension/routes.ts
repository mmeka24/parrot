/**
 * What the browser extension talks to: /api/extension/*.
 *
 * Two read-only endpoints. The extension is UI: it finds post ids in the page,
 * asks here what Parrot knows about them, and draws the answer. It cannot
 * create a job. A dub is requested the way it always was - by the creator
 * replying under their own post - and the extension only types that reply into
 * the page's own composer for them.
 *
 * That shape is deliberate. Anything read out of a web page can be forged by
 * the person looking at it, so nothing the extension could send is trusted:
 * authorship, engagement and the video are resolved here, through the XAdapter,
 * and an inflated like count in someone's DOM can never talk an agent into
 * paying for a dub.
 */

import type { Express } from 'express';
import {
  DEFAULT_SPLIT_CREATOR_BPS,
  SUPPORTED_LANGUAGES,
  UNLOCK_PRICE,
  isPublished,
  languageName,
  mentionsHandle,
  type ExtensionConfigDto,
  type ExtensionDubDto,
  type ExtensionPostStatusDto,
  type ExtensionStatusResponseDto,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { XAdapter } from '../bot/x-adapter.js';
import { money, statusLabel } from '../api/mappers.js';
import { getConfig } from '../config.js';

export interface ExtensionDeps {
  store: Store;
  adapter: XAdapter;
  botHandle: string;
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
      unlockPrice: money(UNLOCK_PRICE),
      creatorPercent: DEFAULT_SPLIT_CREATOR_BPS / 100,
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

  async function statusFor(postId: string): Promise<ExtensionPostStatusDto> {
    const webUrl = getConfig().env.PUBLIC_WEB_URL.replace(/\/$/, '');

    const dubs: ExtensionDubDto[] = store
      .allJobs()
      .filter((job) => job.sourcePostId === postId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((job) => {
        const watchable = isPublished(job.state);
        return {
          jobId: job.id,
          languageCode: job.targetLang,
          languageName: languageName(job.targetLang),
          state: job.state,
          statusLabel: statusLabel(job.state),
          watchable,
          watchUrl: watchable ? `${webUrl}/dub/${job.id}` : null,
        };
      });

    // The authoritative read. With no jobs yet this is the only way to know
    // whether the post exists, has a video, and who wrote it.
    let source = null;
    try {
      source = await adapter.getPost(postId);
    } catch {
      source = null;
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
      pending,
      lastReply: last ? { text: last.text, at: last.createdAt.toISOString() } : null,
    };
  }
}
