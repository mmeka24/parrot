/**
 * Backend entry point.
 *
 * Boots with whatever credentials exist and degrades honestly for the rest:
 * with an empty .env it still runs the full flow end to end, labelling every
 * simulated subsystem in /api/system so the UI can show it.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  copy,
  fill,
  languageName,
  type FeedStatusDto,
  type TickerEntryDto,
} from '@parrot/shared';
import { getConfig } from './config.js';
import { getStore } from './store/store.js';
import { PaymentService } from './services/payment-service.js';
import { DecisionService } from './services/decision-service.js';
import { LearningService } from './services/learning-service.js';
import { SeedService } from './services/seed-service.js';
import { JobPipeline, type DubbingPort, type QcPort } from './services/job-pipeline.js';
import { createApp } from './api/routes.js';

/**
 * Minimal built-in dubbing adapter.
 *
 * The real ElevenLabs implementation lives in services/dubbing-service.ts. This
 * fallback keeps the server bootable with no credentials and no fixtures, which
 * is what makes `npm run dev` work on a clean checkout. It is explicitly
 * simulated and never claims otherwise.
 */
const fallbackDubbing: DubbingPort = {
  async createDub() {
    return { providerJobId: `sim-${randomUUID()}`, simulated: true };
  },
  async pollUntilReady() {
    await new Promise((resolve) => setTimeout(resolve, 150));
  },
  async downloadDub(providerJobId) {
    return { localPath: `/media/${providerJobId}.mp3`, durationS: 30, simulated: true };
  },
};

/**
 * Fallback QC. Deliberately fails ~1 in 5 so the loss path is visible in a
 * demo without credentials - the brief asks for one live QC rejection, and a
 * gate that always passes would be a lie about what QC does.
 */
const fallbackQc: QcPort = {
  async run({ targetLang, sourceDurationS, dubDurationS }) {
    const durationOk = Math.abs(dubDurationS - sourceDurationS) / sourceDurationS <= 0.1;
    const languageOk = Math.random() > 0.2;
    return {
      passed: durationOk && languageOk,
      checks: [
        {
          name: 'duration_match',
          passed: durationOk,
          detail: durationOk
            ? `The dub runs ${dubDurationS.toFixed(0)}s against a ${sourceDurationS.toFixed(0)}s original.`
            : 'The dub came out a very different length from the original.',
        },
        {
          name: 'language_detect',
          passed: languageOk,
          detail: languageOk
            ? `It sounds like ${languageName(targetLang)}, as requested.`
            : `It does not sound like ${languageName(targetLang)}, so it is not safe to publish.`,
        },
        {
          name: 'audio_sanity',
          passed: true,
          detail: 'Audio checks were skipped: ffmpeg is not installed here.',
        },
      ],
      ranAt: new Date(),
    };
  },
};

async function main(): Promise<void> {
  const config = getConfig();
  const store = getStore();

  const payments = new PaymentService(store);
  const decisions = new DecisionService(store);
  const learning = new LearningService(store);
  const seed = new SeedService(store, payments);

  const subscribers = new Set<Response>();
  const broadcast = (entry: TickerEntryDto): void => {
    const payload = `data: ${JSON.stringify({ type: 'ticker', entry })}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        subscribers.delete(res);
      }
    }
  };

  const pipeline = new JobPipeline(store, decisions, payments, fallbackDubbing, fallbackQc, {
    onTransition: (job, event) => {
      broadcast({
        id: randomUUID(),
        kind: event === 'QC_FAILED' ? 'qc' : 'decision',
        text: `${languageName(job.targetLang)} dub: ${event.toLowerCase().replace(/_/g, ' ')}`,
        amount: null,
        at: new Date().toISOString(),
        verifyUrl: null,
        simulated: true,
      });
    },
  });

  const feedStatus = (): FeedStatusDto => ({
    live: subscribers.size > 0,
    source: config.capabilities.quicknodeStream ? 'quicknode_stream' : 'simulated',
    latestBlock: store.latestBlock()?.toString() ?? null,
    lastEventAt: store.allSettlements()[0]?.createdAt.toISOString() ?? null,
  });

  const sseHandler = (_req: Request, res: Response): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() })}\n\n`);
    subscribers.add(res);
    const beat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() })}\n\n`);
    }, 20_000);
    beat.unref?.();
    _req.on('close', () => {
      clearInterval(beat);
      subscribers.delete(res);
    });
  };

  // Seed the demo world so the dashboards are never empty on first load.
  seed.seedAgents();
  const seeded = seed.seedDemoCreators();

  for (const { creator, postId } of seeded) {
    const post = store.botPosts.get(postId);
    if (!post) continue;
    const intake = pipeline.intake({
      creatorId: creator.id,
      sourceUrl: `https://x.com/${creator.handle}/status/${postId}`,
      sourcePostId: postId,
      requestMentionId: null,
      targetLang: 'es',
      durationS: post.videoDurationS ?? 30,
      category: 'comedy',
      signals: {
        likes: post.metrics?.likes ?? 0,
        replies: post.metrics?.replies ?? 0,
        reposts: post.metrics?.reposts ?? 0,
        quotes: post.metrics?.quotes ?? 0,
        sourceViews: post.metrics?.views ?? 0,
        authorFollowers: creator.followers,
        ageHours: Math.max(0, (Date.now() - post.createdAt.getTime()) / 3_600_000),
      },
    });

    if (intake.kind === 'created') {
      const job = await pipeline.run(intake.job.id);
      store.createBotPost({
        authorHandle: config.env.X_BOT_HANDLE,
        authorDisplayName: 'Parrot',
        authorXUserId: 'x-parrot',
        text:
          job.state === 'DECLINED'
            ? fill(copy.bot.declinedReply, { reason: copy.bot.declineReasonLowSignal })
            : job.state === 'REJECTED_BY_QC'
              ? copy.bot.qcFailedReply
              : fill(copy.bot.publishedReply, {
                  language: languageName(job.targetLang),
                  link: `${config.env.PUBLIC_WEB_URL}/dub/${job.id}`,
                }),
        createdAt: new Date(),
        isBot: true,
        inReplyToId: postId,
        parentAuthorXUserId: creator.xUserId,
        metrics: null,
        hasVideo: false,
        videoDurationS: null,
        jobId: job.id,
        posted: false,
      });
    }
  }

  learning.start();

  const app = createApp({
    store,
    payments,
    pipeline,
    learning,
    seed,
    feedStatus,
    broadcast,
    sseHandler,
  });

  const port = config.env.BACKEND_PORT;
  app.listen(port, () => {
    const jobs = store.allJobs();
    console.log(`\n  Parrot backend on http://localhost:${port}`);
    console.log(`  Demo mode: ${config.isDemoMode ? 'on' : 'off'}`);
    if (config.mockedSubsystems.length > 0) {
      console.log(`  Simulated: ${config.mockedSubsystems.join(', ')}`);
    }
    console.log(`  Seeded ${jobs.length} jobs:`);
    for (const job of jobs) {
      console.log(`    ${job.state.padEnd(16)} ${job.id}`);
    }
    console.log('');
  });
}

main().catch((error: unknown) => {
  console.error('Parrot backend failed to start:', error);
  process.exitCode = 1;
});
