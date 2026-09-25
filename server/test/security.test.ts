/**
 * Security regressions from docs/SECURITY_REVIEW.md. Each test demonstrates one finding (SEC-n)
 * and fails on the code before its fix.
 */
import type { HostSnapshot } from '@pby/shared';
import type { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { clientKey, RateLimiter } from '../src/security.js';

const ADMIN = 'admin-secret';
const PIN = '246810';

const clock = Date.UTC(2026, 9, 1, 15, 0, 0);
const now = () => clock;

interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  cookies: Record<string, string>;
  eventId: string;
  code: string;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const cfg = loadConfig({
    DATABASE_PATH: ':memory:',
    ADMIN_PASSWORD: ADMIN,
    PUBLIC_URL: 'https://q.example.com',
    LOG_LEVEL: 'silent',
    WEB_DIST: '',
    ...env,
  });
  cfg.webDist = null;
  const { app, ctx } = await buildApp(cfg, { now, timers: false });
  apps.push(app);
  const res = await app.inject({
    method: 'POST',
    url: '/api/events',
    payload: { adminPassword: ADMIN, name: 'Pumpkin Patch Portraits', pin: PIN },
  });
  expect(res.statusCode).toBe(200);
  const { id, code } = res.json();
  const cookies: Record<string, string> = {};
  for (const c of res.cookies) cookies[c.name] = c.value;
  return { app, ctx, cookies, eventId: id, code };
}

async function host(h: Harness, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) {
  return h.app.inject({
    method,
    url: `/api/host/events/${h.eventId}${path}`,
    cookies: h.cookies,
    payload: method === 'GET' ? undefined : (payload ?? {}),
  });
}

async function snap(h: Harness): Promise<HostSnapshot> {
  return (await host(h, 'GET', '')).json();
}

async function addManual(h: Harness, name: string, phone = '') {
  const res = await host(h, 'POST', '/parties', { name, phone, size: 1, consentConfirmed: true });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().partyId as string;
}

describe('SEC-1 CSRF: JSON-only rule and Origin check', () => {
  it('refuses a no-preflight text/plain body that merely mentions application/json', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830');
    // `text/plain; application/json` is a CORS-safelisted type (its essence is text/plain), so
    // a same-site page could send it with the host's SameSite=Lax cookie and no preflight.
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/host/events/${h.eventId}/delete`,
      cookies: h.cookies,
      headers: { 'content-type': 'text/plain; application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
    expect((await snap(h)).parties).toHaveLength(1);
  });

  it('refuses state-changing requests from another origin', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830');
    const cross = await h.app.inject({
      method: 'POST',
      url: `/api/host/events/${h.eventId}/delete`,
      cookies: h.cookies,
      headers: { origin: 'https://other.example.com', host: 'q.example.com' },
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
    const fetchSite = await h.app.inject({
      method: 'POST',
      url: `/api/host/events/${h.eventId}/call-next`,
      cookies: h.cookies,
      headers: { 'sec-fetch-site': 'same-site' },
      payload: {},
    });
    expect(fetchSite.statusCode).toBe(403);
    expect((await snap(h)).parties).toHaveLength(1);
    // The app's own pages still work.
    const same = await h.app.inject({
      method: 'POST',
      url: `/api/host/events/${h.eventId}/call-next`,
      cookies: h.cookies,
      headers: {
        origin: 'https://q.example.com',
        host: 'q.example.com',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json; charset=utf-8',
      },
      payload: '{}',
    });
    expect(same.statusCode).toBe(200);
  });
});

describe('SEC-2 security headers', () => {
  it('sends a strict CSP, anti-framing, HSTS on HTTPS and no-store on API responses', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830');
    const token = (await snap(h)).parties[0].token;
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/status/${token}`,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['permissions-policy'])).toContain('camera=()');
    expect(String(res.headers['strict-transport-security'])).toMatch(/max-age=\d{7,}/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');

    const hostRes = await host(h, 'GET', '');
    expect(hostRes.headers['cache-control']).toBe('no-store');
    // No HSTS over plain HTTP (LAN testing): browsers ignore it there anyway.
    expect(hostRes.headers['strict-transport-security']).toBeUndefined();
    expect(hostRes.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('SEC-3 purge really deletes', () => {
  it('leaves no guest names or phone numbers in the database file or its WAL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pby-sec-'));
    try {
      const h = await setup({ DATABASE_PATH: join(dir, 'q.db') });
      for (let i = 0; i < 20; i++) await addManual(h, `Zyxquor Family${i}`, `555-201-88${10 + i}`);
      await host(h, 'PATCH', `/parties/${(await snap(h)).parties[0].id}`, {
        notes: 'Qwertnotes secret',
      });
      expect((await host(h, 'POST', '/delete')).statusCode).toBe(200);
      const bytes = ['q.db', 'q.db-wal']
        .map((f) => join(dir, f))
        .filter(existsSync)
        .map((f) => readFileSync(f).toString('latin1'))
        .join('');
      expect(bytes).not.toContain('Zyxquor');
      expect(bytes).not.toContain('Qwertnotes');
      expect(bytes).not.toContain('+155520188');
    } finally {
      while (apps.length) await apps.pop()!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SEC-4 join codes cannot be enumerated through other endpoints', () => {
  const randomCode = (i: number) => `Z${String(i).padStart(5, '0')}`;

  it('counts unknown codes on POST /api/join/:code as misses and keeps no state for them', async () => {
    const h = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 70; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: `/api/join/${randomCode(i)}`,
        payload: { name: 'Probe', phone: '' },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 60).every((c) => c === 404)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    // Attacker-chosen codes must not become rate-limiter keys (unbounded memory).
    expect(h.ctx.limits.join['hits'].size).toBe(0);
    // Real guests on the real code are unaffected from another address.
    const ok = await h.app.inject({
      method: 'POST',
      url: `/api/join/${h.code}`,
      headers: { 'x-forwarded-for': '198.51.100.9' },
      payload: { name: 'Real Guest', phone: '' },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('counts unknown codes on the QR endpoint as misses', async () => {
    const h = await setup();
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await h.app.inject({ method: 'GET', url: `/api/join/${randomCode(i)}/qr.svg` }))
        .statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('SEC-5 per-IP limits survive address rotation', () => {
  it('keys IPv6 clients by /64 and IPv4 clients by address', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
  });

  it('treats every address in one IPv6 /64 as one client', async () => {
    const h = await setup();
    const codes: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/api/host/login',
        headers: { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` },
        payload: { eventId: h.eventId, pin: '000000' },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    // Another /64 is another client.
    const other = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      headers: { 'x-forwarded-for': '2001:db8:1:3::1' },
      payload: { eventId: h.eventId, pin: PIN },
    });
    expect(other.statusCode).toBe(200);
  });

  it('locks event creation after many wrong admin passwords from any mix of addresses', async () => {
    const h = await setup();
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = (
        await h.app.inject({
          method: 'POST',
          url: '/api/events',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
          payload: { adminPassword: `guess-${i}`, name: 'X', pin: PIN },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
    // While locked, even the right password is refused, so guesses learn nothing.
    const right = await h.app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'x-forwarded-for': '198.51.100.77' },
      payload: { adminPassword: ADMIN, name: 'X', pin: PIN },
    });
    expect(right.statusCode).toBe(429);
  });
});

describe('SEC-6 rate-limiter memory is bounded', () => {
  it('caps the number of tracked keys, dropping expired ones first', () => {
    const limiter = new RateLimiter(5, 60_000, 60_000, 100);
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) limiter.hit('attacker', t);
    expect(limiter.retryAfter('attacker', t)).toBeGreaterThan(0);
    for (let i = 0; i < 10_000; i++) limiter.hit(`k${i}`, t + 1 + i);
    expect(limiter['hits'].size).toBeLessThanOrEqual(100);
    expect(limiter['blockedUntil'].size).toBeLessThanOrEqual(100);
    // Evicting counters never lifts an active block.
    expect(limiter.retryAfter('attacker', t + 10_001)).toBeGreaterThan(0);
    // Keys past their window are dropped without waiting for the 15-minute sweep.
    const later = t + 200_000;
    limiter.hit('fresh', later);
    expect(limiter['hits'].size).toBeLessThanOrEqual(100);
  });

  it('gives every app limiter a key cap', async () => {
    const h = await setup();
    for (const l of Object.values(h.ctx.limits)) expect(l['maxKeys']).toBeLessThanOrEqual(100_000);
  });
});

describe('SEC-7 WebSocket connection limits', () => {
  class FakeSocket extends EventEmitter {
    readonly OPEN = 1;
    readyState = 1;
    closedWith: number | null = null;
    send() {}
    close(code: number) {
      if (this.closedWith !== null) return;
      this.closedWith = code;
      this.readyState = 3;
      this.emit('close', code);
    }
  }
  const sock = () => new FakeSocket() as unknown as WebSocket & FakeSocket;

  it('keeps at most a few sockets per status link, closing the oldest', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830');
    const party = (await snap(h)).parties[0];
    const sockets = Array.from({ length: 30 }, () => sock());
    for (const ws of sockets) h.ctx.hub.addGuest(h.eventId, party.id, ws, '203.0.113.5');
    const open = sockets.filter((s) => s.closedWith === null);
    expect(open.length).toBeLessThanOrEqual(10);
    expect(open).toContain(sockets.at(-1));
  });

  it('keeps at most a few sockets per host session', async () => {
    const h = await setup();
    const token = Object.values(h.cookies)[0];
    const sockets = Array.from({ length: 20 }, () => sock());
    for (const ws of sockets) h.ctx.hub.addHost(h.eventId, ws, token, '203.0.113.5');
    expect(sockets.filter((s) => s.closedWith === null).length).toBeLessThanOrEqual(5);
  });

  it('caps concurrent sockets per client address', async () => {
    const h = await setup();
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) tokens.push(await addManual(h, `Family ${i}`));
    const sockets: FakeSocket[] = [];
    for (let i = 0; i < 1100; i++) {
      const ws = sock();
      sockets.push(ws);
      // Spread over parties so the per-link cap doesn't hide the per-address one.
      h.ctx.hub.addGuest(h.eventId, `${tokens[i % 3]}`, ws, '203.0.113.5');
    }
    expect(sockets.filter((s) => s.closedWith === null).length).toBeLessThanOrEqual(30);
    const many: FakeSocket[] = [];
    for (let p = 0; p < 1100; p++) {
      const ws = sock();
      many.push(ws);
      h.ctx.hub.addGuest(h.eventId, `party-${p}`, ws, '203.0.113.6');
    }
    const refused = many.filter((s) => s.closedWith === 4429).length;
    expect(refused).toBeGreaterThan(0);
    expect(many.length - refused).toBeLessThanOrEqual(1000);
    // Another address is unaffected.
    const other = sock();
    h.ctx.hub.addGuest(h.eventId, tokens[0], other, '198.51.100.1');
    expect(other.closedWith).toBeNull();
  });
});

describe('SEC-8 names cannot carry bidi overrides or invisible characters', () => {
  // U+202E flips the rest of the line, U+2066 isolates, U+200B/U+2060 are invisible, U+0007 is
  // a control character and U+3164 renders as a blank "name".
  const HOSTILE = 'Emma\u202E seviR\u2066\u200B\u2060\u0007\u3164';

  it('strips them from self-joined, host-added and event names', async () => {
    const h = await setup();
    const join = await h.app.inject({
      method: 'POST',
      url: `/api/join/${h.code}`,
      payload: { name: HOSTILE, phone: '' },
    });
    expect(join.statusCode, join.body).toBe(200);
    await addManual(h, `Linh\u202ENguyen`);
    const blank = await host(h, 'POST', '/parties', { name: '\u3164\u200B', phone: '' });
    expect(blank.statusCode).toBe(400);
    await host(h, 'PATCH', '/settings', { name: 'Fall\u202E Photos\u0000' });
    const s = await snap(h);
    const bad =
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      /[\u0000-\u001f\u007f-\u009f\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\u3164]/;
    expect(s.parties.map((p) => p.name)).toEqual(['Emma seviR', 'LinhNguyen']);
    expect(s.event.name).toBe('Fall Photos');
    const status = await h.app.inject({ method: 'GET', url: `/api/status/${join.json().token}` });
    expect(status.body).not.toMatch(bad);
  });

  it('keeps emoji sequences and accented names', async () => {
    const h = await setup();
    await addManual(h, 'Zoë 👨\u200D👩\u200D👧 Ñúñez');
    expect((await snap(h)).parties[0].name).toBe('Zoë 👨\u200D👩\u200D👧 Ñúñez');
  });
});
