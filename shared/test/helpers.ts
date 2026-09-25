import type { PartyState, QueueParty } from '../src/types.js';

export function party(
  ticket: number,
  state: PartyState = 'waiting',
  extra: Partial<QueueParty> = {},
): QueueParty {
  return {
    id: `p${ticket}`,
    ticket,
    state,
    sortKey: ticket,
    arrived: true,
    skipCount: 0,
    upNextSent: false,
    calledAt: null,
    doneAt: null,
    ...extra,
  };
}

export function line(count: number, extra: Partial<QueueParty> = {}): QueueParty[] {
  return Array.from({ length: count }, (_, i) => party(i + 1, 'waiting', extra));
}

export function states(parties: readonly QueueParty[]): Record<string, PartyState> {
  return Object.fromEntries(parties.map((p) => [p.id, p.state]));
}

export function order(parties: readonly QueueParty[]): string[] {
  return parties
    .filter((p) => p.state === 'waiting' || p.state === 'up_next')
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((p) => p.id);
}
