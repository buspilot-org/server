/**
 * Live API routes (engine.md, "Live API"; README "Live API"):
 *
 * Members (Supabase access token in `Authorization: Bearer …`):
 * - `GET /v1/live/routes/:routeId`, `…/stream` (Server-Sent Events)
 * - `GET /v1/live/trips/:tripInstanceId`, `…/stream` (also live trips without a route)
 * - `GET /v1/live/stops/:stopId`
 *
 * Anyone, public routes only (cacheable at the edge for 5 s):
 * - `GET /v1/public/routes/:operatorSlug/:routeSlug`
 * - `GET /v1/public/stops/:operatorSlug/:stopSlug`
 *
 * Unknown, not visible and invalid IDs all answer 404, so the existence of
 * a private route is not revealed.
 */
import type { ServerResponse } from 'node:http';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { streamSSE } from 'hono/streaming';
import type { Logger } from '../log.ts';
import { errorMessage } from '../log.ts';
import type { Claims, TokenVerifier } from '../live/auth.ts';
import { AuthError } from '../live/auth.ts';
import type { Change, LiveHub } from '../live/hub.ts';
import type { EndReason, StreamRegistry } from '../live/streams.ts';
import { runStream } from '../live/streams.ts';
import type { ViewContext, Viewer } from '../live/views.ts';
import { routeView, stopView, tripOnlyView } from '../live/views.ts';

export interface LiveDeps {
  hub: LiveHub;
  /** null: SUPABASE_URL is not set; member endpoints answer 503. */
  verifier: TokenVerifier | null;
  streams: StreamRegistry;
  log: Logger;
}

type Env = { Variables: { claims: Claims } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const CACHE_MEMBER = 'private, max-age=5';
export const CACHE_PUBLIC = 'public, max-age=5, s-maxage=5';
const CACHE_PUBLIC_MISS = 'public, max-age=30, s-maxage=30';
const NO_STORE = 'no-store';

function isUuid(s: string): boolean {
  return UUID.test(s);
}

function isSlug(s: string): boolean {
  return s.length <= 63 && SLUG.test(s);
}

export function registerLiveRoutes(app: Hono, deps: LiveDeps): void {
  const { hub, streams, log } = deps;
  const live = new Hono<Env>();

  // Browsers (public pages, a web app) call from other origins. No cookies
  // are used, so any origin is fine.
  live.use('/v1/live/*', cors({ origin: '*', allowMethods: ['GET'], allowHeaders: ['Authorization'], maxAge: 600 }));
  live.use('/v1/public/*', cors({ origin: '*', allowMethods: ['GET'], maxAge: 600 }));

  const notReady = (c: Context): Response => {
    c.header('Cache-Control', NO_STORE);
    c.header('Retry-After', '5');
    return c.json({ error: 'not ready' }, 503);
  };

  // Members: a valid Supabase access token.
  live.use('/v1/live/*', async (c: Context<Env>, next: Next) => {
    if (c.req.method === 'OPTIONS') return next();
    c.header('Vary', 'Authorization');
    if (!deps.verifier) {
      c.header('Cache-Control', NO_STORE);
      return c.json({ error: 'live API for members is not configured' }, 503);
    }
    const header = c.req.header('Authorization') ?? '';
    const m = /^Bearer ([^\s]+)$/i.exec(header);
    if (!m?.[1]) {
      c.header('Cache-Control', NO_STORE);
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized' }, 401);
    }
    try {
      c.set('claims', await deps.verifier.verify(m[1]));
    } catch (err) {
      if (!(err instanceof AuthError)) log.error('token verification failed', { error: errorMessage(err) });
      c.header('Cache-Control', NO_STORE);
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  const viewerOf = (c: Context<Env>): Viewer => ({ uid: c.get('claims').sub });

  /** JSON from memory: 503 before the first load, 404 when not visible. */
  const answer = (c: Context, cache: string, missCache: string, build: (ctx: ViewContext) => object | null): Response => {
    const ctx = hub.context();
    if (!ctx) return notReady(c);
    const body = build(ctx);
    if (body === null) {
      c.header('Cache-Control', missCache);
      return c.json({ error: 'not found' }, 404);
    }
    c.header('Cache-Control', cache);
    return c.json(body, 200);
  };

  const notFound = (c: Context, cache: string): Response => {
    c.header('Cache-Control', cache);
    return c.json({ error: 'not found' }, 404);
  };

  // --- Members: polling -------------------------------------------------

  live.get('/v1/live/routes/:routeId', etag(), (c) => {
    const id = c.req.param('routeId').toLowerCase();
    if (!isUuid(id)) return notFound(c, NO_STORE);
    return answer(c, CACHE_MEMBER, NO_STORE, (ctx) => routeView(ctx, viewerOf(c), id));
  });

  live.get('/v1/live/trips/:tripInstanceId', etag(), (c) => {
    const id = c.req.param('tripInstanceId').toLowerCase();
    if (!isUuid(id)) return notFound(c, NO_STORE);
    return answer(c, CACHE_MEMBER, NO_STORE, (ctx) => tripOnlyView(ctx, viewerOf(c), id));
  });

  live.get('/v1/live/stops/:stopId', etag(), (c) => {
    const id = c.req.param('stopId').toLowerCase();
    if (!isUuid(id)) return notFound(c, NO_STORE);
    return answer(c, CACHE_MEMBER, NO_STORE, (ctx) => stopView(ctx, viewerOf(c), id));
  });

  // --- Members: Server-Sent Events --------------------------------------

  const stream = (
    c: Context<Env>, event: string, build: (ctx: ViewContext, viewer: Viewer) => object | null, relevant: (ch: Change) => boolean,
    goneReason?: (ctx: ViewContext, viewer: Viewer) => EndReason,
  ): Response => {
    const ctx = hub.context();
    if (!ctx) return notReady(c);
    const viewer = viewerOf(c);
    const first = build(ctx, viewer);
    if (first === null) return notFound(c, NO_STORE);
    const claims = c.get('claims');
    const slot = streams.reserve(claims.sub);
    if (!slot) {
      c.header('Cache-Control', NO_STORE);
      c.header('Retry-After', '30');
      return c.json({ error: 'too many streams' }, 429);
    }
    c.header('X-Accel-Buffering', 'no');
    // @hono/node-server passes the Node response as c.env.outgoing.
    const outgoing = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing;
    return streamSSE(c, async (s) => {
      try {
        await runStream(s, {
          event,
          build: () => {
            const now = hub.context();
            return now ? build(now, viewer) : null;
          },
          relevant,
          ...(goneReason ? { goneReason: () => { const now = hub.context(); return now ? goneReason(now, viewer) : 'not_found'; } } : {}),
          expiresAt: claims.exp * 1000,
          drop: () => { outgoing?.destroy(); },
        }, first, hub, slot, streams.limits, log);
      } finally {
        slot.release();
      }
    }, (err) => {
      log.error('live stream failed', { error: errorMessage(err) });
      return Promise.resolve();
    });
  };

  live.get('/v1/live/routes/:routeId/stream', (c) => {
    const id = c.req.param('routeId').toLowerCase();
    if (!isUuid(id)) return notFound(c, NO_STORE);
    return stream(c, 'route', (ctx, viewer) => routeView(ctx, viewer, id), (ch) => ch.all || ch.routeIds.includes(id));
  });

  live.get('/v1/live/trips/:tripInstanceId/stream', (c) => {
    const id = c.req.param('tripInstanceId').toLowerCase();
    if (!isUuid(id)) return notFound(c, NO_STORE);
    return stream(c, 'trip', (ctx, viewer) => tripOnlyView(ctx, viewer, id), (ch) => ch.all || ch.tripIds.includes(id),
      // Still visible, only no longer today's: the trip is over.
      (ctx, viewer) => (ctx.dir.access.tripAccess(viewer.uid, id, ctx.now) >= 1 ? 'trip_ended' : 'not_found'));
  });

  // --- Public routes and stops (anyone) ---------------------------------

  const visitor: Viewer = { uid: null };

  live.get('/v1/public/routes/:operatorSlug/:routeSlug', etag(), (c) => {
    const op = c.req.param('operatorSlug');
    const slug = c.req.param('routeSlug');
    if (!isSlug(op) || !isSlug(slug)) return notFound(c, CACHE_PUBLIC_MISS);
    return answer(c, CACHE_PUBLIC, CACHE_PUBLIC_MISS, (ctx) => {
      const route = ctx.dir.routeBySlug(op, slug);
      return route ? routeView(ctx, visitor, route.id) : null;
    });
  });

  live.get('/v1/public/stops/:operatorSlug/:stopSlug', etag(), (c) => {
    const op = c.req.param('operatorSlug');
    const slug = c.req.param('stopSlug');
    if (!isSlug(op) || !isSlug(slug)) return notFound(c, CACHE_PUBLIC_MISS);
    return answer(c, CACHE_PUBLIC, CACHE_PUBLIC_MISS, (ctx) => {
      const stop = ctx.dir.stopBySlug(op, slug);
      return stop ? stopView(ctx, visitor, stop.id) : null;
    });
  });

  app.route('/', live);
}
