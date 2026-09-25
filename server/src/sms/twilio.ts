import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TwilioConfig } from '../config.js';
import type { SmsProvider, SmsSendResult } from './provider.js';

/** Twilio provider (S3) using the REST API with plain fetch; no SDK needed. */
export function createTwilioProvider(
  cfg: TwilioConfig,
  fetchImpl: typeof fetch = fetch,
): SmsProvider {
  const url = `${cfg.apiBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  return {
    name: 'twilio',
    async send(to: string, body: string): Promise<SmsSendResult> {
      const form = new URLSearchParams({ To: to, Body: body });
      if (cfg.messagingServiceSid) form.set('MessagingServiceSid', cfg.messagingServiceSid);
      else if (cfg.from) form.set('From', cfg.from);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15_000),
        });
        const json = (await res.json().catch(() => ({}))) as {
          sid?: string;
          code?: number;
          message?: string;
        };
        if (res.ok && json.sid) return { status: 'sent', providerId: json.sid };
        return {
          status: 'failed',
          code: typeof json.code === 'number' ? json.code : null,
          message: json.message ?? `HTTP ${res.status}`,
        };
      } catch (err) {
        return { status: 'failed', code: null, message: (err as Error).message };
      }
    },
  };
}

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key + value)...)).
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const OPT_OUT_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
]);
export const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP', 'YES']);

/** Keywords are case-insensitive and must be the whole message (§2.11). */
export function classifyInbound(body: string): 'opt_out' | 'opt_in' | null {
  const word = body.trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(word)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(word)) return 'opt_in';
  return null;
}
