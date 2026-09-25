/** SMS templates and rendering (FEATURES §2.4). GSM-7 only, ≤160 chars rendered. */
import { positionOf } from './queue.js';
import type { QueueParty, TemplateKey } from './types.js';

export const TEMPLATES: Readonly<Record<TemplateKey, string>> = {
  join: "{event}: {name}, you're #{pos} in line. Track live: {link}",
  up_next: "{event}: {name}, you're up next! Please head to the photo area now. Status: {link}",
  your_turn: "{event}: {name}, it's your turn! Please come to the camera now.",
  skipped:
    '{event}: {name}, we called you but missed you. Find the host to get back in line: {link}',
  // E6: optional, sent when the host pauses the line. The host's message is shown on the
  // status page, not in the text, so the text stays GSM-7 and under 160 characters.
  paused:
    '{event}: {name}, the photo line is paused for a short break. You keep your place: {link}',
};

export const TEMPLATE_LABELS: Readonly<Record<TemplateKey, string>> = {
  join: 'Status link',
  up_next: 'Up next',
  your_turn: "It's your turn",
  skipped: 'Missed you',
  paused: 'Line paused',
};

/** Twilio mode only: appended to the first message to a number in an event. */
export const STOP_FOOTER = ' Reply STOP to opt out.';
export const SMS_MAX_LENGTH = 160;
export const SMS_EVENT_MAX = 20;
export const SMS_NAME_MAX = 12;

// GSM 03.38 basic character set (the extension table costs 2 chars and is avoided).
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_SET = new Set(GSM7_BASIC);
/** Extension table: still GSM-7 (no switch to UCS-2) but each costs 2 septets. */
const GSM7_EXTENSION = new Set('^{}\\[~]|€\f');

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!GSM7_SET.has(ch) && !GSM7_EXTENSION.has(ch)) return false;
  return true;
}

/** Length in GSM-7 septets (extension characters such as `~` count twice). */
export function smsLength(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM7_EXTENSION.has(ch) ? 2 : 1;
  return n;
}

const SPECIAL: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ø: 'o',
  Ø: 'O',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  þ: 'th',
  Þ: 'Th',
  ı: 'i',
  '‘': "'",
  '’': "'",
  '‚': "'",
  '′': "'",
  '`': "'",
  '´': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
};

/**
 * Transliterates to plain printable ASCII that is also GSM-7 safe (é → e, smart quotes →
 * straight, emoji dropped). Keeps messages out of UCS-2 (70-char limit).
 */
export function toSmsSafe(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFKD')) {
    if (/\p{M}/u.test(ch)) continue; // combining accents
    const mapped = SPECIAL[ch] ?? ch;
    for (const c of mapped) {
      const code = c.charCodeAt(0);
      if (code >= 0x20 && code <= 0x7e && GSM7_SET.has(c)) out += c;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function smsEventName(eventName: string, smsName?: string | null): string {
  return toSmsSafe(smsName?.trim() || eventName)
    .slice(0, SMS_EVENT_MAX)
    .trim();
}

/** `{name}`: the first word of the display name, ≤12 chars. */
export function smsFirstName(displayName: string): string {
  const first = toSmsSafe(displayName).split(' ')[0] ?? '';
  return first.slice(0, SMS_NAME_MAX);
}

export interface TemplateVars {
  event: string;
  name: string;
  pos?: number | string;
  ticket?: number | string;
  link?: string;
}

function fill(template: string, v: Required<TemplateVars>): string {
  return template.replace(/\{(event|name|pos|ticket|link)\}/g, (_, key: keyof TemplateVars) =>
    String(v[key]),
  );
}

/**
 * Renders a template. Overflow fallback: (1) drop `{name}, `, then (2) truncate `{event}`.
 * `{link}` is never truncated. `event` and `name` are made SMS-safe here.
 */
export function renderSms(
  key: TemplateKey,
  vars: TemplateVars,
  opts: { stopFooter?: boolean; template?: string } = {},
): string {
  const footer = opts.stopFooter ? STOP_FOOTER : '';
  const limit = SMS_MAX_LENGTH - footer.length;
  let template = opts.template ?? TEMPLATES[key];
  const values: Required<TemplateVars> = {
    event: toSmsSafe(vars.event).slice(0, SMS_EVENT_MAX).trim(),
    name: smsFirstName(vars.name),
    pos: vars.pos ?? '',
    ticket: vars.ticket ?? '',
    link: vars.link ?? '',
  };
  if (!values.name) template = template.replace('{name}, ', '');
  let text = fill(template, values);
  if (smsLength(text) > limit) {
    template = template.replace('{name}, ', '');
    text = fill(template, values);
  }
  if (smsLength(text) > limit) {
    const over = smsLength(text) - limit;
    values.event = values.event.slice(0, Math.max(0, values.event.length - over)).trim();
    text = fill(template, values);
  }
  return text + footer;
}

/** The event fields a party's text needs. `HostEventInfo` and the server's event record fit. */
export interface TextEvent {
  name: string;
  smsName: string | null;
  /** Base URL of texted links, e.g. `https://q.example.com`. */
  publicUrl: string;
}

/** A party's private status page, `{publicUrl}/s/{token}`. */
export function statusUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/s/${token}`;
}

/**
 * Renders the text for one party as it is now. The server uses it for Twilio, and host devices
 * use it for the tap-to-send tray, so snapshots never carry rendered bodies.
 */
export function renderPartyText(
  event: TextEvent,
  parties: readonly QueueParty[],
  party: QueueParty & { name: string; token: string },
  template: TemplateKey,
  opts: { stopFooter?: boolean } = {},
): string {
  return renderSms(
    template,
    {
      event: smsEventName(event.name, event.smsName),
      name: party.name,
      pos: positionOf(parties, party.id) ?? '',
      ticket: party.ticket,
      link: statusUrl(event.publicUrl, party.token),
    },
    { stopFooter: opts.stopFooter },
  );
}
