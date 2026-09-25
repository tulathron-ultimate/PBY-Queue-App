/**
 * Security regressions from docs/SECURITY_REVIEW.md. Each test demonstrates one finding (SEC-n)
 * and fails on the code before its fix.
 */
import type { HostSnapshot } from '@pby/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';

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
