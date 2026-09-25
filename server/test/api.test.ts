import type { GuestSnapshot, HostSnapshot } from '@pby/shared';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('locks wrong PINs per (event, IP), so a stranger only locks themselves out (QA #14)', async () => {
    const h = await setup();
    const login = (ip: string, pin: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/host/login',
        headers: { 'x-forwarded-for': ip },
        payload: { code: h.code, pin }, // the join code printed in the public QR code
      });
    // A stranger guesses 20 PINs over 4 minutes (5 a minute is the per-IP rate limit).
    const stranger: number[] = [];
    for (let i = 0; i < 20; i++) {
      if (i && i % 5 === 0) advance(61_000);
      stranger.push((await login('203.0.113.66', '000000')).statusCode);
    }
    expect(stranger.every((c) => c === 401)).toBe(true);
    advance(61_000);
    const locked = await login('203.0.113.66', PIN);
    expect(locked.statusCode).toBe(423);
    expect(locked.json().error).toBe('event_locked');
    // The photographer's helper on another address still gets in.
    expect((await login('198.51.100.7', PIN)).statusCode).toBe(200);
    // Backstop: 200 wrong PINs an hour from any mix of addresses lock the event for everyone.
    const all = h.ctx.limits.pinEventAll;
    while (all.remaining(h.eventId, now()) > 1) all.hit(h.eventId, now());
    expect((await login('192.0.2.1', '000000')).statusCode).toBe(401);
    expect((await login('192.0.2.2', PIN)).statusCode).toBe(423);
    advance(15 * 60_000 + 1);
    expect((await login('192.0.2.2', PIN)).statusCode).toBe(200);
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
    // Tray order: Up next texts first, then Your turn. Emma's own "Up next" text is stale
    // now that she is being served, so it drops off the tray.
    expect(s.pendingTexts.map((t) => [t.template, t.to])).toEqual([
      ['up_next', '+15553094417'],
      ['your_turn', '+15552018830'],
    ]);
    expect(s.pendingTexts[1].body).toBe(
      "Pumpkin Patch Portra: Emma, it's your turn! Please come to the camera now.",
    );

    const g2: GuestSnapshot = (
      await h.app.inject({ method: 'GET', url: `/api/status/${nguyen.token}` })
    ).json();
    expect(g2.nowServing).toEqual({ ticket: 1, name: 'Emma R.', isMe: false });
    expect(g2.me!.position).toBe(1);

    // Okafor (no phone) checks in from the status page (G4)
    const arrive = await h.app.inject({
      method: 'POST',
      url: `/api/status/${okafor.token}/arrive`,
      payload: {},
    });
    expect(arrive.json().me).toMatchObject({ arrived: true, position: 2, hasPhone: false });

    // Mark a tray text sent
    s = (await host(h, 'POST', `/texts/${s.pendingTexts[0].id}`, { status: 'sent' })).json();
    expect(s.pendingTexts).toHaveLength(1);
    expect(s.parties.find((p) => p.id === nguyen.id)!.lastText).toMatchObject({
      template: 'up_next',
      status: 'sent',
    });

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

  it('limits self-join per (IP, event) to 60 per 10 minutes (QA #13)', async () => {
    const h = await setup();
    const other = await h.app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { adminPassword: ADMIN, name: 'Santa Photos', pin: PIN },
    });
    const join = (code: string, i: number) =>
      h.app.inject({
        method: 'POST',
        url: `/api/join/${code}`,
        headers: { 'x-forwarded-for': '198.51.100.20' }, // one venue Wi-Fi
        payload: { name: `Guest ${i}` },
      });
    // 60 families behind one shared address all get in; the 61st in 10 minutes is refused.
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await join(h.code, i)).statusCode);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes[60]).toBe(429);
    // The same address can still join a different event: the budget is per event.
    expect((await join(other.json().code, 0)).statusCode).toBe(200);
    // And the window slides: 10 minutes later the venue can join again.
    advance(10 * 60_000 + 1);
    expect((await join(h.code, 61)).statusCode).toBe(200);
  });

  it('reads SELF_JOIN_PER_IP from the environment', async () => {
    expect(loadConfig({}).selfJoinPerIp).toBe(60);
    expect(loadConfig({ SELF_JOIN_PER_IP: '5' }).selfJoinPerIp).toBe(5);
    const h = await setup({ SELF_JOIN_PER_IP: '2' });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: `/api/join/${h.code}`,
        payload: { name: `Guest ${i}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
  });

  it('never predicts a wait time: no estimate in guest, join, host or text payloads', async () => {
    // Owner decision: wait times vary too much, so the app shows positions only.
    const h = await setup();
    for (const n of ['Garcia Family', 'Nguyen Family', 'Smith Family', 'Okafor']) {
      await addManual(h, n, '555-201-8830');
    }
    advance(5000);
    await host(h, 'POST', '/call-next');
    const s = await snap(h);
    const guest = await h.app.inject({ method: 'GET', url: `/api/status/${s.parties[3].token}` });
    const join = await h.app.inject({ method: 'GET', url: `/api/join/${h.code}` });
    expect(guest.json().me).toMatchObject({ position: 3 });
    for (const body of [guest.body, join.body, JSON.stringify(s)]) {
      expect(body).not.toMatch(/wait(Text|Minutes)|avgMinutes|minutesPerParty|\bmin\b|minute/i);
    }
    const joinText = s.pendingTexts.find((t) => t.template === 'join')!;
    expect(joinText.body).toMatch(/you're #\d+ in line\. Track live: https:/);
    expect(joinText.body).not.toMatch(/min|~/);
  });

  it('limits join-code guessing with the same per-IP miss limit as status tokens (QA #16)', async () => {
    const h = await setup();
    const get = (path: string, ip = '203.0.113.9') =>
      h.app.inject({ method: 'GET', url: path, headers: { 'x-forwarded-for': ip } });
    expect((await get(`/api/join/${h.code}`)).statusCode).toBe(200);
    // 30 wrong join codes plus 30 wrong status tokens share one budget of 60 misses a minute.
    const misses: number[] = [];
    for (let i = 0; i < 30; i++) misses.push((await get(`/api/join/ZZZZ${10 + i}`)).statusCode);
    for (let i = 0; i < 30; i++)
      misses.push((await get(`/api/status/AAAAAAAAA${100 + i}`)).statusCode);
    expect(misses.every((c) => c === 404)).toBe(true);
    // Now that address is cut off, even for a real code, while other addresses are fine.
    expect((await get('/api/join/ZZZZZZ')).statusCode).toBe(429);
    expect((await get(`/api/join/${h.code}`)).statusCode).toBe(429);
    expect((await get(`/api/join/${h.code}`, '198.51.100.3')).statusCode).toBe(200);
    advance(60_001);
    expect((await get(`/api/join/${h.code}`)).statusCode).toBe(200);
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
    advance(5000);
    await host(h, 'POST', '/call-next');
    advance(120_000);
    await host(h, 'POST', '/complete');
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
    // Aggregates survive: 1 served, and the photo took 2 min (a record, not an estimate).
    expect(
      h.ctx.db
        .prepare('SELECT served_count, avg_service_ms FROM events WHERE id = ?')
        .get(h.eventId),
    ).toEqual({ served_count: 1, avg_service_ms: 120_000 });
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

describe('QA regressions', () => {
  it('rate-limits by the client IP a proxy appends, not a spoofed X-Forwarded-For', async () => {
    const h = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      // The attacker sends their own X-Forwarded-For; the proxy (Cloudflare, Fly) appends the
      // real client address, so only the last entry is trustworthy.
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/host/login',
        headers: { 'x-forwarded-for': `10.9.8.${i}, 203.0.113.7` },
        payload: { eventId: h.eventId, pin: '000000' },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    // The same applies to the admin password (it guards event creation and Twilio spend).
    const admin: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { 'x-forwarded-for': `10.9.7.${i}, 203.0.113.8` },
        payload: { adminPassword: `guess-${i}`, name: 'X', pin: PIN },
      });
      admin.push(r.statusCode);
    }
    expect(admin.at(-1)).toBe(429);
  });

  it('parses TRUST_PROXY as a hop count, IP list or off', () => {
    expect(loadConfig({}).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '172.16.0.0/12' }).trustProxy).toBe('172.16.0.0/12');
  });

  it('drops a host WebSocket as soon as its device is signed out', async () => {
    const h = await setup();
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { eventId: h.eventId, pin: PIN },
    });
    const helperCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host/${h.eventId}`, {
      headers: { cookie: helperCookie },
    });
    const phones: (string | null)[] = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'host')
        phones.push(...(msg.data as HostSnapshot).parties.map((p) => p.phone));
    });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((resolve) => ws.on('open', resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The main host signs the helper out, then adds a party with a phone number.
    expect((await host(h, 'POST', '/signout-others')).json()).toEqual({ removed: 1 });
    await addManual(h, 'Secret Family', '555-201-8830');
    expect(await closed).toBe(4401);
    expect(phones).not.toContain('+15552018830');
  });

  it('refuses a cross-site host WebSocket even with a valid session cookie', async () => {
    const h = await setup();
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = h.app.server.address() as { port: number };
    const cookie = Object.entries(h.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    const open = (origin: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host/${h.eventId}`, {
          headers: { cookie, origin },
        });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
      });
    expect(await open('https://evil.example')).toBe(403);
    expect(await open(`http://127.0.0.1:${port}`)).toBe('open');
  });

  it("never puts a full last name or phone in a guest payload, even the guest's own", async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera-Castillo', '555-201-8830');
    // Anyone with the public QR code can self-join with a phone number they know; the
    // duplicate rule hands back that party's status link, so it must not reveal the full name.
    const dup = await h.app.inject({
      method: 'POST',
      url: `/api/join/${h.code}`,
      payload: { name: 'Nosy', phone: '(555) 201-8830', consent: true },
    });
    expect(dup.json().existing).toBe(true);
    const status = await h.app.inject({ method: 'GET', url: `/api/status/${dup.json().token}` });
    const body = status.body;
    expect(status.json().me.name).toBe('Emma R.');
    expect(body).not.toContain('Castillo');
    expect(body).not.toContain('Rivera');
    expect(body).not.toMatch(/201.?8830/);
  });

  it('drops queued texts for a party the host marks No texts', async () => {
    const h = await setup();
    const id = await addManual(h, 'Emma Rivera', '555-201-8830');
    expect((await snap(h)).pendingTexts.map((t) => t.partyId)).toEqual([id]);
    // The guest replied STOP to the host's phone (tap-to-send), so the host turns texts off.
    await host(h, 'PATCH', `/parties/${id}`, { noTexts: true });
    expect((await snap(h)).pendingTexts).toEqual([]);
  });

  it('does not send a queued Twilio text to a party marked No texts', async () => {
    const h = await setup({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret-token',
      TWILIO_FROM: '+15550001111',
    });
    const id = await addManual(h, 'Emma Rivera', '555-201-8830', { sendJoinText: false });
    // Queue a text, then turn texts off before the dispatcher gets to it.
    const svc = h.ctx.service;
    await svc.pendingDispatch;
    const sentBefore = h.sent.length; // the Up next text for joining an empty line
    const smsId = h.ctx.service.store.insertSms({
      eventId: h.eventId,
      partyId: id,
      template: 'join',
      provider: 'twilio',
      status: 'sending',
      footer: false,
      createdAt: now(),
    });
    await host(h, 'PATCH', `/parties/${id}`, { noTexts: true });
    await (svc as unknown as { sendTwilio(id: number): Promise<void> }).sendTwilio(smsId);
    expect(h.sent.length).toBe(sentBefore);
    expect(svc.store.getSms(smsId)!.status).toBe('skipped');
  });

  it('does not accept the .env.example placeholder as the admin password', async () => {
    const placeholder = 'change-me-to-something-long';
    const cfg = loadConfig({
      DATABASE_PATH: ':memory:',
      ADMIN_PASSWORD: placeholder,
      LOG_LEVEL: 'silent',
    });
    expect(cfg.adminPassword).toBeNull();
    cfg.webDist = null;
    const { app } = await buildApp(cfg, { now, timers: false });
    apps.push(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: { adminPassword: placeholder, name: 'X', pin: PIN },
    });
    expect(res.json().error).toBe('admin_not_configured');
  });

  it('marks Twilio texts interrupted by a restart as failed so the host can resend', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pby-qa-'));
    const env = {
      DATABASE_PATH: join(dir, 'q.db'),
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret-token',
      TWILIO_FROM: '+15550001111',
    };
    const h = await setup(env);
    const id = await addManual(h, 'Emma Rivera', '555-201-8830', { sendJoinText: false });
    await h.ctx.service.pendingDispatch;
    // The process dies after queueing a text but before Twilio answered.
    const smsId = h.ctx.service.store.insertSms({
      eventId: h.eventId,
      partyId: id,
      template: 'join',
      provider: 'twilio',
      status: 'sending',
      footer: false,
      createdAt: now(),
    });
    await h.app.close();
    apps.splice(apps.indexOf(h.app), 1);

    const cfg = loadConfig({ ...env, ADMIN_PASSWORD: ADMIN, LOG_LEVEL: 'silent' });
    cfg.webDist = null;
    const { app, ctx } = await buildApp(cfg, { now, timers: false });
    apps.push(app);
    expect(ctx.service.store.getSms(smsId)!.status).toBe('failed');
    const s: HostSnapshot = (
      await app.inject({ method: 'GET', url: `/api/host/events/${h.eventId}`, cookies: h.cookies })
    ).json();
    expect(s.parties.find((p) => p.id === id)!.lastText).toMatchObject({ status: 'failed' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers 400, not 500, to malformed import rows', async () => {
    const h = await setup();
    for (const rows of [[null], ['Garcia'], [42], [[]]]) {
      const res = await host(h, 'POST', '/import', { rows });
      expect(res.statusCode, JSON.stringify(rows)).toBe(400);
    }
  });

  it('lets many guests behind one venue IP load their pages, but stops token guessing', async () => {
    const h = await setup();
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `Family ${i}` }));
    await host(h, 'POST', '/import', { rows });
    const tokens = (await snap(h)).parties.map((p) => p.token);
    // 40 families on the same Wi-Fi open their links in the same minute: page load + refresh.
    const codes = new Set<number>();
    for (const token of [...tokens, ...tokens]) {
      codes.add((await h.app.inject({ method: 'GET', url: `/api/status/${token}` })).statusCode);
    }
    expect([...codes]).toEqual([200]);
    // Guessing tokens from that IP is still cut off after 60 misses a minute.
    const guesses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await h.app.inject({ method: 'GET', url: `/api/status/AAAAAAAAA${100 + i}` });
      guesses.push(res.statusCode);
    }
    expect(guesses.at(-1)).toBe(429);
    // A single page is still limited to 60 requests a minute.
    const one: number[] = [];
    for (let i = 0; i < 61; i++) {
      one.push((await h.app.inject({ method: 'GET', url: `/api/status/${tokens[0]}` })).statusCode);
    }
    expect(one.at(-1)).toBe(429);
  });
});

describe('robustness', () => {
  it('calls exactly one party when two helper devices press Call next together', async () => {
    const h = await setup();
    await addManual(h, 'Garcia Family');
    await addManual(h, 'Nguyen Family');
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { eventId: h.eventId, pin: PIN },
    });
    const helper = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
    advance(5000);
    const [a, b] = await Promise.all([
      host(h, 'POST', '/call-next'),
      h.app.inject({
        method: 'POST',
        url: `/api/host/events/${h.eventId}/call-next`,
        cookies: helper,
        payload: {},
      }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 429]);
    const s = await snap(h);
    expect(s.parties.filter((p) => p.state === 'now_serving').map((p) => p.ticket)).toEqual([1]);
    expect(s.parties.filter((p) => p.state === 'done')).toHaveLength(0);
  });

  it('survives a server restart mid-event: sessions, queue, undo and guest links', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pby-qa-'));
    const env = { DATABASE_PATH: join(dir, 'q.db') };
    const h = await setup(env);
    await addManual(h, 'Garcia Family', '555-201-8830');
    await addManual(h, 'Nguyen Family', '555-309-4417');
    advance(5000);
    await host(h, 'POST', '/call-next');
    const before = await snap(h);
    const guest = before.parties[1].token;
    await h.app.close();
    apps.splice(apps.indexOf(h.app), 1);

    const cfg = loadConfig({ ...env, ADMIN_PASSWORD: ADMIN, LOG_LEVEL: 'silent' });
    cfg.webDist = null;
    const { app } = await buildApp(cfg, { now, timers: false });
    apps.push(app);
    const h2 = { ...h, app };
    const after = await snap(h2);
    expect(after.parties.map((p) => [p.ticket, p.state])).toEqual(
      before.parties.map((p) => [p.ticket, p.state]),
    );
    expect(after.pendingTexts.length).toBe(before.pendingTexts.length);
    const status = await app.inject({ method: 'GET', url: `/api/status/${guest}` });
    expect(status.json().me.position).toBe(1);
    // Undo still works after the restart, and the debounce survives too.
    expect((await host(h2, 'POST', '/undo')).json().undone).toBe('Call next');
    rmSync(dir, { recursive: true, force: true });
  });

  it('handles a 300-party line from import to empty', async () => {
    const h = await setup();
    const rows = Array.from({ length: 300 }, (_, i) => ({
      name: `Family ${i + 1}`,
      phone: `555${String(2000000 + i).padStart(7, '0')}`,
      size: 1 + (i % 6),
    }));
    const started = performance.now();
    const res = await host(h, 'POST', '/import', { rows, arrived: true, consentConfirmed: true });
    expect(res.json().added).toBe(300);
    const last = (await snap(h)).parties.at(-1)!;
    const status = (await h.app.inject({ method: 'GET', url: `/api/status/${last.token}` })).json();
    expect(status.me).toMatchObject({ ticket: 300, position: 300 });
    expect(JSON.stringify(status)).not.toContain('555');
    for (let i = 0; i < 300; i++) {
      advance(60_000);
      expect((await host(h, 'POST', '/call-next')).statusCode).toBe(200);
    }
    const s = await snap(h);
    expect(s.parties.filter((p) => p.state === 'done')).toHaveLength(299);
    advance(60_000);
    expect((await host(h, 'POST', '/call-next')).json().error).toBe('queue_empty');
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it('bounds party size and handles duplicate, foreign and garbage phones', async () => {
    const h = await setup({
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret-token',
      TWILIO_FROM: '+15550001111',
    });
    for (const size of [0, -1, 21, 1e9, 2.5, 'lots']) {
      const res = await host(h, 'POST', '/parties', { name: 'X', size });
      expect(res.json().error, String(size)).toBe('bad_size');
    }
    const join = (payload: object) =>
      h.app.inject({ method: 'POST', url: `/api/join/${h.code}`, payload });
    // Self-join clamps the size stepper's value instead of failing.
    const big = await join({ name: 'Big Group', size: 500 });
    const bigSnap = await h.app.inject({ method: 'GET', url: `/api/status/${big.json().token}` });
    expect(bigSnap.json().me.size).toBe(20);
    // Twilio only texts US numbers (§2.9), so a foreign number can't self-join for texts.
    expect(
      (await join({ name: 'Anna', phone: '+44 7911 123456', consent: true })).json().error,
    ).toBe('us_only');
    expect((await join({ name: 'Anna', phone: 'call me', consent: true })).json().error).toBe(
      'invalid_phone',
    );
    // The host can still add them; they are kept but never texted.
    const foreign = await addManual(h, 'Anna Schmidt', '+44 7911 123456');
    const garbage = await addManual(h, 'Bob Jones', 'ask at desk');
    const dupA = await addManual(h, 'Kid One', '555-201-8830');
    const dupB = await addManual(h, 'Kid Two', '(555) 201-8830');
    const s = await snap(h);
    const by = (id: string) => s.parties.find((p) => p.id === id)!;
    expect(by(foreign)).toMatchObject({ phone: '+447911123456', canText: false });
    expect(by(garbage)).toMatchObject({ phone: null, phoneInvalidInput: 'ask at desk' });
    expect([by(dupA).phone, by(dupB).phone]).toEqual(['+15552018830', '+15552018830']);
  });

  it('validates Twilio signatures and sets Secure cookies behind a tunnel with no PUBLIC_URL', async () => {
    const h = await setup({
      PUBLIC_URL: '',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret-token',
      TWILIO_FROM: '+15550001111',
    });
    // cloudflared talks plain HTTP to the app and forwards the public host and scheme.
    const proxied = { host: 'q.example.com', 'x-forwarded-proto': 'https' };
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      headers: proxied,
      payload: { eventId: h.eventId, pin: PIN },
    });
    expect(login.cookies[0]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });

    const params = { From: '+15552018830', Body: 'STOP', To: '+15550001111' };
    const post = (signedUrl: string) =>
      h.app.inject({
        method: 'POST',
        url: '/sms/twilio/inbound?x=1',
        headers: {
          ...proxied,
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': twilioSignature('secret-token', signedUrl, params),
        },
        payload: new URLSearchParams(params).toString(),
      });
    expect((await post('https://q.example.com/sms/twilio/inbound?x=1')).statusCode).toBe(200);
    expect((await post('http://q.example.com/sms/twilio/inbound?x=1')).statusCode).toBe(403);
    expect((await post('https://evil.example/sms/twilio/inbound?x=1')).statusCode).toBe(403);
  });
});
