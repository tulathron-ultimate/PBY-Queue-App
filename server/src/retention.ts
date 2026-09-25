/** Data retention (§2.12): auto-close idle events and purge party PII after close. */
import { averageMinutes } from '@pby/shared';
import { getMeta, setMeta, type DB } from './db.js';

const DAY = 86_400_000;

/** Deletes party PII (names, phones, members, notes, tokens) and the SMS log; keeps aggregates. */
export function purgeEvent(db: DB, eventId: string, now: number): void {
  db.transaction(() => {
    const counts = db
      .prepare(
        `SELECT SUM(state = 'done') AS served, SUM(state = 'no_show') AS no_show
         FROM parties WHERE event_id = ?`,
      )
      .get(eventId) as { served: number | null; no_show: number | null };
    const ev = db
      .prepare('SELECT samples, minutes_per_party FROM events WHERE id = ?')
      .get(eventId) as { samples: string; minutes_per_party: number } | undefined;
    if (!ev) return;
    const samples = JSON.parse(ev.samples) as number[];
    const avgMs = samples.length ? Math.round(averageMinutes(samples) * 60_000) : null;
    db.prepare('DELETE FROM sms_log WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM undo_stack WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM sessions WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM parties WHERE event_id = ?').run(eventId);
    db.prepare(
      `UPDATE events SET status = 'closed', closed_at = COALESCE(closed_at, ?), purged_at = ?,
        samples = '[]', served_count = COALESCE(served_count, ?), no_show_count = COALESCE(no_show_count, ?),
        avg_service_ms = COALESCE(avg_service_ms, ?)
       WHERE id = ?`,
    ).run(now, now, counts.served ?? 0, counts.no_show ?? 0, avgMs, eventId);
  })();
}

export interface RetentionResult {
  autoClosed: string[];
  purged: string[];
  vacuumed: boolean;
}

export interface RetentionOptions {
  retentionDays: number;
  autoCloseHours: number;
  /** Only purge when true (the daily job); auto-close runs on every sweep. */
  purge: boolean;
}

export function runRetention(db: DB, now: number, opts: RetentionOptions): RetentionResult {
  const autoClosed = (
    db
      .prepare(`SELECT id FROM events WHERE status = 'open' AND last_action_at < ?`)
      .all(now - opts.autoCloseHours * 3_600_000) as { id: string }[]
  ).map((r) => r.id);
  for (const id of autoClosed) {
    db.prepare(`UPDATE events SET status = 'closed', closed_at = ? WHERE id = ?`).run(now, id);
    db.prepare('DELETE FROM sessions WHERE event_id = ?').run(id);
  }
  const purged: string[] = [];
  let vacuumed = false;
  if (opts.purge) {
    const due = db
      .prepare(
        `SELECT id FROM events WHERE status = 'closed' AND purged_at IS NULL AND closed_at <= ?`,
      )
      .all(now - opts.retentionDays * DAY) as { id: string }[];
    for (const { id } of due) {
      purgeEvent(db, id, now);
      purged.push(id);
    }
    const lastVacuum = Number(getMeta(db, 'last_vacuum') ?? 0);
    if (now - lastVacuum >= 7 * DAY) {
      db.exec('VACUUM');
      setMeta(db, 'last_vacuum', String(now));
      vacuumed = true;
    }
  }
  return { autoClosed, purged, vacuumed };
}
