import { afterEach, describe, expect, it } from 'vitest';
import {
  advance,
  closeApps,
  fiveParties,
  host,
  now,
  PIN,
  setup,
  snap,
  type Harness,
} from './harness.js';

afterEach(closeApps);

const exportCsv = (h: Harness, query = '', cookies = h.cookies) =>
  h.app.inject({
    method: 'GET',
    url: `/api/host/events/${h.eventId}/export.csv${query}`,
    cookies,
  });

describe('results CSV export (E8)', () => {
  it('is host-only and scoped to the session’s event', async () => {
    const h = await setup();
    const other = await setup();
    expect((await exportCsv(h, '', {})).statusCode).toBe(401);
    expect((await exportCsv(h, '', other.cookies)).statusCode).toBe(401);
  });

  it('downloads as a UTF-8 CSV attachment with safe headers', async () => {
    const h = await setup({}, { name: 'Café Portraits', date: '2026-10-01' });
    const res = await exportCsv(h);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="cafe-portraits-2026-10-01-results.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(res.body.replace(/^\uFEFF/, '')).toBe(
      'Ticket,Party name,Party size,Members,Phone,Group,Notes,Final status,Checked in,Called,Done\r\n',
    );
  });

  it('lists every party with its final status and times, formula-safe', async () => {
    const h = await setup();
    const start = now();
    await host(h, 'POST', '/import', {
      consentConfirmed: true,
      rows: [
        {
          name: 'Emma Rivera',
          phone: '555-201-8830',
          size: 2,
          members: ['Emma', 'Leo'],
          group: 'U10 Hawks',
        },
        { name: '=HYPERLINK("http://evil")', phone: '555-309-4417', notes: '@SUM(A1), "hi"' },
        { name: 'Late Family', phone: '' },
      ],
    });
    let s = await snap(h);
    advance(60_000);
    await host(h, 'POST', `/parties/${s.parties[0].id}/arrive`);
    await host(h, 'POST', `/parties/${s.parties[1].id}/arrive`);
    advance(60_000);
    await host(h, 'POST', '/call-next'); // #1 now serving
    advance(60_000);
    await host(h, 'POST', '/call-next'); // #1 done, #2 now serving
    advance(2000);
    await host(h, 'POST', '/skip'); // #2 skipped
    s = await snap(h);
    const lines = (await exportCsv(h, '?tz=UTC')).body.replace(/^\uFEFF/, '').split('\r\n');
    const t = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
    expect(lines[1]).toBe(
      `1,Emma Rivera,2,Emma; Leo,'+15552018830,U10 Hawks,,done,${t(start + 60_000)},${t(start + 120_000)},${t(start + 180_000)}`,
    );
    expect(lines[2]).toBe(
      `2,"'=HYPERLINK(""http://evil"")",1,,'+15553094417,,"'@SUM(A1), ""hi""",skipped,${t(start + 60_000)},${t(start + 180_000)},`,
    );
    expect(lines[3]).toBe('3,Late Family,1,,,,,waiting,,,');
    expect(s.parties).toHaveLength(3);
  });

  it('clears the check-in time when a party is checked back out', async () => {
    const h = await setup();
    await fiveParties(h);
    const s = await snap(h);
    await host(h, 'POST', `/parties/${s.parties[4].id}/unarrive`);
    const lines = (await exportCsv(h)).body.split('\r\n');
    expect(lines[5]).toMatch(/,waiting,,,$/);
    expect(lines[4]).toMatch(/,waiting,\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,,$/);
  });

  it('works after the event closes (sign back in with the PIN) and not after the purge', async () => {
    const h = await setup();
    await fiveParties(h);
    await host(h, 'POST', '/close');
    expect((await exportCsv(h)).statusCode).toBe(401); // closing signs every device out
    const login = await h.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { eventId: h.eventId, pin: PIN },
    });
    const cookies = Object.fromEntries(login.cookies.map((c) => [c.name, c.value]));
    const res = await exportCsv(h, '', cookies);
    expect(res.statusCode).toBe(200);
    expect(res.body.split('\r\n')).toHaveLength(7);
    await host(h, 'POST', '/delete', {}, cookies);
    expect((await exportCsv(h, '', cookies)).statusCode).not.toBe(200);
  });
});
