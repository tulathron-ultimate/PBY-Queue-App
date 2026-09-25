import type { GuestSnapshot, HostSnapshot } from '@pby/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runRetention } from '../src/retention.js';
import { twilioSignature } from '../src/sms/twilio.js';

const ADMIN = 'admin-secret';
const PIN = '246810';

let clock = Date.UTC(2026, 9, 1, 15, 0, 0);
const now = () => clock;
const advance = (ms: number) => (clock += ms);

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  cookies: Record<string, string>;
  eventId: string;
  code: string;
  sent: { to: string; body: string }[];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(
  env: Record<string, string> = {},
  twilioFail?: (to: string) => { code: number; message: string } | null,
): Promise<Harness> {
  const sent: { to: string; body: string }[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body));
    const to = form.get('To')!;
    const fail = twilioFail?.(to);
    if (fail) return new Response(JSON.stringify(fail), { status: 400 });
    sent.push({ to, body: form.get('Body')! });
    return new Response(JSON.stringify({ sid: `SM${sent.length}` }), { status: 201 });
  }) as typeof fetch;
  const cfg = loadConfig({
    DATABASE_PATH: ':memory:',
    ADMIN_PASSWORD: ADMIN,
    PUBLIC_URL: 'https://q.example.com',
    LOG_LEVEL: 'silent',
    WEB_DIST: '',
    ...env,
  });
  cfg.webDist = null;
  const { app, ctx } = await buildApp(cfg, { fetchImpl: fakeFetch, now, timers: false });
  apps.push(app);
  const res = await app.inject({
    method: 'POST',
    url: '/api/events',
    payload: {
      adminPassword: ADMIN,
      name: 'Pumpkin Patch Portraits',
      pin: PIN,
      smsMode: env.TWILIO_ACCOUNT_SID ? 'twilio' : 'tap',
    },
  });
  expect(res.statusCode).toBe(200);
  const { id, code } = res.json();
  const cookies: Record<string, string> = {};
  for (const c of res.cookies) cookies[c.name] = c.value;
  return { app, ctx, cookies, eventId: id, code, sent };
}

async function host(h: Harness, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) {
  const res = await h.app.inject({
    method,
    url: `/api/host/events/${h.eventId}${path}`,
    cookies: h.cookies,
    payload: method === 'GET' ? undefined : (payload ?? {}),
  });
  return res;
}

async function snap(h: Harness): Promise<HostSnapshot> {
  return (await host(h, 'GET', '')).json();
}

async function addManual(h: Harness, name: string, phone = '', extra: object = {}) {
  const res = await host(h, 'POST', '/parties', {
    name,
    phone,
    size: 1,
    consentConfirmed: true,
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().partyId as string;
}

describe('events and auth', () => {
  it('requires the admin password to create an event', async () => {
    const h = await setup();
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { adminPassword: 'nope', name: 'X', pin: PIN },
    });
    expect(bad.statusCode).toBe(401);
    const badPin = await h.app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { adminPassword: ADMIN, name: 'X', pin: '123' },
    });
    expect(badPin.json().error).toBe('invalid_pin');
  });

  it('rejects host API calls without a session and non-JSON posts', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: `/api/host/events/${h.eventId}` });
    expect(res.statusCode).toBe(401);
    const form = await h.app.inject({
      method: 'POST',
      url: `/api/host/events/${h.eventId}/call-next`,
      cookies: h.cookies,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1',
    });
    expect(form.statusCode).toBe(415);
  });

  it('sets an httpOnly SameSite=Lax session cookie and lists the event', async () => {
    const h = await setup();
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { code: h.code, pin: PIN },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies[0];
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
    const list = await h.app.inject({ method: 'GET', url: '/api/host/events', cookies: h.cookies });
    expect(list.json().events[0]).toMatchObject({ id: h.eventId, name: 'Pumpkin Patch Portraits' });
  });

  it('blocks an IP after 5 wrong PINs', async () => {
    const h = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/host/login',
        payload: { eventId: h.eventId, pin: '000000' },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    const right = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { eventId: h.eventId, pin: PIN },
    });
    expect(right.statusCode).toBe(429);
  });

  it('allows at most 5 host sessions per event', async () => {
    const h = await setup(); // creator = session 1
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/host/login',
        payload: { eventId: h.eventId, pin: PIN },
      });
      statuses.push(r.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });
});

describe('queue flow (tap-to-send)', () => {
  it('runs import → check in → call next with privacy-filtered guest status', async () => {
    const h = await setup();
    const imp = await host(h, 'POST', '/import', {
      source: 'import',
      consentConfirmed: true,
      rows: [
        { name: 'Emma Rivera', phone: '(555) 201-8830', size: 1 },
        { name: 'Nguyen Family', phone: '555-309-4417', size: 5 },
        { name: 'Okafor', phone: '', size: 1 },
      ],
    });
    expect(imp.statusCode, imp.body).toBe(200);
    let s: HostSnapshot = imp.json().snapshot;
    expect(s.parties.map((p) => [p.ticket, p.arrived, p.state])).toEqual([
      [1, false, 'waiting'],
      [2, false, 'waiting'],
      [3, false, 'waiting'],
    ]);
    // Imports default to no join texts
    expect(s.pendingTexts).toEqual([]);

    // Nobody has arrived: Call next has nobody to call
    const empty = await host(h, 'POST', '/call-next');
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error).toBe('queue_empty');

    const [emma, nguyen, okafor] = s.parties;
    s = (await host(h, 'POST', `/parties/${nguyen.id}/arrive`)).json();
    s = (await host(h, 'POST', `/parties/${emma.id}/arrive`)).json();
    expect(s.parties.find((p) => p.id === nguyen.id)!.state).toBe('up_next');

    // Guest 2 checks their status: position 2 (only Emma, arrived and earlier, is ahead)
    const g = await h.app.inject({ method: 'GET', url: `/api/status/${nguyen.token}` });
    const guest: GuestSnapshot = g.json();
    expect(guest.me).toMatchObject({ ticket: 2, position: 2, state: 'up_next', arrived: true });
    expect(g.body).not.toContain('555');
    expect(g.body).not.toContain('Rivera');

    advance(2000);
    s = (await host(h, 'POST', '/call-next')).json();
    expect(s.parties.find((p) => p.id === emma.id)!.state).toBe('now_serving');
    // Tray order: Up next texts first, then Your turn
    expect(s.pendingTexts.map((t) => [t.template, t.to])).toEqual([
      ['up_next', '+15553094417'],
      ['up_next', '+15552018830'],
      ['your_turn', '+15552018830'],
    ]);
    expect(s.pendingTexts[2].body).toBe(
      "Pumpkin Patch Portra: Emma, it's your turn! Please come to the camera now.",
    );

    const g2: GuestSnapshot = (
      await h.app.inject({ method: 'GET', url: `/api/status/${nguyen.token}` })
    ).json();
    expect(g2.nowServing).toEqual({ ticket: 1, name: 'Emma R.', isMe: false });
    expect(g2.me!.position).toBe(1);
    expect(g2.me!.waitText).toBe('~3 min');

    // Okafor (no phone) checks in from the status page (G4)
    const arrive = await h.app.inject({
      method: 'POST',
      url: `/api/status/${okafor.token}/arrive`,
      payload: {},
    });
    expect(arrive.json().me).toMatchObject({ arrived: true, position: 2, hasPhone: false });

    // Mark a tray text sent
    s = (await host(h, 'POST', `/texts/${s.pendingTexts[0].id}`, { status: 'sent' })).json();
    expect(s.pendingTexts).toHaveLength(2);

    // Call-next debounce (1 s)
    advance(200);
    expect((await host(h, 'POST', '/call-next')).statusCode).toBe(429);
  });

  it('skips, re-inserts, and undoes the last action', async () => {
    const h = await setup();
    for (const n of ['A One', 'B Two', 'C Three', 'D Four', 'E Five']) await addManual(h, n);
    advance(5000);
    let s: HostSnapshot = (await host(h, 'POST', '/call-next')).json();
    advance(30_000);
    s = (await host(h, 'POST', '/skip')).json();
    const a = s.parties.find((p) => p.ticket === 1)!;
    expect(a).toMatchObject({ state: 'skipped', skipCount: 1 });
    expect(s.parties.find((p) => p.ticket === 2)!.state).toBe('now_serving');

    s = (await host(h, 'POST', `/parties/${a.id}/reinsert`)).json();
    const order = s.parties
      .filter((p) => p.state === 'waiting' || p.state === 'up_next')
      .sort((x, y) => x.sortKey - y.sortKey)
      .map((p) => p.ticket);
    expect(order).toEqual([3, 4, 5, 1]);

    const undo = await host(h, 'POST', '/undo');
    expect(undo.json().undone).toBe('Back in line');
    s = undo.json();
    expect(s.parties.find((p) => p.ticket === 1)!.state).toBe('skipped');
    expect(s.undo?.label).toBe('Not here');
  });

  it('warns-but-allows duplicate phones and self-join returns the existing link', async () => {
    const h = await setup();
    const info = await h.app.inject({ method: 'GET', url: `/api/join/${h.code}` });
    expect(info.json()).toMatchObject({ eventName: 'Pumpkin Patch Portraits', open: true });
    const join = (payload: object) =>
      h.app.inject({ method: 'POST', url: `/api/join/${h.code}`, payload });
    const first = await join({
      name: 'Smith Family',
      phone: '555 309 4417',
      size: 4,
      consent: true,
    });
    expect(first.json().existing).toBe(false);
    const again = await join({ name: 'Smith', phone: '(555) 309-4417', size: 1, consent: true });
    expect(again.json()).toEqual({ token: first.json().token, existing: true });
    expect((await join({ name: 'Bot', website: 'http://spam' })).statusCode).toBe(400);
    expect((await join({ name: 'Bad Phone', phone: '555-12' })).json().error).toBe('invalid_phone');

    const s = await snap(h);
    expect(s.pendingTexts.map((t) => t.template)).toEqual(['up_next']);
    const qr = await h.app.inject({ method: 'GET', url: `/api/join/${h.code}/qr.svg` });
    expect(qr.headers['content-type']).toContain('image/svg+xml');

    await host(h, 'PATCH', '/settings', { selfJoin: false });
    expect((await join({ name: 'Late' })).statusCode).toBe(409);
  });

  it('rate-limits self-join to 10 per IP per 10 minutes', async () => {
    const h = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: `/api/join/${h.code}`,
        payload: { name: `Guest ${i}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('returns a generic 404 for unknown status tokens', async () => {
    const h = await setup();
    const r = await h.app.inject({ method: 'GET', url: '/api/status/AAAAAAAAAAAA' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });
});

describe('twilio mode', () => {
  const env = {
    TWILIO_ACCOUNT_SID: 'AC123',
    TWILIO_AUTH_TOKEN: 'secret-token',
    TWILIO_FROM: '+15550001111',
  };

  it('sends automatically, adds the STOP footer once, and honours opt-outs', async () => {
    const h = await setup(env, (to) =>
      to === '+15557770000' ? { code: 21610, message: 'unsubscribed' } : null,
    );
    await addManual(h, 'Emma Rivera', '555-201-8830');
    await h.ctx.service.pendingDispatch;
    advance(2000);
    await host(h, 'POST', '/call-next');
    await h.ctx.service.pendingDispatch;
    expect(h.sent.map((m) => m.body.endsWith(' Reply STOP to opt out.'))).toEqual([true, false]);
    expect(h.sent[0].body).toContain('https://q.example.com/s/');

    // Error 21610 marks the number opted out
    await addManual(h, 'Blocked Person', '555-777-0000');
    await h.ctx.service.pendingDispatch;
    let s = await snap(h);
    expect(s.parties.find((p) => p.name === 'Blocked Person')!.optedOut).toBe(true);

    // Inbound STOP with a valid signature
    const url = 'https://q.example.com/sms/twilio/inbound';
    const params = { From: '+15552018830', Body: ' stop ', To: '+15550001111' };
    const bad = await h.app.inject({
      method: 'POST',
      url: '/sms/twilio/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'nope',
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(bad.statusCode).toBe(403);
    const good = await h.app.inject({
      method: 'POST',
      url: '/sms/twilio/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature('secret-token', url, params),
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(good.statusCode).toBe(200);
    expect(good.body).toContain('<Response>');
    s = await snap(h);
    const emma = s.parties.find((p) => p.name === 'Emma Rivera')!;
    expect(emma).toMatchObject({ optedOut: true, canText: false });

    // START clears it
    const start = { ...params, Body: 'START' };
    await h.app.inject({
      method: 'POST',
      url: '/sms/twilio/inbound',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature('secret-token', url, start),
      },
      payload: new URLSearchParams(start).toString(),
    });
    expect((await snap(h)).parties.find((p) => p.id === emma.id)!.optedOut).toBe(false);
  });
});

describe('retention', () => {
  it('purges party data 7 days after close and keeps aggregates', async () => {
    const h = await setup();
    const id = await addManual(h, 'Emma Rivera', '555-201-8830');
    const token = (await snap(h)).parties.find((p) => p.id === id)!.token;
    await host(h, 'POST', '/close');
    // Closing signs out every device
    expect((await host(h, 'GET', '')).statusCode).toBe(401);
    const ended: GuestSnapshot = (
      await h.app.inject({ method: 'GET', url: `/api/status/${token}` })
    ).json();
    expect(ended.eventEnded).toBe(true);

    advance(6 * 86_400_000);
    runRetention(h.ctx.db, now(), { retentionDays: 7, autoCloseHours: 12, purge: true });
    expect(h.ctx.db.prepare('SELECT COUNT(*) n FROM parties').get()).toEqual({ n: 1 });
    advance(2 * 86_400_000);
    const r = runRetention(h.ctx.db, now(), { retentionDays: 7, autoCloseHours: 12, purge: true });
    expect(r.purged).toEqual([h.eventId]);
    expect(h.ctx.db.prepare('SELECT COUNT(*) n FROM parties').get()).toEqual({ n: 0 });
    expect((await h.app.inject({ method: 'GET', url: `/api/status/${token}` })).statusCode).toBe(
      404,
    );
  });

  it('auto-closes events 12 h after the last host action', async () => {
    const h = await setup();
    advance(13 * 3_600_000);
    const r = runRetention(h.ctx.db, now(), { retentionDays: 7, autoCloseHours: 12, purge: false });
    expect(r.autoClosed).toEqual([h.eventId]);
  });
});

describe('websocket', () => {
  it('pushes live updates to the guest page', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830');
    await addManual(h, 'Linh Nguyen', '555-309-4417');
    const guestToken = (await snap(h)).parties[1].token;
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = h.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws/status/${guestToken}`);
    const messages: GuestSnapshot[] = [];
    const waitFor = (pred: (m: GuestSnapshot) => boolean) =>
      new Promise<GuestSnapshot>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 3000);
        const check = () => {
          const m = messages.find(pred);
          if (m) {
            clearTimeout(t);
            resolve(m);
          }
        };
        ws.on('message', (raw) => {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'guest') messages.push(msg.data);
          check();
        });
      });
    const first = await waitFor(() => true);
    expect(first.nowServing).toBeNull();
    advance(2000);
    await host(h, 'POST', '/call-next');
    const live = await waitFor((m) => m.nowServing?.ticket === 1);
    expect(live.nowServing!.name).toBe('Emma R.');
    expect(live.me!.position).toBe(1);
    ws.close();
  });
});
