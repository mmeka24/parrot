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
  PRICE_PER_VIEW,
  copy,
  formatUsd,
  parseUsd,
  type ApiErrorCode,
  type ApiErrorDto,
  type MeDto,
  type Micros,
  type StartDubRequestDto,
  type StartDubResponseDto,
  type UpdateSettingsRequestDto,
} from '@parrot/shared';
import { declineLine } from '../bot/bot-service.js';
import type { MockXAdapter } from '../bot/mock-x-adapter.js';
import { getConfig } from '../config.js';
import { registerExtensionRoutes, type ExtensionDeps } from '../extension/routes.js';
import type { BillingService } from '../services/billing-service.js';
import type { CampaignService } from '../services/campaign-service.js';
import type { DemoAudience } from '../services/demo-audience.js';
import type { DubFlow } from '../services/dub-flow.js';
import type { InsightService } from '../services/insight-service.js';
import type { ViewService } from '../services/view-service.js';
import type { Store } from '../store/store.js';
import type { Creator } from '../store/types.js';
import { readCookie, type Accounts } from '../users/accounts.js';
import { registerAuthRoutes } from '../users/routes.js';
import { registerXCloneRoutes, type XCloneDeps } from '../xclone/routes.js';
import { creatorDashboard, dubPage, languageRef, money, systemStatus } from './mappers.js';

/** Identifies a browser on Parrot's dub pages, so a viewer is counted once. */
const VIEWER_COOKIE = 'parrot_viewer';

export interface RouteDeps {
  /** Sign-in and per-user balances. Absent when accounts are switched off. */
  accounts?: Accounts;
  store: Store;
  campaigns: CampaignService;
  billing: BillingService;
  views: ViewService;
  insights: InsightService;
  flow: DubFlow;
  /** What a creator can spend right now; null when it cannot be read. */
  balanceOf: (creator: Creator) => Promise<Micros | null>;
  /** The stand-in timeline, when it is the one in use. */
  mockX: MockXAdapter | null;
  /** The demo audience. Null when the timeline is the real one. */
  demoAudience: DemoAudience | null;
  /** Where creators' payments go, for the "under the hood" page. */
  revenueAddress: string | null;
  sseHandler?: (req: Request, res: Response) => void;
  /** Tell open dashboards something changed for this creator. */
  notify?: (creator: Creator, reason: 'dub' | 'views' | 'payment' | 'settings') => void;
  xclone?: XCloneDeps;
  extension?: ExtensionDeps;
}

function fail(res: Response, status: number, code: ApiErrorCode, title: string, detail: string): void {
  res.status(status).json({ ok: false, code, title, detail } satisfies ApiErrorDto);
}

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
/** A plain dollar amount: up to 5 whole digits and 2 decimals. */
const USD = /^\d{1,5}(\.\d{1,2})?$/;

export function createApp(deps: RouteDeps): Express {
  const { store, campaigns, billing, views, flow } = deps;
  const app = express();
  // Behind a proxy (the web app, Fly), so the client's address is forwarded.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  // Rendered dubs and uploaded clips. Dubs are free to watch, so this is public.
  app.use('/media', express.static(getConfig().env.MEDIA_STORAGE_DIR, { fallthrough: true, maxAge: '1h' }));

  app.use((req, res, next) => {
    // The front ends run on other origins in development, and not always on the
    // configured port (a busy port bumps it). Outside production any localhost
    // origin is accepted, because pinning one port breaks the app with a CORS
    // error that looks like a backend outage.
    const { PUBLIC_WEB_URL, PUBLIC_XCLONE_URL, NODE_ENV } = getConfig().env;
    const configured = PUBLIC_WEB_URL.replace(/\/$/, '');
    const origin = req.headers.origin;
    const allowLocalhost =
      NODE_ENV !== 'production' && typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const allowListed = typeof origin === 'string' && [configured, PUBLIC_XCLONE_URL.replace(/\/$/, '')].includes(origin);
    res.setHeader('Access-Control-Allow-Origin', allowLocalhost || allowListed ? (origin as string) : configured);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-admin-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  const allowedOrigins = (): string[] => {
    const { PUBLIC_WEB_URL, PUBLIC_XCLONE_URL, NODE_ENV } = getConfig().env;
    const list = [PUBLIC_WEB_URL.replace(/\/$/, ''), PUBLIC_XCLONE_URL.replace(/\/$/, '')];
    if (NODE_ENV !== 'production') list.push('http://localhost:3100', 'http://localhost:3000');
    return list;
  };

  // -------------------------------------------------------------------------
  // Who is asking
  // -------------------------------------------------------------------------

  /**
   * May this request change a creator's page?
   *
   * A page that belongs to a signed-in account can only be changed by that
   * account. A page nobody has claimed is a demo creator on the stand-in
   * timeline, where there is no sign-in at all (see xclone/routes.ts): anyone
   * may drive it, exactly as anyone may post as them there. Against the real
   * service there are no unclaimed pages to drive.
   */
  function canEdit(req: Request, creator: Creator): boolean {
    if (creator.userId !== null) return deps.accounts?.userFor(req)?.id === creator.userId;
    return deps.mockX !== null;
  }

  /** Refuse a state-changing request from a page that is not ours. */
  function sameSite(req: Request): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') return true; // not a browser cross-origin request
    if (allowedOrigins().includes(origin)) return true;
    return getConfig().env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  }

  function editable(req: Request, res: Response): Creator | null {
    const creator = flow.creatorForHandle(String(req.params.handle ?? ''));
    if (!creator) {
      fail(res, 404, 'NOT_FOUND', copy.errors.notFoundTitle, copy.errors.notFoundBody);
      return null;
    }
    if (!sameSite(req)) {
      fail(res, 403, 'FORBIDDEN', copy.errors.notYoursTitle, copy.errors.notYoursBody);
      return null;
    }
    if (!canEdit(req, creator)) {
      const signedIn = deps.accounts?.userFor(req) !== undefined;
      if (signedIn) fail(res, 403, 'FORBIDDEN', copy.errors.notYoursTitle, copy.errors.notYoursBody);
      else fail(res, 401, 'SIGN_IN_REQUIRED', copy.errors.notSignedInTitle, copy.errors.notSignedInBody);
      return null;
    }
    return creator;
  }

  /**
   * The demo controls. Open in development; on a public server they are closed
   * unless DEMO_ADMIN_TOKEN is set, and then need it in an `x-admin-token` header.
   */
  function demoAllowed(req: Request): boolean {
    const { NODE_ENV, DEMO_ADMIN_TOKEN, DEMO_OPEN } = getConfig().env;
    if (NODE_ENV !== 'production' || DEMO_OPEN) return true;
    return DEMO_ADMIN_TOKEN !== undefined && req.headers['x-admin-token'] === DEMO_ADMIN_TOKEN;
  }

  const demoOn = (): boolean => deps.demoAudience !== null;

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  if (deps.accounts) {
    const accounts = deps.accounts;
    registerAuthRoutes(app, {
      accounts,
      bonusDisplay: formatUsd(parseUsd(getConfig().env.SIGNUP_BONUS_USD)),
      allowedOrigins,
      extendMe: (user): Partial<MeDto> => ({ creatorHandle: store.findCreatorByUserId(user.id)?.handle ?? null }),
    });

    /** Connect the name a signed-in person posts under to their account. */
    app.post('/api/me/creator', (req, res) => {
      const user = accounts.userFor(req);
      if (!user) return fail(res, 401, 'SIGN_IN_REQUIRED', copy.errors.notSignedInTitle, copy.errors.notSignedInBody);
      if (!sameSite(req)) return fail(res, 403, 'FORBIDDEN', copy.errors.notYoursTitle, copy.errors.notYoursBody);

      const handle = String((req.body as { handle?: unknown } | undefined)?.handle ?? '')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();
      if (!HANDLE.test(handle) || handle === deps.mockX?.botHandle) {
        return fail(res, 400, 'BAD_REQUEST', copy.errors.badHandleTitle, copy.errors.badHandleBody);
      }

      const mine = store.findCreatorByUserId(user.id);
      if (mine && mine.handle !== handle) {
        // One name per account. Changing it would move a payment history.
        return fail(res, 400, 'BAD_REQUEST', copy.errors.handleTakenTitle, `You are already connected as @${mine.handle}.`);
      }
      const creator =
        flow.creatorForHandle(handle) ??
        flow.ensureCreator({ xUserId: `x-user-${handle}`, handle, displayName: handle, followers: 0 });
      if (creator.userId !== null && creator.userId !== user.id) {
        return fail(res, 409, 'BAD_REQUEST', copy.errors.handleTakenTitle, copy.errors.handleTakenBody);
      }
      // From here their views are paid for from their own balance.
      const updated = store.updateCreator(creator.id, { userId: user.id, lowBalance: false });
      deps.notify?.(updated, 'settings');
      res.json({ ok: true, handle: updated.handle });
    });
  } else {
    // Accounts are off: say so plainly, so the web app shows no sign-in button.
    app.get('/api/auth/config', (_req, res) => res.json({ enabled: false }));
    app.get('/api/me', (_req, res) => res.json({ signedIn: false } satisfies MeDto));
  }

  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/system', (_req, res) => {
    // Make sure the demo creators exist before listing them.
    for (const user of deps.mockX?.listUsers() ?? []) flow.creatorForHandle(user.handle);
    res.json(systemStatus(store, deps.accounts !== undefined, deps.revenueAddress));
  });

  if (deps.sseHandler) app.get('/api/stream', deps.sseHandler);

  // -------------------------------------------------------------------------
  // A creator's page
  // -------------------------------------------------------------------------

  app.get('/api/creators/:handle', async (req, res) => {
    const creator = flow.creatorForHandle(req.params.handle);
    if (!creator) return fail(res, 404, 'NOT_FOUND', copy.errors.notFoundTitle, copy.errors.notFoundBody);

    const plan = campaigns.plan(creator);
    const balance = await deps.balanceOf(creator).catch(() => null);
    const videoPosts = [...store.botPosts.values()]
      .filter((p) => p.hasVideo && !p.isBot && p.inReplyToId === null && p.authorHandle === creator.handle)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json(
      creatorDashboard({
        store,
        creator,
        plan,
        postsMeasured: campaigns.history(creator).length,
        balance,
        owed: billing.owed(creator),
        canEdit: canEdit(req, creator),
        demo: demoOn() && demoAllowed(req),
        videoPosts,
        postUrl: (postId) => deps.mockX?.postUrl(postId) ?? `https://x.com/${creator.handle}/status/${postId}`,
        insightFor: (facts) => deps.insights.get(facts),
      }),
    );
  });

  app.post('/api/creators/:handle/settings', (req, res) => {
    const creator = editable(req, res);
    if (!creator) return;
    const body = (req.body ?? {}) as UpdateSettingsRequestDto;
    const patch: Partial<Creator> = {};

    if (body.valuePerThousandUsd !== undefined) {
      const raw = String(body.valuePerThousandUsd).trim().replace(/^\$/, '');
      if (!USD.test(raw)) return fail(res, 400, 'BAD_REQUEST', copy.errors.badAmountTitle, copy.errors.badAmountBody);
      patch.valuePerThousand = parseUsd(raw);
      patch.valueIsDefault = false;
    }
    if (body.postBudgetUsd !== undefined) {
      const raw = String(body.postBudgetUsd).trim().replace(/^\$/, '');
      if (!USD.test(raw)) return fail(res, 400, 'BAD_REQUEST', copy.errors.badAmountTitle, copy.errors.badAmountBody);
      const budget = parseUsd(raw);
      // A budget below one view's price could never be charged against.
      if ((budget as bigint) < (PRICE_PER_VIEW as bigint)) {
        return fail(res, 400, 'BAD_REQUEST', copy.errors.badAmountTitle, copy.errors.badAmountBody);
      }
      patch.postBudget = budget;
    }
    if (typeof body.autoDub === 'boolean') patch.autoDub = body.autoDub;

    const updated = store.updateCreator(creator.id, patch);
    deps.notify?.(updated, 'settings');
    res.json({ ok: true });
  });

  app.post('/api/creators/:handle/dub', async (req, res) => {
    const creator = editable(req, res);
    if (!creator) return;
    const body = (req.body ?? {}) as Partial<StartDubRequestDto>;
    const postId = String(body.postId ?? '');
    if (postId === '' || postId.length > 64) {
      return fail(res, 400, 'BAD_REQUEST', copy.errors.genericTitle, copy.errors.genericBody);
    }
    const lang = body.languageCode ? String(body.languageCode).toLowerCase() : null;

    const result = await flow.requestForPost(creator, postId, lang);
    if (result.kind === 'declined') {
      return fail(res, 409, 'DECLINED', copy.errors.declinedTitle, capitalise(declineLine(result.reason)));
    }
    if (result.kind === 'busy') {
      return fail(res, 429, 'RATE_LIMITED', copy.errors.rateLimitedTitle, copy.bot.rateLimitedReply);
    }
    if (result.kind === 'duplicate') {
      return fail(res, 409, 'DECLINED', copy.errors.declinedTitle, `It is already dubbed into ${languageRef(result.dub.lang).name}.`);
    }
    const payload: StartDubResponseDto = {
      ok: true,
      postId: result.post.id,
      languages: result.dubs.map((d) => languageRef(d.lang)),
      summary: result.summary,
    };
    res.status(202).json(payload);
  });

  /** Charge what is owed now, rather than waiting for the next sweep. */
  app.post('/api/creators/:handle/pay', async (req, res) => {
    const creator = editable(req, res);
    if (!creator) return;
    await views.sync().catch(() => undefined);
    const charge = await billing.chargeCreator(creator);
    res.json({ ok: true, charged: charge ? money(charge.amount) : null, status: charge?.status ?? null });
  });

  // -------------------------------------------------------------------------
  // The demo audience
  // -------------------------------------------------------------------------

  app.post('/api/creators/:handle/posts/:postId/audience', (req, res) => {
    const audience = deps.demoAudience;
    if (!audience || !demoAllowed(req)) {
      return fail(res, 404, 'NOT_FOUND', copy.errors.demoClosedTitle, copy.errors.demoClosedBody);
    }
    const creator = editable(req, res);
    if (!creator) return;
    const post = store.posts.get(String(req.params.postId));
    if (!post || post.creatorId !== creator.id) {
      return fail(res, 404, 'NOT_FOUND', copy.errors.notFoundTitle, copy.errors.notFoundBody);
    }
    const ready = store.dubsForPost(post.id).some((d) => d.state === 'PUBLISHED' && d.simulatedViews === 0);
    if (!ready || post.demoAudience === 'arriving') {
      return fail(res, 409, 'BAD_REQUEST', copy.errors.genericTitle, 'There is no live dub waiting for an audience on this post.');
    }
    // Answer at once; the audience arrives over the next few seconds.
    void audience.send(post.id, { waves: 6, waveMs: 1_200 }).catch((error: unknown) => {
      console.error('[demo] audience failed', error);
    });
    res.status(202).json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // The public page for one dub. Free to watch; no sign-in.
  // -------------------------------------------------------------------------

  app.get('/api/dubs/:id', (req, res) => {
    const dub = store.getDub(req.params.id);
    const page = dub ? dubPage(store, dub) : null;
    if (!page) return fail(res, 404, 'NOT_FOUND', copy.errors.dubNotFoundTitle, copy.errors.dubNotFoundBody);
    res.json(page);
  });

  app.post('/api/dubs/:id/view', (req, res) => {
    const dub = store.getDub(req.params.id);
    if (!dub) return fail(res, 404, 'NOT_FOUND', copy.errors.dubNotFoundTitle, copy.errors.dubNotFoundBody);
    if (dub.state !== 'PUBLISHED') {
      return fail(res, 409, 'NOT_PUBLISHED', copy.errors.dubUnavailableTitle, copy.errors.dubUnavailableBody);
    }

    let key = readCookie(req, VIEWER_COOKIE);
    if (!key || !/^[A-Za-z0-9-]{8,64}$/.test(key)) {
      key = randomUUID();
      const secure = getConfig().env.PUBLIC_BACKEND_URL.startsWith('https://') ? '; SameSite=None; Secure' : '; SameSite=Lax';
      res.append('Set-Cookie', `${VIEWER_COOKIE}=${key}; Path=/; Max-Age=31536000; HttpOnly${secure}`);
    }
    // A proxy in front of us may say what country the viewer is in. Without
    // one, the region in the browser's language setting is the best there is.
    const header = req.headers['cf-ipcountry'] ?? req.headers['x-vercel-ip-country'];
    const country = typeof header === 'string' && /^[A-Za-z]{2}$/.test(header) && header.toUpperCase() !== 'XX' ? header.toUpperCase() : null;
    const accept = req.headers['accept-language'];

    const counted = views.recordPageView(dub.id, {
      key,
      country,
      acceptLanguage: typeof accept === 'string' ? accept.slice(0, 200) : null,
    });
    res.json({ ok: true, counted });
  });

  // -------------------------------------------------------------------------
  // The stand-in timeline and the extension
  // -------------------------------------------------------------------------

  if (deps.xclone) registerXCloneRoutes(app, deps.xclone);
  if (deps.extension) registerExtensionRoutes(app, deps.extension);

  app.use((_req, res) => fail(res, 404, 'NOT_FOUND', copy.errors.notFoundTitle, copy.errors.notFoundBody));

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error('[api] unhandled error', error);
    if (res.headersSent) return;
    fail(res, 500, 'INTERNAL', copy.errors.genericTitle, copy.errors.genericBody);
  });

  return app;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
