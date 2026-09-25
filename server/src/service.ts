/**
 * The event service: loads an event's parties, applies a pure queue function from
 * @pby/shared inside a SQLite transaction, persists the result, turns SMS effects into
 * texts (tap-to-send tray or Twilio), and notifies listeners (WebSocket broadcast).
 */
import {
  addParties as addToQueue,
  buildResultsCsv,
  callNext as queueCallNext,
  clampInt,
  cleanPauseMessage,
  cleanText,
  completeCurrent,
  DEFAULTS,
  hasErrors,
  holdUpNextTexts,
  isValidPin,
  LIMITS,
  maskPhone,
  move as queueMove,
  resultsFileName,
  pausedTextEffects,
  QueueError,
  recomputeUpNext,
  reinsert as queueReinsert,
  removeParty,
  restoreSnapshot,
  serveNow as queueServeNow,
  setArrived as queueSetArrived,
  skipCurrent,
  takeSnapshot,
  validateDraft,
  type EventSettings,
  type GuestSnapshot,
  type HostSnapshot,
  type ImportPartyInput,
  type JoinInfo,
  type LobbySnapshot,
  type MoveDirection,
  type PartyState,
  type PartySource,
  type QueueResult,
  type QueueSnapshot,
  type SmsEffect,
  type SmsMode,
  type TemplateKey,
  type TextStatus,
} from '@pby/shared';
import type { Config } from './config.js';
import { getMeta, setMeta, type DB } from './db.js';
import { hashLobbyToken, LOBBY_TOKEN_PATTERN, newLobbyToken, sameLobbyToken } from './lobby.js';
import { QUEUE_ERROR_MESSAGES, ServiceError } from './errors.js';
import { purgeEvent } from './retention.js';
import { hashPin, newId, newJoinCode, newStatusToken, randomString, sha256 } from './security.js';
import { Sessions } from './sessions.js';
import { tapToSend, TWILIO_UNSUBSCRIBED, type SmsProvider } from './sms/provider.js';
import {
  buildGuestSnapshot,
  buildHostSnapshot,
  buildJoinInfo,
  buildLobbySnapshot,
  renderBody,
} from './snapshots.js';
import { Store, type EventRecord, type PartyRecord } from './store.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface CreateEventInput {
  name: string;
  smsName?: string | null;
  date?: string;
  pin: string;
  upNextN?: number;
  smsMode?: SmsMode;
  selfJoin?: boolean;
  showNames?: boolean;
}

export interface AddOptions {
  source: PartySource;
  arrived: boolean;
  position: 'end' | 'next';
  sendJoinText: boolean;
  /** Host confirms once per event that these people agreed to receive texts. */
  consentConfirmed?: boolean;
  /** Self-join consent checkbox. */
  consent?: boolean;
}

/** A text to create. `tray` puts it in the host's tap-to-send tray even in Twilio mode. */
type TextEffect = SmsEffect & { tray?: boolean };

type MutationResult = QueueResult<PartyRecord> & { extraEffects?: TextEffect[] };

const UNDO_KEEP = 20;

const PAUSED_ERROR = () =>
  new ServiceError(409, 'paused', 'The line is paused. Resume it to call the next party.');

/** The states in which a pending tray text still makes sense. */
const STILL_RELEVANT: Record<TemplateKey, PartyState[]> = {
  join: ['waiting', 'up_next'],
  up_next: ['waiting', 'up_next'],
  your_turn: ['now_serving'],
  skipped: ['skipped', 'no_show'],
  paused: ['waiting', 'up_next'],
};

/** The event fields an Undo step restores besides the queue (E6 pause). */
type EventState = Pick<EventRecord, 'paused' | 'pauseMessage' | 'pausedAt'>;

function queueChanged(a: PartyRecord, b: PartyRecord): boolean {
  return (
    a.state !== b.state ||
    a.sortKey !== b.sortKey ||
    a.arrived !== b.arrived ||
    a.skipCount !== b.skipCount ||
    a.upNextSent !== b.upNextSent ||
    a.calledAt !== b.calledAt ||
    a.doneAt !== b.doneAt
  );
}

/** Event names are shown to every guest, so they get the same hygiene as party names (SEC-8). */
function text(value: unknown, max: number): string {
  return typeof value === 'string'
    ? cleanText(value).trim().replace(/\s+/g, ' ').slice(0, max)
    : '';
}

export class QueueService {
  readonly store: Store;
  readonly sessions: Sessions;
  private readonly optOutSalt: string;
  /** Called after every change so the WebSocket hub can broadcast. */
  onChange: (eventId: string) => void = () => {};

  constructor(
    readonly db: DB,
    readonly cfg: Config,
    private readonly twilio: SmsProvider | null,
    private readonly log: Logger,
    readonly now: () => number = Date.now,
  ) {
    this.store = new Store(db);
    this.sessions = new Sessions(db, now);
    let salt = cfg.optOutSalt ?? getMeta(db, 'optout_salt');
    if (!salt) {
      salt = randomString(32);
      setMeta(db, 'optout_salt', salt);
    }
    this.optOutSalt = salt;
    // Twilio texts still `sending` belong to a dispatch that died with the previous process.
    // Twilio may or may not have them, so don't resend blindly: mark them failed, which shows
    // the host a warning and lets them use "Text now".
    const interrupted = db
      .prepare(
        `UPDATE sms_log SET status = 'failed', error = 'interrupted', updated_at = ?
         WHERE status = 'sending'`,
      )
      .run(now()).changes;
    if (interrupted) log.warn({ count: interrupted }, 'texts interrupted by a restart');
  }

  get twilioAvailable(): boolean {
    return this.twilio !== null;
  }

  /* ------------------------------------------------------------------ events */

  async createEvent(input: CreateEventInput, origin: string): Promise<EventRecord> {
    const name = text(input.name, 1000);
    if (!name || name.length > LIMITS.eventNameMax) {
      throw new ServiceError(
        400,
        'invalid_name',
        `Event name must be 1–${LIMITS.eventNameMax} characters.`,
      );
    }
    if (!isValidPin(String(input.pin ?? ''))) {
      throw new ServiceError(400, 'invalid_pin', 'PIN must be 6–12 digits or letters.');
    }
    const smsMode: SmsMode = input.smsMode === 'twilio' && this.twilio ? 'twilio' : 'tap';
    const now = this.now();
    let code = newJoinCode();
    while (this.store.getEventByCode(code)) code = newJoinCode();
    const event: EventRecord = {
      id: newId(),
      code,
      name,
      smsName: text(input.smsName, LIMITS.smsEventNameMax) || null,
      date: /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')
        ? input.date!
        : new Date(now).toISOString().slice(0, 10),
      pinHash: await hashPin(String(input.pin)),
      upNextN: clampInt(input.upNextN, LIMITS.upNextMin, LIMITS.upNextMax, DEFAULTS.upNextN),
      smsMode,
      selfJoin: input.selfJoin ?? true,
      showNames: input.showNames ?? true,
      hostConsent: false,
      status: 'open',
      publicUrl: this.cfg.publicUrl ?? origin.replace(/\/+$/, ''),
      nextTicket: 1,
      createdAt: now,
      lastActionAt: now,
      lastHostActionAt: now,
      lastCallAt: null,
      closedAt: null,
      purgedAt: null,
      paused: false,
      pauseMessage: null,
      pausedAt: null,
      lobbyToken: null,
      lobbyTokenHash: null,
    };
    this.store.insertEvent(event);
    this.log.info({ event: event.id }, 'event created');
    return event;
  }

  getEvent(id: string): EventRecord | null {
    const e = this.store.getEvent(id);
    return e && !e.purgedAt ? e : null;
  }

  requireEvent(id: string, opts: { open?: boolean } = {}): EventRecord {
    const event = this.getEvent(id);
    if (!event) throw new ServiceError(404, 'not_found', 'Event not found.');
    if (opts.open && event.status !== 'open') {
      throw new ServiceError(409, 'event_closed', 'This event has ended.');
    }
    return event;
  }

  /** Records a host action for auto-close (§2.12). Called only by authenticated host routes. */
  touchHost(eventId: string): void {
    this.store.updateEvent(eventId, { lastHostActionAt: this.now() });
  }

  /* ------------------------------------------------------------- snapshots */

  hostSnapshot(eventId: string): HostSnapshot {
    const event = this.requireEvent(eventId);
    const undoRow = this.db
      .prepare(
        'SELECT label, created_at FROM undo_stack WHERE event_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(eventId) as { label: string; created_at: number } | undefined;
    return buildHostSnapshot({
      event,
      parties: this.store.listParties(eventId),
      sms: this.store.listSms(eventId),
      undo:
        undoRow && event.status === 'open'
          ? { label: undoRow.label, at: undoRow.created_at }
          : null,
      twilioAvailable: this.twilioAvailable,
      retentionDays: this.cfg.retentionDays,
      isOptedOut: (phone) => this.isOptedOut(phone),
      canText: (p) => this.canText(event, p),
      now: this.now(),
    });
  }

  guestSnapshot(token: string): GuestSnapshot | null {
    const party = this.store.getPartyByToken(token);
    if (!party) return null;
    const event = this.getEvent(party.eventId);
    if (!event) return null;
    return buildGuestSnapshot(event, this.store.listParties(event.id), party, this.now());
  }

  /** Guest snapshots for many tokens of one event, loading the parties once. */
  guestSnapshots(eventId: string, partyIds: Iterable<string>): Map<string, GuestSnapshot> {
    const out = new Map<string, GuestSnapshot>();
    const event = this.store.getEvent(eventId);
    const parties = event ? this.store.listParties(eventId) : [];
    const byId = new Map(parties.map((p) => [p.id, p]));
    for (const id of partyIds) {
      const party = byId.get(id);
      if (event && party) out.set(id, buildGuestSnapshot(event, parties, party, this.now()));
    }
    return out;
  }

  /** The event a lobby display token belongs to: looked up by hash, compared in constant time. */
  lobbyEvent(token: string): EventRecord | null {
    if (!LOBBY_TOKEN_PATTERN.test(token)) return null;
    const event = this.store.getEventByLobbyHash(hashLobbyToken(token));
    if (!event || event.purgedAt || !event.lobbyToken) return null;
    return sameLobbyToken(event.lobbyToken, token) ? event : null;
  }

  /** G5 lobby display payload for a token, or null when it is unknown or was revoked. */
  lobbySnapshot(token: string): LobbySnapshot | null {
    const event = this.lobbyEvent(token);
    return event ? buildLobbySnapshot(event, this.store.listParties(event.id)) : null;
  }

  /** The event's current lobby token and payload, for broadcasting to open displays. */
  lobbyForEvent(eventId: string): { token: string; snapshot: LobbySnapshot } | null {
    const event = this.getEvent(eventId);
    if (!event?.lobbyToken) return null;
    return {
      token: event.lobbyToken,
      snapshot: buildLobbySnapshot(event, this.store.listParties(eventId)),
    };
  }

  /**
   * G5: makes a new lobby display link (replacing any old one, which stops working) or, with
   * `on` false, revokes it. Open displays on an old link are disconnected by the hub.
   */
  setLobbyLink(eventId: string, on: boolean): void {
    this.requireEvent(eventId, on ? { open: true } : {});
    const token = on ? newLobbyToken() : null;
    this.store.updateEvent(eventId, {
      lobbyToken: token,
      lobbyTokenHash: token ? hashLobbyToken(token) : null,
    });
    this.log.info({ event: eventId, lobby: on ? 'new link' : 'revoked' }, 'lobby link');
    this.onChange(eventId);
  }

  joinInfo(code: string): JoinInfo | null {
    const event = this.store.getEventByCode(code);
    if (!event || event.purgedAt) return null;
    return buildJoinInfo(
      event,
      this.store.listParties(event.id),
      event.smsMode === 'twilio' && this.twilioAvailable,
    );
  }

  /* --------------------------------------------------------------- texting */

  optOutHash(phone: string): string {
    return sha256(phone + this.optOutSalt);
  }

  isOptedOut(phone: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM opt_outs WHERE hash = ?').get(this.optOutHash(phone));
  }

  setOptOut(phone: string, optedOut: boolean): void {
    if (optedOut) {
      this.db
        .prepare('INSERT OR IGNORE INTO opt_outs (hash, created_at) VALUES (?, ?)')
        .run(this.optOutHash(phone), this.now());
    } else {
      this.db.prepare('DELETE FROM opt_outs WHERE hash = ?').run(this.optOutHash(phone));
    }
    const events = this.db
      .prepare(`SELECT DISTINCT event_id FROM parties WHERE phone = ?`)
      .all(phone) as { event_id: string }[];
    for (const e of events) this.onChange(e.event_id);
  }

  private usesTwilio(event: EventRecord): boolean {
    return event.smsMode === 'twilio' && this.twilio !== null;
  }

  canText(event: EventRecord, party: PartyRecord): boolean {
    if (!party.phone || party.noTexts) return false;
    if (party.source === 'self' ? !party.consent : !event.hostConsent) return false;
    if (this.usesTwilio(event) && !party.phone.startsWith('+1')) return false;
    return !this.isOptedOut(party.phone);
  }

  /** Turns effects into sms_log rows. Returns all ids and the ones Twilio must send. */
  private createTexts(
    event: EventRecord,
    parties: readonly PartyRecord[],
    effects: readonly TextEffect[],
    now: number,
  ): { ids: number[]; twilioIds: number[] } {
    const ids: number[] = [];
    const twilioIds: number[] = [];
    const footerGiven = new Set<string>();
    // Tap-to-send never sends from the server: its texts wait in the host's tray as `pending`.
    const eventProvider = this.usesTwilio(event) ? 'twilio' : tapToSend.name;
    for (const effect of effects) {
      const provider = effect.tray ? tapToSend.name : eventProvider;
      const party = parties.find((p) => p.id === effect.partyId);
      if (!party || !this.canText(event, party)) continue;
      const footer =
        provider === 'twilio' &&
        !footerGiven.has(party.phone!) &&
        !this.store.hasTwilioMessageTo(event.id, party.phone!);
      if (footer) footerGiven.add(party.phone!);
      const id = this.store.insertSms({
        eventId: event.id,
        partyId: party.id,
        template: effect.template,
        provider,
        status: provider === 'tap' ? 'pending' : 'sending',
        footer,
        createdAt: now,
      });
      ids.push(id);
      if (provider === 'twilio') twilioIds.push(id);
    }
    return { ids, twilioIds };
  }

  private dispatch(twilioIds: number[]): Promise<void> {
    if (!twilioIds.length) return Promise.resolve();
    return (async () => {
      for (const id of twilioIds) await this.sendTwilio(id);
    })().catch((err) => this.log.error({ err: (err as Error).message }, 'twilio dispatch failed'));
  }

  /** Last dispatch promise; tests await it. */
  pendingDispatch: Promise<void> = Promise.resolve();

  private async sendTwilio(id: number): Promise<void> {
    const sms = this.store.getSms(id);
    if (!sms || sms.status !== 'sending' || !this.twilio) return;
    const event = this.store.getEvent(sms.eventId);
    const parties = event ? this.store.listParties(event.id) : [];
    const party = parties.find((p) => p.id === sms.partyId);
    if (!event || !party?.phone) return;
    const now = this.now();
    // Re-check at send time: the number may have opted out, or the host may have switched the
    // party to "No texts", since the text was queued.
    if (!this.canText(event, party)) {
      this.store.setSmsStatus(
        id,
        'skipped',
        now,
        this.isOptedOut(party.phone) ? 'opted_out' : 'cannot_text',
      );
      this.onChange(event.id);
      return;
    }
    // The line resumed before this "we're paused" text went out: it no longer applies.
    if (sms.template === 'paused' && !event.paused) {
      this.store.setSmsStatus(id, 'canceled', now, 'resumed');
      this.onChange(event.id);
      return;
    }
    const body = renderBody(event, parties, party, sms.template, sms.footer);
    const result = await this.twilio.send(party.phone, body);
    const logCtx = { sms: id, to: maskPhone(party.phone), template: sms.template };
    if (result.status === 'sent') {
      this.store.setSmsStatus(id, 'sent', this.now(), null, result.providerId);
      this.log.info({ ...logCtx, status: 'sent' }, 'sms sent');
    } else if (result.status === 'failed') {
      this.store.setSmsStatus(id, 'failed', this.now(), result.message);
      this.log.warn({ ...logCtx, status: 'failed', code: result.code }, 'sms failed');
      if (result.code === TWILIO_UNSUBSCRIBED) this.setOptOut(party.phone, true);
    }
    this.onChange(event.id);
  }

  /* --------------------------------------------------------------- mutations */

  /**
   * Runs `fn` against the current parties in a transaction, persists changes, creates texts,
   * and pushes an Undo entry when `undoLabel` is given.
   */
  private mutate(
    eventId: string,
    undoLabel: string | null,
    fn: (parties: PartyRecord[], event: EventRecord, now: number) => MutationResult,
  ): MutationResult {
    const now = this.now();
    let twilioIds: number[] = [];
    const result = this.db.transaction(() => {
      const event = this.requireEvent(eventId, { open: true });
      const before = this.store.listParties(eventId);
      let r: MutationResult;
      try {
        r = fn(before, event, now);
      } catch (err) {
        if (err instanceof QueueError) {
          throw new ServiceError(409, err.code, QUEUE_ERROR_MESSAGES[err.code]);
        }
        throw err;
      }
      // E6: while the line is paused (as it is after `fn`), Up next texts wait for Resume.
      if (this.store.getEvent(eventId)?.paused) r = { ...r, ...holdUpNextTexts(r) };
      const old = new Map(before.map((p) => [p.id, p]));
      for (const q of r.parties) {
        const prev = old.get(q.id);
        // E8 export: record when a party is checked in; clear it when checked back out.
        const arrivedAt = !q.arrived ? null : prev?.arrived ? prev.arrivedAt : now;
        const p = arrivedAt === q.arrivedAt ? q : { ...q, arrivedAt };
        if (!prev) this.store.insertParty(p);
        else if (queueChanged(prev, p)) this.store.updatePartyQueue(p);
      }
      this.cancelStaleTexts(eventId, r.parties);
      const texts = this.createTexts(
        event,
        r.parties,
        [...r.effects, ...(r.extraEffects ?? [])],
        now,
      );
      twilioIds = texts.twilioIds;
      this.store.updateEvent(eventId, { lastActionAt: now });
      if (undoLabel) {
        this.db
          .prepare(
            // `samples` (the old wait-estimate data) is unused; the column is NOT NULL.
            `INSERT INTO undo_stack (event_id, label, snapshot, samples, sms_ids, event_state,
               created_at)
             VALUES (?, ?, ?, '[]', ?, ?, ?)`,
          )
          .run(
            eventId,
            undoLabel,
            JSON.stringify(takeSnapshot(before)),
            JSON.stringify(texts.ids),
            JSON.stringify({
              paused: event.paused,
              pauseMessage: event.pauseMessage,
              pausedAt: event.pausedAt,
            } satisfies EventState),
            now,
          );
        this.db
          .prepare(
            `DELETE FROM undo_stack WHERE event_id = ? AND id NOT IN
              (SELECT id FROM undo_stack WHERE event_id = ? ORDER BY id DESC LIMIT ?)`,
          )
          .run(eventId, eventId, UNDO_KEEP);
      }
      return r;
    })();
    this.pendingDispatch = this.dispatch(twilioIds);
    this.onChange(eventId);
    return result;
  }

  /** Drops tray texts that no longer apply, e.g. "Up next" for a party now being served. */
  private cancelStaleTexts(eventId: string, parties: readonly PartyRecord[]): void {
    const byId = new Map(parties.map((p) => [p.id, p]));
    const paused = !!this.store.getEvent(eventId)?.paused;
    for (const sms of this.store.listSms(eventId)) {
      if (sms.status !== 'pending') continue;
      const party = byId.get(sms.partyId);
      const stale = sms.template === 'paused' && !paused;
      if (!party || stale || !STILL_RELEVANT[sms.template].includes(party.state)) {
        this.store.setSmsStatus(sms.id, 'canceled', this.now());
      }
    }
  }

  callNext(eventId: string): MutationResult {
    return this.mutate(eventId, 'Call next', (parties, event, now) => {
      if (event.paused) throw PAUSED_ERROR();
      if (event.lastCallAt && now - event.lastCallAt < DEFAULTS.callNextDebounceMs) {
        throw new ServiceError(429, 'too_fast', 'Call next was just pressed.');
      }
      this.store.updateEvent(eventId, { lastCallAt: now });
      return queueCallNext(parties, event.upNextN, now);
    });
  }

  completeCurrent(eventId: string): MutationResult {
    return this.mutate(eventId, 'Done', (parties, event, now) =>
      completeCurrent(parties, event.upNextN, now),
    );
  }

  skipCurrent(eventId: string): MutationResult {
    return this.mutate(eventId, 'Not here', (parties, event, now) => {
      if (event.lastCallAt && now - event.lastCallAt < DEFAULTS.callNextDebounceMs) {
        throw new ServiceError(429, 'too_fast', 'Call next was just pressed.');
      }
      this.store.updateEvent(eventId, { lastCallAt: now });
      // E6: while paused, "Not here" marks the party missed but calls nobody else.
      return skipCurrent(parties, event.upNextN, now, DEFAULTS.maxSkips, !event.paused);
    });
  }

  serveNow(eventId: string, partyId: string): MutationResult {
    return this.mutate(eventId, 'Serve now', (parties, event, now) => {
      this.store.updateEvent(eventId, { lastCallAt: now });
      return queueServeNow(parties, partyId, event.upNextN, now);
    });
  }

  move(eventId: string, partyId: string, direction: MoveDirection): MutationResult {
    const label =
      direction === 'next' ? 'Move to next' : direction === 'up' ? 'Move up' : 'Move down';
    return this.mutate(eventId, label, (parties, event) =>
      queueMove(parties, partyId, direction, event.upNextN),
    );
  }

  remove(eventId: string, partyId: string): MutationResult {
    return this.mutate(eventId, 'Remove', (parties, event, now) =>
      removeParty(parties, partyId, event.upNextN, now),
    );
  }

  reinsert(eventId: string, partyId: string): MutationResult {
    return this.mutate(eventId, 'Back in line', (parties, event) =>
      queueReinsert(parties, partyId, event.upNextN),
    );
  }

  setArrived(eventId: string, partyId: string, arrived: boolean): MutationResult {
    return this.mutate(eventId, arrived ? 'Check in' : 'Not arrived', (parties, event) =>
      queueSetArrived(parties, partyId, arrived, event.upNextN),
    );
  }

  /**
   * E6 Pause the line, with an optional short message for guests. When `notify` is true, one
   * "we're paused" text is queued for each party waiting (tap-to-send tray or Twilio, per the
   * event), subject to the same No texts, consent and opt-out checks as every other text.
   */
  pause(eventId: string, input: { message?: unknown; notify?: unknown }): MutationResult {
    const message = cleanPauseMessage(input.message);
    return this.mutate(eventId, 'Pause', (parties, event, now) => {
      if (event.paused)
        throw new ServiceError(409, 'already_paused', 'The line is already paused.');
      this.store.updateEvent(eventId, { paused: true, pauseMessage: message, pausedAt: now });
      const extraEffects = input.notify === true ? pausedTextEffects(parties) : [];
      return { parties, effects: [], extraEffects };
    });
  }

  /** E6 Resume: Call next works again and the Up next texts held during the pause go out. */
  resume(eventId: string): MutationResult {
    return this.mutate(eventId, 'Resume', (parties, event) => {
      if (!event.paused) throw new ServiceError(409, 'not_paused', 'The line is not paused.');
      this.store.updateEvent(eventId, { paused: false, pauseMessage: null, pausedAt: null });
      return recomputeUpNext(parties, event.upNextN);
    });
  }

  /** G4: the guest taps "I'm here" on their status page. */
  guestArrive(token: string): GuestSnapshot {
    const party = this.store.getPartyByToken(token);
    if (!party) throw new ServiceError(404, 'not_found', 'Not found.');
    if (party.state !== 'waiting' && party.state !== 'up_next') {
      throw new ServiceError(409, 'not_active', 'You are not waiting in line.');
    }
    if (!party.arrived) {
      this.mutate(party.eventId, null, (parties, event) =>
        queueSetArrived(parties, party.id, true, event.upNextN),
      );
    }
    return this.guestSnapshot(token)!;
  }

  undo(eventId: string): { label: string } {
    let label = '';
    this.mutate(eventId, null, (parties, event) => {
      const row = this.db
        .prepare('SELECT * FROM undo_stack WHERE event_id = ? ORDER BY id DESC LIMIT 1')
        .get(eventId) as
        | {
            id: number;
            label: string;
            snapshot: string;
            sms_ids: string;
            event_state: string | null;
          }
        | undefined;
      if (!row) throw new ServiceError(409, 'nothing_to_undo', 'Nothing to undo.');
      label = row.label;
      // Steps saved before pause existed carry no event state; the pause state then stays.
      if (row.event_state) {
        const state = JSON.parse(row.event_state) as EventState;
        this.store.updateEvent(eventId, {
          paused: !!state.paused,
          pauseMessage: state.pauseMessage ?? null,
          pausedAt: state.pausedAt ?? null,
        });
      }
      const alreadyTexted = new Set<string>();
      for (const id of JSON.parse(row.sms_ids) as number[]) {
        const sms = this.store.getSms(id);
        if (!sms) continue;
        if (sms.status === 'pending') this.store.setSmsStatus(id, 'canceled', this.now());
        else if (sms.template === 'up_next') alreadyTexted.add(sms.partyId);
      }
      this.db.prepare('DELETE FROM undo_stack WHERE id = ?').run(row.id);
      const snapshot = JSON.parse(row.snapshot) as QueueSnapshot;
      return restoreSnapshot(parties, snapshot, event.upNextN, alreadyTexted);
    });
    return { label };
  }

  /** Validates party input with the same rules as the import preview (§2.7, §2.8). */
  private validateParty(input: Partial<ImportPartyInput>, row = 1): ImportPartyInput {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ServiceError(400, 'bad_row', `Row ${row} is not a party.`, { row });
    }
    const members = Array.isArray(input.members) ? input.members.map((m) => String(m)) : [];
    const draft = {
      name: typeof input.name === 'string' ? input.name : '',
      phone: String(input.phone ?? input.phoneInvalidInput ?? ''),
      size: input.size === undefined || input.size === null ? '' : String(input.size),
      members: members.join('; '),
      group: typeof input.group === 'string' ? input.group : '',
      notes: typeof input.notes === 'string' ? input.notes : '',
    };
    const v = validateDraft(draft, row);
    if (hasErrors(v)) {
      const first = v.issues.find((i) => i.level === 'error')!;
      throw new ServiceError(400, first.code, first.message, { row });
    }
    return {
      name: v.name,
      phone: v.phone,
      phoneInvalidInput: v.phoneInvalidInput,
      size: v.size,
      members: v.members,
      group: v.group,
      notes: v.notes,
    };
  }

  addParties(
    eventId: string,
    inputs: Partial<ImportPartyInput>[],
    opts: AddOptions,
  ): PartyRecord[] {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ServiceError(400, 'no_rows', 'Nothing to add.');
    }
    if (inputs.length > LIMITS.importRowsMax) {
      throw new ServiceError(
        400,
        'too_many_rows',
        `At most ${LIMITS.importRowsMax} rows per import.`,
      );
    }
    const valid = inputs.map((input, i) => this.validateParty(input, i + 1));
    let added: PartyRecord[] = [];
    this.mutate(eventId, null, (parties, event, now) => {
      const active = parties.filter((p) => p.state === 'waiting' || p.state === 'up_next').length;
      if (active + valid.length > LIMITS.activePartiesMax) {
        throw new ServiceError(
          409,
          'line_full',
          `The line is full (${LIMITS.activePartiesMax} parties max).`,
        );
      }
      if (opts.consentConfirmed && !event.hostConsent) {
        event.hostConsent = true;
        this.store.updateEvent(eventId, { hostConsent: true });
      }
      let ticket = event.nextTicket;
      added = valid.map((v) => ({
        ...v,
        id: newId(),
        eventId,
        token: newStatusToken(),
        ticket: ticket++,
        source: opts.source,
        consent: opts.source === 'self' ? !!opts.consent && !!v.phone : false,
        noTexts: false,
        state: 'waiting' as const,
        sortKey: 0,
        arrived: opts.arrived,
        skipCount: 0,
        upNextSent: false,
        calledAt: null,
        doneAt: null,
        createdAt: now,
        arrivedAt: null,
      }));
      this.store.updateEvent(eventId, { nextTicket: ticket });
      const r = addToQueue(parties, added, event.upNextN, opts.position);
      const upNextTexted = new Set(r.effects.map((e) => e.partyId));
      // QA #15: anyone with the QR code can self-join with any US number, and each join text
      // costs the owner money in Twilio mode. Past the hourly cap the party still joins, and its
      // join text waits in the host's tray instead of going out automatically.
      const tray =
        opts.source === 'self' && this.usesTwilio(event) && this.selfJoinTextCapReached(event, now);
      const joinTexts: TextEffect[] = opts.sendJoinText
        ? added
            .filter((p) => !upNextTexted.has(p.id))
            .map((p) => ({ partyId: p.id, template: 'join' as const, tray }))
        : [];
      added = added.map((a) => r.parties.find((p) => p.id === a.id)!);
      return { ...r, extraEffects: joinTexts };
    });
    return added;
  }

  /**
   * Twilio join texts for self-joins in the last hour have reached the cap (QA #15). Broadcast
   * "we're paused" texts (E6) count toward it too.
   */
  private selfJoinTextCapReached(event: EventRecord, now: number): boolean {
    const { n } = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sms_log s JOIN parties p ON p.id = s.party_id
         WHERE s.event_id = ? AND s.provider = 'twilio' AND s.created_at > ?
           AND ((s.template = 'join' AND p.source = 'self') OR s.template = 'paused')`,
      )
      .get(event.id, now - 3_600_000) as { n: number };
    const reached = n >= this.cfg.selfJoinTextsPerHour;
    if (reached) this.log.warn({ event: event.id }, 'self-join text cap reached; using the tray');
    return reached;
  }

  /** A5 self-join. One active party per phone: a duplicate returns the existing link. */
  selfJoin(
    code: string,
    input: { name?: unknown; phone?: unknown; size?: unknown; consent?: unknown },
  ): { token: string; existing: boolean } {
    const event = this.store.getEventByCode(code);
    if (!event || event.purgedAt) throw new ServiceError(404, 'not_found', 'Event not found.');
    if (event.status !== 'open' || !event.selfJoin) {
      throw new ServiceError(409, 'closed', "The line isn't taking new people right now.");
    }
    const phoneText = typeof input.phone === 'string' ? input.phone : '';
    const v = this.validateParty({
      name: typeof input.name === 'string' ? input.name : '',
      phone: phoneText,
      size: clampInt(input.size, LIMITS.partySizeMin, LIMITS.partySizeMax, 1),
    });
    if (v.phoneInvalidInput) {
      throw new ServiceError(400, 'invalid_phone', 'Please check your mobile number.');
    }
    if (v.phone && this.usesTwilio(event) && !v.phone.startsWith('+1')) {
      throw new ServiceError(400, 'us_only', 'Texts only go to US mobile numbers.');
    }
    if (v.phone) {
      const existing = this.store
        .listParties(event.id)
        .find(
          (p) =>
            p.phone === v.phone &&
            (p.state === 'waiting' || p.state === 'up_next' || p.state === 'now_serving'),
        );
      if (existing) return { token: existing.token, existing: true };
    }
    const [party] = this.addParties(event.id, [v], {
      source: 'self',
      arrived: true,
      position: 'end',
      sendJoinText: true,
      consent: input.consent === true,
    });
    return { token: party.token, existing: false };
  }

  updateParty(
    eventId: string,
    partyId: string,
    patch: Partial<ImportPartyInput> & { noTexts?: boolean },
  ): void {
    this.requireEvent(eventId, { open: true });
    const party = this.store.listParties(eventId).find((p) => p.id === partyId);
    if (!party) throw new ServiceError(404, 'not_found', 'Party not found.');
    const phoneGiven = patch.phone !== undefined || patch.phoneInvalidInput !== undefined;
    const v = this.validateParty({
      name: patch.name ?? party.name,
      phone: phoneGiven
        ? (patch.phone ?? patch.phoneInvalidInput ?? '')
        : (party.phone ?? party.phoneInvalidInput ?? ''),
      size: patch.size ?? party.size,
      members: patch.members ?? party.members,
      group: patch.group !== undefined ? (patch.group ?? '') : (party.group ?? ''),
      notes: patch.notes !== undefined ? (patch.notes ?? '') : (party.notes ?? ''),
    });
    this.store.updatePartyDetails(partyId, {
      ...v,
      noTexts: typeof patch.noTexts === 'boolean' ? patch.noTexts : party.noTexts,
    });
    this.store.updateEvent(eventId, { lastActionAt: this.now() });
    this.onChange(eventId);
  }

  /** "Text now" from Party actions: the template follows the party's state. */
  textParty(eventId: string, partyId: string): void {
    this.mutate(eventId, null, (parties, event) => {
      const party = parties.find((p) => p.id === partyId);
      if (!party) throw new ServiceError(404, 'not_found', 'Party not found.');
      if (!this.canText(event, party)) {
        throw new ServiceError(409, 'cannot_text', "This party can't be texted.");
      }
      const waiting = party.state === 'waiting' || party.state === 'up_next';
      // E6: while paused, a waiting party is told the line is paused, not to come forward.
      const template: TemplateKey =
        event.paused && waiting
          ? 'paused'
          : party.state === 'now_serving'
            ? 'your_turn'
            : party.state === 'up_next'
              ? 'up_next'
              : party.state === 'skipped' || party.state === 'no_show'
                ? 'skipped'
                : 'join';
      return { parties, effects: [{ partyId, template }] };
    });
  }

  /** Tap-to-send tray: mark a message sent, skipped, or back to pending ("Didn't send"). */
  markText(eventId: string, smsId: number, status: TextStatus): void {
    if (!['sent', 'skipped', 'pending'].includes(status)) {
      throw new ServiceError(400, 'invalid_status', 'Invalid status.');
    }
    const sms = this.store.getSms(smsId);
    if (!sms || sms.eventId !== eventId || sms.provider !== 'tap') {
      throw new ServiceError(404, 'not_found', 'Text not found.');
    }
    this.store.setSmsStatus(smsId, status, this.now());
    this.onChange(eventId);
  }

  updateSettings(eventId: string, patch: Partial<EventSettings>): void {
    const event = this.requireEvent(eventId, { open: true });
    const update: Partial<EventRecord> = {};
    if (patch.name !== undefined) {
      const name = text(patch.name, 1000);
      if (!name || name.length > LIMITS.eventNameMax) {
        throw new ServiceError(
          400,
          'invalid_name',
          `Event name must be 1–${LIMITS.eventNameMax} characters.`,
        );
      }
      update.name = name;
    }
    if (patch.smsName !== undefined)
      update.smsName = text(patch.smsName, LIMITS.smsEventNameMax) || null;
    if (patch.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(patch.date))
      update.date = patch.date;
    if (patch.smsMode !== undefined) {
      if (patch.smsMode === 'twilio' && !this.twilio) {
        throw new ServiceError(
          400,
          'twilio_unavailable',
          'Twilio is not configured on the server.',
        );
      }
      update.smsMode = patch.smsMode === 'twilio' ? 'twilio' : 'tap';
    }
    if (typeof patch.selfJoin === 'boolean') update.selfJoin = patch.selfJoin;
    if (typeof patch.showNames === 'boolean') update.showNames = patch.showNames;
    const newN =
      patch.upNextN !== undefined
        ? clampInt(patch.upNextN, LIMITS.upNextMin, LIMITS.upNextMax, event.upNextN)
        : event.upNextN;
    update.lastActionAt = this.now();
    this.store.updateEvent(eventId, update);
    if (newN !== event.upNextN) {
      this.store.updateEvent(eventId, { upNextN: newN });
      this.mutate(eventId, null, (parties) => recomputeUpNext(parties, newN));
    } else {
      this.onChange(eventId);
    }
  }

  /**
   * E8 results export for photo ordering, open or closed, until the retention purge (after
   * which the event is gone and this is a 404). Times are local to `timeZone` (else UTC).
   */
  resultsCsv(eventId: string, timeZone: unknown): { fileName: string; csv: string } {
    const event = this.requireEvent(eventId);
    const parties = this.store.listParties(eventId);
    this.log.info({ event: eventId, rows: parties.length }, 'results exported');
    return {
      fileName: resultsFileName(event.name, event.date),
      csv: buildResultsCsv(parties, typeof timeZone === 'string' ? timeZone : 'UTC'),
    };
  }

  /** E5 close: stops self-join and status updates, and signs out every host device. */
  close(eventId: string): void {
    this.requireEvent(eventId);
    const now = this.now();
    this.store.updateEvent(eventId, { status: 'closed', closedAt: now, lastActionAt: now });
    this.sessions.deleteAll(eventId);
    this.log.info({ event: eventId }, 'event closed');
    this.onChange(eventId);
  }

  /** E5 "Delete now": purge party data immediately. */
  deleteNow(eventId: string): void {
    this.requireEvent(eventId);
    purgeEvent(this.db, eventId, this.now());
    this.log.info({ event: eventId }, 'event purged');
    this.onChange(eventId);
  }
}
