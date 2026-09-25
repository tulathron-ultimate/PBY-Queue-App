import { DEFAULTS, LIMITS } from '@pby/shared';
import type { DB } from './db.js';
import { ServiceError } from './errors.js';
import { newSessionToken, sha256 } from './security.js';

/** Host sessions: 12 h, max 5 concurrent per event, cleared when the event closes (§2.10). */
export class Sessions {
  constructor(
    private readonly db: DB,
    private readonly now: () => number,
  ) {}

  static cookieName(eventId: string): string {
    return `pby_h_${eventId}`;
  }

  static readonly maxAgeSeconds = DEFAULTS.sessionHours * 3600;

  active(eventId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE event_id = ? AND expires_at > ?')
      .get(eventId, this.now()) as { n: number };
    return row.n;
  }

  create(eventId: string): string {
    const now = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    if (this.active(eventId) >= LIMITS.helperSessionsMax) {
      throw new ServiceError(
        429,
        'too_many_devices',
        `This event already has ${LIMITS.helperSessionsMax} devices signed in. Sign one out in Settings.`,
      );
    }
    const token = newSessionToken();
    this.db
      .prepare(
        'INSERT INTO sessions (token_hash, event_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(sha256(token), eventId, now, now + Sessions.maxAgeSeconds * 1000);
    return token;
  }

  valid(eventId: string, token: string | undefined): boolean {
    if (!token) return false;
    return !!this.db
      .prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND event_id = ? AND expires_at > ?')
      .get(sha256(token), eventId, this.now());
  }

  delete(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  deleteOthers(eventId: string, keepToken: string): number {
    return this.db
      .prepare('DELETE FROM sessions WHERE event_id = ? AND token_hash != ?')
      .run(eventId, sha256(keepToken)).changes;
  }

  deleteAll(eventId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE event_id = ?').run(eventId);
  }
}
