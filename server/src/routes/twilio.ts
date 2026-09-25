import { normalizePhone } from '@pby/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { classifyInbound, validateTwilioSignature } from '../sms/twilio.js';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * S4: inbound SMS webhook for STOP/START. Twilio's Advanced Opt-Out already replies and
 * blocks, so the app never sends its own confirmation text.
 */
export function registerTwilioRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/sms/twilio/inbound', async (req, reply) => {
    const twilio = ctx.cfg.twilio;
    if (!twilio) return reply.code(404).send({ error: 'not_found' });
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
      params[k] = Array.isArray(v) ? String(v[0]) : String(v ?? '');
    }
    const base = ctx.cfg.publicUrl ?? ctx.originOf(req);
    const signature = req.headers['x-twilio-signature'];
    if (
      !validateTwilioSignature(
        twilio.authToken,
        typeof signature === 'string' ? signature : undefined,
        base + req.url,
        params,
      )
    ) {
      req.log.warn('twilio webhook: bad signature');
      return reply.code(403).send({ error: 'forbidden' });
    }
    const kind = classifyInbound(params.Body ?? '');
    const from = normalizePhone(params.From ?? '');
    if (kind && from.ok) {
      ctx.service.setOptOut(from.e164, kind === 'opt_out');
      req.log.info({ kind }, 'twilio opt-out keyword');
    }
    return reply.type('text/xml').send(EMPTY_TWIML);
  });
}
