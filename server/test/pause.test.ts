import type { HostSnapshot } from '@pby/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addManual,
  advance,
  closeApps,
  fiveParties,
  guest,
  host,
  PIN,
  setup,
  snap,
  TWILIO_ENV,
} from './harness.js';

afterEach(closeApps);

const pendingOf = (s: HostSnapshot, template: string) =>
  s.pendingTexts.filter((t) => t.template === template).map((t) => t.partyId);

describe('pause the line (E6)', () => {
  it('is host-only and scoped to the session’s event', async () => {
    const h = await setup();
    const other = await setup();
    expect((await host(h, 'POST', '/pause', {}, {})).statusCode).toBe(401);
    // A valid session for another event does not open this one.
    expect((await host(h, 'POST', '/pause', {}, other.cookies)).statusCode).toBe(401);
    expect((await snap(h)).event.paused).toBe(false);
  });

  it('disables Call next, shows a banner to guests, holds Up next texts, and resumes', async () => {
    const h = await setup();
    await addManual(h, 'Emma Rivera', '555-201-8830', { sendJoinText: false });
    let s = (
      await host(h, 'POST', '/pause', { message: '  Back in 10 minutes — lunch break ' })
    ).json() as HostSnapshot;
    expect(s.event).toMatchObject({
      paused: true,
      pauseMessage: 'Back in 10 minutes — lunch break',
    });
    expect(s.undo?.label).toBe('Pause');
    // Emma was texted Up next before the pause. Two more arrive while paused: they show as
    // Up next, but nobody is told to come forward.
    expect(pendingOf(s, 'up_next')).toHaveLength(1);
    await addManual(h, 'Nguyen Family', '555-309-4417', { sendJoinText: false });
    await addManual(h, 'Smith Family', '555-740-1122', { sendJoinText: false });
    s = await snap(h);
    const [emma, nguyen, smith] = s.parties;
    expect(nguyen.state).toBe('up_next');
    expect(pendingOf(s, 'up_next')).toEqual([emma.id]);

    const call = await host(h, 'POST', '/call-next');
    expect(call.statusCode).toBe(409);
    expect(call.json().error).toBe('paused');

    const g = await guest(h, smith.token);
    expect(g).toMatchObject({ paused: true, pauseMessage: 'Back in 10 minutes — lunch break' });
    expect(g.me!.position).toBe(3); // position still shown

    s = (await host(h, 'POST', '/resume')).json();
    expect(s.event).toMatchObject({ paused: false, pauseMessage: null });
    expect(pendingOf(s, 'up_next')).toEqual([emma.id, nguyen.id]);
    expect((await guest(h, smith.token)).paused).toBe(false);
    advance(2000);
    expect((await host(h, 'POST', '/call-next')).statusCode).toBe(200);
  });

  it('cleans the message: no control or bidi characters, at most 120 characters', async () => {
    const h = await setup();
    let s: HostSnapshot = (
      await host(h, 'POST', '/pause', { message: 'Back‮ soon\u0007 <b>x</b>' })
    ).json();
    expect(s.event.pauseMessage).toBe('Back soon <b>x</b>');
    await host(h, 'POST', '/resume');
    s = (await host(h, 'POST', '/pause', { message: 'y'.repeat(400) })).json();
    expect(s.event.pauseMessage).toHaveLength(120);
    expect((await host(h, 'POST', '/pause')).json().error).toBe('already_paused');
    await host(h, 'POST', '/resume');
    expect((await host(h, 'POST', '/resume')).json().error).toBe('not_paused');
    s = (await host(h, 'POST', '/pause', { message: { html: 1 } })).json();
    expect(s.event.pauseMessage).toBeNull();
  });

  it('undoes Pause and Resume like other host actions', async () => {
    const h = await setup();
    await fiveParties(h);
    await host(h, 'POST', '/pause', { message: 'Lunch' });
    let r = await host(h, 'POST', '/undo');
    expect(r.json().undone).toBe('Pause');
    expect((r.json() as HostSnapshot).event.paused).toBe(false);

    await host(h, 'POST', '/pause', { message: 'Lunch' });
    await host(h, 'POST', '/resume');
    r = await host(h, 'POST', '/undo');
    expect(r.json().undone).toBe('Resume');
    expect((r.json() as HostSnapshot).event).toMatchObject({ paused: true, pauseMessage: 'Lunch' });
    // Moves while paused undo without un-pausing.
    const s = await snap(h);
    await host(h, 'POST', `/parties/${s.parties[4].id}/move-next`);
    r = await host(h, 'POST', '/undo');
    expect(r.json().undone).toBe('Move to next');
    expect((r.json() as HostSnapshot).event.paused).toBe(true);
  });

  it('"Not here" while paused calls nobody else', async () => {
    const h = await setup();
    await fiveParties(h);
    advance(2000);
    await host(h, 'POST', '/call-next');
    await host(h, 'POST', '/pause');
    advance(2000);
    const s: HostSnapshot = (await host(h, 'POST', '/skip')).json();
    expect(s.parties.find((p) => p.ticket === 1)!.state).toBe('skipped');
    expect(s.parties.some((p) => p.state === 'now_serving')).toBe(false);
  });

  it('syncs to helper devices', async () => {
    const h = await setup();
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { eventId: h.eventId, pin: PIN },
    });
    const helper = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
    await host(h, 'POST', '/pause', { message: 'Back soon' });
    const s: HostSnapshot = (await host(h, 'GET', '', undefined, helper)).json();
    expect(s.event).toMatchObject({ paused: true, pauseMessage: 'Back soon' });
    expect((await host(h, 'POST', '/resume', {}, helper)).statusCode).toBe(200);
    expect((await snap(h)).event.paused).toBe(false);
  });
});

describe('the optional "we\'re paused" text', () => {
  it('is off by default', async () => {
    const h = await setup();
    await fiveParties(h);
    const s: HostSnapshot = (await host(h, 'POST', '/pause', { message: 'Lunch' })).json();
    expect(pendingOf(s, 'paused')).toEqual([]);
  });

  it('goes once to each waiting party that can be texted, and is dropped on Resume', async () => {
    const h = await setup();
    await fiveParties(h);
    await addManual(h, 'No Phone');
    let s = await snap(h);
    advance(2000);
    await host(h, 'POST', '/call-next'); // #1 is being served, not waiting
    await host(h, 'PATCH', `/parties/${s.parties[1].id}`, { noTexts: true }); // #2: No texts
    h.ctx.service.setOptOut('+15557401122', true); // #3 opted out
    s = (await host(h, 'POST', '/pause', { message: 'Lunch', notify: true })).json();
    const byTicket = (id: string) => s.parties.find((p) => p.id === id)!.ticket;
    expect(pendingOf(s, 'paused').map(byTicket)).toEqual([4, 5]);
    expect(s.pendingTexts.filter((t) => t.template === 'paused')[0].to).toBe('+15552018831');

    s = (await host(h, 'POST', '/resume')).json();
    expect(pendingOf(s, 'paused')).toEqual([]);
  });

  it('sends through Twilio, honours opt-outs, and counts toward the hourly Twilio cap', async () => {
    const h = await setup({ ...TWILIO_ENV, SELF_JOIN_TEXTS_PER_HOUR: '2' });
    await fiveParties(h);
    await h.ctx.service.pendingDispatch;
    h.ctx.service.setOptOut('+15552018832', true); // #5
    h.sent.length = 0;
    await host(h, 'POST', '/pause', { notify: true });
    await h.ctx.service.pendingDispatch;
    // #1 and #2 are Up next (texted before the pause); all five were waiting.
    expect(h.sent.map((m) => m.to)).toEqual([
      '+15552018830',
      '+15553094417',
      '+15557401122',
      '+15552018831',
    ]);
    expect(h.sent[0].body).toBe(
      'Pumpkin Patch Portra: Emma, the photo line is paused for a short break. You keep your place: ' +
        h.sent[0].body.split('place: ')[1],
    );
    // Four broadcast texts already exceed the cap of 2, so a stranger's self-join text waits
    // in the host's tray instead of going out automatically.
    const join = await h.app.inject({
      method: 'POST',
      url: `/api/join/${h.code}`,
      payload: { name: 'Stranger', phone: '555-201-8899', size: 1, consent: true },
    });
    expect(join.statusCode).toBe(200);
    await h.ctx.service.pendingDispatch;
    expect(h.sent).toHaveLength(4);
    expect(pendingOf(await snap(h), 'join')).toHaveLength(1);
  });
});
