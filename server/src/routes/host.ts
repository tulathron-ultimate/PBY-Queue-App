import type {
  EventSettings,
  ImportPartyInput,
  MoveDirection,
  PartySource,
  TextStatus,
} from '@pby/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { ServiceError } from '../errors.js';
import { clientKey } from '../security.js';
import { Sessions } from '../sessions.js';

type Body = Record<string, unknown>;
type EventParams = { Params: { id: string } };
type PartyParams = { Params: { id: string; pid: string; action?: string } };

const IMPORT_SOURCES: PartySource[] = ['import', 'vcard', 'contacts'];

export function registerHostRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { service } = ctx;

  const token = (req: FastifyRequest, id: string) => req.cookies[Sessions.cookieName(id)];

  /**
   * WebSocket upgrades are not covered by CORS or the JSON-only CSRF rule, so a page on another
   * site could open the host feed with the host's cookie. Browsers always send Origin on them.
   */
  function crossSiteUpgrade(req: FastifyRequest): boolean {
    if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return false;
    const origin = req.headers.origin;
    if (!origin) return false; // not a browser, so no ambient cookie to abuse
    try {
      return new URL(origin).host !== req.host;
    } catch {
      return true;
    }
  }

  /** Host auth: a valid session cookie for this event. */
  async function requireHost(req: FastifyRequest<EventParams>, reply: FastifyReply) {
    if (crossSiteUpgrade(req)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Cross-site request.' });
    }
    if (!service.sessions.valid(req.params.id, token(req, req.params.id))) {
      ctx.clearHostCookie(reply, req.params.id);
      return reply.code(401).send({ error: 'unauthorized', message: 'Enter the event PIN.' });
    }
  }

  const snapshot = (id: string) => service.hostSnapshot(id);

  app.register(async (host) => {
    // onRequest, so an unauthenticated request is refused before its body is read (SEC-9).
    host.addHook('onRequest', requireHost as never);
    // §2.12 auto-close counts host actions only. This hook runs after requireHost, so only
    // authenticated host requests get here; reads and the live feed don't count as actions.
    host.addHook('preHandler', async (req: FastifyRequest<EventParams>, reply) => {
      if (reply.sent || req.method === 'GET') return;
      if (service.getEvent(req.params.id)) service.touchHost(req.params.id);
    });

    host.get<EventParams>('/api/host/events/:id', async (req) => snapshot(req.params.id));

    host.post<EventParams>('/api/host/events/:id/call-next', async (req) => {
      service.callNext(req.params.id);
      return snapshot(req.params.id);
    });
    host.post<EventParams>('/api/host/events/:id/complete', async (req) => {
      service.completeCurrent(req.params.id);
      return snapshot(req.params.id);
    });
    host.post<EventParams>('/api/host/events/:id/skip', async (req) => {
      service.skipCurrent(req.params.id);
      return snapshot(req.params.id);
    });
    host.post<EventParams>('/api/host/events/:id/undo', async (req) => {
      const { label } = service.undo(req.params.id);
      return { ...snapshot(req.params.id), undone: label };
    });

    /** A1 manual add. */
    host.post<EventParams>('/api/host/events/:id/parties', async (req) => {
      const body = (req.body ?? {}) as Body & Partial<ImportPartyInput>;
      const [party] = service.addParties(req.params.id, [body], {
        source: 'manual',
        arrived: body.arrived !== false,
        position: body.position === 'next' ? 'next' : 'end',
        sendJoinText: body.sendJoinText !== false,
        consentConfirmed: body.consentConfirmed === true,
      });
      return { partyId: party.id, snapshot: snapshot(req.params.id) };
    });

    /** A2/A3/A4 import. Imported parties start as not arrived (A8). */
    // A 500-row roster with members and notes is up to about 1 MB of JSON (SEC-9).
    host.post<EventParams>(
      '/api/host/events/:id/import',
      { bodyLimit: 2 * 1024 * 1024 },
      async (req) => {
        const body = (req.body ?? {}) as Body;
        const source = IMPORT_SOURCES.includes(body.source as PartySource)
          ? (body.source as PartySource)
          : 'import';
        const added = service.addParties(req.params.id, body.rows as Partial<ImportPartyInput>[], {
          source,
          arrived: body.arrived === true,
          position: 'end',
          sendJoinText: body.sendJoinTexts === true,
          consentConfirmed: body.consentConfirmed === true,
        });
        return { added: added.length, snapshot: snapshot(req.params.id) };
      },
    );

    host.patch<PartyParams>('/api/host/events/:id/parties/:pid', async (req) => {
      service.updateParty(req.params.id, req.params.pid, (req.body ?? {}) as Body);
      return snapshot(req.params.id);
    });

    host.post<PartyParams>('/api/host/events/:id/parties/:pid/:action', async (req) => {
      const { id, pid, action } = req.params;
      const moves: Record<string, MoveDirection> = {
        'move-up': 'up',
        'move-down': 'down',
        'move-next': 'next',
      };
      if (action && moves[action]) service.move(id, pid, moves[action]);
      else if (action === 'remove') service.remove(id, pid);
      else if (action === 'reinsert') service.reinsert(id, pid);
      else if (action === 'serve') service.serveNow(id, pid);
      else if (action === 'arrive') service.setArrived(id, pid, true);
      else if (action === 'unarrive') service.setArrived(id, pid, false);
      else if (action === 'text') service.textParty(id, pid);
      else throw new ServiceError(404, 'not_found', 'Unknown action.');
      return snapshot(id);
    });

    /** Tap-to-send tray: mark a text sent / skipped / back to pending. */
    host.post<{ Params: { id: string; sid: string } }>(
      '/api/host/events/:id/texts/:sid',
      async (req) => {
        const body = (req.body ?? {}) as Body;
        service.markText(req.params.id, Number(req.params.sid), body.status as TextStatus);
        return snapshot(req.params.id);
      },
    );

    host.patch<EventParams>('/api/host/events/:id/settings', async (req) => {
      service.updateSettings(req.params.id, (req.body ?? {}) as Partial<EventSettings>);
      return snapshot(req.params.id);
    });

    host.post<EventParams>('/api/host/events/:id/close', async (req, reply) => {
      service.close(req.params.id);
      ctx.clearHostCookie(reply, req.params.id);
      return { ok: true };
    });

    host.post<EventParams>('/api/host/events/:id/delete', async (req, reply) => {
      service.deleteNow(req.params.id);
      ctx.clearHostCookie(reply, req.params.id);
      return { ok: true };
    });

    host.post<EventParams>('/api/host/events/:id/logout', async (req, reply) => {
      service.sessions.delete(token(req, req.params.id)!);
      ctx.clearHostCookie(reply, req.params.id);
      ctx.hub.schedule(req.params.id); // closes this device's live socket
      return { ok: true };
    });

    host.post<EventParams>('/api/host/events/:id/signout-others', async (req) => {
      const removed = service.sessions.deleteOthers(req.params.id, token(req, req.params.id)!);
      ctx.hub.schedule(req.params.id); // closes the other devices' live sockets
      return { removed };
    });

    host.get<EventParams>('/ws/host/:id', { websocket: true }, (socket, req) => {
      ctx.hub.addHost(req.params.id, socket, token(req, req.params.id)!, clientKey(req.ip));
    });
  });
}
