import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '@pby/shared';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  from: string | null;
  messagingServiceSid: string | null;
  /** Override for tests. */
  apiBase: string;
}

export interface Config {
  port: number;
  host: string;
  dbPath: string;
  adminPassword: string | null;
  /** Base URL used in texted links and the QR code. Falls back to the creating request's origin. */
  publicUrl: string | null;
  cookieSecure: 'auto' | boolean;
  /**
   * Fastify `trustProxy`: a hop count (default 1), an IP/CIDR list, or false. Never `true`:
   * that trusts the left-most X-Forwarded-For entry, which any client can forge to dodge the
   * per-IP rate limits (PIN, admin password, self-join).
   */
  trustProxy: number | string | false;
  retentionDays: number;
  autoCloseHours: number;
  optOutSalt: string | null;
  twilio: TwilioConfig | null;
  webDist: string | null;
  logLevel: string;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** TRUST_PROXY: unset or `true` → 1 hop, `false`/`0` → off, `N` → N hops, else an IP/CIDR list. */
function trustProxy(value: string | undefined): number | string | false {
  const v = value?.trim().toLowerCase() ?? '';
  if (v === '' || ['true', 'yes', 'on'].includes(v)) return 1;
  if (['false', 'no', 'off', '0'].includes(v)) return false;
  if (/^\d+$/.test(v)) return Number(v);
  return value!.trim();
}

function defaultWebDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, '../../web/dist');
  return existsSync(candidate) ? candidate : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM?.trim() || null;
  const mss = env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null;
  const twilio =
    sid && token && (from || mss)
      ? {
          accountSid: sid,
          authToken: token,
          from,
          messagingServiceSid: mss,
          apiBase: env.TWILIO_API_BASE?.trim() || 'https://api.twilio.com',
        }
      : null;
  const cookieSecure = env.COOKIE_SECURE?.trim();
  return {
    port: num(env.PORT, 3000),
    host: env.HOST?.trim() || '0.0.0.0',
    dbPath: env.DATABASE_PATH?.trim() || resolve(process.cwd(), 'data/pby-queue.db'),
    adminPassword: env.ADMIN_PASSWORD?.trim() || null,
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, '') || null,
    cookieSecure: !cookieSecure || cookieSecure === 'auto' ? 'auto' : bool(cookieSecure, false),
    trustProxy: trustProxy(env.TRUST_PROXY),
    retentionDays: num(env.RETENTION_DAYS, DEFAULTS.retentionDays),
    autoCloseHours: num(env.AUTO_CLOSE_HOURS, DEFAULTS.autoCloseHours),
    optOutSalt: env.OPTOUT_SALT?.trim() || null,
    twilio,
    webDist: env.WEB_DIST?.trim() || defaultWebDist(),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  };
}
