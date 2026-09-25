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
    pinEvent: RateLimiter;
    admin: RateLimiter;
    status: RateLimiter;
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

export async function buildApp(
  cfg: Config,
  opts: BuildOptions = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    trustProxy: cfg.trustProxy,
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
      admin: new RateLimiter(5, 60_000, 60_000),
      status: new RateLimiter(60, 60_000),
      join: new RateLimiter(10, 10 * 60_000),
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

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });

  // Cross-site forms cannot send JSON, so requiring it blocks CSRF on cookie-authenticated routes.
  app.addHook('preHandler', async (req, reply) => {
    if (!['POST', 'PATCH', 'DELETE'].includes(req.method) || !req.url.startsWith('/api/')) return;
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      return reply.code(415).send({ error: 'json_required', message: 'Send JSON.' });
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
