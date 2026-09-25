import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { maskPhonesInText } from '@pby/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { openDb, type DB } from './db.js';
import { ServiceError } from './errors.js';
import { Hub } from './hub.js';
import { runRetention } from './retention.js';
import { registerHostRoutes } from './routes/host.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerTwilioRoutes } from './routes/twilio.js';
import { RateLimiter } from './security.js';
import { QueueService } from './service.js';
import { Sessions } from './sessions.js';
import { createTwilioProvider } from './sms/twilio.js';

export interface AppContext {
  cfg: Config;
  db: DB;
  service: QueueService;
  hub: Hub;
  limits: {
    pinIp: RateLimiter;
    /** Wrong PINs per (event, IP): a stranger with the public join code only locks themselves out. */
    pinEvent: RateLimiter;
    /** Backstop: wrong PINs per event from every address together. */
    pinEventAll: RateLimiter;
    admin: RateLimiter;
    /** Unknown status tokens per IP (guessing). */
    status: RateLimiter;
    /** Requests per known status link. */
    statusToken: RateLimiter;
    /** Self-joins per (IP, event), so families on one venue Wi-Fi don't share one budget. */
    join: RateLimiter;
  };
  setHostCookie(req: FastifyRequest, reply: FastifyReply, eventId: string, token: string): void;
  clearHostCookie(reply: FastifyReply, eventId: string): void;
  originOf(req: FastifyRequest): string;
}

export interface BuildOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Disable the background retention timer (tests). */
  timers?: boolean;
}

/** Hides status tokens from request logs; phone numbers never reach the logs unmasked. */
function redactUrl(url: string): string {
  return maskPhonesInText(url.replace(/\/(s|status)\/[A-Za-z0-9]+/g, '/$1/***'));
}

/**
 * SEC-2. No 'unsafe-inline': the built index.html has no inline script or style, and React's
 * `style` props go through the CSSOM, which CSP allows. `connect-src 'self'` covers ws/wss to
 * the same host (CSP Level 3). `frame-ancestors 'none'` stops clickjacking of Call next and
 * "Delete guest data now".
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Wake lock is the only powerful feature the app uses (H1 keeps the screen on). */
const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'bluetooth=()',
  'screen-wake-lock=(self)',
].join(', ');

/**
 * True when a browser says the request came from another origin (SEC-1). Requests without
 * `Origin` or `Sec-Fetch-Site` are not from a browser page, so there is no ambient cookie to
 * abuse. `PUBLIC_URL`'s host is accepted too, in case a proxy rewrites Host.
 */
export function crossOrigin(req: FastifyRequest, publicUrl: string | null): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true; // `Origin: null` (sandboxed frames, data: URLs) or garbage
  }
  if (host === req.host) return false;
  try {
    return !publicUrl || new URL(publicUrl).host !== host;
  } catch {
    return true;
  }
}

export async function buildApp(
  cfg: Config,
  opts: BuildOptions = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    // A hop count becomes the same trust function proxy-addr would build (Fastify's types
    // don't list the numeric form).
    trustProxy:
      typeof cfg.trustProxy === 'number'
        ? (_addr: string, hop: number) => hop < (cfg.trustProxy as number)
        : cfg.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logger: {
      level: cfg.logLevel,
      serializers: {
        req: (req) => ({ method: req.method, url: redactUrl(req.url) }),
      },
    },
  });
  const db = openDb(cfg.dbPath);
  const twilio = cfg.twilio ? createTwilioProvider(cfg.twilio, opts.fetchImpl) : null;
  const service = new QueueService(db, cfg, twilio, app.log, opts.now);
  const hub = new Hub(service);

  const ctx: AppContext = {
    cfg,
    db,
    service,
    hub,
    limits: {
      pinIp: new RateLimiter(5, 60_000, 60_000),
      pinEvent: new RateLimiter(20, 3_600_000, 15 * 60_000),
      pinEventAll: new RateLimiter(200, 3_600_000, 15 * 60_000),
      admin: new RateLimiter(5, 60_000, 60_000),
      status: new RateLimiter(60, 60_000),
      statusToken: new RateLimiter(60, 60_000),
      join: new RateLimiter(cfg.selfJoinPerIp, 10 * 60_000),
    },
    setHostCookie(req, reply, eventId, token) {
      reply.setCookie(Sessions.cookieName(eventId), token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.cookieSecure === 'auto' ? req.protocol === 'https' : cfg.cookieSecure,
        maxAge: Sessions.maxAgeSeconds,
      });
    },
    clearHostCookie(reply, eventId) {
      reply.clearCookie(Sessions.cookieName(eventId), { path: '/' });
    },
    originOf(req) {
      return `${req.protocol}://${req.host}`;
    },
  };

  await app.register(cookie);
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.addHook('onSend', async (req, reply, payload) => {
    // Status tokens are in page URLs: never send them to another site in Referer.
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    // SEC-2: the built PWA loads only same-origin scripts, styles, fonts, images, the manifest
    // and its service worker, and talks to its own API and WebSocket.
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY'); // older browsers without frame-ancestors
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.protocol === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
    // Snapshots carry names, phone numbers and status tokens: keep them out of every cache.
    if (/^\/(api|ws)\//.test(req.url) && !reply.hasHeader('cache-control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  // CSRF (SEC-1): cross-site forms and no-preflight fetches cannot send a body whose media type
  // is exactly application/json, so requiring it blocks CSRF on cookie-authenticated routes.
  // `text/plain; application/json` is CORS-safelisted, so only the type essence counts.
  // Browsers also say where a request came from: refuse other origins, including sibling
  // subdomains, which SameSite=Lax treats as same-site.
  app.addHook('onRequest', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.url.startsWith('/api/')) return;
    const essence = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (essence !== 'application/json') {
      return reply.code(415).send({ error: 'json_required', message: 'Send JSON.' });
    }
    if (crossOrigin(req, cfg.publicUrl)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Cross-site request.' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ServiceError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err: maskPhonesInText(String(err)) }, 'request failed');
    return reply
      .code(status)
      .send({ error: status >= 500 ? 'server_error' : 'bad_request', message: 'Request failed.' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  registerPublicRoutes(app, ctx);
  registerHostRoutes(app, ctx);
  registerTwilioRoutes(app, ctx);

  if (cfg.webDist) {
    await app.register(fastifyStatic, {
      root: cfg.webDist,
      prefix: '/',
      setHeaders(res, path) {
        if (/\/assets\//.test(path)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const isApi = /^\/(api|ws|sms)\//.test(req.url);
    if (req.method === 'GET' && !isApi && cfg.webDist) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Not found.' });
  });

  // Retention (§2.12): auto-close sweep every 15 min, purge on startup and every 24 h.
  let lastPurge = 0;
  const sweep = () => {
    const now = service.now();
    const purge = now - lastPurge >= 86_400_000;
    const r = runRetention(db, now, {
      retentionDays: cfg.retentionDays,
      autoCloseHours: cfg.autoCloseHours,
      purge,
    });
    if (purge) lastPurge = now;
    for (const id of [...r.autoClosed, ...r.purged]) hub.schedule(id);
    if (r.autoClosed.length || r.purged.length) {
      app.log.info({ autoClosed: r.autoClosed.length, purged: r.purged.length }, 'retention sweep');
    }
    for (const l of Object.values(ctx.limits)) l.prune(now);
  };
  if (opts.timers !== false) {
    sweep();
    const timer = setInterval(sweep, 15 * 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  app.addHook('onClose', async () => {
    hub.close();
    db.close();
  });

  return { app, ctx };
}
