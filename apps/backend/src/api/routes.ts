/**
 * HTTP API. Every response is one of the DTOs in packages/shared/src/api.ts.
 *
 * Error responses are human-readable and already free of the forbidden
 * vocabulary, because the client renders `title` and `detail` directly - there
 * is no second place where an error string could be invented.
 */

import express, { type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import {
  copy,
  fill,
  formatUsd,
  languageName,
  UNLOCK_PRICE,
  isPublished,
  type ApiErrorDto,
  type AgentDashboardDto,
  type BotConsoleDto,
  type DemoStateDto,
  type FeedStatusDto,
  type TickerEntryDto,
  type BotPostDto,
  micros,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import { PaymentService, InsufficientBalanceError, RateLimitedError } from '../services/payment-service.js';
import type { JobPipeline } from '../services/job-pipeline.js';
import type { LearningService } from '../services/learning-service.js';
import type { SeedService } from '../services/seed-service.js';
import {
  mediaUrl,
  accuracySeries,
  agentJobRow,
  agentSummary,
  botPostDto,
  creatorDashboard,
  decisionLog,
  dubPage,
  money,
  systemStatus,
  tickerFromSettlement,
  tickerFromUnlock,
} from './mappers.js';
import { getConfig } from '../config.js';

/** Cookie that identifies a guest viewer. No sign-in, no popup, no wallet. */
const VIEWER_COOKIE = 'parrot_viewer';

export interface RouteDeps {
  store: Store;
  payments: PaymentService;
  pipeline: JobPipeline;
  learning: LearningService;
  seed: SeedService;
  feedStatus: () => FeedStatusDto;
  broadcast: (entry: TickerEntryDto) => void;
  /** Returns an SSE handler, supplied by the feed module. */
  sseHandler?: (req: Request, res: Response) => void;
  /**
   * Injects a mention and runs the REAL bot path end to end. The console uses
   * this rather than a parallel fake, so what judges see on /console is the
   * same code that would run against the live X API.
   */
  processMention?: (
    text: string,
    parentPostId?: string,
    authorHandle?: string,
  ) => Promise<string | null>;
  /** Pushes a new bot post to connected dashboards. */
  broadcastPost?: (post: BotPostDto) => void;
}

function sendError(res: Response, status: number, error: ApiErrorDto): void {
  res.status(status).json(error);
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function createApp(deps: RouteDeps): Express {
  const { store, payments, pipeline, learning, seed } = deps;
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Serve rendered dubs. Without this the dub page 404s on its own media.
  app.use(
    '/media',
    express.static(getConfig().env.MEDIA_STORAGE_DIR, {
      fallthrough: true,
      maxAge: '1h',
    }),
  );

  app.use((req, res, next) => {
    // The web app runs on a different origin in development, and not always on
    // the configured port (a busy port bumps it). Outside production we accept
    // any localhost origin, because pinning one port silently breaks the live
    // ticker with a CORS error that looks like a backend outage.
    const configured = getConfig().env.PUBLIC_WEB_URL;
    const origin = req.headers.origin;
    const allowLocalhost =
      getConfig().env.NODE_ENV !== 'production' &&
      typeof origin === 'string' &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    res.setHeader('Access-Control-Allow-Origin', allowLocalhost ? origin : configured);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  // -------------------------------------------------------------------------
  // Viewer identity: a cookie, created silently. No wallet, no sign-in.
  // -------------------------------------------------------------------------

  function currentViewer(req: Request, res: Response, create: boolean): string | null {
    const existing = readCookie(req, VIEWER_COOKIE);
    if (existing && store.getAccount(existing)) return existing;
    if (!create) return null;

    const account = store.createAccount({
      kind: 'viewer',
      label: 'Guest',
      email: null,
      walletAddress: null,
    });
    payments.grantStarterCredit(account.id);
    res.setHeader(
      'Set-Cookie',
      `${VIEWER_COOKIE}=${account.id}; Path=/; Max-Age=2592000; SameSite=Lax`,
    );
    return account.id;
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  app.get('/api/system', (_req, res) => {
    res.json(systemStatus(store, deps.feedStatus()));
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Dub page
  // -------------------------------------------------------------------------

  app.get('/api/dubs/:id', (req, res) => {
    const job = store.getJob(req.params.id as string);
    if (!job) {
      return sendError(res, 404, {
        ok: false,
        code: 'NOT_FOUND',
        title: copy.errors.dubNotFoundTitle,
        detail: copy.errors.dubNotFoundBody,
      });
    }
    const viewerId = currentViewer(req, res, true);
    res.json(dubPage(store, job, viewerId));
  });

  app.post('/api/dubs/:id/unlock', async (req, res) => {
    const job = store.getJob(req.params.id as string);
    if (!job) {
      return sendError(res, 404, {
        ok: false,
        code: 'NOT_FOUND',
        title: copy.errors.dubNotFoundTitle,
        detail: copy.errors.dubNotFoundBody,
      });
    }

    if (!isPublished(job.state)) {
      return sendError(res, 409, {
        ok: false,
        code: 'NOT_PUBLISHED',
        title: copy.errors.dubUnavailableTitle,
        detail: copy.errors.dubUnavailableBody,
      });
    }

    const viewerId = currentViewer(req, res, true);
    if (!viewerId) {
      return sendError(res, 500, {
        ok: false,
        code: 'INTERNAL',
        title: copy.errors.genericTitle,
        detail: copy.errors.genericBody,
      });
    }

    const agent = job.claimedByAgentId ? store.agents.get(job.claimedByAgentId) : undefined;
    const creator = store.creators.get(job.creatorId);
    if (!agent || !creator) {
      return sendError(res, 500, {
        ok: false,
        code: 'INTERNAL',
        title: copy.errors.genericTitle,
        detail: copy.errors.genericBody,
      });
    }

    try {
      const result = payments.recordUnlock({
        jobId: job.id,
        viewerAccountId: viewerId,
        amount: UNLOCK_PRICE,
        agentAccountId: agent.accountId,
        creatorAccountId: creator.accountId,
        splitAgentBps: job.splitAgentBps,
        splitCreatorBps: job.splitCreatorBps,
        paymentRef: `x402:${randomUUID()}`,
        simulated: !getConfig().capabilities.x402Payments,
      });

      await pipeline.notePaidUnlock(job.id);
      deps.broadcast(tickerFromUnlock(result.unlock, store));

      const refreshed = store.getJob(job.id);
      res.json({
        ok: true,
        fullUrl: mediaUrl(refreshed?.dubUrl ?? null) ?? '',
        viewerBalance: money(result.viewerBalance),
        receipt: dubPage(store, refreshed ?? job, viewerId).receipts[0] ?? null,
      });
    } catch (error: unknown) {
      if (error instanceof InsufficientBalanceError) {
        return sendError(res, 402, {
          ok: false,
          code: 'INSUFFICIENT_BALANCE',
          title: copy.errors.insufficientBalanceTitle,
          detail: copy.errors.insufficientBalanceBody,
        });
      }
      if (error instanceof RateLimitedError) {
        return sendError(res, 429, {
          ok: false,
          code: 'RATE_LIMITED',
          title: copy.errors.genericTitle,
          detail: copy.bot.rateLimitedReply,
        });
      }
      return sendError(res, 500, {
        ok: false,
        code: 'PAYMENT_FAILED',
        title: copy.errors.paymentFailedTitle,
        detail: copy.errors.paymentFailedBody,
      });
    }
  });

  // -------------------------------------------------------------------------
  // Creator dashboard
  // -------------------------------------------------------------------------

  app.get('/api/creators/:handle', (req, res) => {
    const creator = store.findCreatorByHandle(req.params.handle as string);
    if (!creator) {
      return sendError(res, 404, {
        ok: false,
        code: 'NOT_FOUND',
        title: copy.creator.noDubsTitle,
        detail: fill(copy.creator.noDubsBody, { mention: copy.bot.mention }),
      });
    }
    res.json(creatorDashboard(store, creator));
  });

  app.post('/api/creators/:handle/claim', async (req, res) => {
    const creator = store.findCreatorByHandle(req.params.handle as string);
    if (!creator) {
      return sendError(res, 404, {
        ok: false,
        code: 'NOT_FOUND',
        title: copy.errors.notSignedInTitle,
        detail: copy.errors.notSignedInBody,
      });
    }

    const balance = store.balanceOf(creator.accountId);
    if ((balance as bigint) <= 0n) {
      return sendError(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        title: copy.creator.claimEmptyTitle,
        detail: copy.creator.claimEmptyBody,
      });
    }

    const settlement = await payments.payoutCreator({
      creatorAccountId: creator.accountId,
      amount: balance,
      requestId: (req.body?.requestId as string) ?? randomUUID(),
      treasuryPrivateKey: getConfig().env.PARROT_TREASURY_PRIVATE_KEY as `0x${string}` | undefined,
    });

    store.creators.set(creator.id, { ...creator, claimed: true });
    deps.broadcast(tickerFromSettlement(settlement, store));

    res.json({
      ok: true,
      title: copy.creator.claimedTitle,
      detail: fill(copy.creator.claimedBody, { amount: formatUsd(balance) }),
    });
  });

  // -------------------------------------------------------------------------
  // Agent P&L dashboard
  // -------------------------------------------------------------------------

  function buildAgentDashboard(): AgentDashboardDto {
    const agents = [...store.agents.values()].map((a) => agentSummary(store, a));
    const jobs = store
      .allJobs()
      .filter((j) => j.claimedByAgentId !== null)
      .map((j) => agentJobRow(store, j));

    const ticker: TickerEntryDto[] = [
      ...store.allSettlements().slice(0, 25).map((s) => tickerFromSettlement(s, store)),
      ...store.allUnlocks().slice(0, 25).map((u) => tickerFromUnlock(u, store)),
    ]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 40);

    let balance = 0n;
    let spend = 0n;
    let revenue = 0n;
    for (const agent of store.agents.values()) {
      balance += store.balanceOf(agent.accountId) as bigint;
      spend += store.totalSpend(agent.accountId, 'dub_cost') as bigint;
      revenue += store.totalEarned(agent.accountId, ['agent_share']) as bigint;
    }

    const all = store.allJobs();

    return {
      agents,
      jobs,
      decisions: decisionLog(store),
      ticker,
      accuracy: accuracySeries(store),
      totals: {
        balance: money(micros(balance)),
        spend: money(micros(spend)),
        revenue: money(micros(revenue), 3),
        profit: money(micros(revenue - spend), 3),
        unlocks: store.unlocks.size,
        dubsPublished: all.filter((j) => isPublished(j.state)).length,
        dubsRejected: all.filter((j) => j.state === 'REJECTED_BY_QC').length,
      },
      feed: deps.feedStatus(),
    };
  }

  app.get('/api/agents', (_req, res) => res.json(buildAgentDashboard()));

  // -------------------------------------------------------------------------
  // Bot console (the mock X adapter surface)
  // -------------------------------------------------------------------------

  app.get('/api/bot', (_req, res) => {
    const payload: BotConsoleDto = {
      posts: store.timeline().map(botPostDto),
      live: true,
      simulated: !getConfig().capabilities.xApi,
    };
    res.json(payload);
  });

  app.post('/api/bot/mention', async (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) {
      return sendError(res, 400, {
        ok: false,
        code: 'BAD_REQUEST',
        title: copy.errors.genericTitle,
        detail: copy.errors.genericBody,
      });
    }
    if (!deps.processMention) {
      return sendError(res, 503, {
        ok: false,
        code: 'INTERNAL',
        title: copy.errors.sourceUnavailableTitle,
        detail: copy.errors.sourceUnavailableBody,
      });
    }

    const before = new Set(store.botPosts.keys());
    const jobId = await deps.processMention(
      text,
      req.body?.parentPostId as string | undefined,
      req.body?.authorHandle as string | undefined,
    );

    // Return just what this mention produced: the post and Parrot's reply.
    const fresh = store
      .timeline(200)
      .filter((p) => !before.has(p.id))
      .map(botPostDto);
    for (const post of fresh) deps.broadcastPost?.(post);

    res.json({ ok: true, jobId, posts: fresh });
  });

  // -------------------------------------------------------------------------
  // Demo controls
  // -------------------------------------------------------------------------

  let trafficTimer: NodeJS.Timeout | null = null;
  let ratePerMinute = 60;

  app.get('/api/demo', (_req, res) => {
    const payload: DemoStateDto = {
      seeded: store.agents.size > 0,
      trafficRunning: trafficTimer !== null,
      ratePerMinute,
      compressedLearning: getConfig().isDemoMode,
    };
    res.json(payload);
  });

  app.post('/api/demo/seed', async (_req, res) => {
    seed.seedAgents();
    seed.seedDemoCreators();
    res.json({ ok: true, seeded: true });
  });

  app.post('/api/demo/traffic', (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    ratePerMinute = Number(req.body?.ratePerMinute ?? ratePerMinute);

    if (trafficTimer) {
      clearInterval(trafficTimer);
      trafficTimer = null;
    }

    if (enabled) {
      let index = 0;
      trafficTimer = setInterval(
        () => {
          const published = store.allJobs().filter((j) => isPublished(j.state));
          const job = published[index % Math.max(published.length, 1)];
          if (job) {
            if (seed.simulateUnlock(job, index)) {
              const latest = store.allUnlocks()[0];
              if (latest) deps.broadcast(tickerFromUnlock(latest, store));
            }
          }
          index++;
        },
        Math.max(250, Math.round(60_000 / Math.max(ratePerMinute, 1))),
      );
      trafficTimer.unref?.();
    }

    res.json({ ok: true, trafficRunning: trafficTimer !== null, ratePerMinute });
  });

  app.post('/api/demo/learn', (_req, res) => {
    // Compressed learning: resolve every outstanding prediction immediately.
    const results = [];
    for (const job of store.allJobs()) {
      if (job.publishedAt) {
        const result = learning.simulateOutcome(job);
        if (result) results.push(result);
      }
    }
    res.json({ ok: true, resolved: results.length, accuracyPercent: learning.accuracy() });
  });

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  if (deps.sseHandler) {
    app.get('/api/stream', deps.sseHandler);
  }

  app.use((_req, res) => {
    sendError(res, 404, {
      ok: false,
      code: 'NOT_FOUND',
      title: copy.errors.dubNotFoundTitle,
      detail: copy.errors.dubNotFoundBody,
    });
  });

  return app;
}

export { languageName };
