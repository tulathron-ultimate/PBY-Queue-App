import { describe, expect, it } from 'vitest';
import {
  buildResultsCsv,
  csvCell,
  formatCsvTime,
  resultsFileName,
  RESULTS_CSV_HEADERS,
  safeTimeZone,
  type ResultsRow,
} from '../src/csv.js';

const T = Date.UTC(2026, 9, 1, 15, 4, 5);

const row = (extra: Partial<ResultsRow> = {}): ResultsRow => ({
  ticket: 1,
  name: 'Emma Rivera',
  size: 2,
  members: ['Emma', 'Leo'],
  phone: '+15552018830',
  group: 'U10 Hawks',
  notes: null,
  state: 'done',
  arrivedAt: T,
  calledAt: T + 60_000,
  doneAt: T + 120_000,
  ...extra,
});

describe('CSV export (E8)', () => {
  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+15552018830', "'+15552018830"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tcmd', "'\tcmd"],
    ['\rcmd', `"'\rcmd"`],
    ['Smith, Jr.', '"Smith, Jr."'],
    ['a\nb', '"a\nb"'],
    ['say "hi"', '"say ""hi"""'],
    ['Emma = Leo', 'Emma = Leo'],
    ['', ''],
  ])('escapes %j', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('writes the header and one row per party, sorted by ticket', () => {
    const csv = buildResultsCsv(
      [
        row({ ticket: 2, name: '=cmd|calc', state: 'no_show', doneAt: T, phone: null }),
        row(),
        row({ ticket: 3, state: 'up_next', calledAt: null, doneAt: null, arrivedAt: null }),
        row({ ticket: 4, state: 'now_serving', doneAt: null, notes: 'needs a chair' }),
      ],
      'America/Chicago',
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(RESULTS_CSV_HEADERS.join(','));
    expect(lines[0]).toBe(
      'Ticket,Party name,Party size,Members,Phone,Group,Notes,Final status,Checked in,Called,Done',
    );
    expect(lines[1]).toBe(
      "1,Emma Rivera,2,Emma; Leo,'+15552018830,U10 Hawks,,done,2026-10-01 10:04:05,2026-10-01 10:05:05,2026-10-01 10:06:05",
    );
    expect(lines[2]).toBe(
      "2,'=cmd|calc,2,Emma; Leo,,U10 Hawks,,no_show,2026-10-01 10:04:05,2026-10-01 10:05:05,",
    );
    expect(lines[3]).toBe("3,Emma Rivera,2,Emma; Leo,'+15552018830,U10 Hawks,,waiting,,,");
    expect(lines[4]).toContain(',needs a chair,now_serving,');
    expect(lines[5]).toBe('');
    expect(lines).toHaveLength(6);
  });

  it('falls back to UTC for a bad time zone', () => {
    expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
    expect(safeTimeZone('../../etc')).toBe('UTC');
    expect(safeTimeZone('Europe/London')).toBe('Europe/London');
    expect(formatCsvTime(T, 'UTC')).toBe('2026-10-01 15:04:05');
    expect(formatCsvTime(null, 'UTC')).toBe('');
  });

  it('makes a plain ASCII file name', () => {
    expect(resultsFileName('Café "Portraits" / Oak Park', '2026-10-01')).toBe(
      'cafe-portraits-oak-park-2026-10-01-results.csv',
    );
    expect(resultsFileName('🎃🎃', 'x')).toBe('event-results.csv');
  });
});
