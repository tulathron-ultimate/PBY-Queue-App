# PBY Queue App: Features, Defaults and Rules

Companion to `DECISIONS.md`, which is locked and takes precedence. This doc covers **what** to build in each release and the **default values and rules** the coder needs.
Scale: Value 1 (nice) to 5 (essential). Effort S is under half a day, M is 1 to 2 days, and L is more than 2 days.

---

## 1. Feature inventory

### 1.1 Event & host

| # | Feature | Description | Value | Effort | Release | Risk / notes |
|---|---------|-------------|:-----:|:------:|:-------:|--------------|
| E1 | Create event | Name, date, host PIN, Up next N, SMS mode. Creating an event requires the `ADMIN_PASSWORD` env var. | 5 | S | **MVP** | Event name is used in SMS, so cap it at 20 chars (§2.7). |
| E2 | Host PIN login | Unlock the host UI of one event with its PIN. | 5 | S | **MVP** | Rules in §2.9. |
| E3 | Helper devices | A second phone or tablet joins with the same PIN. All devices sync over WebSocket. | 4 | S | **MVP** | Last write wins. The server is the only authority on queue order. |
| E4 | Event settings screen | Change N, SMS mode (tap-to-send or Twilio), self-join on/off, public name display. | 4 | S | **MVP** | |
| E5 | Close / delete event | Close stops self-join and status updates. "Delete now" purges immediately. | 5 | S | **MVP** | Retention in §2.12. |
| E6 | Pause queue ("On break") | Shows "Photographer on a short break" to guests. | 3 | S | **Built (v1.1)** | Rules in §2.13. Optional short message (≤120 chars) and optional "we're paused" text; undoable. |
| E7 | Editable message templates | Per-event editing with a live 160-char and GSM-7 counter. | 3 | S | v1.1 | MVP ships the fixed defaults from §2.4. |
| E8 | Export results CSV | Who was served, when, and no-shows. Useful for photo ordering. | 3 | S | **Built (v1.1)** | Must happen before the retention purge. Columns and escaping in §2.15. |
| E9 | Multiple stations | Two or more photographers pulling from one queue, or several queues per event. | 2 | L | Later | |

### 1.2 Adding parties

| # | Feature | Description | Value | Effort | Release | Risk / notes |
|---|---------|-------------|:-----:|:------:|:-------:|--------------|
| A1 | Manual add | Name, phone, size, optional member names. One screen, big fields. | 5 | S | **MVP** | |
| A2 | Excel/CSV import | Upload `.xlsx`/`.csv` and see a preview with per-row errors before confirming. A template can be downloaded. | 5 | M | **MVP** | Columns in §2.8. Parsed client-side with SheetJS. |
| A3 | vCard import | Upload `.vcf` (the iPhone "share contacts" path). Each contact becomes a party of size 1 that can be edited in the preview. | 4 | M | **MVP** | Handle vCard 3.0 and 4.0, folded lines and multiple TELs (prefer CELL, then the first one). |
| A4 | Contact Picker | Android Chrome `navigator.contacts.select(['name','tel'], {multiple:true})`. | 3 | S | **MVP** | Feature-detect it and hide the button when it is unsupported. |
| A5 | QR / link self-join | Guest scans a QR code, enters name, phone, size and SMS consent, and joins the end of the line. | 5 | S | **MVP** | Rate limits in §2.10. The host shows the QR full-screen. |
| A6 | Duplicate detection | Warns when a phone number already has an active party in the event. The host can still add it (siblings often share a parent's phone). | 4 | S | **MVP** | |
| A7 | Group tag | Optional label per party, such as "U10 Hawks" or "Class 3B", with a filter chip on the host list. | 3 | S | v1.1 | The `Group` column is accepted by import in MVP and stored, just not yet used in the UI. |
| A8 | Arrival check-in | Imported parties are "not arrived" and are skipped by Call next until checked in (by the host, or by the guest from the status link). | 4 | M | **MVP** | Implement as a boolean flag, not a new state. Confirmed by user: rosters arrive over time. |
| A9 | Linked groups | A team photo followed by the individual photos of its members, with dependencies. | 2 | L | Later | |

### 1.3 Queue & host actions (one-handed)

| # | Feature | Description | Value | Effort | Release | Risk / notes |
|---|---------|-------------|:-----:|:------:|:-------:|--------------|
| Q1 | Queue list | Ticket #, name, size, state badge and phone-status icon. The now-serving party is pinned at the top. | 5 | M | **MVP** | Must render 300 rows smoothly. Virtualize if needed. |
| Q2 | **Call next** | A large button (at least 25% of screen height) in the bottom thumb zone. Marks the current party `done`, the next one `now_serving`, and recomputes `up_next`. | 5 | S | **MVP** | Debounce 1 s to prevent a double tap from calling two parties. |
| Q3 | Auto Up next | Parties within N spots of the front become `up_next`, which triggers the Up next SMS. | 5 | S | **MVP** | Rules in §2.2. |
| Q4 | Skip / Not here | Marks the now-serving party `skipped`, sends the Skipped SMS and calls the next party. | 5 | S | **MVP** | Policy in §2.6. |
| Q5 | Re-insert | "Back in line" on a skipped or no-show party. | 5 | S | **MVP** | Policy in §2.6. |
| Q6 | Undo | Undoes the last host action (a 10 s toast plus a persistent Undo button). | 5 | S | **MVP** | Essential when working one-handed. SMS already sent cannot be recalled. |
| Q7 | Move / remove | Move up, Move down and "Move to next" buttons on each row, plus Remove. | 4 | S | **MVP** | Drag-and-drop is v1.1. |
| Q8 | Ticket numbers | A stable sequential # for each party (1, 2, 3…), so parties can be called out loud. | 4 | S | **MVP** | Distinct from the position, which changes. |
| Q9 | Screen wake lock + haptics | Keeps the host screen on, and vibrates on Call next. | 4 | S | **MVP** | Wake Lock API, with a graceful fallback. |
| Q10 | Drag-and-drop reorder | | 2 | M | v1.1 | |
| Q11 | Offline host actions | Queue actions while signal drops, synced on reconnect. | 3 | L | Later | Conflicts with helper devices. |

### 1.4 SMS

| # | Feature | Description | Value | Effort | Release | Risk / notes |
|---|---------|-------------|:-----:|:------:|:-------:|--------------|
| S1 | `SmsProvider` interface | `send(to, body) -> {status}`. The two implementations below plug into it. | 5 | S | **MVP** | |
| S2 | Tap-to-send (default) | A **"Texts to send (n)" tray** holds pending messages. Tapping one opens `sms:` prefilled. Once it is marked sent (or the host returns to the app) it drops off. | 5 | M | **MVP** | iOS uses `sms:+1XXX&body=` and Android uses `sms:+1XXX?body=`. Detect by user agent. One recipient per tap. |
| S3 | Twilio provider | Sends automatically. Credentials are env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`). The event toggle only appears when these are set. | 5 | M | **MVP** | US A2P 10DLC or toll-free verification is required and takes days to weeks. See §2.11. |
| S4 | STOP / inbound webhook | `POST /sms/twilio/inbound` with a validated `X-Twilio-Signature`. | 5 | S | **MVP** | Compliance. See §2.11. |
| S5 | Delivery status | Twilio status callback, shown as ✓ / ✗ per party. | 3 | S | v1.1 | |
| S6 | Resend / custom text | Send a one-off message to a single party. | 3 | S | v1.1 | |
| S7 | Two-way replies | For example "Reply 1 for 5 more min". | 2 | L | Later | |
| S8 | Web Push notifications | For guests who keep the status page open. | 2 | M | Later | iOS only supports it for installed PWAs. |
| S9 | Multi-language templates | | 2 | M | Later | |

### 1.5 Guest view

| # | Feature | Description | Value | Effort | Release | Risk / notes |
|---|---------|-------------|:-----:|:------:|:-------:|--------------|
| G1 | Status page | `/s/{token}` shows your ticket #, your position ("You're #4", "3 ahead of you"), your state, who is up now and the event name. No wait time (see G6). | 5 | M | **MVP** | Live over WebSocket, with 15 s polling as a fallback. No login. |
| G2 | Name privacy on public views | "Now serving" shows `#14 Emma R.` (first name plus last initial), or only `#14` if the host turns names off. | 4 | S | **MVP** | Protects children's full names. |
| G3 | Leave line | The guest cancels from the status page (with a confirm step). | 4 | S | v1.1 | Keeps positions accurate. |
| G4 | "I'm here" check-in | Pairs with A8. | 4 | S | **MVP** | |
| G5 | Lobby/TV board | A large read-only 16:9 display of Now serving and the next 5 tickets, with the join QR code. | 3 | S | **Built (v1.1)** | Built at `/d/{token}` with an unguessable, revocable per-event token instead of the public event code (§2.14). Same privacy rule as G2. No wait time (G6). |
| G6 | ~~Wait-time estimate~~ | **Removed by owner decision (2026-09-25):** "don't use wait times, as it can vary." No screen, text or display shows a wait time or ETA; guests see their position and how many are ahead. | – | – | **Removed** | See §2.3. |

### 1.6 Platform & privacy

| # | Feature | Description | Value | Effort | Release | Risk / notes |
|---|---------|-------------|:-----:|:------:|:-------:|--------------|
| P1 | PWA manifest + install | Icons, standalone display, app-shell caching. | 4 | S | **MVP** | |
| P2 | Retention auto-purge | A daily job deletes party PII (§2.12). | 5 | S | **MVP** | |
| P3 | Log hygiene | Phone numbers are masked in logs (`+1******1234`). No SMS bodies are logged. | 5 | S | **MVP** | |
| P4 | Capacitor native wrap | Native contacts and SMS adapters. | 3 | L | Later | Adapters already isolated per DECISIONS. |

**MVP = E1–E5, A1–A6, Q1–Q9, S1–S4, G1–G2, P1–P3.** **Built in v1.1: E6, E8, G5.**

---

## 2. Defaults and rules

### 2.1 Queue states (from DECISIONS; restated for the rules below)
`waiting` → `up_next` → `now_serving` → `done`. Side states: `skipped`, `no_show`, `removed`.
The **position** is 1-based among `waiting` + `up_next` parties, ordered by `sort_key`. `now_serving` is position 0. At most **1** party is `now_serving` at a time.

### 2.2 Up next

| Rule | Default |
|------|---------|
| Threshold N | **2** (configurable 0–5; 0 disables Up next) |
| Trigger | After any queue change, parties at positions 1..N that are still `waiting` become `up_next`. |
| SMS | Sent **once per queue entry**. A party that moves back out of range (the host reorders) returns to `waiting` with no new text, and is **not** texted again when it comes back into range. Re-insertion after a skip counts as a new entry, so it resets the "sent once" flag. |
| Bulk case | When the queue first starts, or after an import, the top N parties get Up next at the same moment. |
| Your turn SMS | Sent when a party becomes `now_serving`. In tap-to-send mode it is queued in the tray **after** the Up next texts, because Up next matters more when the host is short on time. |

### 2.3 Wait-time estimate (removed)

**Removed by owner decision (2026-09-25):** "don't use wait times, as it can vary." The app
does not predict wait times anywhere: not on the guest status page, the join page, the host
dashboard, in texts, or on a lobby display. There is no "minutes per party" setting. Guests
see their position ("You're #4"), how many parties are ahead of them, who is being served now,
and the Up next state. Do not replace the estimate with any other time prediction.

### 2.4 Message templates (GSM-7 only, each ≤160 chars rendered)

Placeholders: `{event}` (≤20), `{name}` (first word of the display name, ≤12), `{pos}` (≤3 digits), `{ticket}` (≤3), `{link}` (≤45, see §2.10). There is no wait or ETA placeholder (§2.3).

| Key | Template | Max rendered length |
|-----|----------|:----------:|
| `join` | `{event}: {name}, you're #{pos} in line. Track live: {link}` | 114 (137 with the STOP footer) |
| `up_next` | `{event}: {name}, you're up next! Please head to the photo area now. Status: {link}` | 140 |
| `your_turn` | `{event}: {name}, it's your turn! Please come to the camera now.` | 82 |
| `skipped` | `{event}: {name}, we called you but missed you. Find the host to get back in line: {link}` | 146 |
| `paused` (v1.1, E6) | `{event}: {name}, the photo line is paused for a short break. You keep your place: {link}` | 146 (149 with a 48-char link; with the STOP footer the name is dropped: ≤160) |

Rules:
- The `join` message is sent on import, manual add and self-join. For an import, the "Send join texts" confirmation shows how many texts will go out (in tap-to-send mode, 200 taps is unrealistic, so this defaults to **off for imports and on for self-join**).
- In **Twilio mode only**, the first message to a number in an event appends ` Reply STOP to opt out.` (23 chars).
- Use only straight quotes and apostrophes and no emoji. Any non-GSM-7 character switches the message to UCS-2, which has a 70-char limit. Transliterate names to ASCII when sending (é becomes e).
- Overflow fallback when rendering: (1) drop `{name}, `, then (2) truncate `{event}`. Never truncate `{link}`.

### 2.5 Call next behaviour
1. The current `now_serving` party becomes `done` (with its timestamp recorded).
2. The first party by `sort_key` among `up_next`/`waiting` becomes `now_serving`, which triggers `your_turn`.
3. Up next is recomputed (§2.2).
4. If nobody can be called, the button is disabled and says **"Line is empty"** when no one is waiting, or **"Nobody checked in"** when everyone waiting is not here yet (A8). (Aligned with the UI and DESIGN H3 after QA; this replaces "Queue empty".)

### 2.6 Skip / no-show policy

| Rule | Default |
|------|---------|
| Skip | "Not here" on the now-serving party marks it `skipped`, sends the `skipped` SMS and auto-calls the next party. |
| Re-insert position | **3 spots back** from the front (it becomes position 4), or the end of the line if the line is shorter. This is not the end of the line, because the party is usually nearby. |
| Re-insert trigger | Only the host can re-insert ("Back in line" on the skipped list) in MVP. |
| Max skips | **2** skips per party. The 3rd "Not here" marks it `no_show`, which can still be re-inserted manually but goes to the **end of the line**. |
| Auto no-show | None in MVP. Skipped parties stay visible in a collapsible "Missed" section until the event closes. |

### 2.7 Field limits

| Item | Limit |
|------|-------|
| Event name | 1–40 chars. The first 20 are used in SMS, and the host can set a separate "SMS short name". |
| Party display name | 1–40 chars |
| Party size | 1–**20** (default 1) |
| Member names | ≤20 names, each ≤40 chars |
| Notes (host-only) | ≤200 chars |
| Active parties per event | **500** (import and self-join are refused beyond this) |
| Rows per import | 500 |
| Helper devices | 5 concurrent host sessions per event |

### 2.8 Excel/CSV template

Sheet name `Queue`, header row 1, one party per row. Headers are case-insensitive and extra columns are ignored.

| Column header | Required | Format / rule | Accepted aliases |
|---------------|:--------:|---------------|------------------|
| `Name` | Yes | The party display name, e.g. "Rivera Family" | `Party Name`, `Full Name` |
| `Phone` | No* | Any US format (§2.9). A blank phone means the party gets no texts. | `Mobile`, `Cell`, `Phone Number` |
| `Party Size` | No | Integer 1–20. If blank, it is the member count, or 1. | `Size`, `Count` |
| `Members` | No | Names separated by `;` or `,` | `Member Names` |
| `Group` | No | A free-text label (stored in MVP, used in v1.1) | `Team`, `Class` |
| `Notes` | No | Host-only | |

\*A missing phone number is allowed, but it shows as a warning in the preview.
Row order becomes queue order. Rows with no `Name` are skipped. Invalid rows are listed with the reason and can be fixed or excluded in the preview. CSV files must be UTF-8 (with a BOM tolerated). The downloadable template includes 2 example rows, and the importer ignores rows whose Name starts with `Example`.

### 2.9 Phone normalization (US, E.164)
1. Strip everything except digits and a leading `+`.
2. 10 digits: prefix `+1`. 11 digits starting with `1`: prefix `+`. A leading `+` with 8–15 digits is kept as-is (international, allowed only in tap-to-send mode).
3. Otherwise the number is **invalid**. The party is still saved, flagged "no texts", and a ⚠ icon appears in the list.
4. Reject US numbers whose area code or exchange starts with 0 or 1.
5. Store only E.164. Display as `(555) 123-4567`.
6. Recommended library: `libphonenumber-js` (the "min" metadata).

### 2.10 Tokens, PIN and abuse limits

| Item | Default |
|------|---------|
| Status link token | **12 chars base62** from a CSPRNG (~71 bits). URL `https://{host}/s/{token}`. Keep `{host}` ≤25 chars so `{link}` stays ≤45. |
| Event join code (QR) | 6 chars from base32 without ambiguous characters. URL `/j/{code}`. Unknown codes on `GET /api/join/{code}` count toward the same per-IP miss limit as unknown status tokens (QA #16). |
| Host PIN | **6 digits** minimum (up to 12 chars, digits or letters). Stored as a scrypt or argon2 hash, never in plain text. |
| PIN brute force | 5 failures per IP per minute causes a 60 s block. **20 failures per (event, IP) per hour lock that event for that IP for 15 min**, so a stranger holding the public join code only locks themselves out. Backstop: **200 failures per event per hour** from all addresses together lock the event for everyone for 15 min. (Was 20 per event; changed by owner decision after QA #14.) |
| Host session | An HttpOnly, Secure, SameSite=Lax cookie, valid for 12 h and cleared when the event closes. |
| Status endpoint | 60 req/min per IP. An unknown token returns a generic 404. |
| Self-join | **60 joins per (IP, event) per 10 min**, configurable with the `SELF_JOIN_PER_IP` env var. Keyed per event because families at one venue share a Wi-Fi or carrier NAT address (was 10 per IP; changed by owner decision after QA #13). One active party per phone per event (a duplicate returns the existing status link). Honeypot field; no CAPTCHA in MVP. The 500 active-party cap (§2.7) still applies. |
| Twilio join texts from self-join | **60 per event per hour** (env `SELF_JOIN_TEXTS_PER_HOUR`), so strangers with the QR code can't run up the Twilio bill by joining with numbers they know. Parties over the cap still join; their join text is not sent automatically and instead waits in the host's "Texts to send" tray, with a banner on the dashboard (QA #15). Host-added parties and Up next / Your turn texts are not capped. |

### 2.11 SMS opt-out & Twilio compliance

| Topic | Rule |
|-------|------|
| Consent | Self-join: an **unchecked** checkbox reading "Text me queue updates (msg & data rates may apply)", which must be ticked before any text is sent. Import and manual add: the host confirms once per event that "these people agreed to receive texts about this photo session". |
| Opt-out keywords | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT (case-insensitive, whole message): mark the phone `opted_out`. Twilio's Advanced Opt-Out also auto-replies and blocks, so the app must **not** send its own confirmation text. |
| Opt-in keywords | START, UNSTOP, YES: clear the `opted_out` flag. |
| HELP | Let Twilio's default reply handle it, and set a HELP message in the Messaging Service that includes the business name and contact. |
| Suppression list | Store opted-out numbers as **SHA-256(E.164 + server salt)**, kept indefinitely and across events, so they survive the PII purge. Check it before every Twilio send. |
| Error 21610 | Twilio "unsubscribed recipient": mark the number opted out and show ⚠ on the party. |
| Tap-to-send mode | The text comes from the host's own phone, so STOP does not reach the app. A per-party "No texts" toggle covers it. Tap-to-send still honours the suppression list. |
| Registration | US long codes need **A2P 10DLC** brand and campaign registration. Toll-free numbers need **toll-free verification**. Either takes days to weeks and costs a small fee, so document this in the setup guide. |
| Quiet hours | None; messages are only sent in response to a live event. |

### 2.12 Data retention

| Data | Retention |
|------|-----------|
| Event auto-close | 12 h after the last host action, or at the manual close. Only authenticated host changes count (stored as `last_host_action_at`); guest self-joins, "I'm here" taps and simply viewing the dashboard do not (QA #18). |
| Party PII (names, phones, members, notes, tokens) | **Deleted 7 days after close.** "Delete now" is available at any time. |
| Aggregate stats (counts, average service time) | Kept without PII. |
| SMS send log | Kept with the PII and deleted with it. The body is never stored, only the template key and status. |
| Opt-out hashes | Kept indefinitely (§2.11). |
| Backups | Back up the SQLite file only if the host opts in, and document that backups extend retention. |
| Purge job | Runs on startup and every 24 h. Deleted rows are removed for real, followed by `VACUUM` weekly. |

### 2.13 Pause the line (E6, v1.1)

| Rule | Default |
|------|---------|
| Who | Host devices only (any signed-in helper). **Pause line** is in the dashboard's More menu; **Resume** is on the paused strip above Call next. Helper devices sync live. |
| Message | Optional, ≤**120** characters, text only: control and bidi characters are removed. Shown on guest status pages, the lobby display and the host dashboard. It is not put in texts. |
| While paused | Call next is refused (dashboard: disabled, "Line paused"). "Not here" marks the party skipped but calls nobody else. Serve now still works (an explicit host choice). Parties still move into `up_next` so pages stay correct, but **no Up next texts go out**: Twilio sends none, and tray texts queued before the pause are held out of the tray. "Text now" on a waiting party sends the `paused` text instead of Up next. |
| Resume | Call next works again. Up next texts that were held go out once (the "sent once per entry" rule of §2.2 still applies). Queued `paused` texts that were not sent yet are dropped. |
| "We're paused" text | Optional, **off by default**. One `paused` text per party waiting (arrived or not), at most once per pause, through the tray or Twilio per the event's mode. It follows No texts, consent and the opt-out list like every text, and in Twilio mode it counts toward the hourly `SELF_JOIN_TEXTS_PER_HOUR` cap. |
| Undo | Pause and Resume are undoable. Every undo step also records the pause state it replaces. |

### 2.14 Lobby display link (G5, v1.1)

| Rule | Default |
|------|---------|
| Link | `https://{host}/d/{token}`: 18 random bytes (144 bits), base64url (24 chars). The host makes it on the Share screen ("Make a TV link", then "Open on TV" copies it). None exists until the host makes one. |
| Storage | The token (so any host device can show it again) and its SHA-256, which lookups use, followed by a constant-time compare. |
| Revoke | "Turn off TV link" clears it; making a new link replaces the old one. Either way, displays on the old link are disconnected at once. The purge (§2.12) clears it too. |
| Payload | Built from an allowlist: event name, ended flag, pause state and message, now serving and the next **5** arrived parties as ticket + G2 name ("Emma R.", or null when names are off), and the join link and QR path (null when self-join is off). No phone numbers, party ids, status tokens, notes, members or sizes. |
| Limits | Unknown tokens count toward the per-IP miss limit shared with status links and join codes (§2.10); each real link gets 60 requests a minute. Tokens are redacted from logs, and every response has `Referrer-Policy: no-referrer`. |
| Display | Always dark, 16:9 (stacks when held upright), keeps the screen awake, reconnects on its own with 15 s polling as a fallback. |

### 2.15 Results CSV export (E8, v1.1)

| Rule | Default |
|------|---------|
| Where | Settings → Data → **Download results (CSV)**, while the event is open or closed, until the retention purge (after closing, sign back in with the PIN). Host session only (`GET /api/host/events/{id}/export.csv`). |
| Columns | `Ticket, Party name, Party size, Members, Phone, Group, Notes, Final status, Checked in, Called, Done`. Members are joined with `; `. Phone is E.164 (blank if missing or invalid). Final status is `done`, `no_show`, `skipped`, `removed` or `waiting` (Up next counts as waiting), or `now_serving` for a party being photographed at export time. Times are `YYYY-MM-DD HH:MM:SS` in the device's time zone; Done is filled for done parties only. Check-in times are recorded from v1.1 on. |
| Escaping | Any cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'` (so every phone number shows as `'+15551234567`), then RFC 4180 quoting. |
| File | UTF-8 with a BOM (for Excel), CRLF lines, `Content-Disposition: attachment` with an ASCII name like `pumpkin-patch-portraits-2026-10-01-results.csv`, `Cache-Control: no-store`, `nosniff`. The service worker never caches API responses. |

---

## 3. Open questions for the user (≤3)

1. ~~**Imported rosters:**~~ Resolved: arrival check-in (A8, G4) is in MVP.
2. **Twilio at launch?** Tap-to-send works with no setup, but automated texts need A2P 10DLC or toll-free registration, which takes days to weeks. Should registration start now, before the first event?
