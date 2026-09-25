/** Queue states (FEATURES §2.1). `removed` parties vanish from lists. */
export type PartyState =
  'waiting' | 'up_next' | 'now_serving' | 'done' | 'skipped' | 'no_show' | 'removed';

export const PARTY_STATES: readonly PartyState[] = [
  'waiting',
  'up_next',
  'now_serving',
  'done',
  'skipped',
  'no_show',
  'removed',
];

export type SmsMode = 'tap' | 'twilio';

export type TemplateKey = 'join' | 'up_next' | 'your_turn' | 'skipped' | 'paused';

export type PartySource = 'manual' | 'import' | 'vcard' | 'contacts' | 'self';

export type EventStatus = 'open' | 'closed';

/** The fields the queue state machine needs. Server rows extend this. */
export interface QueueParty {
  id: string;
  ticket: number;
  state: PartyState;
  sortKey: number;
  /** A8: imported parties start as not arrived and are skipped by Call next. */
  arrived: boolean;
  skipCount: number;
  /** Up next SMS is sent once per queue entry (§2.2). */
  upNextSent: boolean;
  calledAt: number | null;
  doneAt: number | null;
}

export type TextStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'canceled';

export interface HostPartyText {
  template: TemplateKey;
  status: TextStatus;
  at: number;
}

/** Party as seen by an authenticated host device. */
export interface HostParty extends QueueParty {
  name: string;
  size: number;
  members: string[];
  /** E.164, or null when blank or invalid. */
  phone: string | null;
  /** The raw input when the phone could not be normalized (shown with a warning icon). */
  phoneInvalidInput: string | null;
  group: string | null;
  notes: string | null;
  source: PartySource;
  noTexts: boolean;
  optedOut: boolean;
  /** Whether the app would text this party right now. */
  canText: boolean;
  token: string;
  createdAt: number;
  lastText: HostPartyText | null;
}

export interface PendingText {
  id: number;
  partyId: string;
  template: TemplateKey;
  /** E.164 recipient. The body is rendered on the device with `renderPartyText`. */
  to: string;
  createdAt: number;
}

export interface EventSettings {
  name: string;
  smsName: string | null;
  date: string;
  upNextN: number;
  smsMode: SmsMode;
  selfJoin: boolean;
  showNames: boolean;
}

export interface HostEventInfo extends EventSettings {
  id: string;
  code: string;
  status: EventStatus;
  joinUrl: string;
  /** Base of texted status links, so host devices can render tray texts themselves. */
  publicUrl: string;
  hostConsent: boolean;
  createdAt: number;
  closedAt: number | null;
  /** E6: the host paused the line. Call next is off and Up next texts wait until Resume. */
  paused: boolean;
  /** Optional short note shown to guests while paused, e.g. "Back in 10 minutes". */
  pauseMessage: string | null;
  pausedAt: number | null;
  /** G5: the read-only TV display link, or null when the host has not made one (or revoked it). */
  lobbyUrl: string | null;
}

export interface HostSnapshot {
  event: HostEventInfo;
  parties: HostParty[];
  pendingTexts: PendingText[];
  undo: { label: string; at: number } | null;
  twilioAvailable: boolean;
  /** Days after close before guest data is purged (§2.12, env RETENTION_DAYS). */
  retentionDays: number;
  serverTime: number;
}

export interface GuestPartyRef {
  ticket: number;
  /** Privacy-filtered ("Emma R."), or null when names are hidden. */
  name: string | null;
  isMe: boolean;
}

export interface GuestSnapshot {
  eventName: string;
  eventEnded: boolean;
  me: {
    ticket: number;
    /**
     * The guest's own party name, privacy-filtered like everyone else's ("Emma R."): a status
     * link can be forwarded, and a self-join with a known phone returns that party's link.
     */
    name: string;
    size: number;
    state: PartyState;
    arrived: boolean;
    position: number | null;
    hasPhone: boolean;
  } | null;
  nowServing: GuestPartyRef | null;
  comingUp: GuestPartyRef[];
  upNextN: number;
  selfJoin: boolean;
  joinCode: string;
  /** E6: the line is paused, with the host's optional message. */
  paused: boolean;
  pauseMessage: string | null;
  serverTime: number;
}

/** A party on the lobby display: ticket and privacy-filtered name ("Emma R."), nothing else. */
export interface LobbyPartyRef {
  ticket: number;
  /** Null when the host hides names from guests (ticket numbers only). */
  name: string | null;
}

/**
 * G5 lobby / TV display. Built from an allowlist: it shows no more than a guest status page
 * does (no phone numbers, party ids, status tokens, notes, members or sizes).
 */
export interface LobbySnapshot {
  eventName: string;
  eventEnded: boolean;
  paused: boolean;
  pauseMessage: string | null;
  nowServing: LobbyPartyRef | null;
  /** The next parties Call next will take, in order (at most `DEFAULTS.lobbyComingUp`). */
  comingUp: LobbyPartyRef[];
  /** Self-join link and its QR code, or null when joining is off or the event ended. */
  joinUrl: string | null;
  joinQrUrl: string | null;
}

export interface JoinInfo {
  eventName: string;
  open: boolean;
  selfJoin: boolean;
  lineLength: number;
  smsMode: SmsMode;
  full: boolean;
}

export type WsMessage =
  | { type: 'host'; data: HostSnapshot }
  | { type: 'guest'; data: GuestSnapshot }
  | { type: 'lobby'; data: LobbySnapshot }
  | { type: 'ping' };
