/**
 * Backend entry point.
 *
 * Everything real is wired here: the ElevenLabs dubbing service, the quality
 * check, the timeline adapter and bot, view counting, billing on Arc and the
 * live event stream. Each degrades honestly when its credentials are absent, so
 * the whole flow runs on an empty .env and `GET /api/system` reports exactly
 * what is simulated.
 */

import type { Request, Response } from 'express';
import {
  BILLING_INTERVAL_MS,
  DEMO_BILLING_INTERVAL_MS,
  VIEW_SYNC_INTERVAL_MS,
  parseStatusHref,
  parseUsd,
  type QcReport,
} from '@parrot/shared';
import { createApp } from './api/routes.js';
import { extensionForecast, extensionResults, mediaUrl } from './api/mappers.js';
import { BotService, replies } from './bot/bot-service.js';
import { MockXAdapter } from './bot/mock-x-adapter.js';
import { createXApiAdapter, type XAdapter } from './bot/x-adapter.js';
import { addressFromKey, type Address, type Hex } from './chain/client.js';
import { getConfig, loadDotEnv } from './config.js';
import { SseHub } from './feed/sse.js';
import { BillingService } from './services/billing-service.js';
import { CampaignService, type DubbingPort, type PublisherPort, type QcPort } from './services/campaign-service.js';
import { DemoAudience } from './services/demo-audience.js';
import { DubFlow } from './services/dub-flow.js';
import { DubbingService } from './services/dubbing-service.js';
import { InsightService } from './services/insight-service.js';
import { MediaFetcher, X_STATUS_URL } from './services/media-fetcher.js';
import { DemoPayer, WalletPayer, creatorPayer } from './services/payers.js';
import { QcService } from './services/qc-service.js';
import { ReplyLanguageReader } from './services/reply-languages.js';
import { ViewService } from './services/view-service.js';
import { getStore } from './store/store.js';
import type { Creator } from './store/types.js';
import { buildAccounts } from './users/setup.js';

/**
 * What stands behind a post's source link.
 *
 *  - `file`: a clip someone really uploaded to the stand-in. Dubbed for real
 *    when a key is configured.
 *  - `none`: a seeded demo post. It has a duration and an audience but no
 *    media, so it is ALWAYS simulated - even with a key. Without this, adding a
 *    key would send those links to the provider and fail every seeded dub.
 *  - `remote`: a real post on the real service; the provider fetches the link.
 *  - `x`: a post read off x.com by the extension. There is no stored file, so
 *    the video is downloaded first (MediaFetcher); if the downloader is not
 *    installed it falls back to `remote`.
 */
type SourceMedia = { kind: 'file'; path: string } | { kind: 'none' } | { kind: 'remote' } | { kind: 'x' };

/** Who makes the dubs. The quality check refuses to grade its own vendor's work. */
const DUB_PROVIDER = 'ElevenLabs';

/**
 * Adapts DubbingService to the campaign's port. The campaign depends on a
 * narrow interface rather than on ElevenLabs directly, so the provider can be
 * swapped (or stubbed in a test) without the state machine knowing.
 */
function dubbingPort(
  service: DubbingService,
  resolveSource: (sourceUrl: string) => SourceMedia,
  fetcher: MediaFetcher,
): DubbingPort {
  return {
    async createDub({ sourceUrl, targetLang, durationS }) {
      let source = resolveSource(sourceUrl);
      if (source.kind === 'x') {
        // Fetch the real video. Null means the downloader is not installed:
        // let the provider try the link itself rather than fail outright.
        const path = await fetcher.fetch(sourceUrl);
        source = path ? { kind: 'file', path } : { kind: 'remote' };
      }
      const result =
        source.kind === 'file'
          ? // A really-uploaded clip: send the bytes. The provider cannot fetch
            // a localhost URL, so a link would only ever fail.
            await service.createDub({ filePath: source.path, targetLang, durationS })
          : await service.createDub({ sourceUrl, targetLang, durationS, simulate: source.kind === 'none' });
      return { providerJobId: result.providerJobId, simulated: result.simulated };
    },
    async pollUntilReady(providerJobId) {
      await service.pollUntilReady(providerJobId);
    },
    async downloadDub(providerJobId, languageCode) {
      const downloaded = await service.downloadDub(providerJobId, languageCode);
      return { localPath: downloaded.path, simulated: downloaded.simulated };
    },
  };
}

/**
 * Adapts QcService to the campaign's port, plus the demo failure injection.
 *
 * `forceFail` exists because a demo should be able to show a dub being
 * scrapped, and a randomly-failing check would sometimes deny it that. The
 * injected report is marked `demo_injected` and says so in its own words:
 * staging a demo is fine, pretending it was observed is not.
 */
function qcPort(
  service: QcService,
  resolveSource: (sourceUrl: string) => SourceMedia,
  fetcher: MediaFetcher,
): QcPort {
  return {
    async run({ dubPath, sourceDurationS, targetLang, simulated, sourceUrl, forceFail }) {
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
              detail: 'Staged for the demo: this dub was made to fail the language check, to show what happens when one does.',
              measured: { demo_injected: true },
            },
          ],
          ranAt: new Date(),
        };
        return report;
      }

      const source = resolveSource(sourceUrl);
      // A post read off x.com: the original was downloaded to make the dub, so
      // the meaning check can compare against that same file (no second
      // download: the fetcher remembers it).
      const fetched = source.kind === 'x' && !simulated ? await fetcher.fetch(sourceUrl).catch(() => null) : null;
      return service.run({
        // The stand-in render is named `.sim.wav` by DubbingService. It has no
        // real speech, so its speech checks are skipped rather than run.
        simulated: simulated || dubPath.endsWith('.sim.wav'),
        dubPath,
        sourceDurationS,
        // Only the stand-in has a declared length; real dubs are measured.
        dubDurationS: sourceDurationS,
        targetLang,
        // Where the check can read the original, for the meaning check: an
        // uploaded file or a real public link. Seeded posts have no media and
        // an x.com page is not media itself, so both skip it (and say so).
        sourcePath:
          fetched
            ? fetched
            : source.kind === 'file'
            ? source.path
            : source.kind === 'remote' && /^https:\/\//.test(sourceUrl)
              ? sourceUrl
              : undefined,
        dubProvider: DUB_PROVIDER,
      });
    },
  };
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = getConfig();
  const store = getStore();
  const hub = new SseHub();

  const notify = (creator: Creator, reason: 'dub' | 'views' | 'payment' | 'settings'): void => {
    hub.broadcast({ type: 'creator', handle: creator.handle, reason });
  };

  // ---- the timeline ---------------------------------------------------------
  // The real X API when credentials exist, otherwise the local stand-in. The
  // stand-in is always built, because the extension's x.com mode needs
  // somewhere to keep what it has seen.
  const realX: XAdapter | null = createXApiAdapter(config);
  const mockX = new MockXAdapter(store, {
    botHandle: config.env.X_BOT_HANDLE,
    permalinkBase: config.env.PUBLIC_XCLONE_URL,
    mediaUrlFor: (videoPath) => mediaUrl(videoPath),
  });
  const adapter: XAdapter = realX ?? mockX;
  // The local stand-in (Chirp) is optional: with CHIRP_ENABLED=false everything
  // comes from the posts the extension reads off x.com.
  const standIn = adapter.isMock && config.env.CHIRP_ENABLED ? mockX : null;
  const bot = new BotService(store, adapter, { webBaseUrl: config.env.PUBLIC_WEB_URL });

  const resolveSource = (sourceUrl: string): SourceMedia => {
    // A post the extension read off x.com: fetch its real video.
    const xPost = X_STATUS_URL.exec(sourceUrl)?.[2];
    if (xPost !== undefined && store.observedPosts.has(xPost)) return { kind: 'x' };
    if (!adapter.isMock) return { kind: 'remote' };
    const postId = parseStatusHref(sourceUrl)?.postId;
    if (postId && store.observedPosts.has(postId)) return { kind: 'remote' };
    const videoPath = postId ? store.botPosts.get(postId)?.videoPath : null;
    return videoPath ? { kind: 'file', path: videoPath } : { kind: 'none' };
  };

  // ---- accounts and payments ------------------------------------------------
  const { accounts, status: accountsStatus } = await buildAccounts(config, store);
  const revenueKey = config.env.PARROT_REVENUE_PRIVATE_KEY as Hex | undefined;
  const revenueAddress: Address | null = revenueKey ? addressFromKey(revenueKey) : null;
  const payer = creatorPayer(
    new DemoPayer(store),
    accounts && revenueAddress ? new WalletPayer(accounts, revenueAddress) : null,
  );

  // ---- dubbing --------------------------------------------------------------
  const publisher: PublisherPort = {
    async publish({ sourcePostId, dub, durationS }) {
      const text = replies.dubPost(dub.lang, bot.link(dub.id));
      if (standIn) {
        // A post seen only through the extension has no thread here to post in.
        if (!store.botPosts.has(sourcePostId)) return { postId: null, url: null };
        const reply = await standIn.postDub({
          inReplyToId: sourcePostId,
          text,
          dubId: dub.id,
          durationS,
          // A stand-in dub is a test tone: there is nothing worth playing.
          videoPath: dub.simulatedDub ? null : dub.mediaPath,
        });
        return { postId: reply.id, url: standIn.postUrl(reply.id) };
      }
      const reply = await adapter.reply(sourcePostId, text);
      return { postId: reply.id, url: `https://x.com/i/status/${reply.id}` };
    },
  };

  const fetcher = new MediaFetcher();
  const campaigns = new CampaignService({
    store,
    dubbing: dubbingPort(new DubbingService(), resolveSource, fetcher),
    qc: qcPort(new QcService({ ffmpegPath: config.env.FFMPEG_PATH }), resolveSource, fetcher),
    exploreCount: config.env.EXPLORE_LANGUAGES,
    publisher,
    available: (creator) => payer.available(creator),
    announce: async (inReplyToId, kind, lang) => {
      await bot.send(inReplyToId, kind === 'qcFailed' ? replies.qcFailed(lang) : replies.failed(lang));
    },
    onChange: notify,
    // How long a post's dubs are watched before their results count.
    measureWindowMs: config.isDemoMode ? 60_000 : 24 * 60 * 60_000,
  });

  const grok = { apiKey: config.env.XAI_API_KEY, baseUrl: config.env.XAI_BASE_URL, model: config.env.XAI_MODEL };
  const flow = new DubFlow({
    store,
    bot,
    campaigns,
    mockX: standIn,
    botHandle: config.env.X_BOT_HANDLE,
    grok,
    dailySpendCap: config.env.DAILY_DUB_SPEND_CAP_USD ? parseUsd(config.env.DAILY_DUB_SPEND_CAP_USD) : null,
    // The demo's loss path: one of @chefkenji's dubs is made to fail the check.
    qcDemoFail: standIn ? { chefkenji: ['fr'] } : {},
  });

  const views = new ViewService({
    store,
    adapter,
    campaigns,
    replyLanguages: new ReplyLanguageReader(grok),
    onChange: notify,
  });
  const billing = new BillingService({ store, payer, onChange: notify });
  const insights = new InsightService({
    ...grok,
    onReady: (handle) => hub.broadcast({ type: 'creator', handle, reason: 'views' }),
  });
  // The simulated audience belongs to a demo server, not to Chirp: it works on
  // dubs of a post read through the extension too. On a public server it is
  // closed unless DEMO_OPEN is set.
  const demoAllowed = config.isDemoMode && (config.env.NODE_ENV !== 'production' || config.env.DEMO_OPEN);
  const demoAudience = demoAllowed ? new DemoAudience({ store, mockX: standIn, afterWave: () => views.sync() }) : null;

  // ---- the demo world -------------------------------------------------------
  // Built through the REAL path - plan, dub, check, post, count, charge - with
  // stand-in dubs and a simulated audience, so there is something learned to
  // look at the moment the app opens. Two of @maria's three posts are dubbed;
  // the third is left for a person to dub and watch.
  if (standIn && demoAudience) {
    const seededPosts = [...store.botPosts.values()].filter((p) => p.hasVideo);
    const dubOnBoot = [
      seededPosts.filter((p) => p.authorHandle === 'maria')[0],
      seededPosts.filter((p) => p.authorHandle === 'chefkenji')[0],
      seededPosts.filter((p) => p.authorHandle === 'maria')[1],
    ];
    for (const user of standIn.listUsers()) flow.creatorForHandle(user.handle);
    console.log('  Building the demo world...');
    for (const seeded of dubOnBoot) {
      const creator = seeded ? flow.creatorForHandle(seeded.authorHandle) : undefined;
      if (!seeded || !creator) continue;
      const result = await flow.requestForPost(creator, seeded.id, null);
      if (result.kind !== 'started') {
        console.log(`    @${creator.handle}: not dubbed (${result.kind})`);
        continue;
      }
      await result.done;
      await demoAudience.send(result.post.id, { waves: 1 });
      console.log(`    @${creator.handle}: dubbed into ${result.dubs.map((d) => d.lang).join(', ')}`);
    }
    await billing.sweep();
    console.log('  Demo world ready.');
    // Seeding runs on a fixed clock so it replays identically. From here on
    // posts are written by people, and are stamped when they are written.
    standIn.useWallClock();
  }

  views.start(VIEW_SYNC_INTERVAL_MS);
  billing.start(config.isDemoMode ? DEMO_BILLING_INTERVAL_MS : BILLING_INTERVAL_MS);

  const sseHandler = (_req: Request, res: Response): void => {
    hub.subscribe(res);
  };

  const app = createApp({
    ...(accounts ? { accounts } : {}),
    store,
    campaigns,
    billing,
    views,
    insights,
    flow,
    balanceOf: (creator) => payer.available(creator),
    mockX: standIn,
    demoAudience,
    revenueAddress,
    sseHandler,
    notify,
    xclone: {
      store,
      mockX,
      enabled: standIn !== null,
      processMentionById: (mentionId) => flow.processMention(mentionId),
      onVideoPost: (postId, authorHandle) => flow.onNewVideoPost(postId, authorHandle),
    },
    extension: {
      store,
      adapter,
      botHandle: config.env.X_BOT_HANDLE,
      dubObservedPost: (post, lang) => flow.dubObservedPost(post, lang),
      forecast: (post) => {
        if (post.durationS === null) return null;
        const creator = flow.ensureCreator({
          xUserId: `x-handle-${post.authorHandle}`,
          handle: post.authorHandle,
          displayName: post.authorDisplayName || post.authorHandle,
          followers: 0,
        });
        return extensionForecast({
          creator,
          plan: campaigns.plan(creator),
          postId: post.postId,
          originalViews: post.metrics.views,
          durationS: post.durationS,
        });
      },
      results: (postId) => {
        const post = store.findPostBySource(postId);
        const creator = post ? store.creators.get(post.creatorId) : undefined;
        if (!post || !creator) return null;
        return extensionResults({
          store,
          creator,
          post,
          plan: campaigns.plan(creator),
          postsMeasured: campaigns.history(creator).length,
          canSendAudience: demoAudience !== null,
          webUrl: config.env.PUBLIC_WEB_URL,
        });
      },
      ...(demoAudience
        ? {
            sendAudience: (postId: string) => {
              const post = store.findPostBySource(postId);
              return post ? demoAudience.send(post.id, { waves: 6, waveMs: 1_200 }) : Promise.resolve(false);
            },
          }
        : {}),
    },
  });

  const port = config.env.BACKEND_PORT;
  app.listen(port, () => {
    console.log(`\n  Parrot backend on http://localhost:${port}`);
    console.log(`  Demo mode: ${config.isDemoMode ? 'on' : 'off'}`);
    console.log(`  Accounts: ${accountsStatus}`);
    console.log(`  Payments arrive at: ${revenueAddress ?? '(no wallet configured: demo balances only)'}`);
    if (config.mockedSubsystems.length > 0) console.log(`  Simulated: ${config.mockedSubsystems.join('; ')}`);
    console.log(`  Demo world: ${store.posts.size} posts dubbed into ${store.dubs.size} dubs, ${store.charges.size} payments`);
    for (const dub of store.dubs.values()) {
      const creator = store.creators.get(dub.creatorId);
      console.log(`    ${dub.state.padEnd(15)} @${(creator?.handle ?? '?').padEnd(10)} ${dub.lang}  ${String(dub.xViews + dub.pageViews).padStart(6)} views`);
    }
    console.log('');
  });
}

main().catch((error: unknown) => {
  console.error('Parrot backend failed to start:', error);
  process.exitCode = 1;
});
