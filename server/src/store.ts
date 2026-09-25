/** Row mapping and plain queries. Business rules live in service.ts and @pby/shared. */
import type {
  EventStatus,
  PartySource,
  PartyState,
  QueueParty,
  SmsMode,
  TemplateKey,
  TextStatus,
} from '@pby/shared';
import type { DB } from './db.js';

export interface EventRecord {
  id: string;
  code: string;
  name: string;
  smsName: string | null;
  date: string;
  pinHash: string;
  upNextN: number;
  smsMode: SmsMode;
  selfJoin: boolean;
  showNames: boolean;
  hostConsent: boolean;
  status: EventStatus;
  publicUrl: string;
  nextTicket: number;
  createdAt: number;
  lastActionAt: number;
  /** Only authenticated host routes move this; auto-close uses it (§2.12). */
  lastHostActionAt: number;
  lastCallAt: number | null;
  closedAt: number | null;
  purgedAt: number | null;
  /** E6 pause. */
  paused: boolean;
  pauseMessage: string | null;
  pausedAt: number | null;
}

export interface PartyRecord extends QueueParty {
  eventId: string;
  token: string;
  name: string;
  size: number;
  members: string[];
  phone: string | null;
  phoneInvalidInput: string | null;
  group: string | null;
  notes: string | null;
  source: PartySource;
  consent: boolean;
  noTexts: boolean;
  createdAt: number;
}

export interface SmsLogRecord {
  id: number;
  eventId: string;
  partyId: string;
  template: TemplateKey;
  provider: 'tap' | 'twilio';
  status: TextStatus;
  footer: boolean;
  createdAt: number;
  updatedAt: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toEvent(r: any): EventRecord {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    smsName: r.sms_name,
    date: r.date,
    pinHash: r.pin_hash,
    upNextN: r.up_next_n,
    smsMode: r.sms_mode,
    selfJoin: !!r.self_join,
    showNames: !!r.show_names,
    hostConsent: !!r.host_consent,
    status: r.status,
    publicUrl: r.public_url,
    nextTicket: r.next_ticket,
    createdAt: r.created_at,
    lastActionAt: r.last_action_at,
    lastHostActionAt: r.last_host_action_at ?? r.last_action_at,
    lastCallAt: r.last_call_at,
    closedAt: r.closed_at,
    purgedAt: r.purged_at,
    paused: !!r.paused,
    pauseMessage: r.pause_message ?? null,
    pausedAt: r.paused_at ?? null,
  };
}

function toParty(r: any): PartyRecord {
  return {
    id: r.id,
    eventId: r.event_id,
    token: r.token,
    ticket: r.ticket,
    name: r.name,
    size: r.size,
    members: JSON.parse(r.members),
    phone: r.phone,
    phoneInvalidInput: r.phone_invalid_input,
    group: r.group_label,
    notes: r.notes,
    source: r.source,
    consent: !!r.consent,
    noTexts: !!r.no_texts,
    state: r.state as PartyState,
    sortKey: r.sort_key,
    arrived: !!r.arrived,
    skipCount: r.skip_count,
    upNextSent: !!r.up_next_sent,
    calledAt: r.called_at,
    doneAt: r.done_at,
    createdAt: r.created_at,
  };
}

function toSms(r: any): SmsLogRecord {
  return {
    id: r.id,
    eventId: r.event_id,
    partyId: r.party_id,
    template: r.template,
    provider: r.provider,
    status: r.status,
    footer: !!r.footer,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class Store {
  constructor(readonly db: DB) {}

  getEvent(id: string): EventRecord | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    return r ? toEvent(r) : null;
  }

  getEventByCode(code: string): EventRecord | null {
    const r = this.db.prepare('SELECT * FROM events WHERE code = ?').get(code.toUpperCase());
    return r ? toEvent(r) : null;
  }

  insertEvent(e: EventRecord): void {
    this.db
      .prepare(
        // minutes_per_party and samples fed the wait-time estimate, which was removed by the
        // owner's decision. The columns stay (NOT NULL) for existing databases but are unused.
        `INSERT INTO events (id, code, name, sms_name, date, pin_hash, up_next_n, minutes_per_party,
          sms_mode, self_join, show_names, host_consent, status, public_url, next_ticket,
          created_at, last_action_at, last_host_action_at)
         VALUES (@id, @code, @name, @smsName, @date, @pinHash, @upNextN, 0,
          @smsMode, @selfJoin, @showNames, @hostConsent, @status, @publicUrl, @nextTicket,
          @createdAt, @lastActionAt, @lastHostActionAt)`,
      )
      .run({
        ...e,
        selfJoin: e.selfJoin ? 1 : 0,
        showNames: e.showNames ? 1 : 0,
        hostConsent: e.hostConsent ? 1 : 0,
      });
  }

  updateEvent(id: string, patch: Partial<EventRecord>): void {
    const columns: Record<string, string> = {
      name: 'name',
      smsName: 'sms_name',
      date: 'date',
      upNextN: 'up_next_n',
      smsMode: 'sms_mode',
      selfJoin: 'self_join',
      showNames: 'show_names',
      hostConsent: 'host_consent',
      status: 'status',
      nextTicket: 'next_ticket',
      lastActionAt: 'last_action_at',
      lastHostActionAt: 'last_host_action_at',
      lastCallAt: 'last_call_at',
      closedAt: 'closed_at',
      purgedAt: 'purged_at',
      paused: 'paused',
      pauseMessage: 'pause_message',
      pausedAt: 'paused_at',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const col = columns[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  listParties(eventId: string): PartyRecord[] {
    return this.db
      .prepare('SELECT * FROM parties WHERE event_id = ? ORDER BY ticket')
      .all(eventId)
      .map(toParty);
  }

  getPartyByToken(token: string): PartyRecord | null {
    const r = this.db.prepare('SELECT * FROM parties WHERE token = ?').get(token);
    return r ? toParty(r) : null;
  }

  insertParty(p: PartyRecord): void {
    this.db
      .prepare(
        `INSERT INTO parties (id, event_id, token, ticket, name, size, members, phone,
          phone_invalid_input, group_label, notes, source, consent, no_texts, state, sort_key,
          arrived, skip_count, up_next_sent, called_at, done_at, created_at)
         VALUES (@id, @eventId, @token, @ticket, @name, @size, @members, @phone,
          @phoneInvalidInput, @group, @notes, @source, @consent, @noTexts, @state, @sortKey,
          @arrived, @skipCount, @upNextSent, @calledAt, @doneAt, @createdAt)`,
      )
      .run({
        ...p,
        members: JSON.stringify(p.members),
        consent: p.consent ? 1 : 0,
        noTexts: p.noTexts ? 1 : 0,
        arrived: p.arrived ? 1 : 0,
        upNextSent: p.upNextSent ? 1 : 0,
      });
  }

  updatePartyQueue(p: QueueParty): void {
    this.db
      .prepare(
        `UPDATE parties SET state = ?, sort_key = ?, arrived = ?, skip_count = ?, up_next_sent = ?,
          called_at = ?, done_at = ? WHERE id = ?`,
      )
      .run(
        p.state,
        p.sortKey,
        p.arrived ? 1 : 0,
        p.skipCount,
        p.upNextSent ? 1 : 0,
        p.calledAt,
        p.doneAt,
        p.id,
      );
  }

  updatePartyDetails(
    id: string,
    d: Pick<
      PartyRecord,
      'name' | 'size' | 'members' | 'phone' | 'phoneInvalidInput' | 'group' | 'notes' | 'noTexts'
    >,
  ): void {
    this.db
      .prepare(
        `UPDATE parties SET name = ?, size = ?, members = ?, phone = ?, phone_invalid_input = ?,
          group_label = ?, notes = ?, no_texts = ? WHERE id = ?`,
      )
      .run(
        d.name,
        d.size,
        JSON.stringify(d.members),
        d.phone,
        d.phoneInvalidInput,
        d.group,
        d.notes,
        d.noTexts ? 1 : 0,
        id,
      );
  }

  insertSms(r: Omit<SmsLogRecord, 'id' | 'updatedAt'>): number {
    const info = this.db
      .prepare(
        `INSERT INTO sms_log (event_id, party_id, template, provider, status, footer, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.eventId,
        r.partyId,
        r.template,
        r.provider,
        r.status,
        r.footer ? 1 : 0,
        r.createdAt,
        r.createdAt,
      );
    return Number(info.lastInsertRowid);
  }

  setSmsStatus(
    id: number,
    status: TextStatus,
    now: number,
    error?: string | null,
    providerId?: string,
  ) {
    this.db
      .prepare(
        'UPDATE sms_log SET status = ?, error = ?, provider_id = COALESCE(?, provider_id), updated_at = ? WHERE id = ?',
      )
      .run(status, error ?? null, providerId ?? null, now, id);
  }

  getSms(id: number): SmsLogRecord | null {
    const r = this.db.prepare('SELECT * FROM sms_log WHERE id = ?').get(id);
    return r ? toSms(r) : null;
  }

  listSms(eventId: string): SmsLogRecord[] {
    return this.db
      .prepare('SELECT * FROM sms_log WHERE event_id = ? ORDER BY id')
      .all(eventId)
      .map(toSms);
  }

  /** Has a Twilio message already gone to this number in this event? (STOP footer rule) */
  hasTwilioMessageTo(eventId: string, phone: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM sms_log s JOIN parties p ON p.id = s.party_id
         WHERE s.event_id = ? AND p.phone = ? AND s.provider = 'twilio'
           AND s.status IN ('sending', 'sent') LIMIT 1`,
      )
      .get(eventId, phone);
  }
}
