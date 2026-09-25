import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import type { AppContext } from '../app.js';
import { ServiceError } from '../errors.js';
import { clientKey, safeEqual, verifyPin } from '../security.js';
import { joinLink } from '../snapshots.js';
import type { CreateEventInput } from '../service.js';

type Body = Record<string, unknown>;

const ADMIN_ALL = 'all';

/** The rate-limit key for the client: its IPv4 address or IPv6 /64 (SEC-5). */
const ip = (req: FastifyRequest) => clientKey(req.ip);

export function registerPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { service, cfg, limits } = ctx;

  app.get('/api/config', async () => ({
    twilioAvailable: service.twilioAvailable,
    adminConfigured: !!cfg.adminPassword,
  }));

  /** E1: creating an event requires ADMIN_PASSWORD. */
  app.post('/api/events', async (req, reply) => {
    const body = (req.body ?? {}) as Body & CreateEventInput;
    if (!cfg.adminPassword) {
      throw new ServiceError(
        403,
        'admin_not_configured',
        'Set ADMIN_PASSWORD on the server first.',
      );
    }
    const now = service.now();
    // Per client, plus a backstop across every address (SEC-5): a botnet or a rotating IPv6
    // range must not get unlimited guesses at the password that unlocks Twilio spend. While the
    // backstop is on, even the right password is refused, so guesses learn nothing.
    const wait = Math.max(
      limits.admin.retryAfter(ip(req), now),
      limits.adminAll.retryAfter(ADMIN_ALL, now),
    );
    if (wait)
      throw new ServiceError(429, 'rate_limited', `Try again in ${wait} s.`, { retryAfter: wait });
    if (!safeEqual(String(body.adminPassword ?? ''), cfg.adminPassword)) {
      limits.admin.hit(ip(req), now);
      limits.adminAll.hit(ADMIN_ALL, now);
      throw new ServiceError(401, 'wrong_admin_password', 'Wrong admin password.');
    }
    const event = await service.createEvent(body, ctx.originOf(req));
    const token = service.sessions.create(event.id);
    ctx.setHostCookie(req, reply, event.id, token);
    return { id: event.id, code: event.code };
  });

  /** Minimal info for the PIN screen. */
  app.get<{ Params: { id: string } }>('/api/events/:id/public', async (req) => {
    const event = service.getEvent(req.params.id);
    if (!event) throw new ServiceError(404, 'not_found', 'Event not found.');
    return { id: event.id, name: event.name, status: event.status };
  });

  /** E2/E3: unlock one event with its PIN (by event id or join code). */
  app.post('/api/host/login', async (req, reply) => {
    const body = (req.body ?? {}) as Body;
    const now = service.now();
    const ipWait = limits.pinIp.retryAfter(ip(req), now);
    if (ipWait) {
      throw new ServiceError(429, 'rate_limited', `Too many tries. Try again in ${ipWait} s.`, {
        retryAfter: ipWait,
      });
    }
    const event =
      typeof body.eventId === 'string'
        ? service.getEvent(body.eventId)
        : typeof body.code === 'string'
          ? service.store.getEventByCode(body.code.trim())
          : null;
    // Wrong PINs lock the event per (event, IP), so a stranger holding the public join code
    // only locks themselves out; a much higher per-event count is a backstop against many IPs.
    const eventIpKey = event ? `${event.id} ${ip(req)}` : '';
    if (event && !event.purgedAt) {
      const lock = Math.max(
        limits.pinEvent.retryAfter(eventIpKey, now),
        limits.pinEventAll.retryAfter(event.id, now),
      );
      if (lock) {
        throw new ServiceError(
          423,
          'event_locked',
          `Too many wrong PINs. Try again in ${Math.ceil(lock / 60)} min.`,
          {
            retryAfter: lock,
          },
        );
      }
    }
    const ok =
      event && !event.purgedAt ? await verifyPin(String(body.pin ?? ''), event.pinHash) : false;
    if (!ok || !event) {
      limits.pinIp.hit(ip(req), now);
      if (event) {
        limits.pinEvent.hit(eventIpKey, now);
        limits.pinEventAll.hit(event.id, now);
      }
      const triesLeft = limits.pinIp.remaining(ip(req), now);
      throw new ServiceError(401, 'wrong_pin', 'Wrong PIN.', { triesLeft });
    }
    const token = service.sessions.create(event.id);
    ctx.setHostCookie(req, reply, event.id, token);
    return { id: event.id };
  });

  /** H0: the events this device is signed in to (one cookie per event). */
  app.get('/api/host/events', async (req) => {
    const events = [];
    for (const [name, token] of Object.entries(req.cookies)) {
      if (!name.startsWith('pby_h_') || !token) continue;
      const id = name.slice('pby_h_'.length);
      if (!service.sessions.valid(id, token)) continue;
      const event = service.getEvent(id);
      if (!event) continue;
      const parties = service.store.listParties(id);
      events.push({
        id,
        name: event.name,
        date: event.date,
        status: event.status,
        waiting: parties.filter((p) => p.state === 'waiting' || p.state === 'up_next').length,
        done: parties.filter((p) => p.state === 'done').length,
      });
    }
    return { events: events.sort((a, b) => b.date.localeCompare(a.date)) };
  });

  /* ------------------------------------------------------------ guests */

  /**
   * Looks up a join code for a guest-facing route. Unknown codes count toward the same per-IP
   * miss limit as status tokens on every route that answers 404 for them (QA #16, SEC-4), so
   * none of them is an unlimited oracle for guessing codes.
   */
  const joinEvent = (ip: string, code: string) => {
    const now = service.now();
    if (limits.status.retryAfter(ip, now) > 0) {
      throw new ServiceError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
    }
    const event = service.store.getEventByCode(code);
    if (!event || event.purgedAt) {
      limits.status.hit(ip, now);
      throw new ServiceError(404, 'not_found', 'Not found.');
    }
    return event;
  };

  /** Join page info. */
  app.get<{ Params: { code: string } }>('/api/join/:code', async (req) => {
    const event = joinEvent(ip(req), req.params.code);
    return service.joinInfo(event.code)!;
  });

  app.post<{ Params: { code: string } }>('/api/join/:code', async (req) => {
    const body = (req.body ?? {}) as Body;
    // Honeypot: real people never fill the hidden "website" field.
    if (typeof body.website === 'string' && body.website.trim()) {
      throw new ServiceError(400, 'bad_request', 'Request failed.');
    }
    const event = joinEvent(ip(req), req.params.code);
    // Keyed on (IP, event): a venue's shared Wi-Fi or carrier NAT address has one budget per
    // event, and the honeypot, one active party per phone and the 500-party cap still apply.
    // Only real codes become keys, so attacker-chosen strings can't grow the map (SEC-4).
    if (!limits.join.hit(`${ip(req)} ${event.code}`, service.now())) {
      throw new ServiceError(
        429,
        'rate_limited',
        'Too many sign-ups from this network. Try again soon.',
      );
    }
    return service.selfJoin(event.code, body);
  });

  app.get<{ Params: { code: string } }>('/api/join/:code/qr.svg', async (req, reply) => {
    const event = joinEvent(ip(req), req.params.code);
    const svg = await QRCode.toString(joinLink(event), {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
    return reply.type('image/svg+xml').header('Cache-Control', 'public, max-age=3600').send(svg);
  });

  /**
   * §2.10 status limit (the miss counter is shared with join codes), keyed so that a venue's shared Wi-Fi or carrier NAT address doesn't lock
   * out every family on it: unknown tokens count per IP (60 misses a minute stops guessing, and
   * then that IP gets 429 for every token, so it can't keep probing), and each real link gets
   * 60 requests a minute of its own.
   */
  const statusGuard = (ip: string, token: string) => {
    const tooMany = () =>
      new ServiceError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
    const now = service.now();
    if (limits.status.retryAfter(ip, now) > 0) throw tooMany();
    if (!service.store.getPartyByToken(token)) {
      limits.status.hit(ip, now);
      return;
    }
    if (!limits.statusToken.hit(token, now)) throw tooMany();
  };

  /** G1 status (polling fallback). Unknown tokens get a generic 404. */
  app.get<{ Params: { token: string } }>('/api/status/:token', async (req) => {
    statusGuard(ip(req), req.params.token);
    const snap = service.guestSnapshot(req.params.token);
    if (!snap) throw new ServiceError(404, 'not_found', 'Not found.');
    return snap;
  });

  /** G4 "I'm here" check-in. */
  app.post<{ Params: { token: string } }>('/api/status/:token/arrive', async (req) => {
    statusGuard(ip(req), req.params.token);
    return service.guestArrive(req.params.token);
  });

  /**
   * G5 lobby display. Unknown tokens count toward the same per-IP miss limit as status tokens
   * and join codes; each real link gets 60 requests a minute of its own.
   */
  const lobbyGuard = (ip: string, token: string) => {
    const tooMany = () =>
      new ServiceError(429, 'rate_limited', 'Too many requests. Try again in a minute.');
    const now = service.now();
    if (limits.status.retryAfter(ip, now) > 0) throw tooMany();
    const event = service.lobbyEvent(token);
    if (!event) {
      limits.status.hit(ip, now);
      throw new ServiceError(404, 'not_found', 'Not found.');
    }
    if (!limits.statusToken.hit(`lobby:${event.id}`, now)) throw tooMany();
    return event;
  };

  app.get<{ Params: { token: string } }>('/api/lobby/:token', async (req, reply) => {
    lobbyGuard(req.ip, req.params.token);
    const snap = service.lobbySnapshot(req.params.token);
    if (!snap) throw new ServiceError(404, 'not_found', 'Not found.');
    return reply.header('Cache-Control', 'no-store').send(snap);
  });

  app.get<{ Params: { token: string } }>('/ws/lobby/:token', { websocket: true }, (socket, req) => {
    let event;
    try {
      event = lobbyGuard(req.ip, req.params.token);
    } catch (err) {
      return socket.close(
        err instanceof ServiceError && err.status === 429 ? 4429 : 4404,
        'not_found',
      );
    }
    ctx.hub.addLobby(event.id, socket, req.params.token);
  });

  app.get<{ Params: { token: string } }>(
    '/ws/status/:token',
    { websocket: true },
    (socket, req) => {
      try {
        statusGuard(ip(req), req.params.token);
      } catch {
        return socket.close(4429, 'rate_limited');
      }
      const party = service.store.getPartyByToken(req.params.token);
      if (!party || !service.getEvent(party.eventId)) return socket.close(4404, 'not_found');
      ctx.hub.addGuest(party.eventId, party.id, socket, ip(req));
    },
  );
}
