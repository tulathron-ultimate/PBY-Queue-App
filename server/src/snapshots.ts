/** Builds the payloads sent to host and guest pages. Guest payloads are privacy-filtered. */
import {
  averageMinutes,
  estimateWaitMinutes,
  findNowServing,
  formatWait,
  orderActive,
  partiesAheadForNewcomer,
  partiesAheadForWait,
  positionOf,
  publicName,
  renderSms,
  smsEventName,
  waitForSms,
  type GuestPartyRef,
  type GuestSnapshot,
  type HostEventInfo,
  type HostParty,
  type HostPartyText,
  type HostSnapshot,
  type JoinInfo,
  type PendingText,
  type TemplateKey,
  LIMITS,
} from '@pby/shared';
import type { EventRecord, PartyRecord, SmsLogRecord } from './store.js';

export function statusLink(event: EventRecord, party: PartyRecord): string {
  return `${event.publicUrl}/s/${party.token}`;
}

export function joinLink(event: EventRecord): string {
  return `${event.publicUrl}/j/${event.code}`;
}

export function avgMinutesFor(event: EventRecord): number {
  return averageMinutes(event.samples, event.minutesPerParty);
}

export function renderBody(
  event: EventRecord,
  parties: readonly PartyRecord[],
  party: PartyRecord,
  template: TemplateKey,
  stopFooter: boolean,
): string {
  const pos = positionOf(parties, party.id);
  const ahead = partiesAheadForWait(parties, party.id) ?? partiesAheadForNewcomer(parties);
  const wait = estimateWaitMinutes(ahead, avgMinutesFor(event));
  return renderSms(
    template,
    {
      event: smsEventName(event.name, event.smsName),
      name: party.name,
      pos: pos ?? '',
      wait: waitForSms(wait),
      ticket: party.ticket,
      link: statusLink(event, party),
    },
    { stopFooter },
  );
}

export function hostEventInfo(event: EventRecord): HostEventInfo {
  return {
    id: event.id,
    code: event.code,
    name: event.name,
    smsName: event.smsName,
    date: event.date,
    upNextN: event.upNextN,
    minutesPerParty: event.minutesPerParty,
    smsMode: event.smsMode,
    selfJoin: event.selfJoin,
    showNames: event.showNames,
    status: event.status,
    joinUrl: joinLink(event),
    hostConsent: event.hostConsent,
    createdAt: event.createdAt,
    closedAt: event.closedAt,
  };
}

export interface HostSnapshotInput {
  event: EventRecord;
  parties: PartyRecord[];
  sms: SmsLogRecord[];
  undo: { label: string; at: number } | null;
  twilioAvailable: boolean;
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
    const party = byId.get(s.partyId);
    if (!party?.phone) continue;
    pendingTexts.push({
      id: s.id,
      partyId: s.partyId,
      template: s.template,
      to: party.phone,
      body: renderBody(event, parties, party, s.template, false),
      createdAt: s.createdAt,
    });
  }
  return {
    event: hostEventInfo(event),
    parties: hostParties,
    pendingTexts,
    undo: input.undo,
    avgMinutes: avgMinutesFor(event),
    twilioAvailable: input.twilioAvailable,
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
    serverTime: now,
  };
  if (ended) return { ...base, me: null, nowServing: null, comingUp: [] };
  const position = positionOf(parties, party.id);
  const ahead = partiesAheadForWait(parties, party.id);
  const waitMinutes = ahead === null ? null : estimateWaitMinutes(ahead, avgMinutesFor(event));
  const serving = findNowServing(parties);
  const comingUp = orderActive(parties)
    .filter((p) => p.arrived)
    .slice(0, 3)
    .map((p) => ref(event, p, party.id));
  return {
    ...base,
    me: {
      ticket: party.ticket,
      name: party.name,
      size: party.size,
      state: party.state,
      arrived: party.arrived,
      position,
      waitMinutes,
      waitText: waitMinutes === null ? null : formatWait(waitMinutes),
      hasPhone: !!party.phone && !party.noTexts,
    },
    nowServing: serving ? ref(event, serving, party.id) : null,
    comingUp,
  };
}

export function buildJoinInfo(
  event: EventRecord,
  parties: readonly PartyRecord[],
  twilioActive: boolean,
): JoinInfo {
  const ahead = partiesAheadForNewcomer(parties);
  const active = parties.filter((p) => p.state === 'waiting' || p.state === 'up_next').length;
  return {
    eventName: event.name,
    open: event.status === 'open',
    selfJoin: event.selfJoin,
    lineLength: orderActive(parties).filter((p) => p.arrived).length,
    waitText: formatWait(estimateWaitMinutes(ahead, avgMinutesFor(event))),
    smsMode: twilioActive ? 'twilio' : 'tap',
    full: active >= LIMITS.activePartiesMax,
  };
}
