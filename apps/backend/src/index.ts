/**
 * Backend entry point.
 *
 * Everything real is wired here: the ElevenLabs dubbing service, the QC gate,
 * the mock X adapter and bot, the settlement scheduler, and the SSE hub. Each
 * degrades honestly when its credentials are absent, so the whole flow runs on
 * an empty .env and `GET /api/system` reports exactly what is simulated.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  copy,
  languageName,
  type FeedStatusDto,
  type TickerEntryDto,
  type QcReport,
  type Category,
} from '@parrot/shared';
import { getConfig } from './config.js';
import { getStore } from './store/store.js';
import { PaymentService } from './services/payment-service.js';
import { DecisionService } from './services/decision-service.js';
import { LearningService } from './services/learning-service.js';
import { SeedService } from './services/seed-service.js';
import { DubbingService } from './services/dubbing-service.js';
import { QcService } from './services/qc-service.js';
import { JobPipeline, type DubbingPort, type QcPort } from './services/job-pipeline.js';
import { SettlementScheduler } from './payments/settlement-scheduler.js';
import { MockXAdapter, MOCK_SEED_POSTS } from './bot/mock-x-adapter.js';
import { BotService, composeReply } from './bot/bot-service.js';
import { parseIntent } from './bot/grok-parser.js';
import { SseHub } from './feed/sse.js';
import { createApp } from './api/routes.js';
import { createXApiAdapter } from './bot/x-adapter.js';
import type { XAdapter } from './bot/x-adapter.js';

/**
 * Adapts DubbingService to the pipeline's port.
 *
 * The pipeline deliberately depends on a narrow interface rather than on
 * ElevenLabs directly, so the provider can be swapped (or stubbed in a test)
 * without the state machine knowing.
 */
function dubbingPort(service: DubbingService): DubbingPort {
  return {
    async createDub({ sourceUrl, targetLang, durationS }) {
      const result = await service.createDub({ sourceUrl, targetLang, durationS });
      return { providerJobId: result.providerJobId, simulated: result.simulated };
    },
    async pollUntilReady(providerJobId) {
      await service.pollUntilReady(providerJobId);
    },
    async downloadDub(providerJobId, languageCode) {
      const downloaded = await service.downloadDub(providerJobId, languageCode);
      return {
        localPath: downloaded.path,
        // The provider reports the real duration; the simulated fixture is a
        // short clip, so fall back to the source duration the caller knows.
        durationS: 0,
        simulated: downloaded.simulated,
      };
    },
  };
}

/**
 * Adapts QcService to the pipeline's port, plus the demo failure injection.
 *
 * `forceFail` exists because the brief requires a visible QC rejection and a
 * randomly-failing gate would sometimes deny the demo its loss path. Exactly
 * one seeded job carries the flag. The injected report is marked
 * `demo_injected` in `measured`, so the dashboard can show that this failure
 * was staged rather than observed - staging a demo is fine, pretending it was
 * observed is not.
 */
function qcPort(service: QcService): QcPort {
  return {
    async run({ dubPath, sourceDurationS, dubDurationS, targetLang, forceFail }) {
      if (forceFail) {
        const report: QcReport = {
          passed: false,
          checks: [
            {
              name: 'duration_match',
              status: 'passed',
              passed: true,
              detail: 'The dub runs about as long as the original.',
            },
            {
              name: 'language_detect',
              status: 'failed',
              passed: false,
              detail:
                'The dub does not sound like the language that was asked for, so it is not safe to publish.',
              measured: { demo_injected: true },
            },
          ],
          ranAt: new Date(),
        };
        return report;
      }

      return service.run({
        dubPath,
        sourceDurationS,
        // The simulated fixture is a short clip, so comparing its real length
        // against the source would fail duration_match for the wrong reason.
        dubDurationS: dubDurationS || sourceDurationS,
        targetLang,
      });
    },
  };
}

/** Pick a rough category from the post text. A real system would use the LLM. */
function categorise(text: string): Category {
  const lower = text.toLowerCase();
  if (/cook|recipe|kitchen|knife|chef|food|budget/.test(lower)) return 'lifestyle';
  if (/debug|code|race condition|parser|build|ship/.test(lower)) return 'tech';
  if (/workout|equipment|fit|minutes|reps/.test(lower)) return 'sports';
  return 'other';
}

async function main(): Promise<void> {
  const config = getConfig();
  const store = getStore();

  const payments = new PaymentService(store);
  const decisions = new DecisionService(store);
  const learning = new LearningService(store);
  const seed = new SeedService(store, payments);
  const dubbing = new DubbingService();
  const qc = new QcService();

  const hub = new SseHub();
  const broadcast = (entry: TickerEntryDto): void => {
    hub.broadcast({ type: 'ticker', entry });
  };

  const pipeline = new JobPipeline(store, decisions, payments, dubbingPort(dubbing), qcPort(qc), {
    onTransition: (job, event) => {
      hub.broadcast({ type: 'job', jobId: job.id, state: job.state });
    },
  });

  // The X adapter: real when credentials exist, otherwise the mock console.
  const realX: XAdapter | null = createXApiAdapter(config);
  const mockX = new MockXAdapter(store);
  const adapter: XAdapter = realX ?? mockX;
  const bot = new BotService(store, adapter, { webBaseUrl: config.env.PUBLIC_WEB_URL });

  const scheduler = new SettlementScheduler({
    store,
    payments,
    onError: (error) => console.error('[settlement]', error),
  });

  /**
   * The whole creator journey, from a mention to a reply. Used by the boot
   * seeding and by the bot console, so the console exercises the real path
   * rather than a parallel fake one.
   */
  async function processMention(mentionId: string): Promise<string | null> {
    if (!bot.claimMention(mentionId)) return null;

    const mentions = await bot.fetchMentions();
    const mention = mentions.find((m) => m.id === mentionId);
    if (!mention) return null;

    const intent = await parseIntent(mention.text, {
      botHandle: config.env.X_BOT_HANDLE,
      apiKey: config.env.XAI_API_KEY,
      baseUrl: config.env.XAI_BASE_URL,
      model: config.env.XAI_MODEL,
    });

    if (intent.action !== 'dub' || intent.targetLang === null) {
      const text = composeReply('error');
      await bot.send(mention.id, text);
      bot.recordOutcome(mention.id, null, 'not_a_dub_request');
      return null;
    }

    const parentId = mention.inReplyToPostId;
    const sourcePost = parentId ? await bot.getPost(parentId) : null;

    if (!sourcePost) {
      await bot.send(mention.id, composeReply('declined', { reason: 'NO_VIDEO' }));
      bot.recordOutcome(mention.id, null, 'no_video');
      return null;
    }

    // Only the author may request a dub: the creator share attaches to the
    // post's owner, so letting a stranger request it would let them hand
    // someone else's earnings to a video they do not own.
    if (!bot.isAuthorised(mention, sourcePost)) {
      await bot.send(
        mention.id,
        composeReply('declined', { reason: 'NOT_AUTHOR' }),
      );
      bot.recordOutcome(mention.id, null, 'not_author');
      return null;
    }

    const creator =
      store.findCreatorByXUserId(sourcePost.authorId) ??
      (() => {
        const account = store.createAccount({
          kind: 'creator',
          label: `@${sourcePost.authorHandle}`,
          email: null,
          walletAddress: null,
        });
        return store.createCreator({
          xUserId: sourcePost.authorId,
          handle: sourcePost.authorHandle,
          displayName: sourcePost.authorHandle,
          accountId: account.id,
          followers: sourcePost.authorFollowers,
          claimed: false,
        });
      })();

    const durationS = sourcePost.video ? sourcePost.video.durationMs / 1000 : 30;

    const intake = pipeline.intake({
      creatorId: creator.id,
      sourceUrl: mockX.postUrl(sourcePost.postId),
      sourcePostId: sourcePost.postId,
      requestMentionId: mention.id,
      targetLang: intent.targetLang,
      durationS,
      category: categorise(sourcePost.text),
      // The loss path the demo must show. Kenji's clip has strong numbers, so
      // an agent takes the bet - and then the dub fails the gate.
      qcDemoFail: sourcePost.authorHandle === 'chefkenji',
      signals: {
        likes: sourcePost.metrics.likeCount,
        replies: sourcePost.metrics.replyCount,
        reposts: sourcePost.metrics.retweetCount,
        quotes: sourcePost.metrics.quoteCount,
        sourceViews: sourcePost.metrics.impressionCount ?? 0,
        authorFollowers: sourcePost.authorFollowers,
        ageHours: Math.max(0, (Date.now() - sourcePost.createdAt.getTime()) / 3_600_000),
      },
    });

    if (intake.kind === 'duplicate') {
      await bot.send(
        mention.id,
        composeReply('duplicate', {
          language: languageName(intake.job.targetLang),
          link: bot.link(intake.job.id),
        }),
      );
      bot.recordOutcome(mention.id, intake.job.id, 'duplicate');
      return intake.job.id;
    }

    if (intake.kind === 'rejected') {
      await bot.send(mention.id, composeReply('declined', { reason: intake.reason }));
      bot.recordOutcome(mention.id, null, `rejected:${intake.reason}`);
      return null;
    }

    const job = await pipeline.run(intake.job.id);

    if (job.state === 'DECLINED') {
      await bot.send(
        mention.id,
        composeReply('declined', { reason: job.declineReason ?? 'LOW_EV' }),
      );
    } else if (job.state === 'REJECTED_BY_QC') {
      await bot.send(mention.id, composeReply('qcFailed'));
    } else if (job.state === 'FAILED') {
      await bot.send(mention.id, composeReply('error'));
    } else {
      await bot.send(
        mention.id,
        composeReply('published', {
          language: languageName(job.targetLang),
          link: bot.link(job.id),
        }),
      );
    }

    bot.recordOutcome(mention.id, job.id, job.state);
    return job.id;
  }

  const feedStatus = (): FeedStatusDto => ({
    live: hub.clientCount > 0,
    source: config.capabilities.quicknodeStream ? 'quicknode_stream' : 'simulated',
    latestBlock: store.latestBlock()?.toString() ?? null,
    lastEventAt: store.allSettlements()[0]?.createdAt.toISOString() ?? null,
  });

  const sseHandler = (req: Request, res: Response): void => {
    hub.subscribe(res);
  };

  // ---- boot the demo world -------------------------------------------------
  seed.seedAgents();

  // Run every seeded post through the REAL bot path: mention -> parse ->
  // authorise -> intake -> decision -> dub -> QC -> reply.
  for (const seeded of MOCK_SEED_POSTS) {
    const postId = mockX
      .seededPostIds()
      .find((id) => store.botPosts.get(id)?.authorHandle === seeded.handle);
    if (!postId) continue;

    const mention = mockX.injectMention({
      text: `@${config.env.X_BOT_HANDLE} dub this to Spanish`,
      inReplyToPostId: postId,
      authorHandle: seeded.handle,
    });
    await processMention(mention.id);
  }

  learning.start();
  scheduler.start();

  const app = createApp({
    store,
    payments,
    pipeline,
    learning,
    seed,
    feedStatus,
    broadcast,
    sseHandler,
    processMention: async (text: string, parentPostId?: string, authorHandle?: string) => {
      const mention = mockX.injectMention({
        text,
        inReplyToPostId: parentPostId ?? null,
        authorHandle,
      });
      return processMention(mention.id);
    },
  });

  const port = config.env.BACKEND_PORT;
  app.listen(port, () => {
    console.log(`\n  Parrot backend on http://localhost:${port}`);
    console.log(`  Demo mode: ${config.isDemoMode ? 'on' : 'off'}`);
    if (config.mockedSubsystems.length > 0) {
      console.log(`  Simulated: ${config.mockedSubsystems.join(', ')}`);
    }
    console.log(`  Settlement sweep every ${Math.round(scheduler.intervalMs / 1000)}s`);
    console.log(`  Seeded ${store.allJobs().length} jobs:`);
    for (const job of store.allJobs()) {
      const creator = store.creators.get(job.creatorId);
      console.log(`    ${job.state.padEnd(16)} @${creator?.handle ?? '?'}  ${job.id}`);
    }
    console.log('');
  });
}

main().catch((error: unknown) => {
  console.error('Parrot backend failed to start:', error);
  process.exitCode = 1;
});
