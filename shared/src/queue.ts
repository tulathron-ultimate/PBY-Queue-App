/**
 * The queue state machine (DECISIONS "Core queue flow", FEATURES §2.1–§2.6).
 *
 * Every function is pure: it takes the current parties of one event and returns a new
 * array plus the SMS effects the action should trigger. The server is the only caller
 * that persists results; the web app uses the read helpers for display.
 */
import { DEFAULTS } from './limits.js';
import type { PartyState, QueueParty, TemplateKey } from './types.js';

export interface SmsEffect {
  partyId: string;
  template: TemplateKey;
}

export interface QueueResult<T extends QueueParty> {
  parties: T[];
  effects: SmsEffect[];
}

export type QueueErrorCode =
  'queue_empty' | 'nobody_serving' | 'not_found' | 'not_active' | 'not_missed' | 'already_there';

export class QueueError extends Error {
  constructor(public readonly code: QueueErrorCode) {
    super(code);
    this.name = 'QueueError';
  }
}

const ACTIVE_STATES: ReadonlySet<PartyState> = new Set(['waiting', 'up_next']);
const MISSED_STATES: ReadonlySet<PartyState> = new Set(['skipped', 'no_show']);

export function isActive(p: Pick<QueueParty, 'state'>): boolean {
  return ACTIVE_STATES.has(p.state);
}

export function isMissed(p: Pick<QueueParty, 'state'>): boolean {
  return MISSED_STATES.has(p.state);
}

function byOrder(a: QueueParty, b: QueueParty): number {
  return a.sortKey - b.sortKey || a.ticket - b.ticket;
}

/** Active (`waiting` + `up_next`) parties in queue order. */
export function orderActive<T extends QueueParty>(parties: readonly T[]): T[] {
  return parties.filter(isActive).sort(byOrder);
}

export function findNowServing<T extends QueueParty>(parties: readonly T[]): T | undefined {
  return parties.find((p) => p.state === 'now_serving');
}

/** The party Call next would call: the first *arrived* active party (A8). */
export function findNextToCall<T extends QueueParty>(parties: readonly T[]): T | undefined {
  return orderActive(parties).find((p) => p.arrived);
}

/**
 * 1-based position among parties that will actually be called before this one:
 * arrived active parties ahead + 1. `now_serving` is position 0. Null for other states.
 */
export function positionOf(parties: readonly QueueParty[], id: string): number | null {
  const party = parties.find((p) => p.id === id);
  if (!party) return null;
  if (party.state === 'now_serving') return 0;
  if (!isActive(party)) return null;
  let ahead = 0;
  for (const p of orderActive(parties)) {
    if (p.id === id) break;
    if (p.arrived) ahead++;
  }
  return ahead + 1;
}

function replace<T extends QueueParty>(parties: readonly T[], id: string, patch: Partial<T>): T[] {
  return parties.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

function requireParty<T extends QueueParty>(parties: readonly T[], id: string): T {
  const party = parties.find((p) => p.id === id);
  if (!party) throw new QueueError('not_found');
  return party;
}

/** Assigns sortKey 1..k to the given order of active parties. */
function applyOrder<T extends QueueParty>(parties: readonly T[], ordered: readonly T[]): T[] {
  const keys = new Map(ordered.map((p, i) => [p.id, i + 1]));
  return parties.map((p) => {
    const key = keys.get(p.id);
    return key !== undefined && key !== p.sortKey ? { ...p, sortKey: key } : p;
  });
}

/**
 * Auto Up next (§2.2): the first N arrived active parties become `up_next`; the rest go back to
 * `waiting`. The Up next text goes out once per queue entry (tracked by `upNextSent`). A party
 * already `up_next` whose text was held back while the line was paused (E6) is texted now.
 */
export function recomputeUpNext<T extends QueueParty>(
  parties: readonly T[],
  n: number,
): { parties: T[]; effects: SmsEffect[] } {
  const inRange = orderActive(parties)
    .filter((p) => p.arrived)
    .slice(0, Math.max(0, n));
  const inRangeIds = new Set(inRange.map((p) => p.id));
  const texted = new Set<string>();
  const out = parties.map((p) => {
    if (!isActive(p)) return p;
    if (inRangeIds.has(p.id)) {
      if (p.state === 'up_next' && p.upNextSent) return p;
      if (!p.upNextSent) texted.add(p.id);
      return { ...p, state: 'up_next' as const, upNextSent: true };
    }
    return p.state === 'up_next' ? { ...p, state: 'waiting' as const } : p;
  });
  const effects = inRange
    .filter((p) => texted.has(p.id))
    .map((p) => ({ partyId: p.id, template: 'up_next' as const }));
  return { parties: out, effects };
}

function finish<T extends QueueParty>(
  parties: T[],
  n: number,
  calledId: string | null,
  extra: SmsEffect[] = [],
): QueueResult<T> {
  const r = recomputeUpNext(parties, n);
  // Tap-to-send tray order: Up next texts first, then Your turn (§2.2), then the rest.
  const effects = [...r.effects];
  if (calledId) effects.push({ partyId: calledId, template: 'your_turn' });
  effects.push(...extra);
  return { parties: r.parties, effects };
}

/** Call next (§2.5): current → done, first arrived active → now_serving, recompute Up next. */
export function callNext<T extends QueueParty>(
  parties: readonly T[],
  n: number,
  now: number,
): QueueResult<T> {
  const next = findNextToCall(parties);
  if (!next) throw new QueueError('queue_empty');
  const current = findNowServing(parties);
  let out = [...parties];
  if (current) out = replace(out, current.id, { state: 'done', doneAt: now } as Partial<T>);
  out = replace(out, next.id, { state: 'now_serving', calledAt: now } as Partial<T>);
  return finish(out, n, next.id);
}

/** "Done" on the Now-serving card without calling anyone else. */
export function completeCurrent<T extends QueueParty>(
  parties: readonly T[],
  n: number,
  now: number,
): QueueResult<T> {
  const current = findNowServing(parties);
  if (!current) throw new QueueError('nobody_serving');
  const out = replace(parties, current.id, { state: 'done', doneAt: now } as Partial<T>);
  return finish(out, n, null);
}

/**
 * Skip / Not here (§2.6): the now-serving party becomes `skipped` (or `no_show` on the
 * 3rd time), gets the Skipped text, and the next party is called automatically, unless the
 * line is paused (E6: `callNext` false), when nobody else is called.
 */
export function skipCurrent<T extends QueueParty>(
  parties: readonly T[],
  n: number,
  now: number,
  maxSkips: number = DEFAULTS.maxSkips,
  callNext = true,
): QueueResult<T> {
  const current = findNowServing(parties);
  if (!current) throw new QueueError('nobody_serving');
  const skipCount = current.skipCount + 1;
  const state: PartyState = skipCount > maxSkips ? 'no_show' : 'skipped';
  let out = replace(parties, current.id, { state, skipCount, doneAt: now } as Partial<T>);
  const next = callNext ? findNextToCall(out) : undefined;
  if (next) out = replace(out, next.id, { state: 'now_serving', calledAt: now } as Partial<T>);
  return finish(out, n, next?.id ?? null, [{ partyId: current.id, template: 'skipped' }]);
}

/** "Serve now" on any active or missed party: current → done, this one → now_serving. */
export function serveNow<T extends QueueParty>(
  parties: readonly T[],
  id: string,
  n: number,
  now: number,
): QueueResult<T> {
  const target = requireParty(parties, id);
  if (target.state === 'now_serving') throw new QueueError('already_there');
  if (!isActive(target) && !isMissed(target)) throw new QueueError('not_active');
  const current = findNowServing(parties);
  let out = [...parties];
  if (current) out = replace(out, current.id, { state: 'done', doneAt: now } as Partial<T>);
  out = replace(out, id, { state: 'now_serving', calledAt: now, arrived: true } as Partial<T>);
  return finish(out, n, id);
}

/**
 * Re-insert / "Back in line" (§2.6). A skipped party goes 3 spots back from the front
 * (position 4) or to the end if the line is shorter; a no-show goes to the end. Counts
 * as a new queue entry, so the Up next text can go out again.
 */
export function reinsert<T extends QueueParty>(
  parties: readonly T[],
  id: string,
  n: number,
  spotsBack: number = DEFAULTS.reinsertSpotsBack,
): QueueResult<T> {
  const target = requireParty(parties, id);
  if (!isMissed(target)) throw new QueueError('not_missed');
  const ordered = orderActive(parties);
  let index = ordered.length;
  if (target.state === 'skipped') {
    let arrivedSeen = 0;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].arrived) arrivedSeen++;
      if (arrivedSeen === spotsBack) {
        index = i + 1;
        break;
      }
    }
  }
  const updated = {
    ...target,
    state: 'waiting' as const,
    arrived: true,
    upNextSent: false,
    calledAt: null,
    doneAt: null,
  };
  ordered.splice(index, 0, updated);
  const out = applyOrder(
    parties.map((p) => (p.id === id ? updated : p)),
    ordered,
  );
  return finish(out, n, null);
}

export type MoveDirection = 'up' | 'down' | 'next';

/** Q7: Move up / Move down / Move to next among active parties. */
export function move<T extends QueueParty>(
  parties: readonly T[],
  id: string,
  direction: MoveDirection,
  n: number,
): QueueResult<T> {
  const target = requireParty(parties, id);
  if (!isActive(target)) throw new QueueError('not_active');
  const ordered = orderActive(parties);
  const i = ordered.findIndex((p) => p.id === id);
  const j = direction === 'up' ? i - 1 : direction === 'down' ? i + 1 : 0;
  if (j < 0 || j >= ordered.length || j === i) throw new QueueError('already_there');
  const [item] = ordered.splice(i, 1);
  ordered.splice(j, 0, item);
  return finish(applyOrder(parties, ordered), n, null);
}

/** Q7: Remove from line. Removed parties vanish from lists. */
export function removeParty<T extends QueueParty>(
  parties: readonly T[],
  id: string,
  n: number,
  now: number,
): QueueResult<T> {
  const target = requireParty(parties, id);
  if (target.state === 'removed' || target.state === 'done') throw new QueueError('not_active');
  const out = replace(parties, id, { state: 'removed', doneAt: now } as Partial<T>);
  return finish(out, n, null);
}

/** A8 / G4: arrival check-in (a flag, not a state). */
export function setArrived<T extends QueueParty>(
  parties: readonly T[],
  id: string,
  arrived: boolean,
  n: number,
): QueueResult<T> {
  const target = requireParty(parties, id);
  if (target.arrived === arrived) return { parties: [...parties], effects: [] };
  return finish(replace(parties, id, { arrived } as Partial<T>), n, null);
}

/**
 * Adds new parties at the end of the line (or at the front for "Next"). Their sortKey is
 * assigned here. Up next is recomputed, which covers the bulk case after an import.
 */
export function addParties<T extends QueueParty>(
  parties: readonly T[],
  added: readonly T[],
  n: number,
  position: 'end' | 'next' = 'end',
): QueueResult<T> {
  if (position === 'next') {
    const ordered = [...added, ...orderActive(parties)];
    return finish(applyOrder([...parties, ...added], ordered), n, null);
  }
  let key = parties.reduce((max, p) => Math.max(max, p.sortKey), 0);
  const withKeys = added.map((p) => ({ ...p, sortKey: ++key }));
  return finish([...parties, ...withKeys], n, null);
}

/** The queue fields captured for Undo. */
export type QueueSnapshot = Pick<
  QueueParty,
  'id' | 'state' | 'sortKey' | 'arrived' | 'skipCount' | 'upNextSent' | 'calledAt' | 'doneAt'
>[];

export function takeSnapshot(parties: readonly QueueParty[]): QueueSnapshot {
  return parties.map(
    ({ id, state, sortKey, arrived, skipCount, upNextSent, calledAt, doneAt }) => ({
      id,
      state,
      sortKey,
      arrived,
      skipCount,
      upNextSent,
      calledAt,
      doneAt,
    }),
  );
}

/**
 * Undo (Q6): restores the queue fields of every party in the snapshot. Parties added after the
 * snapshot are kept as they are. Texts that were already sent cannot be recalled, so the
 * "Up next sent" flag stays set for `alreadyTexted` parties.
 */
export function restoreSnapshot<T extends QueueParty>(
  parties: readonly T[],
  snapshot: QueueSnapshot,
  n: number,
  alreadyTexted: ReadonlySet<string> = new Set(),
): QueueResult<T> {
  const saved = new Map(snapshot.map((s) => [s.id, s]));
  const out = parties.map((p) => {
    const s = saved.get(p.id);
    if (!s) return p;
    return { ...p, ...s, upNextSent: s.upNextSent || alreadyTexted.has(p.id) };
  });
  return finish(out, n, null);
}
