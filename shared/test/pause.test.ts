import { describe, expect, it } from 'vitest';
import {
  cleanPauseMessage,
  holdUpNextTexts,
  PAUSE_MESSAGE_MAX,
  pausedTextEffects,
} from '../src/pause.js';
import { move, recomputeUpNext, serveNow, skipCurrent } from '../src/queue.js';
import { line, party, states } from './helpers.js';

const N = 2;
const T0 = 1_000_000;

describe('pause the line (E6)', () => {
  it('holds Up next texts while paused and sends them on resume', () => {
    // The line is paused before anyone is up next: states update, texts wait.
    const paused = holdUpNextTexts(recomputeUpNext(line(4), N));
    expect(states(paused.parties)).toMatchObject({ p1: 'up_next', p2: 'up_next', p3: 'waiting' });
    expect(paused.effects).toEqual([]);
    expect(paused.parties.some((p) => p.upNextSent)).toBe(false);

    // Resume: the same recompute now texts the parties already shown as up next, once.
    const resumed = recomputeUpNext(paused.parties, N);
    expect(resumed.effects).toEqual([
      { partyId: 'p1', template: 'up_next' },
      { partyId: 'p2', template: 'up_next' },
    ]);
    expect(recomputeUpNext(resumed.parties, N).effects).toEqual([]);
  });

  it('keeps other texts, such as Your turn from Serve now, while paused', () => {
    const r = holdUpNextTexts(serveNow(line(4), 'p3', N, T0));
    expect(r.effects).toEqual([{ partyId: 'p3', template: 'your_turn' }]);
    expect(states(r.parties)).toMatchObject({ p3: 'now_serving', p1: 'up_next' });
  });

  it('never texts a party twice across pause, reorder and resume', () => {
    let r = recomputeUpNext(line(4), N); // p1, p2 texted before the pause
    r = holdUpNextTexts(move(r.parties, 'p4', 'next', N)); // p4 held, p2 drops out
    expect(r.effects).toEqual([]);
    r = recomputeUpNext(r.parties, N); // resume
    expect(r.effects).toEqual([{ partyId: 'p4', template: 'up_next' }]);
  });

  it('"Not here" while paused calls nobody else', () => {
    const start = [party(1, 'now_serving'), party(2, 'up_next', { upNextSent: true }), party(3)];
    const r = holdUpNextTexts(skipCurrent(start, N, T0, 2, false));
    expect(states(r.parties)).toMatchObject({ p1: 'skipped', p2: 'up_next', p3: 'up_next' });
    expect(r.effects).toEqual([{ partyId: 'p1', template: 'skipped' }]);
  });

  it('queues one paused text per party waiting, arrived or not', () => {
    const parties = [
      party(1, 'now_serving'),
      party(2, 'up_next'),
      party(3, 'waiting', { arrived: false }),
      party(4, 'skipped'),
      party(5, 'done'),
    ];
    expect(pausedTextEffects(parties)).toEqual([
      { partyId: 'p2', template: 'paused' },
      { partyId: 'p3', template: 'paused' },
    ]);
  });

  it('cleans the message: text only, no control or bidi characters, capped', () => {
    expect(cleanPauseMessage('  Back in 10 minutes — lunch break  ')).toBe(
      'Back in 10 minutes — lunch break',
    );
    expect(cleanPauseMessage('a‮b\u0000c\nd⁦e')).toBe('a b c d e');
    expect(cleanPauseMessage('   ')).toBeNull();
    expect(cleanPauseMessage(42)).toBeNull();
    expect(cleanPauseMessage('<b>hi</b>')).toBe('<b>hi</b>'); // rendered as text, never HTML
    expect(cleanPauseMessage('x'.repeat(500))).toHaveLength(PAUSE_MESSAGE_MAX);
    expect(PAUSE_MESSAGE_MAX).toBe(120);
  });
});
