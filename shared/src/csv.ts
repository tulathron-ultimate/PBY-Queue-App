/**
 * E8 results export: one row per party, for photo ordering. CSV-injection safe: a cell that
 * starts with = + - @ tab or CR gets a leading single quote, so spreadsheet apps never run it
 * as a formula. That includes every E164 phone number (they start with +), so the Phone column
 * is always prefixed the same way.
 */
import type { PartyState } from './types.js';

export const RESULTS_CSV_HEADERS = [
  'Ticket',
  'Party name',
  'Party size',
  'Members',
  'Phone',
  'Group',
  'Notes',
  'Final status',
  'Checked in',
  'Called',
  'Done',
] as const;

export type ResultStatus = 'done' | 'no_show' | 'skipped' | 'removed' | 'waiting' | 'now_serving';

export interface ResultsRow {
  ticket: number;
  name: string;
  size: number;
  members: readonly string[];
  /** E164 or null. */
  phone: string | null;
  group: string | null;
  notes: string | null;
  state: PartyState;
  arrivedAt: number | null;
  calledAt: number | null;
  doneAt: number | null;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: formula-looking text gets a leading ', then RFC 4180 quoting if needed. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Up next parties are still waiting; a party being photographed at export is `now_serving`. */
export function resultStatus(state: PartyState): ResultStatus {
  return state === 'up_next' ? 'waiting' : state;
}

/** A valid IANA time zone, or UTC. */
export function safeTimeZone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** "2026-10-01 09:05:00" in the given time zone; blank for null. */
export function formatCsvTime(ms: number | null, timeZone: string): string {
  if (ms === null) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * The results CSV, sorted by ticket, with CRLF line ends and no BOM (the server adds one so
 * Excel reads UTF-8). Times are local to `timeZone`. "Done" is filled only for done parties.
 */
export function buildResultsCsv(rows: readonly ResultsRow[], timeZone = 'UTC'): string {
  const tz = safeTimeZone(timeZone);
  const lines = [RESULTS_CSV_HEADERS.map(csvCell).join(',')];
  for (const r of [...rows].sort((a, b) => a.ticket - b.ticket)) {
    lines.push(
      [
        r.ticket,
        r.name,
        r.size,
        r.members.join('; '),
        r.phone ?? '',
        r.group ?? '',
        r.notes ?? '',
        resultStatus(r.state),
        formatCsvTime(r.arrivedAt, tz),
        formatCsvTime(r.calledAt, tz),
        r.state === 'done' ? formatCsvTime(r.doneAt, tz) : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** An ASCII-only file name such as `pumpkin-patch-portraits-2026-10-01-results.csv`. */
export function resultsFileName(eventName: string, date: string): string {
  const slug = eventName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  return [slug || 'event', day, 'results'].filter(Boolean).join('-') + '.csv';
}
