/**
 * Second-pass security regressions for the v1.1 features (lobby display, pause, results CSV).
 * See "Second pass: v1.1 features" in docs/SECURITY_REVIEW.md. Tests named SEC-n failed on the
 * code before that fix; the others confirm that the earlier protections cover the new routes.
 */
import type { HostSnapshot, LobbySnapshot } from '@pby/shared';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { WS_LIMITS } from '../src/hub.js';
import {
  addManual,
  advance,
  closeApps,
  fiveParties,
  host,
  setup,
  snap,
  TWILIO_ENV,
  type Harness,
} from './harness.js';

afterEach(closeApps);

async function makeLink(h: Harness, payload: object = {}): Promise<string> {
  const res = await host(h, 'POST', '/lobby', payload);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as HostSnapshot).event.lobbyUrl!.split('/d/')[1];
}

const lobby = (h: Harness, token: string, ip = '203.0.113.9') =>
  h.app.inject({ method: 'GET', url: `/api/lobby/${token}`, remoteAddress: ip });

async function openLobbySocket(h: Harness, token: string) {
  if (!h.app.server.listening) await h.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = h.app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/lobby/${token}`);
  let closedWith: number | null = null;
  const closed = new Promise<number>((resolve) =>
    ws.on('close', (code) => {
      closedWith = code;
      resolve(code);
    }),
  );
  const first = new Promise<LobbySnapshot>((resolve) =>
    ws.once('message', (raw) => resolve(JSON.parse(String(raw)).data)),
  );
  return { ws, closed, first, closedWith: () => closedWith };
}

const settle = () => new Promise((r) => setTimeout(r, 100));

describe('v1.1 routes keep the SEC-1/2/9 protections', () => {
  const routes = ['/pause', '/resume', '/lobby', '/lobby/revoke'];

  it('refuses non-JSON and cross-origin writes to pause, resume and the lobby link', async () => {
    const h = await setup();
    for (const path of routes) {
      const url = `/api/host/events/${h.eventId}${path}`;
      const plain = await h.app.inject({
        method: 'POST',
        url,
        cookies: h.cookies,
        headers: { 'content-type': 'text/plain; application/json' },
        payload: '{}',
      });
      expect(plain.statusCode, path).toBe(415);
      const sibling = await h.app.inject({
        method: 'POST',
        url,
        cookies: h.cookies,
        headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'same-site' },
        payload: {},
      });
      expect(sibling.statusCode, path).toBe(403);
    }
    const s = await snap(h);
    expect(s.event.paused).toBe(false);
    expect(s.event.lobbyUrl).toBeNull();
  });

  it('keeps the 64 KB body limit on the new routes', async () => {
    const h = await setup();
    const res = await host(h, 'POST', '/pause', { message: 'x'.repeat(70 * 1024) });
    expect(res.statusCode).toBe(413);
    expect((await snap(h)).event.paused).toBe(false);
  });

  it('sends CSP, anti-framing and no-store on the export and the lobby API', async () => {
    const h = await setup();
    const token = await makeLink(h);
    const csv = await host(h, 'GET', '/export.csv');
    const lob = await lobby(h, token);
    for (const res of [csv, lob]) {
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('builds the export file name from a slug only (quotes, newlines, unicode)', async () => {
    const name = 'Ev"il\r\nSet-Cookie: a=b ✨ Ünï';
    const h = await setup({}, { name, date: '2026-10-01' });
    const res = await host(h, 'GET', '/export.csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="[a-z0-9-]+-2026-10-01-results\.csv"$/,
    );
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('pause and lobby routes are host-only; guests cannot change the pause state', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830');
    const token = (await snap(h)).parties[0].token;
    for (const url of [
      `/api/status/${token}/pause`,
      `/api/lobby/${'A'.repeat(24)}/pause`,
      `/api/host/events/${h.eventId}/pause`,
    ]) {
      const res = await h.app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(401);
    }
    expect((await snap(h)).event.paused).toBe(false);
  });
});

describe('SEC-17 lobby display sockets have per-link and per-address caps', () => {
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

  it('keeps at most a few sockets per lobby link, closing the oldest', async () => {
    const h = await setup();
    const token = await makeLink(h);
    const sockets = Array.from({ length: 30 }, () => sock());
    for (const ws of sockets) h.ctx.hub.addLobby(h.eventId, ws, token, '203.0.113.5');
    const open = sockets.filter((s) => s.closedWith === null);
    expect(open.length).toBeLessThanOrEqual(WS_LIMITS.perLobby);
    expect(open).toContain(sockets.at(-1));
    expect(sockets[0].closedWith).toBe(4408);
  });

  it('counts lobby sockets toward the per-address cap', async () => {
    const h = await setup();
    const token = await makeLink(h);
    for (let i = 0; i < WS_LIMITS.perIp; i++) {
      h.ctx.hub.addGuest(h.eventId, `party-${i}`, sock(), '203.0.113.6');
    }
    const ws = sock();
    h.ctx.hub.addLobby(h.eventId, ws, token, '203.0.113.6');
    expect(ws.closedWith).toBe(4429);
  });

  it('applies over the real /ws/lobby route, and Hub.close() closes lobby sockets', async () => {
    const h = await setup();
    const token = await makeLink(h);
    const socks = [];
    for (let i = 0; i < WS_LIMITS.perLobby + 2; i++) {
      const s = await openLobbySocket(h, token);
      await s.first;
      socks.push(s);
    }
    expect(await socks[0].closed).toBe(4408);
    expect(await socks[1].closed).toBe(4408);
    const last = socks.at(-1)!;
    expect(last.closedWith()).toBeNull();
    h.ctx.hub.close();
    expect(await last.closed).toBe(1001);
  });
});

describe('SEC-18 lobby token misses are keyed by IPv6 /64', () => {
  it('rotating addresses inside one /64 shares one miss budget', async () => {
    const h = await setup();
    const token = await makeLink(h);
    for (let i = 0; i < 60; i++) {
      await lobby(h, `x${i}`.padEnd(24, 'y'), `2001:db8:1:2::${(i + 1).toString(16)}`);
    }
    // Another address in the same /64 is locked out too, on lobby links and status links.
    expect((await lobby(h, token, '2001:db8:1:2::ffff')).statusCode).toBe(429);
    const status = await h.app.inject({
      method: 'GET',
      url: `/api/status/${'s'.repeat(12)}`,
      remoteAddress: '2001:db8:1:2::abcd',
    });
    expect(status.statusCode).toBe(429);
    expect((await lobby(h, token, '2001:db8:1:3::1')).statusCode).toBe(200);
  });
});

describe('SEC-19 "we\'re paused" texts go at most once per party per hour', () => {
  it('toggling pause and resume does not re-text everyone in Twilio mode', async () => {
    const h = await setup(TWILIO_ENV);
    await fiveParties(h);
    await h.ctx.service.pendingDispatch;
    h.sent.length = 0;
    await host(h, 'POST', '/pause', { notify: true });
    await h.ctx.service.pendingDispatch;
    const first = h.sent.length;
    expect(first).toBe(5);
    for (let i = 0; i < 5; i++) {
      advance(2000);
      expect((await host(h, 'POST', '/resume')).statusCode).toBe(200);
      advance(2000);
      expect((await host(h, 'POST', '/pause', { notify: true })).statusCode).toBe(200);
      await h.ctx.service.pendingDispatch;
    }
    expect(h.sent).toHaveLength(first);
    // A real second break more than an hour later texts again.
    advance(3_600_000);
    await host(h, 'POST', '/resume');
    await host(h, 'POST', '/pause', { notify: true });
    await h.ctx.service.pendingDispatch;
    expect(h.sent).toHaveLength(first * 2);
  });

  it('a fast pause/resume/pause does not queue a second copy behind the first', async () => {
    const h = await setup(TWILIO_ENV);
    await fiveParties(h);
    await h.ctx.service.pendingDispatch;
    h.sent.length = 0;
    // No awaiting between the calls: the first batch is still `sending` when the line is
    // paused again, so it goes out; the second pause must not add a copy for anyone.
    await host(h, 'POST', '/pause', { notify: true });
    await host(h, 'POST', '/resume');
    await host(h, 'POST', '/pause', { notify: true });
    await h.ctx.service.pendingDispatch;
    await settle();
    const to = h.sent.map((m) => m.to);
    expect(new Set(to).size).toBe(to.length);
  });

  it('tray texts the host already sent are not offered again on the next pause', async () => {
    const h = await setup();
    await fiveParties(h);
    let s: HostSnapshot = (await host(h, 'POST', '/pause', { notify: true })).json();
    const paused = s.pendingTexts.filter((t) => t.template === 'paused');
    expect(paused).toHaveLength(5);
    for (const t of paused) await host(h, 'POST', `/texts/${t.id}`, { status: 'sent' });
    advance(2000);
    await host(h, 'POST', '/resume');
    advance(2000);
    s = (await host(h, 'POST', '/pause', { notify: true })).json();
    expect(s.pendingTexts.filter((t) => t.template === 'paused')).toHaveLength(0);
  });
});
