# Implementation notes

Choices made while building the MVP where the specs were ambiguous, disagreed, or left
something open. The rule used throughout: `DECISIONS.md` wins, then `FEATURES.md` (defaults,
templates and rules), then `DESIGN.md`, and otherwise the simplest reasonable option.

## Where FEATURES.md and DESIGN.md disagree (FEATURES.md used)

| Topic              | DESIGN.md                   | Built (FEATURES.md)                                                         |
| ------------------ | --------------------------- | --------------------------------------------------------------------------- |
| Message templates  | §7 wording, with 📸 emoji   | §2.4 templates exactly (GSM-7, no emoji), plus the §2.4 overflow rules      |
| Up next threshold  | 1–10                        | 0–5, default 2; 0 turns Up next off                                         |
| Undo toast         | 6 s                         | 10 s, plus a persistent Undo button in the top bar                          |
| Party size         | 1–30                        | 1–20                                                                        |
| Host PIN           | 4–6 digits                  | 6–12 digits or letters, scrypt-hashed                                       |
| Call next button   | 80 px tall                  | at least 25% of the screen height (Q2), never under 80 px                   |
| Twilio credentials | entered per event in the UI | server env vars only; the "Automatic" option appears only when they are set |

## Queue rules

- **Position with arrival check-in (A8).** Call next skips parties that have not arrived, so a
  guest's position is `1 + arrived active parties ahead`. Otherwise an imported roster of 200
  not-yet-arrived families would show the first arrival "#150 in line" while being next. Up next
  goes to the first N _arrived_ parties, the ones that will actually be called.
- **No wait-time estimates** (owner decision, FEATURES §2.3 and G6): the estimate, its service-time
  samples and the "Minutes per party" setting were removed from the guest page, the join page,
  the host dashboard, Settings and the join text. Guests see their position and "N ahead of you"
  (arrived parties ahead). The `events.minutes_per_party`, `events.samples` and
  `undo_stack.samples` columns are kept for existing databases but are no longer read. Guests
  who have not checked in see a big **I'm here** button instead of the "ahead" line.
- **Who starts as arrived:** manual adds and self-joins are arrived (the host is looking at them;
  a guest scanning the QR is on site). Excel/CSV, vCard and Contact Picker imports start as not
  arrived, with an "Everyone is here already" option in the import preview.
- **Re-insert "3 spots back"** counts arrived parties, consistent with positions. No-shows go to
  the end. Re-insert resets the "Up next sent" flag (new entry) and marks the party arrived.
- **Skip / No-show:** "Not here" works on the now-serving party (Q4). DESIGN's separate No-show
  button on the Now-serving card became "Not here"; the 3rd "Not here" makes a party `no_show`
  (§2.6). Parties can also be served out of order with **Serve now** (DESIGN H4).
- **Done without calling the next party:** the Now-serving card's **Done** marks the current party
  done without calling anyone.
- **Undo** covers queue actions (Call next, Done, Not here, Serve now, Move, Remove, Back in line,
  check in / out). The server keeps the last 20 per event and restores the queue fields of every
  party in the snapshot; parties added since are kept. Adding, importing and editing details are
  not undoable (Remove covers mistakes). Texts already sent cannot be recalled, so the Up next
  flag stays set for them; tap-to-send texts the undone action queued are cancelled.
- **Debounce:** Call next is debounced for 1 s on the device and again on the server (HTTP 429),
  so two helper devices cannot call two parties at once.
- **Remove** is allowed for any state except done/removed. Removed parties show under "Done &
  removed" with a strikethrough.

## Texting

- **Tray order** follows §2.2: Up next texts first, then Your turn, then Missed. A queued tray text
  that no longer applies (e.g. "Up next" for a party that is now being served) is dropped
  automatically.
- **Join texts:** on by default for manual adds and self-join, off by default for imports (the
  preview shows how many would go out). A party that is texted "Up next" the moment it is added
  does not also get the join text.
- **Consent (§2.11):** self-join needs the (unchecked by default) consent box before any text, and
  the Join page requires it when a phone number is entered. Host-added parties can be texted once
  the host ticks "these people agreed to receive texts about this photo session" (asked once per
  event, in the add form and the import preview). Per-party **No texts** covers tap-to-send STOP
  requests.
- **Tap-to-send** marks a text sent when the page becomes visible again after Messages opened
  (optimistic; "Didn't send? Put it back" reverts). On a desktop, where the page never hides, an
  "I sent it" button does the same. The message body is rendered on the host device when the tray is
  shown, with the same shared template code the server uses for Twilio (`renderPartyText`), and
  never stored. Host snapshots carry only the template key, so they stay small with a full tray.
- **Twilio** sends from the server with plain `fetch`. International numbers are not texted in
  Twilio mode (§2.9 allows them only in tap-to-send). The STOP footer goes on the first Twilio
  message to a number in an event, tracked through the SMS log. Delivery status callbacks (S5) are
  v1.1, so "sent" means Twilio accepted the message.
- **Event name in texts:** a separate "short name for texts" field appears when the event name is
  longer than 20 characters (§2.7); otherwise the first 20 characters are used.

## Links, auth and privacy

- **`{link}` host:** `PUBLIC_URL` if set, otherwise the origin of the request that created the
  event is stored with the event (works on a LAN without configuration).
- **Host events list (H0)** shows the events this device holds a valid session cookie for (one
  httpOnly cookie per event). Helpers open an event with its 6-character join code and the PIN.
- **Helper limit:** the 6th concurrent device is refused ("sign one out in Settings") rather than
  silently signing out the oldest, which could be the main host.
- **Closing** an event clears every session (§2.10). The host can sign back in with the PIN to see
  the read-only event and use **Delete guest data now**.
- **Public names (G2):** first word plus the initial of the last word, so "Emma Rivera" → "Emma R."
  and "Priya & Dev" → "Priya D.". A guest's own name is filtered the same way on their status page: status links get
  forwarded, and a self-join with a phone already in line returns that party's link, so the
  page must not reveal a full name to whoever holds it.
- **CSRF:** host routes use a SameSite=Lax cookie and require `application/json` bodies, which
  cross-site forms cannot send.
- **Logs:** request URLs have status tokens replaced with `***` and phone-like numbers masked
  (`+1******1234`); SMS bodies are never logged. `Referrer-Policy: no-referrer` keeps status
  tokens out of referrers.
- **Rate limits** (§2.10) are in memory, which is correct for the single-container deployment.
- **Status limit (§2.10):** instead of 60 requests a minute per IP, unknown tokens count 60 a
  minute per IP (after that the IP gets 429 for every token) and each real link gets 60 a minute.
  Families at one venue often share a Wi-Fi or carrier NAT address, and a page load costs two
  requests (fetch + WebSocket), so a plain per-IP limit locked out the 31st family to open
  their link in the same minute.

## Imports

- Phone normalization follows §2.9 by hand instead of using `libphonenumber-js`; the rules are
  short and exact, and the result is unit-tested.
- SheetJS is installed from the official SheetJS CDN tarball (`xlsx` 0.20.3); the npm registry
  copy is stuck at an old, vulnerable version. It is loaded on demand so the host dashboard stays
  small.
- If no `Name` column is found, the preview says so and offers the template, instead of the
  per-column mapping dropdowns sketched in DESIGN H6a. Imports always go to the end of the line
  (DESIGN's "before current waiting list / shuffle" options were left out).
- Invalid phone numbers are warnings (fix inline or keep with no texts); name, size, member and
  note limits are errors that must be fixed or the row left out.

## Retention and operations

- Auto-close uses `events.last_host_action_at`, which only authenticated host requests that
  change something move (added by an additive migration and backfilled from `last_action_at`).
- The retention sweep runs every 15 minutes for the 12-hour auto-close; the purge part runs at
  startup and every 24 hours, with `VACUUM` at most weekly (§2.12).
- The Docker image installs with `--ignore-scripts`: better-sqlite3 13 ships prebuilt binaries for
  glibc/musl on x64/arm64 and nothing else needs an install script, so no compiler is needed.

## Not built in the MVP (by the specs' release column or deliberately)

- v1.1 / Later items: pause ("On break"), editable templates, CSV export, group filter chips,
  drag-and-drop reorder, delivery status, one-off custom texts, leave line / change party size on
  the guest page, lobby/TV display, multi-language, Web Push, offline queueing of host actions
  (the dashboard shows an offline banner; actions need a connection), and the Capacitor wrap.
- The queue list uses `content-visibility: auto` rather than a virtualization library, which keeps
  300–500 simple rows cheap to render. It has not been profiled on a low-end phone yet.
- The guest pages are part of the SPA rather than a server-rendered shell.
