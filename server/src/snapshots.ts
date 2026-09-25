/** Builds the payloads sent to host and guest pages. Guest payloads are privacy-filtered. */
import {
  DEFAULTS,
  findNowServing,
  orderActive,
  positionOf,
  publicName,
  renderPartyText,
  statusUrl,
  type GuestPartyRef,
  type GuestSnapshot,
  type HostEventInfo,
  type HostParty,
  type HostPartyText,
  type HostSnapshot,
  type JoinInfo,
  type LobbyPartyRef,
  type LobbySnapshot,
  type PendingText,
  type TemplateKey,
  LIMITS,
} from '@pby/shared';
import { lobbyUrl } from './lobby.js';
import type { EventRecord, PartyRecord, SmsLogRecord } from './store.js';

export function statusLink(event: EventRecord, party: PartyRecord): string {
  return statusUrl(event.publicUrl, party.token);
}

export function joinLink(event: EventRecord): string {
  return `${event.publicUrl}/j/${event.code}`;
}

export function renderBody(
  event: EventRecord,
  parties: readonly PartyRecord[],
  party: PartyRecord,
  template: TemplateKey,
  stopFooter: boolean,
): string {
  return renderPartyText(event, parties, party, template, { stopFooter });
}

export function hostEventInfo(event: EventRecord): HostEventInfo {
  return {
    id: event.id,
    code: event.code,
    name: event.name,
    smsName: event.smsName,
    date: event.date,
    upNextN: event.upNextN,
    smsMode: event.smsMode,
    selfJoin: event.selfJoin,
    showNames: event.showNames,
    status: event.status,
    joinUrl: joinLink(event),
    publicUrl: event.publicUrl,
    hostConsent: event.hostConsent,
    createdAt: event.createdAt,
    closedAt: event.closedAt,
    paused: event.paused,
    pauseMessage: event.pauseMessage,
    pausedAt: event.pausedAt,
    lobbyUrl: event.lobbyToken ? lobbyUrl(event.publicUrl, event.lobbyToken) : null,
  };
}

export interface HostSnapshotInput {
  event: EventRecord;
  parties: PartyRecord[];
  sms: SmsLogRecord[];
  undo: { label: string; at: number } | null;
  twilioAvailable: boolean;
  retentionDays: number;
  isOptedOut: (phone: string) => boolean;
  canText: (party: PartyRecord) => boolean;
  now: number;
}

export function buildHostSnapshot(input: HostSnapshotInput): HostSnapshot {
  const { event, parties, sms } = input;
  const lastText = new Map<string, HostPartyText>();
  for (const s of sms) {
    if (s.status === 'canceled') continue;
    lastText.set(s.partyId, { template: s.template, status: s.status, at: s.updatedAt });
  }
  const byId = new Map(parties.map((p) => [p.id, p]));
  const hostParties: HostParty[] = parties.map((p) => ({
    id: p.id,
    ticket: p.ticket,
    state: p.state,
    sortKey: p.sortKey,
    arrived: p.arrived,
    skipCount: p.skipCount,
    upNextSent: p.upNextSent,
    calledAt: p.calledAt,
    doneAt: p.doneAt,
    name: p.name,
    size: p.size,
    members: p.members,
    phone: p.phone,
    phoneInvalidInput: p.phoneInvalidInput,
    group: p.group,
    notes: p.notes,
    source: p.source,
    noTexts: p.noTexts,
    optedOut: p.phone ? input.isOptedOut(p.phone) : false,
    canText: input.canText(p),
    token: p.token,
    createdAt: p.createdAt,
    lastText: lastText.get(p.id) ?? null,
  }));
  const pendingTexts: PendingText[] = [];
  for (const s of sms) {
    if (s.status !== 'pending' || s.provider !== 'tap') continue;
    // E6: no Up next texts while paused. Ones queued before the pause wait here until Resume.
    if (event.paused && s.template === 'up_next') continue;
    const party = byId.get(s.partyId);
    // Turned to "No texts", opted out or lost consent since it was queued: never offer it.
    if (!party?.phone || !input.canText(party)) continue;
    pendingTexts.push({
      id: s.id,
      partyId: s.partyId,
      template: s.template,
      to: party.phone,
      createdAt: s.createdAt,
    });
  }
  return {
    event: hostEventInfo(event),
    parties: hostParties,
    pendingTexts,
    undo: input.undo,
    twilioAvailable: input.twilioAvailable,
    retentionDays: input.retentionDays,
    serverTime: input.now,
  };
}

function ref(event: EventRecord, p: PartyRecord, meId: string): GuestPartyRef {
  return { ticket: p.ticket, name: publicName(p.name, event.showNames), isMe: p.id === meId };
}

export function buildGuestSnapshot(
  event: EventRecord,
  parties: readonly PartyRecord[],
  party: PartyRecord,
  now: number,
): GuestSnapshot {
  const ended = event.status === 'closed';
  const base = {
    eventName: event.name,
    eventEnded: ended,
    upNextN: event.upNextN,
    selfJoin: event.selfJoin && !ended,
    joinCode: event.code,
    paused: event.paused && !ended,
    pauseMessage: event.paused && !ended ? event.pauseMessage : null,
    serverTime: now,
  };
  if (ended) return { ...base, me: null, nowServing: null, comingUp: [] };
  const position = positionOf(parties, party.id);
  const serving = findNowServing(parties);
  const comingUp = orderActive(parties)
    .filter((p) => p.arrived)
    .slice(0, 3)
    .map((p) => ref(event, p, party.id));
  return {
    ...base,
    me: {
      ticket: party.ticket,
      name: publicName(party.name, true) ?? '',
      size: party.size,
      state: party.state,
      arrived: party.arrived,
      position,
      hasPhone: !!party.phone && !party.noTexts,
    },
    nowServing: serving ? ref(event, serving, party.id) : null,
    comingUp,
  };
}

function lobbyRef(event: EventRecord, p: PartyRecord): LobbyPartyRef {
  return { ticket: p.ticket, name: publicName(p.name, event.showNames) };
}

/**
 * G5 lobby display payload, built field by field from an allowlist: the event name, the pause
 * state and message, tickets with privacy-filtered names (G2), and the public join link. It
 * never carries phone numbers, party ids, status tokens, notes, members or party sizes.
 */
export function buildLobbySnapshot(
  event: EventRecord,
  parties: readonly PartyRecord[],
): LobbySnapshot {
  const ended = event.status === 'closed';
  const serving = ended ? undefined : findNowServing(parties);
  const joinOpen = event.selfJoin && !ended;
  return {
    eventName: event.name,
    eventEnded: ended,
    paused: event.paused && !ended,
    pauseMessage: event.paused && !ended ? event.pauseMessage : null,
    nowServing: serving ? lobbyRef(event, serving) : null,
    comingUp: ended
      ? []
      : orderActive(parties)
          .filter((p) => p.arrived)
          .slice(0, DEFAULTS.lobbyComingUp)
          .map((p) => lobbyRef(event, p)),
    joinUrl: joinOpen ? joinLink(event) : null,
    joinQrUrl: joinOpen ? `/api/join/${event.code}/qr.svg` : null,
  };
}

export function buildJoinInfo(
  event: EventRecord,
  parties: readonly PartyRecord[],
  twilioActive: boolean,
): JoinInfo {
  const active = parties.filter((p) => p.state === 'waiting' || p.state === 'up_next').length;
  return {
    eventName: event.name,
    open: event.status === 'open',
    selfJoin: event.selfJoin,
    lineLength: orderActive(parties).filter((p) => p.arrived).length,
    smsMode: twilioActive ? 'twilio' : 'tap',
    full: active >= LIMITS.activePartiesMax,
  };
}
