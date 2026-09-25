/** Data retention (§2.12): auto-close idle events and purge party PII after close. */
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
    if (!db.prepare('SELECT 1 FROM events WHERE id = ?').get(eventId)) return;
    // Aggregate kept after the purge (§2.12): how long a photo took on average, from the
    // parties that were served. This is a record of the past, not a wait prediction.
    const avg = db
      .prepare(
        `SELECT AVG(done_at - called_at) AS ms FROM parties
         WHERE event_id = ? AND state = 'done' AND called_at IS NOT NULL AND done_at IS NOT NULL`,
      )
      .get(eventId) as { ms: number | null };
    const avgMs = avg.ms === null ? null : Math.round(avg.ms);
    db.prepare('DELETE FROM sms_log WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM undo_stack WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM sessions WHERE event_id = ?').run(eventId);
    db.prepare('DELETE FROM parties WHERE event_id = ?').run(eventId);
    db.prepare(
      `UPDATE events SET status = 'closed', closed_at = COALESCE(closed_at, ?), purged_at = ?,
        samples = '[]', paused = 0, pause_message = NULL, paused_at = NULL,
        lobby_token = NULL, lobby_token_hash = NULL, served_count = COALESCE(served_count, ?), no_show_count = COALESCE(no_show_count, ?),
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
      // Host actions only: guest self-joins and "I'm here" taps must not keep an event open.
      .prepare(
        `SELECT id FROM events WHERE status = 'open'
           AND COALESCE(last_host_action_at, last_action_at) < ?`,
      )
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
