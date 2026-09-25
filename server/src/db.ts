import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

/** Schema migrations; `user_version` counts how many have run. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    sms_name TEXT,
    date TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    up_next_n INTEGER NOT NULL,
    minutes_per_party INTEGER NOT NULL,
    sms_mode TEXT NOT NULL,
    self_join INTEGER NOT NULL,
    show_names INTEGER NOT NULL,
    host_consent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    public_url TEXT NOT NULL,
    next_ticket INTEGER NOT NULL DEFAULT 1,
    samples TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    last_action_at INTEGER NOT NULL,
    last_call_at INTEGER,
    closed_at INTEGER,
    purged_at INTEGER,
    served_count INTEGER,
    no_show_count INTEGER,
    avg_service_ms INTEGER
  );

  CREATE TABLE parties (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    ticket INTEGER NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    members TEXT NOT NULL DEFAULT '[]',
    phone TEXT,
    phone_invalid_input TEXT,
    group_label TEXT,
    notes TEXT,
    source TEXT NOT NULL,
    consent INTEGER NOT NULL DEFAULT 0,
    no_texts INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    sort_key REAL NOT NULL,
    arrived INTEGER NOT NULL,
    skip_count INTEGER NOT NULL DEFAULT 0,
    up_next_sent INTEGER NOT NULL DEFAULT 0,
    called_at INTEGER,
    done_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX parties_event ON parties(event_id);

  -- The SMS body is never stored, only the template key and status (§2.12).
  CREATE TABLE sms_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    party_id TEXT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    template TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    footer INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    provider_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sms_log_event ON sms_log(event_id);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_event ON sessions(event_id);

  -- SHA-256(E.164 + salt). Kept indefinitely, across events (§2.11).
  CREATE TABLE opt_outs (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);

  CREATE TABLE undo_stack (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    samples TEXT NOT NULL,
    sms_ids TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // 2: auto-close (§2.12) counts only host actions; guest self-joins and "I'm here" taps also
  // move last_action_at. Additive: existing events start from their last activity.
  `
  ALTER TABLE events ADD COLUMN last_host_action_at INTEGER;
  UPDATE events SET last_host_action_at = last_action_at;
  `,
  // 3: pause the line (E6). Undo steps also record the pause state they replace.
  `
  ALTER TABLE events ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE events ADD COLUMN pause_message TEXT;
  ALTER TABLE events ADD COLUMN paused_at INTEGER;
  ALTER TABLE undo_stack ADD COLUMN event_state TEXT;
  `,
];

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
