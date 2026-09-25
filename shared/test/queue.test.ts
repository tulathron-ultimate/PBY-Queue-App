import { describe, expect, it } from 'vitest';
import {
  QueueError,
  addParties,
  callNext,
  completeCurrent,
  findNextToCall,
  move,
  partiesAheadForWait,
  positionOf,
  recomputeUpNext,
  reinsert,
  removeParty,
  restoreSnapshot,
  serveNow,
  setArrived,
  skipCurrent,
  takeSnapshot,
} from '../src/queue.js';
import { line, order, party, states } from './helpers.js';

const N = 2;
const T0 = 1_000_000;

describe('recomputeUpNext', () => {
  it('marks the first N arrived parties up_next and texts each once (bulk case)', () => {
    const r = recomputeUpNext(line(5), N);
    expect(states(r.parties)).toMatchObject({ p1: 'up_next', p2: 'up_next', p3: 'waiting' });
    expect(r.effects).toEqual([
      { partyId: 'p1', template: 'up_next' },
      { partyId: 'p2', template: 'up_next' },
    ]);
    expect(r.parties.filter((p) => p.upNextSent).map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('N = 0 disables Up next', () => {
    const r = recomputeUpNext(line(3), 0);
    expect(r.parties.every((p) => p.state === 'waiting')).toBe(true);
    expect(r.effects).toEqual([]);
  });

  it('does not re-text a party that moves out of range and back in', () => {
    let r = recomputeUpNext(line(4), N);
    // host moves p4 to next: p2 drops out of range
    r = move(r.parties, 'p4', 'next', N);
    expect(states(r.parties)).toMatchObject({ p4: 'up_next', p1: 'up_next', p2: 'waiting' });
    expect(r.effects).toEqual([{ partyId: 'p4', template: 'up_next' }]);
    // move p4 back down twice: p2 comes back into range without a new text
    r = move(r.parties, 'p4', 'down', N);
    r = move(r.parties, 'p4', 'down', N);
    expect(states(r.parties)).toMatchObject({ p1: 'up_next', p2: 'up_next', p4: 'waiting' });
    expect(r.effects).toEqual([]);
  });

  it('skips parties that have not arrived (A8)', () => {
    const parties = [party(1, 'waiting', { arrived: false }), party(2), party(3)];
    const r = recomputeUpNext(parties, N);
    expect(states(r.parties)).toEqual({ p1: 'waiting', p2: 'up_next', p3: 'up_next' });
  });
});

describe('callNext', () => {
  it('marks current done, calls the first party and recomputes Up next', () => {
    let r = recomputeUpNext(line(4), N);
    r = callNext(r.parties, N, T0);
    expect(states(r.parties)).toMatchObject({
      p1: 'now_serving',
      p2: 'up_next',
      p3: 'up_next',
      p4: 'waiting',
    });
    // Up next texts come before Your turn in the tray (§2.2)
    expect(r.effects).toEqual([
      { partyId: 'p3', template: 'up_next' },
      { partyId: 'p1', template: 'your_turn' },
    ]);
    expect(r.sampleMs).toBeNull();

    r = callNext(r.parties, N, T0 + 90_000);
    const p1 = r.parties.find((p) => p.id === 'p1')!;
    expect(p1.state).toBe('done');
    expect(p1.doneAt).toBe(T0 + 90_000);
    expect(r.sampleMs).toBe(90_000);
    expect(states(r.parties)).toMatchObject({ p2: 'now_serving', p3: 'up_next', p4: 'up_next' });
  });

  it('skips not-arrived parties until they check in', () => {
    const parties = [
      party(1, 'waiting', { arrived: false }),
      party(2, 'waiting', { arrived: false }),
      party(3),
    ];
    let r = callNext(parties, N, T0);
    expect(states(r.parties)).toMatchObject({ p1: 'waiting', p2: 'waiting', p3: 'now_serving' });
    expect(() => callNext(r.parties, N, T0 + 1)).toThrow(QueueError);
    r = setArrived(r.parties, 'p2', true, N);
    expect(states(r.parties).p2).toBe('up_next');
    expect(r.effects).toEqual([{ partyId: 'p2', template: 'up_next' }]);
    r = callNext(r.parties, N, T0 + 60_000);
    expect(states(r.parties)).toMatchObject({ p2: 'now_serving', p3: 'done', p1: 'waiting' });
  });

  it('throws queue_empty when nobody is left to call', () => {
    expect(() => callNext([party(1, 'done')], N, T0)).toThrow('queue_empty');
    expect(findNextToCall([])).toBeUndefined();
  });

  it('completeCurrent marks the served party done without calling another', () => {
    const r1 = callNext(line(2), N, T0);
    const r2 = completeCurrent(r1.parties, N, T0 + 30_000);
    expect(states(r2.parties)).toMatchObject({ p1: 'done', p2: 'up_next' });
    expect(r2.sampleMs).toBe(30_000);
    expect(() => completeCurrent(r2.parties, N, T0)).toThrow('nobody_serving');
  });
});

describe('skip and re-insert', () => {
  it('skip marks skipped, texts them and calls the next party', () => {
    let r = callNext(line(3), N, T0);
    r = skipCurrent(r.parties, N, T0 + 20_000);
    const p1 = r.parties.find((p) => p.id === 'p1')!;
    expect(p1.state).toBe('skipped');
    expect(p1.skipCount).toBe(1);
    expect(states(r.parties)).toMatchObject({ p2: 'now_serving', p3: 'up_next' });
    expect(r.effects).toEqual([
      { partyId: 'p2', template: 'your_turn' },
      { partyId: 'p1', template: 'skipped' },
    ]);
    expect(r.sampleMs).toBe(20_000);
  });

  it('re-inserts a skipped party 3 spots back (position 4) with a fresh Up next', () => {
    let r = recomputeUpNext(line(7), N);
    r = callNext(r.parties, N, T0);
    r = skipCurrent(r.parties, N, T0 + 1000); // p1 skipped, p2 serving
    r = reinsert(r.parties, 'p1', N);
    expect(order(r.parties)).toEqual(['p3', 'p4', 'p5', 'p1', 'p6', 'p7']);
    expect(positionOf(r.parties, 'p1')).toBe(4);
    const p1 = r.parties.find((p) => p.id === 'p1')!;
    expect(p1.upNextSent).toBe(false);
    expect(p1.state).toBe('waiting');
    // Once it moves into range it is texted again (new entry)
    r = callNext(r.parties, N, T0 + 60_000);
    r = callNext(r.parties, N, T0 + 120_000);
    expect(states(r.parties).p1).toBe('up_next');
    expect(r.effects).toContainEqual({ partyId: 'p1', template: 'up_next' });
  });

  it('re-inserts at the end when the line is shorter than 3', () => {
    let r = callNext(line(3), N, T0);
    r = skipCurrent(r.parties, N, T0 + 1000);
    r = reinsert(r.parties, 'p1', N);
    expect(order(r.parties)).toEqual(['p3', 'p1']);
  });

  it('the 3rd skip marks no_show, which re-inserts at the end', () => {
    let parties = line(8);
    let r = { parties, effects: [], sampleMs: null } as ReturnType<typeof callNext>;
    for (let i = 0; i < 3; i++) {
      r = serveNow(r.parties, 'p1', N, T0 + i);
      r = skipCurrent(r.parties, N, T0 + i + 1);
      if (i < 2) {
        expect(r.parties.find((p) => p.id === 'p1')!.state).toBe('skipped');
        r = reinsert(r.parties, 'p1', N);
      }
    }
    const p1 = r.parties.find((p) => p.id === 'p1')!;
    expect(p1.state).toBe('no_show');
    expect(p1.skipCount).toBe(3);
    r = reinsert(r.parties, 'p1', N);
    parties = r.parties;
    expect(order(parties).at(-1)).toBe('p1');
    expect(() => reinsert(parties, 'p2', N)).toThrow('not_missed');
  });
});

describe('reorder, remove, add', () => {
  it('moves up, down and to next', () => {
    let r = recomputeUpNext(line(4), N);
    r = move(r.parties, 'p3', 'up', N);
    expect(order(r.parties)).toEqual(['p1', 'p3', 'p2', 'p4']);
    r = move(r.parties, 'p1', 'down', N);
    expect(order(r.parties)).toEqual(['p3', 'p1', 'p2', 'p4']);
    r = move(r.parties, 'p4', 'next', N);
    expect(order(r.parties)).toEqual(['p4', 'p3', 'p1', 'p2']);
    expect(() => move(r.parties, 'p4', 'up', N)).toThrow('already_there');
    expect(() => move(r.parties, 'p2', 'down', N)).toThrow('already_there');
  });

  it('remove takes a party out of line and promotes the next one', () => {
    let r = recomputeUpNext(line(3), N);
    r = removeParty(r.parties, 'p1', N, T0);
    expect(states(r.parties)).toMatchObject({ p1: 'removed', p2: 'up_next', p3: 'up_next' });
    expect(r.effects).toEqual([{ partyId: 'p3', template: 'up_next' }]);
  });

  it('adds at the end or next, assigning sort keys', () => {
    let r = recomputeUpNext(line(2), N);
    r = addParties(r.parties, [party(3, 'waiting', { sortKey: 0 })], N);
    expect(order(r.parties)).toEqual(['p1', 'p2', 'p3']);
    r = addParties(r.parties, [party(4, 'waiting', { sortKey: 0 })], N, 'next');
    expect(order(r.parties)).toEqual(['p4', 'p1', 'p2', 'p3']);
    expect(states(r.parties)).toMatchObject({ p4: 'up_next', p1: 'up_next', p2: 'waiting' });
  });
});

describe('positions and undo', () => {
  it('position counts arrived parties ahead; now_serving is 0', () => {
    const parties = [
      party(1, 'now_serving'),
      party(2, 'up_next'),
      party(3, 'waiting', { arrived: false }),
      party(4),
      party(5, 'done'),
    ];
    expect(positionOf(parties, 'p1')).toBe(0);
    expect(positionOf(parties, 'p2')).toBe(1);
    expect(positionOf(parties, 'p3')).toBe(2);
    expect(positionOf(parties, 'p4')).toBe(2);
    expect(positionOf(parties, 'p5')).toBeNull();
    expect(partiesAheadForWait(parties, 'p4')).toBe(2);
    expect(partiesAheadForWait(parties, 'p2')).toBe(1);
  });

  it('undo restores the queue fields but keeps parties added afterwards', () => {
    const start = recomputeUpNext(line(3), N);
    const snap = takeSnapshot(start.parties);
    let r = callNext(start.parties, N, T0);
    r = addParties(r.parties, [party(9, 'waiting', { sortKey: 0 })], N);
    const undone = restoreSnapshot(r.parties, snap, N, new Set(['p3']));
    expect(states(undone.parties)).toMatchObject({
      p1: 'up_next',
      p2: 'up_next',
      p3: 'waiting',
      p9: 'waiting',
    });
    // p3 was texted "Up next" before the undo, so it is not texted again
    expect(undone.parties.find((p) => p.id === 'p3')!.upNextSent).toBe(true);
    expect(undone.parties.find((p) => p.id === 'p1')!.calledAt).toBeNull();
  });
});
