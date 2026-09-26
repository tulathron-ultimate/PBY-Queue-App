/** Test harness for the v1.1 API tests: an in-memory app, a fake clock and a fake Twilio. */
import type { GuestSnapshot, HostSnapshot } from '@pby/shared';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const ADMIN = 'admin-secret';
export const PIN = '246810';
export const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret-token',
  TWILIO_FROM: '+15550001111',
};

let clock = Date.UTC(2026, 9, 1, 15, 0, 0);
export const now = () => clock;
export const advance = (ms: number) => (clock += ms);

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  cookies: Record<string, string>;
  eventId: string;
  code: string;
  sent: { to: string; body: string }[];
}

const apps: FastifyInstance[] = [];

/** Call from `afterEach`. */
export async function closeApps(): Promise<void> {
  while (apps.length) await apps.pop()!.close();
}

export async function setup(
  env: Record<string, string> = {},
  event: Record<string, unknown> = {},
): Promise<Harness> {
  const sent: { to: string; body: string }[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    const form = new URLSearchParams(String(init.body));
    sent.push({ to: form.get('To')!, body: form.get('Body')! });
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
      ...event,
    },
  });
  expect(res.statusCode).toBe(200);
  const { id, code } = res.json();
  const cookies: Record<string, string> = {};
  for (const c of res.cookies) cookies[c.name] = c.value;
  return { app, ctx, cookies, eventId: id, code, sent };
}

export async function host(
  h: Harness,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object,
  cookies: Record<string, string> = h.cookies,
) {
  return h.app.inject({
    method,
    url: `/api/host/events/${h.eventId}${path}`,
    cookies,
    payload: method === 'GET' ? undefined : (payload ?? {}),
  });
}

export async function snap(h: Harness): Promise<HostSnapshot> {
  return (await host(h, 'GET', '')).json();
}

export async function guest(h: Harness, token: string): Promise<GuestSnapshot> {
  return (await h.app.inject({ method: 'GET', url: `/api/status/${token}` })).json();
}

export async function addManual(h: Harness, name: string, phone = '', extra: object = {}) {
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

/** Five checked-in parties with phones: #1 Emma Rivera … #5 Walsh Family. */
export async function fiveParties(h: Harness): Promise<void> {
  const people = [
    ['Emma Rivera', '555-201-8830'],
    ['Nguyen Family', '555-309-4417'],
    ['Smith Family', '555-740-1122'],
    ['Okafor', '555-201-8831'],
    ['Walsh Family', '555-201-8832'],
  ];
  for (const [name, phone] of people) await addManual(h, name, phone, { sendJoinText: false });
}
