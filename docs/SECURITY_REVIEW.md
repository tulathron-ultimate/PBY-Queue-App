# Security review: PBY Queue MVP

Scope: `origin/main` at `5edfbce` (the MVP plus the QA fixes): the Fastify server, WebSocket hub,
Twilio webhook, SQLite storage and retention, the React PWA and service worker, Docker and the
dependency tree. The threat model is an internet-exposed single container (Unraid behind a
Cloudflare Tunnel, or Fly.io/Render) holding guests' names and phone numbers, and able to send
Twilio texts at the owner's cost. Attackers considered: anyone on the internet, anyone holding
the public QR/join code, a guest holding their own status link, a page on a sibling subdomain of
the same domain (the typical self-hosted setup), and someone who later gets a copy of the
database file.

The QA report's fixes were re-tested and hold (#1 forged `X-Forwarded-For`, #2 signed-out
sockets, #3 guest names, #4 placeholder admin password, #8 cross-site host WebSocket, #10 import
validation, #13–#16 rate limits and Twilio cap, #18 auto-close). SEC-4 extends #16 to the two
join routes it missed.

**Summary:** 9 findings fixed (0 Critical, 0 High, 5 Medium, 4 Low), and 7 left open (2 Low, 5
Info) with reasons below. Every fix has a regression test in `server/test/security.test.ts`
(or `e2e/security.spec.ts`) that failed before the fix.

## Findings

| ID     | Severity | Area                | Description                                                                                                                                                                                                                                                                             | Exploit scenario                                                                                                                                                                                                                                                                                                             | Status                 | Commit    |
| ------ | -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------- |
| SEC-1  | Medium   | CSRF                | The JSON-only CSRF rule accepted any `Content-Type` that _contained_ `application/json`. `text/plain; application/json` is CORS-safelisted (its essence is `text/plain`), so it needs no preflight. There was no Origin check, and SameSite=Lax treats sibling subdomains as same-site. | A page on `other.yourdomain.com` (another app behind the same tunnel, or any XSS there) runs `fetch('/api/host/events/<id>/delete', {method:'POST', credentials:'include', headers:{'content-type':'text/plain; application/json'}})` while the host is signed in, and wipes the guest data mid-event, or presses Call next. | Fixed                  | `9227db4` |
| SEC-2  | Medium   | Headers             | No CSP, `X-Frame-Options`/`frame-ancestors`, HSTS, Permissions-Policy or `Cache-Control` on API responses. Only `Referrer-Policy` and `nosniff` were sent.                                                                                                                              | Any site frames `/host/e/<id>` under a decoy and tricks the host into clicking **Delete guest data now** or **Call next** (clickjacking). There's no CSP to contain a future XSS. Snapshots with names, phones and status tokens could be kept by browser or intermediary caches.                                            | Fixed                  | `af01043` |
| SEC-3  | Medium   | Privacy / retention | Purges ran `DELETE`s, but SQLite leaves deleted cells in free pages, and the WAL keeps the old page images until the weekly `VACUUM`. The names, phones and notes stayed in `pby-queue.db`/`-wal` for up to 7 days after "Delete guest data now".                                       | Someone who later gets the volume, an Unraid appdata backup or a copied `.db` file runs `strings pby-queue.db` and reads guest names and numbers the host believed were deleted. This breaks the §2.12 promise.                                                                                                              | Fixed                  | `92f9214` |
| SEC-4  | Low      | Enumeration / DoS   | QA #16 limited unknown codes on `GET /api/join/:code` only. `POST /api/join/:code` and `GET /api/join/:code/qr.svg` still answered 404 with no miss counting. POST also turned the attacker-chosen code into a rate-limiter key before checking it.                                     | Enumerate the 30-bit join code space through the QR endpoint with no limit, then spam self-joins or guess PINs by code. Or POST random codes to grow the join limiter's map by one key per request until memory runs out.                                                                                                    | Fixed                  | `e826333` |
| SEC-5  | Medium   | AuthN / rate limits | Per-IP limits used the full client address. An IPv6 client owns a /64 (2^64 addresses; Cloudflare passes the real client address), so every per-IP limit was effectively per request. The admin password had no global backstop.                                                        | From one IPv6 host, rotate the source address per request: unlimited guesses at `ADMIN_PASSWORD`. A correct guess lets the attacker create events and send Twilio texts at the owner's cost. The same trick sidesteps the PIN, status-token and self-join per-IP limits.                                                     | Fixed                  | `7212d7a` |
| SEC-6  | Low      | DoS (memory)        | Rate-limiter maps gained one key per client and were only pruned by the 15-minute sweep, with no size cap.                                                                                                                                                                              | A botnet, or many IPv6 /64s, sends requests from distinct addresses and grows the maps by hundreds of MB inside one sweep, until the small Unraid container is OOM-killed mid-event.                                                                                                                                         | Fixed                  | `89d5a0b` |
| SEC-7  | Medium   | WebSocket / DoS     | No limit on concurrent WebSockets per status link, host session or address. Each socket stays registered for the life of the event and gets a snapshot on every change.                                                                                                                 | Self-join once (the QR code is public) and open thousands of `/ws/status/<own token>` sockets over time (60 a minute pass the per-link limit). Memory and the per-change fan-out grow until the server stalls for every family.                                                                                              | Fixed                  | `26ad6a2` |
| SEC-8  | Low      | Input / UI spoofing | Names, members, notes, groups and event names kept control characters, bidi overrides/isolates (U+202E, U+2066…), zero-width and blank-looking characters (U+200B, U+3164). SMS bodies were already ASCII-only.                                                                         | A self-joiner names themselves `Emma` followed by U+202E to reverse the text after it on the host's list and on every guest's **Now serving** / **Coming up**, imitates another family's name with invisible differences, or joins with a blank name that the host can't identify.                                           | Fixed                  | `6370f3d` |
| SEC-9  | Low      | DoS (CPU)           | Every route accepted 2 MB JSON bodies, including anonymous ones (self-join, login, event creation, check-in). Bodies were parsed before auth or rate limits.                                                                                                                            | One client streams 2 MB JSON bodies to `/api/join/<code>` or `/api/host/login` in a loop. Each is fully parsed before being refused, so a single connection costs the server CPU and memory without limit.                                                                                                                   | Fixed                  | `bed3786` |
| SEC-10 | Low      | Privacy (by design) | Self-join with a phone already in line returns that party's status link (A5 "a duplicate returns the existing link").                                                                                                                                                                   | Someone holding the public QR code and a family's phone number gets their status link: their place in line (name as "Emma R.") and the **I'm here** button.                                                                                                                                                                  | Fixed (owner decision) | see below |
| SEC-11 | Low      | Privacy             | The opt-out salt defaults to a random value stored in the same database as the hashes. US numbers are about 10^10 values, so SHA-256(phone + salt) is reversible in minutes by whoever has the file.                                                                                    | Someone with a copy of the database recovers which phone numbers texted STOP (kept indefinitely, across purges).                                                                                                                                                                                                             | Open: config           | –         |
| SEC-12 | Info     | AuthN               | The PIN hash is scrypt N=2^14, r=8, p=1 (OWASP suggests N=2^17). A 6-digit PIN is at most 10^6 tries offline whatever the cost factor.                                                                                                                                                  | Only matters if the database leaks, and then the guest data the PIN protects has leaked with it. Raising N to 2^17 needs 128 MB per hash, which would make concurrent logins a memory-exhaustion vector.                                                                                                                     | Accepted               | –         |
| SEC-13 | Info     | Deployment          | `docker-compose.yml` publishes `3000:3000` on all interfaces while `TRUST_PROXY=1` trusts one forwarded hop.                                                                                                                                                                            | If the router forwards port 3000 too, a direct client forges `X-Forwarded-For` and gets fresh per-IP limits. The README already warns against this (QA deployment note).                                                                                                                                                     | Open: documented       | –         |
| SEC-14 | Info     | Session             | The session cookie has no `__Host-` prefix.                                                                                                                                                                                                                                             | A sibling subdomain could set a same-named cookie for the parent domain and sign a host device out (no access gained). `__Host-` requires `Secure`, which would break plain-HTTP LAN testing.                                                                                                                                | Open                   | –         |
| SEC-15 | Info     | Supply chain        | The Docker base image `node:22-bookworm-slim` is pinned by tag, not digest.                                                                                                                                                                                                             | A compromised or changed tag changes the runtime on the next build. Pinning by digest needs a process to bump it for security updates.                                                                                                                                                                                       | Open                   | –         |
| SEC-16 | Info     | Content abuse       | Guests choose the name other guests see (first name plus initial).                                                                                                                                                                                                                      | A self-joiner uses an offensive or misleading name ("Photographer says leave"). The host can remove the party, or turn names off (ticket numbers only) in Settings.                                                                                                                                                          | Open: guidance below   | –         |

### What each fix does

- **SEC-1** `server/src/app.ts`: the CSRF hook (now `onRequest`) compares the media-type
  _essence_ exactly with `application/json`. It then refuses `/api` writes whose `Origin` host
  isn't the request host (or `PUBLIC_URL`'s), or whose `Sec-Fetch-Site` is anything but
  `same-origin`/`none`. Non-browser clients (no `Origin`, no `Sec-Fetch-Site`) have no ambient
  cookie and are unaffected.
- **SEC-2** `server/src/app.ts`: `Content-Security-Policy: default-src 'self'; script-src 'self';
style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src
'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self';
frame-ancestors 'none'` (no `unsafe-inline`/`unsafe-eval`: the built `index.html` has no inline
  code, and React `style` props use the CSSOM). Also `X-Frame-Options: DENY`, a
  `Permissions-Policy` that allows only `screen-wake-lock=(self)`, COOP/CORP `same-origin`,
  `Strict-Transport-Security: max-age=31536000` on HTTPS requests, and `Cache-Control: no-store`
  on `/api` and `/ws` unless a route sets its own (the QR SVG). `e2e/security.spec.ts` checks
  that the PWA, the QR image, the service worker and the WebSockets raise no CSP violations.
- **SEC-3** `server/src/db.ts`, `retention.ts`: `PRAGMA secure_delete = ON` zeroes deleted
  content, and each purge ends with `wal_checkpoint(TRUNCATE)`. The test reads the raw `.db` and
  `-wal` bytes after **Delete guest data now**.
- **SEC-4** `server/src/routes/public.ts`: one `joinEvent()` lookup for all three join routes
  counts misses per client, and only real codes become self-join limiter keys.
- **SEC-5** `server/src/security.ts` `clientKey()`: limits are keyed by IPv4 address or IPv6 /64
  (IPv4-mapped IPv6 is unwrapped). A new `adminAll` limiter locks event creation for 15 min after
  30 wrong admin passwords an hour from all addresses together. While locked, even the right
  password is refused, so guesses learn nothing.
- **SEC-6** `RateLimiter`: at most 50,000 keys per map. Past it, expired keys are dropped (a full
  scan at most once a second), then the oldest counters. Active blocks are kept unless the block
  map itself overflows.
- **SEC-7** `server/src/hub.ts` `WS_LIMITS`: 10 sockets per status link and 5 per host session
  (the oldest is closed with 4408, so a reload never locks anyone out), and 1,000 per client
  address (refused with 4429; generous because venues share one address). `Hub.close()` now
  closes and forgets every socket.
- **SEC-8** `shared/src/text.ts` `cleanText()`: used by `validateDraft` (import preview, manual
  add, self-join, edits) and by the server's event-name cleaning. It strips C0/C1 controls, bidi
  marks, overrides and isolates, zero-width and invisible formatting characters, Hangul/Braille
  blanks, the BOM and tag characters. ZWJ/ZWNJ (emoji sequences) and accents are kept. Notes keep
  newlines.
- **SEC-9** The default body limit is 64 KB. `POST …/import` keeps 2 MB (a maximal 500-row roster
  is about 1 MB, tested). Host routes check the session in `onRequest`, before the body is read.

### Recommendations for the open items

- **SEC-10 (fixed, owner decision):** a duplicate phone now gets only `{ existing: true }` and the
  join page says "You're already in line with this number. Use the link we texted you, or ask
  the photographer." No status link is returned. The device that created the party still sees
  its own "See my place" link from local storage. No text is re-sent, so a stranger can't use
  the QR code to trigger texts to a family.
- **SEC-11:** Set `OPTOUT_SALT` from a secret store (Unraid masked variable, `fly secrets`), so
  the salt isn't in the database file. The code already prefers it. A keyed HMAC with the same
  secret is equivalent.
- **SEC-13:** For single-host Docker setups, publish `127.0.0.1:3000:3000` (cloudflared on the
  same host) or the LAN address only.
- **SEC-15:** Pin `node:22-bookworm-slim@sha256:…` and bump the digest with a dependency bot.

## Reviewed and found clean

| Area                     | What was checked                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PIN / admin password     | scrypt with a 16-byte random salt, `timingSafeEqual` on equal-length buffers; the admin password is compared through SHA-256 digests in constant time; the placeholder is refused (QA #4); the PIN is never logged or returned.                                                                                                                                                                                                  |
| Sessions                 | 256-bit random token, stored only as SHA-256; a new token on every login (no fixation: there is no pre-login session); `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS; absolute 12 h lifetime; at most 5 per event; logout, sign-out-others, close, auto-close and purge all delete server-side and live sockets are re-checked on every broadcast and ping (QA #2).                                                              |
| Authorization / IDOR     | Every `/api/host/events/:id/*` route and `/ws/host/:id` sit behind the session check for that `:id`. Party, text and undo lookups are scoped to the event (another event's `pid`/`sid` gives 404). The guest token only reads its own privacy-filtered status, taps **I'm here** (open events only) and opens a socket with no message handler. No route takes an event id from the body except login.                           |
| Mass assignment          | Bodies are copied field by field: `validateParty` picks name/phone/size/members/group/notes; settings accept only whitelisted keys with type checks; `source` is whitelisted; `hostConsent`, `consent`, `state`, `ticket` and tokens can't be set from a body. Fastify's JSON parser rejects `__proto__`/`constructor` keys.                                                                                                     |
| SQL                      | All queries are prepared statements with bound parameters; the only interpolation is the migration's `user_version` (an integer from code).                                                                                                                                                                                                                                                                                      |
| ReDoS                    | Every regex in the phone, vCard, import, template and masking code is linear (no nested quantifiers). The vCard and SheetJS parsers run on the host's device with size, row and column caps (QA #11), and the server re-validates.                                                                                                                                                                                               |
| XSS / URLs               | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in the app or the built bundles. `href`s use server-generated ids, tokens and codes, or `PUBLIC_URL`; `tel:`/`sms:` use a server-normalized E.164 number and an `encodeURIComponent`'d body. The QR SVG encodes only the join URL.                                                                                                                           |
| CSV / formula injection  | Nothing is exported yet. The template download is static text with no user data. See the guidance for CSV export below.                                                                                                                                                                                                                                                                                                          |
| CORS                     | No CORS plugin and no `Access-Control-Allow-*` headers (tested), so other origins can't read responses.                                                                                                                                                                                                                                                                                                                          |
| WebSocket                | Host upgrades check `Origin` (QA #8); `maxPayload` is 16 KB; guest sockets have no message handler; the hub re-checks host sessions on every send.                                                                                                                                                                                                                                                                               |
| Twilio                   | `X-Twilio-Signature` HMAC-SHA1 over `PUBLIC_URL` (or the trusted forwarded origin) + path + sorted params, compared in constant time; a forged Host can't help without the auth token. STOP/START are whole-message keywords with an empty TwiML reply. Opt-outs are checked at queue time and send time (QA #5), and self-join join texts are capped (QA #15). Replay would need the TLS traffic between Twilio and the tunnel. |
| Secrets and config       | `git log --all -p` has no credentials (test-only values `admin-secret`, `secret-token`, `e2e-admin`). `.env`, `*.db*` and `data/` are git- and docker-ignored. The Twilio token is only used in the HMAC and Basic auth header.                                                                                                                                                                                                  |
| Logs                     | Checked with a live logger: `/s/…`, `/api/status/…`, `/api/status/…/arrive` and `/ws/status/…` log as `/***`; phone numbers are masked; no names, PINs, passwords, cookies or SMS bodies are logged.                                                                                                                                                                                                                             |
| Service worker / PWA     | Workbox precaches only the hashed build assets and `index.html`; there is no runtime caching, so no API response or guest status is cached. `/api`, `/ws`, `/sms` and `/healthz` are excluded from the navigation fallback. `sw.js` and `index.html` are served `no-cache`, assets `immutable`.                                                                                                                                  |
| Referrer leakage         | `Referrer-Policy: no-referrer` header plus `<meta name="referrer" content="no-referrer">`; status-page links opened from the host use `rel="noreferrer"`.                                                                                                                                                                                                                                                                        |
| Dependencies             | `npm audit`: 0 vulnerabilities (all and production-only). SheetJS 0.20.3 comes from the vendor tarball (the npm registry copy has known CVEs). `npm ci` warns that `glob@11` is deprecated: it is a build-time dependency of `workbox-build` (vite-plugin-pwa), is not in the runtime image, and has no advisory.                                                                                                                |
| Docker                   | Multi-stage build, `npm ci --ignore-scripts`, no build secrets or args, the runtime stage has only production dependencies and the build output, runs as `node` (uid 1000), and has a `/healthz` health check.                                                                                                                                                                                                                   |
| Guest payloads           | No phone numbers, notes, members, other parties' tokens or full last names (QA #3). The status payload carries the public join code (it's on the QR code anyway).                                                                                                                                                                                                                                                                |
| Retention                | The purge deletes parties, the SMS log, undo snapshots (which hold names) and sessions in one transaction; auto-close and purge only use host activity (QA #18); opt-out hashes are kept by design (§2.11).                                                                                                                                                                                                                      |
| SQLite locking / fan-out | One process with synchronous better-sqlite3 and `busy_timeout`; broadcasts are coalesced per tick; the weekly `VACUUM` briefly blocks the loop, which is acceptable at this scale.                                                                                                                                                                                                                                               |

## Guidance for new features

Rules for the lobby display, pause and CSV export being built on another branch. They are
written so the checks in `server/test/security.test.ts` can be copied.

### Lobby display (public screen)

- **Token:** a separate display token per event (at least 12 base62 characters from
  `randomString`, like status tokens), stored hashed or compared in constant time. Never reuse
  the join code (it's printed publicly) or the event id (it's in host URLs and cookie names), and
  never make it a host session.
- **Put the token in the path** (`/d/<token>`), never in a query string. Add `d` to `redactUrl`
  in `server/src/app.ts` so it is logged as `/d/***`, and keep `Referrer-Policy: no-referrer`.
- **Limits:** unknown tokens go through the per-client miss limiter, like `statusGuard` (use
  `clientKey(req.ip)`, not `req.ip`). Display sockets go through `Hub.admit()` with their own
  small per-token cap (for example 3).
- **Payload minimization:** build it from a new `buildDisplaySnapshot` that copies fields one by
  one, never by spreading a host or party record. Allowed: event name, the now-serving ticket
  and `publicName()` (respecting `showNames`), the next few tickets and names, and a paused flag
  and message. Never phone numbers, members, notes, groups, `source`, tokens, `canText`, texts,
  undo, `publicUrl` or the event id. Add a test like QA #3's that asserts the payload has no
  digits run from a phone number and no full last name.
- **Revocation:** a host-only "Reset display link" rotates the token and closes existing display
  sockets (as `signout-others` does with `hub.schedule`). Closing, auto-closing or purging the
  event ends the display feed. After purge the token must 404.
- **Framing:** the CSP has `frame-ancestors 'none'`. If the display must be embedded (for
  example in digital signage), relax it for `/d/*` only, to a named origin, never `*`.

### Pause queue

- **AuthZ:** pause and resume are host routes inside the `registerHostRoutes` plugin, so they
  get the session check (in `onRequest`), the JSON/Origin CSRF rule and `touchHost`. Pausing
  changes queue behaviour, so put it through `service.mutate` (requires an open event) and
  decide whether it is an Undo entry.
- **Server-side enforcement:** while paused, `callNext`, `skipCurrent` and `serveNow` must refuse
  (409) or behave as specified on the server, not just in the UI. Decide explicitly whether
  self-join and Up next texts continue.
- **Message text:** if the host can type a pause message shown to guests or on the display,
  validate it like party names: `cleanText()`, trim, collapse whitespace, a hard length limit
  (for example 80) and type checks (reject non-strings). It is rendered only as React text, never
  as HTML or a URL. If it goes into an SMS, pass it through `toSmsSafe` and the 160-character
  budget.
- **Abuse:** pause/resume cause broadcasts to every socket. That's fine behind host auth, but
  debounce it like Call next (`DEFAULTS.callNextDebounceMs`) so a stuck client can't cause a
  broadcast storm. No guest-facing route may change the pause state.

### CSV export

- **AuthZ:** `GET /api/host/events/:id/export.csv` inside the host plugin (session required for
  that `:id`). Because it's a GET, the CSRF hook doesn't cover it. Safe only because it has no
  side effects: never change state on export. Refuse after purge (404).
- **Formula injection:** for every cell, if the value starts with `=`, `+`, `-`, `@`, tab
  (`\t`) or carriage return (`\r`), prefix it with a single quote `'`. Also do this after
  trimming leading spaces, and for full-width `＝＋－＠`. Then quote every field: wrap it in
  `"`, double inner quotes, and keep newlines inside the quotes. Phone numbers are E.164
  (`+1…`), so they need the prefix too, or export them as `(555) 123-4567` with `formatPhone`.
  Test with names like `=HYPERLINK("http://x","y")`, `+1+1`, `@SUM(A1)`, `-2+3` and
  `\t=1`.
- **Headers:** `Content-Type: text/csv; charset=utf-8`, a UTF-8 BOM for Excel,
  `Content-Disposition: attachment; filename="pby-queue-<date>.csv"` with the filename built only
  from a validated date or id (never the event name raw; if you want it in the name, use
  `filename*=UTF-8''<percent-encoded>` after `cleanText`). The global hook already sets
  `Cache-Control: no-store`; don't override it. Keep `X-Content-Type-Options: nosniff`.
- **Minimize:** export only the columns the host needs. Include status tokens or links only if
  asked for, since a leaked file then grants access to status pages. Never include opt-out
  hashes or SMS error text. Say in the UI that an exported file is outside the 7-day purge.
- **Logging:** don't log row contents or counts per phone. Mask as `maskPhonesInText` does if you
  log errors.
- **Client-side export** (if built in the browser instead): the same escaping rules apply, and
  `downloadBlob` revokes the object URL. A `blob:` download link needs no CSP change.

### General (every new route)

- Host routes go inside `registerHostRoutes`' plugin; anything anonymous uses
  `clientKey(req.ip)` for rate limits, counts unknown ids and tokens as misses, and has no
  `bodyLimit` above the 64 KB default without a reason.
- Copy fields out of request bodies one by one with type checks, and run every display string
  through `cleanText()`.
- Guest and display payloads get a test asserting that no phone number, full last name, token or
  note appears in them.

## Final command results

Run in this worktree after the last fix commit (`npm ci && npm run lint && npm run typecheck &&
npm test && npm run build && npm run e2e`):

| Command             | Result                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `npm ci`            | OK; `found 0 vulnerabilities`                                                                |
| `npm audit`         | 0 vulnerabilities (also with `--omit=dev`)                                                   |
| `npm run lint`      | OK (ESLint and Prettier clean)                                                               |
| `npm run typecheck` | OK (shared, server, web, e2e)                                                                |
| `npm test`          | 5 files, 118 tests passed (101 before this review; 17 new in `server/test/security.test.ts`) |
| `npm run build`     | OK                                                                                           |
| `npm run e2e`       | 4 passed (smoke, the two QA phone UX runs, and the new CSP check in `e2e/security.spec.ts`)  |

## Second pass: v1.1 features

Scope: the lobby display (`/d/{token}`, `GET /api/lobby/:token`, `/ws/lobby/:token`, create and
revoke on Share), pause/resume (routes, the optional "we're paused" text, undo) and the results
CSV export (`GET /api/host/events/:id/export.csv`), as merged with SEC-1..9 at `6ce837a`. The
question was whether the SEC-1..9 protections, written before these features existed, actually
cover the new routes and sockets, and whether the new code follows "Guidance for new features".

**Summary:** 5 findings fixed (0 Critical, 0 High, 2 Medium, 3 Low), and 4 left open (4 Info)
with reasons below. Every fix has a regression test that failed before the fix, in
`server/test/security-v11.test.ts` (SEC-17, 18, 19, 21) or `shared/test/csv.test.ts` (SEC-20).
The server file also has tests confirming the earlier rules on the new routes.

### Findings

| ID     | Severity | Area                    | Description                                                                                                                                                                                                                                                                             | Exploit scenario                                                                                                                                                                                                                                                                                             | Status                 | Commit    |
| ------ | -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | --------- |
| SEC-17 | Medium   | WebSocket / DoS         | `/ws/lobby/:token` called `Hub.addLobby()`, which skipped `Hub.admit()`: no per-link cap and no per-address count (SEC-7 did not cover it). `Hub.close()` also left lobby sockets open.                                                                                                 | Anyone who sees the TV link (in the TV's address bar, or pasted into a group chat) opens thousands of lobby sockets over time from many addresses (60 a minute pass the per-link request limit). Each gets a payload on every queue change until memory and fan-out stall the server.                        | Fixed                  | `4ceb683` |
| SEC-18 | Low      | Rate limits (IPv6)      | The lobby API and socket passed the raw `req.ip` to the shared miss limiter instead of `clientKey()`, so SEC-5's IPv6 /64 keying did not apply.                                                                                                                                         | An IPv6 client rotates its source address within its /64 and gets a fresh miss budget on every lobby request, so the shared lockout never trips. Lobby tokens are 144-bit, so guessing them stays infeasible, but the misses also stop counting toward the budget that protects status links and join codes. | Fixed                  | `eee9d73` |
| SEC-19 | Medium   | Twilio cost / abuse     | Each Pause with `notify` queued a `paused` text to every waiting party. Broadcast pause texts are exempt from the hourly Twilio cap, and nothing stopped a party getting one per pause. A quick Pause, Resume, Pause also sent two copies, because the first batch was still `sending`. | A stuck or bouncing helper device (or anyone with the PIN) toggles Pause/Resume with "Text everyone": each toggle sends up to 500 paid texts, and families get the same message again and again, which drives STOP replies and carrier filtering.                                                            | Fixed                  | `fef39fa` |
| SEC-20 | Low      | CSV / formula injection | `csvCell` checked only the first character, so `" =HYPERLINK(…)"`, a leading LF and the full-width `＝＋－＠` were not prefixed. Server validation trims names and notes today, so this is defence in depth for the shared helper.                                                      | A future import path or an older row keeps a leading space: `" =HYPERLINK(""http://x"",""Click"")"` becomes a live link in spreadsheet apps that trim before parsing, and full-width signs start formulas in some CJK locales.                                                                               | Fixed                  | `0650e22` |
| SEC-21 | Low      | Race (helper devices)   | `POST …/lobby` always rotated the token. A helper whose Share screen still showed "Make a TV link" (a stale screen, or two helpers tapping together) replaced the link and cut off the TV already set up.                                                                               | Two helpers set up two TVs at once: the second tap silently kills the first TV's link, which then shows "This display link was turned off" mid-event.                                                                                                                                                        | Fixed                  | `b8b06e6` |
| SEC-22 | Info     | Twilio cost             | Broadcast `paused` texts count toward `SELF_JOIN_TEXTS_PER_HOUR` but are not held back by it (a documented product decision: the host chose to send them).                                                                                                                              | With SEC-19 the worst case is one paused text per waiting party per hour (500-party cap), sent only by a signed-in host.                                                                                                                                                                                     | Open: product decision | –         |
| SEC-23 | Info     | WebSocket               | `/ws/lobby/:token` has no `Origin` check.                                                                                                                                                                                                                                               | None found: the socket uses no cookie and needs the 144-bit token, and its payload is what the TV shows anyone in the room. A page that knows the token could fetch it directly anyway.                                                                                                                      | Accepted               | –         |
| SEC-24 | Info     | Lobby / retention       | After Close the lobby link keeps answering (with `eventEnded: true`, the event name and nothing else) until the host turns it off or the purge clears it.                                                                                                                               | The TV shows "This photo line has ended". No party data is in the payload after close.                                                                                                                                                                                                                       | Accepted               | –         |
| SEC-25 | Info     | Abuse                   | Pause and Resume have no debounce like Call next.                                                                                                                                                                                                                                       | Host-only; a repeat gets 409 (`already_paused`/`not_paused`), broadcasts are coalesced per tick, and texts are bounded by SEC-19.                                                                                                                                                                            | Accepted               | –         |

### What each fix does

- **SEC-17** `server/src/hub.ts`: `addLobby()` goes through `admit()` with a new
  `WS_LIMITS.perLobby` of 5 per link (the oldest is closed with 4408, so a reload never locks a
  TV out) and counts toward the 1,000 per address; the route passes `clientKey(req.ip)`.
  `Hub.close()` closes and forgets lobby sockets too.
- **SEC-18** `server/src/routes/public.ts`: both lobby routes call `lobbyGuard(ip(req), …)`.
- **SEC-19** `server/src/service.ts` `pause()`: parties with a `paused` text created in the last
  hour in any status but `canceled` (`sending`, `sent`, `failed`, or a tray text marked sent or
  skipped) are left out of the broadcast. Texts canceled before going out (Resume, Undo) don't
  count. FEATURES §2.13 now says "at most once per party per hour".
- **SEC-20** `shared/src/csv.ts`: a cell gets the `'` prefix when it starts with tab, CR or LF,
  or when `= + - @` or their full-width forms follow any leading whitespace. Ordinary text
  (`Emma = Leo`, ` Emma`, `Smith-Jones`) is unchanged.
- **SEC-21** `server/src/service.ts` `setLobbyLink()`: making a link when one exists returns it
  unchanged unless the body has `replace: true`. The Share screen only ever creates or revokes.

### Checked and found clean

| Area           | What was checked                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSRF / Origin  | Pause, resume, lobby create and revoke are inside the host plugin, and the global `onRequest` hook refuses `text/plain; application/json` (415) and sibling-origin requests (403) on all four. Tested.                                                                                                                                                                                                                                |
| Headers        | The export and `GET /api/lobby/:token` carry the global CSP (`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Cache-Control: no-store`, `nosniff`, `Referrer-Policy: no-referrer` and no CORS headers (tested). `/d/<token>` is the SPA shell with the same headers.                                                                                                                                                              |
| Body limits    | The new routes keep the 64 KB default (a 70 KB pause body is 413 and changes nothing), and host routes authenticate in `onRequest`, before the body is read.                                                                                                                                                                                                                                                                          |
| Lobby token    | 18 random bytes (144 bits), base64url; pattern-checked, looked up by SHA-256, then `timingSafeEqual`. Never the join code, event id or a session. `/d/`, `/api/lobby/` and `/ws/lobby/` are logged as `/***`. Revoke, rotation and purge close open displays at once (`broadcastLobbies`), and the purge clears the token so it 404s.                                                                                                 |
| Lobby payload  | `buildLobbySnapshot` copies fields one by one: event name, ended and pause flags, the pause message, ticket plus `publicName()` (null when names are off), and the join link and QR path (null when self-join is off). Tests assert no phone digits, last names, notes, members, party ids or tokens.                                                                                                                                 |
| Pause          | Host-only (401 without a session or with another event's) and goes through `mutate` (open event, one transaction, an undo entry with the previous pause state). No guest or lobby route changes it. The message is type-checked, `cleanText`ed, stripped of control and bidi characters, whitespace-collapsed, capped at 120 code points, rendered only as React text and never put in an SMS. Undo cancels unsent pause texts.       |
| CSV export     | Host-only for that `:id`; a GET with no side effects; 404 after the purge. Phone numbers, tab and CR get the `'` prefix; RFC 4180 quoting; UTF-8 BOM. `Content-Disposition` uses an ASCII slug of `[a-z0-9-]` plus a validated date, so quotes, CR/LF and unicode in the event name can't inject a header or parameter (tested). `?tz=` is allowlisted. The service worker has no runtime caching and its fallback denylists `/api/`. |
| Helper devices | better-sqlite3 is synchronous and every mutation is one transaction, so two helpers pausing together get one Pause and one 409, and undo steps restore the pause state they replaced.                                                                                                                                                                                                                                                 |

### Command results

Run in this worktree after the last fix commit (`npm ci && npm run lint && npm run typecheck &&
npm test && npm run build && npm run e2e && SCREENSHOTS=1 npx playwright test
e2e/screenshots.spec.ts`):

| Command                                                     | Result                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                    | OK; `found 0 vulnerabilities` (`npm audit --omit=dev`: 0)                                                                        |
| `npm run lint`                                              | OK (ESLint and Prettier clean)                                                                                                   |
| `npm run typecheck`                                         | OK (shared, server, web, e2e)                                                                                                    |
| `npm test`                                                  | 11 files, 189 tests passed (165 before this pass; 13 new in `server/test/security-v11.test.ts`, 11 in `shared/test/csv.test.ts`) |
| `npm run build`                                             | OK                                                                                                                               |
| `npm run e2e`                                               | 4 passed, 1 skipped (the screenshot spec, which runs only with `SCREENSHOTS=1`)                                                  |
| `SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts` | 1 passed                                                                                                                         |
