import type { HostSnapshot, LobbySnapshot } from '@pby/shared';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { redactUrl } from '../src/app.js';
import { hashLobbyToken } from '../src/lobby.js';
import {
  addManual,
  advance,
  closeApps,
  fiveParties,
  host,
  setup,
  snap,
  type Harness,
} from './harness.js';

afterEach(closeApps);

async function makeLink(h: Harness): Promise<string> {
  const res = await host(h, 'POST', '/lobby');
  expect(res.statusCode, res.body).toBe(200);
  const url = (res.json() as HostSnapshot).event.lobbyUrl!;
  expect(url).toMatch(/^https:\/\/q\.example\.com\/d\/[A-Za-z0-9_-]{24}$/);
  return url.split('/d/')[1];
}

const lobby = (h: Harness, token: string, ip = '203.0.113.9') =>
  h.app.inject({ method: 'GET', url: `/api/lobby/${token}`, remoteAddress: ip });

/** Opens a lobby socket and records its messages and close code. */
async function openLobbySocket(h: Harness, token: string) {
  if (!h.app.server.listening) await h.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = h.app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/lobby/${token}`);
  const messages: LobbySnapshot[] = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'lobby') messages.push(msg.data);
  });
  const waitFor = async (pred: (m: LobbySnapshot) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const m = messages.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout');
  };
  return { ws, messages, closed, waitFor };
}

describe('lobby display link (G5)', () => {
  it('is made and revoked by the host only, for the session’s event', async () => {
    const h = await setup();
    const other = await setup();
    expect((await host(h, 'POST', '/lobby', {}, {})).statusCode).toBe(401);
    expect((await host(h, 'POST', '/lobby', {}, other.cookies)).statusCode).toBe(401);
    expect((await host(h, 'POST', '/lobby/revoke', {}, other.cookies)).statusCode).toBe(401);
    expect((await snap(h)).event.lobbyUrl).toBeNull();
  });

  it('uses a fresh 144-bit token each time and looks it up by hash', async () => {
    const h = await setup();
    const a = await makeLink(h);
    const b = await makeLink(h);
    expect(a).not.toBe(b);
    const row = h.ctx.db
      .prepare('SELECT lobby_token_hash FROM events WHERE id = ?')
      .get(h.eventId) as { lobby_token_hash: string };
    expect(row.lobby_token_hash).toBe(hashLobbyToken(b));
    expect((await lobby(h, a)).statusCode).toBe(404); // replaced
    expect((await lobby(h, b)).statusCode).toBe(200);
  });

  it('sends only allowlisted fields: tickets, filtered names, pause state, join link', async () => {
    const h = await setup();
    await fiveParties(h);
    await addManual(h, 'Chen Family', '555-201-8833', { notes: 'wheelchair', members: ['Li'] });
    await addManual(h, 'Late Arrival', '555-201-8834', { arrived: false });
    advance(2000);
    await host(h, 'POST', '/call-next');
    await host(h, 'POST', '/pause', { message: 'Back in 10 minutes' });
    const token = await makeLink(h);
    const res = await lobby(h, token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as LobbySnapshot;
    expect(Object.keys(body).sort()).toEqual(
      [
        'comingUp',
        'eventEnded',
        'eventName',
        'joinQrUrl',
        'joinUrl',
        'nowServing',
        'pauseMessage',
        'paused',
      ].sort(),
    );
    expect(body).toEqual({
      eventName: 'Pumpkin Patch Portraits',
      eventEnded: false,
      paused: true,
      pauseMessage: 'Back in 10 minutes',
      nowServing: { ticket: 1, name: 'Emma R.' },
      comingUp: [
        { ticket: 2, name: 'Nguyen F.' },
        { ticket: 3, name: 'Smith F.' },
        { ticket: 4, name: 'Okafor' },
        { ticket: 5, name: 'Walsh F.' },
        { ticket: 6, name: 'Chen F.' },
      ],
      joinUrl: `https://q.example.com/j/${h.code}`,
      joinQrUrl: `/api/join/${h.code}/qr.svg`,
    });
    const s = await snap(h);
    for (const leak of [
      '555',
      'Rivera',
      'Family',
      'wheelchair',
      'Li"',
      ...s.parties.map((p) => p.token),
      ...s.parties.map((p) => p.id),
    ]) {
      expect(res.body).not.toContain(leak);
    }
  });

  it('shows ticket numbers only when names are hidden, and no join link when joining is off', async () => {
    const h = await setup();
    await fiveParties(h);
    await host(h, 'PATCH', '/settings', { showNames: false, selfJoin: false });
    advance(2000);
    await host(h, 'POST', '/call-next');
    const body: LobbySnapshot = (await lobby(h, await makeLink(h))).json();
    expect(body.nowServing).toEqual({ ticket: 1, name: null });
    expect(body.comingUp.every((c) => c.name === null)).toBe(true);
    expect(body.joinUrl).toBeNull();
    expect(body.joinQrUrl).toBeNull();
  });

  it('says the event ended, with no parties, once it is closed; the purge kills the link', async () => {
    const h = await setup();
    await fiveParties(h);
    const token = await makeLink(h);
    await host(h, 'POST', '/close');
    const body: LobbySnapshot = (await lobby(h, token)).json();
    expect(body).toMatchObject({ eventEnded: true, nowServing: null, comingUp: [], joinUrl: null });
    h.ctx.service.deleteNow(h.eventId);
    expect((await lobby(h, token)).statusCode).toBe(404);
  });

  it('puts unknown tokens behind the per-IP miss limit shared with status links', async () => {
    const h = await setup();
    const token = await makeLink(h);
    const bad = await lobby(h, 'A'.repeat(24));
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toEqual({ error: 'not_found', message: 'Not found.' });
    // 59 more misses from this IP, some on status links: the 60th locks the IP out.
    for (let i = 0; i < 30; i++) await lobby(h, `x${i}`.padEnd(24, 'y'));
    for (let i = 0; i < 29; i++) {
      await h.app.inject({
        method: 'GET',
        url: `/api/status/${`s${i}`.padEnd(12, 'z')}`,
        remoteAddress: '203.0.113.9',
      });
    }
    expect((await lobby(h, token)).statusCode).toBe(429);
    expect((await lobby(h, token, '198.51.100.1')).statusCode).toBe(200);
  });

  it('keeps lobby tokens out of request logs', () => {
    const t = 'Ab_-cdEFghIJklMNopQRstUV';
    expect(redactUrl(`/d/${t}`)).toBe('/d/***');
    expect(redactUrl(`/api/lobby/${t}`)).toBe('/api/lobby/***');
    expect(redactUrl(`/ws/lobby/${t}`)).toBe('/ws/lobby/***');
  });
});

describe('lobby display live updates (G5)', () => {
  it('updates live with no phone numbers, and a revoked link disconnects at once', async () => {
    const h = await setup();
    await fiveParties(h);
    const token = await makeLink(h);
    const sock = await openLobbySocket(h, token);
    const first = await sock.waitFor(() => true);
    expect(first.nowServing).toBeNull();
    advance(2000);
    await host(h, 'POST', '/call-next');
    const live = await sock.waitFor((m) => m.nowServing?.ticket === 1);
    expect(live.nowServing!.name).toBe('Emma R.');
    expect(JSON.stringify(sock.messages)).not.toContain('555');

    await host(h, 'POST', '/lobby/revoke');
    expect(await sock.closed).toBe(4404);
    expect((await snap(h)).event.lobbyUrl).toBeNull();
    expect((await lobby(h, token)).statusCode).toBe(404);
  });

  it('a new link disconnects displays on the old one', async () => {
    const h = await setup();
    const old = await makeLink(h);
    const sock = await openLobbySocket(h, old);
    await sock.waitFor(() => true);
    const fresh = await makeLink(h);
    expect(await sock.closed).toBe(4404);
    const again = await openLobbySocket(h, fresh);
    expect((await again.waitFor(() => true)).eventName).toBe('Pumpkin Patch Portraits');
    again.ws.close();
  });

  it('refuses a socket for an unknown token', async () => {
    const h = await setup();
    await makeLink(h);
    const sock = await openLobbySocket(h, 'B'.repeat(24));
    expect(await sock.closed).toBe(4404);
  });
});
