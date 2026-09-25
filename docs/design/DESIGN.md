# PBY Queue App: Interface Design

Status: v1 design reference. Builds on the locked decisions in [`../DECISIONS.md`](../DECISIONS.md).
Visual reference: [`mockups.html`](./mockups.html). Open it in any browser; it has no dependencies.

---

## 0. Design principles

1. **One thumb, one glance.** The host is holding a camera. Every frequent host action must be reachable with the right or left thumb in the bottom 40% of the screen and must be readable at arm's length. Primary action (**Call next**) is always pinned at the bottom.
2. **Sunlight first.** The default theme is light: near-black text on white, solid saturated status fills, no light-gray text, no thin fonts, no meaning carried by subtle tints alone. Dark mode is for evening and indoor use.
3. **Never color alone.** Every status is shown as color **plus** a text label **plus** an icon/shape, so it survives glare, color blindness and grayscale.
4. **Forgiving over confirming.** Frequent actions (Call next, Skip, No-show, Done) run immediately and show a 6-second **Undo** toast. Confirmation dialogs are used only for destructive, rare actions (Remove party, End event, Clear queue).
5. **Guests need three facts.** Where am I, who is up now, roughly how long. Everything else on the guest page is secondary and small.
6. **Adapters, not assumptions.** SMS, contacts and notifications appear in the UI as capabilities. If a capability is missing (e.g., Contact Picker on iPhone), its button is hidden, never shown disabled with no explanation.

---

## 1. Design system

### 1.1 Color tokens

All colors are CSS custom properties on `:root`. Dark mode overrides them under `@media (prefers-color-scheme: dark)` and under `[data-theme="dark"]`. The host can force Light / Dark / Auto in Settings (default **Light**, not Auto, because the phone may be in dark mode while she shoots outdoors).

Contrast targets: body text ≥ 7:1 (WCAG AAA) against its background; text on status fills ≥ 4.5:1.

#### Neutrals and brand

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FFFFFF` | `#000000` | Page background (true black saves OLED battery) |
| `--surface` | `#F2F4F7` | `#14171B` | Cards, list rows |
| `--surface-2` | `#E3E7ED` | `#232830` | Sheets, pressed states, input fill |
| `--border` | `#8A94A3` | `#4A5361` | Hairlines, input borders (2px on inputs) |
| `--text` | `#0A0A0A` | `#F7F8FA` | Primary text (19.8:1 / 19.6:1) |
| `--text-muted` | `#3A4250` | `#C3CAD4` | Secondary text; never lighter than this |
| `--primary` | `#1537B8` | `#8FB0FF` | Primary buttons, links, focus |
| `--on-primary` | `#FFFFFF` | `#000000` | Text on primary (8.9:1 / 10.1:1) |
| `--danger` | `#B3121B` | `#FF7A7F` | Remove, End event |
| `--on-danger` | `#FFFFFF` | `#000000` | |
| `--focus-ring` | `#1537B8` | `#FFD34D` | 3px outline, 2px offset |
| `--scrim` | `rgba(0,0,0,.55)` | `rgba(0,0,0,.7)` | Behind sheets and dialogs |

#### Queue status colors

Each status has a **solid** fill (badges, the Now-serving card, lobby display), an **on** color for text on that fill, and a **tint** for list-row backgrounds. Rows also get a 6px left bar in the solid color, so status is readable even if the tint washes out in sun.

| Status | Label | Icon | Solid (L / D) | On (L / D) | Tint (L / D) |
|---|---|---|---|---|---|
| `waiting` | Waiting | ○ hollow circle | `#4A5361` / `#A7B0BD` | `#FFF` / `#000` | `#F2F4F7` / `#14171B` |
| `up_next` | Up next | ◆ diamond (or bell) | `#F5A300` / `#FFC23D` | `#000` / `#000` | `#FFF1CC` / `#3A2A00` |
| `now_serving` | Now serving | ● filled circle / camera | `#067A4A` / `#3DDC97` | `#FFF` / `#000` | `#D6F5E6` / `#06301F` |
| `done` | Done | ✓ check | `#5B6472` / `#6E7785` | `#FFF` / `#FFF` | `#FFFFFF` / `#000000` (row text uses `--text-muted`) |
| `skipped` | Skipped | ↷ skip arrow | `#6B2FD6` / `#B79BFF` | `#FFF` / `#000` | `#EEE6FF` / `#24163F` |
| `no_show` | No-show | ✕ in circle | `#B3121B` / `#FF7A7F` | `#FFF` / `#000` | `#FFE3E4` / `#3D0B0E` |

Notes:
- Amber `up_next` uses black text on purpose: white on amber fails contrast and disappears in sun.
- `removed` has no color; removed parties vanish from lists (still visible under the "Done & removed" filter with a strikethrough).
- "It's your turn" on the guest page uses the full-screen `now_serving` solid.

#### Optional "Max contrast" mode (Settings toggle)
Tints become `--bg`, borders become 2px `--text`, status is shown by the left bar + solid badge only, and all text is weight ≥ 600. For direct midday sun.

### 1.2 Typography

System font stack for zero-latency loading and native legibility: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. All numbers use `font-variant-numeric: tabular-nums` so positions do not jitter as they update.

Base size is **18px** (larger than the usual 16) because both audiences read at arm's length or in glare. Nothing interactive is smaller than 16px; 14px is reserved for timestamps and fine print.

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `--fs-xs` | 14 / 20 | 500 | Timestamps, helper text, legal |
| `--fs-sm` | 16 / 22 | 500 | Secondary row text, labels |
| `--fs-base` | 18 / 26 | 500 | Body, list row names |
| `--fs-lg` | 22 / 28 | 700 | Section headers, sheet titles, button text |
| `--fs-xl` | 28 / 34 | 800 | Screen titles, Now-serving party name (host) |
| `--fs-2xl` | 36 / 40 | 800 | Call next button label |
| `--fs-display` | 56 / 60 | 900 | Guest "Now serving" ticket number |
| `--fs-mega` | 112 / 112 | 900 | Guest's own position number; lobby display |

### 1.3 Spacing, shape, elevation

- Spacing scale (4px base): `--s1 4`, `--s2 8`, `--s3 12`, `--s4 16`, `--s5 24`, `--s6 32`, `--s7 48`.
- Screen side gutter: 16px. Max content width on large screens: 560px (host) / 480px (guest), centered.
- Radii: `--r-sm 8` (badges, inputs), `--r-md 14` (cards, rows), `--r-lg 22` (sheets, big buttons), `--r-pill 999`.
- Elevation: only two levels. Sheets and the sticky Call-next bar get `0 -4px 24px rgba(0,0,0,.18)`; everything else is flat with borders (shadows vanish in sunlight).

### 1.4 Touch targets

| Element | Min height | Notes |
|---|---|---|
| Any tappable | **48px**, 48px wide | 8px minimum gap between adjacent targets |
| List row | 64px | Whole row is the target (opens Party actions) |
| Standard button | 56px | Full-width in sheets |
| Primary bottom button (Call next, Join the line) | **80px** | Full width minus 16px gutters, bottom-pinned, above home indicator (`env(safe-area-inset-bottom)`) |
| Icon button (e.g., per-row SMS) | 48×48 | Icon 24px, always paired with an accessible label |

Long-press is never the only way to do something. Swipe gestures are not used (they conflict with scrolling when one-handed and are undiscoverable).

### 1.5 Feedback and motion

- **Haptics** (`navigator.vibrate` where available, native haptics later via Capacitor): short pulse on Call next, double pulse on guest "It's your turn".
- **Toasts** appear directly above the Call-next bar (in the thumb zone), 56px tall, with an **Undo** button 48px wide. Auto-dismiss 6s.
- **Motion**: 150–200ms ease-out; rows animate position when the queue changes. Respect `prefers-reduced-motion` (no movement, just instant updates).
- **Live indicator**: a small "● Live" pill in the header. On socket loss it turns to "Reconnecting…" (amber) and after 30s "Offline · updated 2 min ago" (red). Host actions performed offline queue locally and replay; the UI marks them "Pending sync".

### 1.6 Icons

Simple 2px-stroke line icons, 24px (inline SVG in the app). Required set: camera, next-arrow, message, phone, users, qr, upload, contact, file, edit, skip, no-show, check, trash, undo, gear, share, drag-handle, pause, more.

### 1.7 Copy tone

Short, warm, literal. Use the party name the guest typed ("Smith Family"), ticket numbers with `#` ("#14"), and times as ranges ("about 10–15 min"). Never show "ETA 0 min"; say "Any minute now".

---

## 2. Core concepts shown in the UI

- **Ticket number**: each party gets a sequential number at creation (`#1`, `#2`…). It never changes, even when reordered. Used on the lobby display, in texts and on the guest page. It lets guests find themselves without reading names, and gives a privacy option.
- **Position**: live count of parties ahead of you + 1 among active (`waiting`, `up_next`) parties. "You're #3 in line" uses position, not ticket number. To avoid confusion, the UI always writes ticket numbers as "Ticket #14" or "#14" in a badge, and position as a big plain number with "in line" beneath.
- **Estimated wait**: `(position − 1 + 1 if someone is being served) × avg session length`. Average = rolling median of the last 5 completed sessions; before 3 sessions complete, use the event's "Minutes per party" setting (default 3). Always shown as a range rounded to 5 min (e.g., "about 10–15 min"). Hidden while the queue is paused.
- **Up-next threshold N** (default 2): the first N active parties are `up_next` and get the Up-next text.
- **Pause**: host can pause the line ("Back in 10 min"). Guests see a paused banner; estimates are hidden.
- **Privacy setting**: "Show names to guests" (default on). When off, guest page and lobby show ticket numbers only.

---

## 3. Screen inventory

| ID | Screen | Audience | Type |
|---|---|---|---|
| H0 | Host home / events list | Host | Page |
| H1 | Create event | Host | Page (single scroll form) |
| H2 | Unlock with PIN (helper device / re-login) | Host, helpers | Page |
| H3 | **Dashboard** | Host | Page (primary) |
| H4 | Party actions | Host | Bottom sheet |
| H5 | Send texts (tap-to-send) | Host | Bottom sheet |
| H6 | Add people | Host | Bottom sheet → sub-flows |
| H6a | Import review (CSV/Excel/vCard/Contacts) | Host | Full-screen sheet |
| H7 | Party editor (add / edit) | Host | Full-screen sheet |
| H8 | Share / QR code | Host | Page |
| H9 | Settings | Host | Page |
| G1 | Join the line | Guest | Page |
| G2 | **My status** | Guest | Page (primary) |
| G3 | It's your turn | Guest | State of G2 (full-screen) |
| G4 | Terminal states (Done, Skipped, No-show, Removed, Event ended, Link invalid) | Guest | States of G2 |
| L1 | Lobby display | Anyone (TV/tablet) | Page, landscape |

---

## 4. Navigation map

```
HOST
 H0 Events list ──(+ New event)──► H1 Create event ──(Create)──► H3 Dashboard
   │                                                              │
   └──(tap event)──► [H2 PIN if device not trusted] ──────────────┘
                                                                  │
 H3 Dashboard  (top bar: event name · Live · [Share] [⋯ menu])
   ├─ [Call next] (bottom) ──► advance queue ─► Undo toast
   │                               └─(tap-to-send mode)─► H5 Send texts sheet ─► Messages app ─► back ─► next text
   ├─ Now-serving card: [Done] [No-show] [Text]  
   ├─ Up-next badge "2 to text" ──► H5 (batch)
   ├─ tap any row ──► H4 Party actions ──► Edit ─► H7 Party editor
   │                                    ├─► Text ─► Messages app / Twilio send
   │                                    ├─► Move up/down, Move to next, Skip, No-show, Re-add to line, Remove(confirm)
   ├─ [+ Add] (bottom-left FAB of bar) ──► H6 Add people
   │        ├─ Type it in ─► H7
   │        ├─ From contacts (Contact Picker, Android only) ─► H6a
   │        ├─ Contact file (.vcf) ─► H6a
   │        ├─ Spreadsheet (.xlsx/.csv) ─► H6a   (+ "Download template")
   │        └─ Let guests join ─► H8
   ├─ [Share] ──► H8 QR / link  ──(Open lobby display)─► L1
   └─ [⋯] ──► Pause line · Settings (H9) · Show done & removed · Lobby display · End event

GUEST
 QR / link ──► G1 Join ──(Join)──► G2 My status (URL is their private link; also texted)
 Texted status link ───────────────► G2
 G2 ──(status becomes now_serving)──► G3 It's your turn
 G2 ──(done / skipped / no_show / removed / event ended)──► G4
 G2 [Leave the line] ──(confirm)──► G4 "You left the line" (with [Rejoin])

LOBBY
 H8 or /e/{slug}/display ──► L1 (read-only, no PIN, auto-refresh via WebSocket)
```

URL scheme (for reference): `/host`, `/host/new`, `/host/e/{eventId}`, `/j/{eventSlug}` (join), `/s/{partyToken}` (guest status), `/d/{eventSlug}` (display).

---

## 5. Host screens

### H0 Events list
- **Components**: title "Your events", event cards (name, date, "42 waiting" or "Ended"), pinned bottom button **+ New event** (80px).
- **Empty**: camera illustration-free text: "No events yet. Create one before the shoot; it takes 30 seconds." + button.
- **Loading**: 3 skeleton cards. **Error**: inline card "Can't reach the server. Check your connection." + Retry.

### H1 Create event
Single scrolling form, one column, big inputs (56px). Sticky **Create event** button at bottom.

| Field | Control | Default / validation |
|---|---|---|
| Event name | Text | Required. e.g., "Santa Photos – Oak Park" |
| Date | Date | Today |
| Host PIN | 4–6 digit numeric input (`inputmode="numeric"`), show/hide eye | Required. Helper: "Helpers enter this to run the line from another phone." |
| Texting | Segmented control, 2 big options with one-line explanations | **Tap to send** (default): "Your phone opens Messages with the text ready. You tap Send. No setup." / **Automatic (Twilio)**: "Texts send by themselves. Needs a Twilio account." Selecting Twilio reveals Account SID, Auth Token, From number + **Send test text** button. If server has Twilio env vars, show "Configured on server ✓" and hide fields. |
| Text people when they're within | Stepper (− 2 +), 48px buttons | 2 spots, range 1–10. Helper: "They get an 'Up next' text at this point." |
| Minutes per party (estimate) | Stepper | 3 min. Helper: "Used until we learn your real pace." |
| Guests can join by QR | Toggle | On |
| Show names to guests | Toggle | On |
| Message templates | Collapsed "Customize texts" | See §7 defaults |

- **States**: Create button disabled until name + PIN valid; inline errors under fields in `--danger` with icon. Saving → button shows spinner "Creating…". Error → toast "Couldn't create event. Try again."
- **After create**: go to H3 with a one-time coach mark on Call next and the Add button.

### H2 PIN unlock
- Event name, 6 large PIN boxes, numeric keypad (native). Auto-submits when complete.
- Wrong PIN: boxes shake (or just red border with reduced motion), "Wrong PIN. 4 tries left." Rate-limited after 5 tries: "Try again in 1 minute."
- Checkbox "Trust this device" (default on) so the host isn't re-prompted.

### H3 Dashboard (primary host screen)

Layout, top to bottom (390px wide phone):

1. **Top bar** (56px): event name (truncated), Live pill, **Share** icon button (QR), **⋯** menu. Paused state replaces Live pill with an amber "Paused" pill.
2. **Counts strip** (40px): "38 waiting · 12 done · ~3 min each". Tapping "done" toggles the done filter.
3. **Now serving card** (`now_serving` solid fill, white text, ~150px):
   - Label "NOW SERVING" (fs-sm, caps, letter-spaced), ticket badge `#14`, party name (fs-xl), "4 people · Maria, Leo, Ana, Sam" (one line, truncated), timer "2:41" since called.
   - Row of 3 buttons on the card (56px, white outline style): **Done ✓**, **No-show**, **Text** (message icon; shows "Texted ✓" after sending).
   - Empty state: neutral surface card "No one is being served. Tap **Call next** to start."
4. **Up next** section header with amber diamond + "Up next" + right-aligned action chip **"Text 2 ▸"** (only when un-texted up-next parties exist; shows count). Rows for the N up-next parties, amber tint + bar.
5. **Waiting** section header "Waiting (36)" + search icon button (filters by name/phone/ticket; important with 300 parties). Rows.
6. **Skipped / No-show** section (collapsed by default, violet/red) — "3 skipped · tap to show". Each row has a quick **Re-add** button.
7. **Bottom action bar** (sticky, elevated, safe-area aware):
   - Left: **+ Add** square button (80×80, surface-2, icon + "Add").
   - Right: **Call next** (80px tall, flexible width, `--primary`, fs-2xl weight 800, "Call next ▸"). Sub-label inside the button: "Garcia Family · #15" so she knows who is coming without reading the list.
   - When the queue is empty: button disabled with label "Line is empty".
   - When paused: button reads "Resume line".

**Queue row (64px)**: left 6px status bar · ticket badge (`#15`, 44px wide, tabular) · name (fs-base 700) with size chip "👥 4" rendered as a users icon + number · second line: status label + "texted 2m ago" or phone last-4 · right: **message icon button** (48×48; filled dot when not yet texted for current status) · whole row tappable → H4.

**Reorder**: Row has a drag handle (≡) only when "Reorder" mode is on (⋯ → Reorder line), which enlarges handles to 48px and hides the SMS buttons. Default quick path is H4's "Move up / Move down / Move to next". This avoids accidental drags one-handed.

**Call next behavior**:
1. Current `now_serving` → `done` (if any).
2. First `up_next` → `now_serving`; next party in waiting promotes to `up_next`.
3. Haptic pulse; Now-serving card animates in; toast "Now serving Garcia Family · Undo".
4. Texting: in Twilio mode, texts send automatically ("Your turn" to the new now-serving party, "Up next" to newly promoted). In tap-to-send mode, the **Send texts sheet (H5)** opens automatically (can be turned off in Settings → "Ask to text after Call next").

**States**:
- Loading: skeleton card + 6 skeleton rows; Call next disabled.
- Empty queue (new event): center card "No one in line yet" with two big buttons **Add people** and **Show QR code**.
- Offline: Live pill red; banner under top bar "Offline — changes will sync when you're back." Actions still work locally.
- Error on action: toast in `--danger` "Couldn't call next. Tap to retry."
- Conflict (helper device acted simultaneously): list refreshes, toast "Updated by another device".

### H4 Party actions (bottom sheet)
Opened by tapping a row. Sheet height auto, max 85%. Grab handle, big header: `#15` badge + name + status badge; line 2: size, member names, phone (tap to call).

Buttons (56px, full width, 8px gaps), shown by relevance:
- **Text now** (message) — label adapts: "Text 'You're up next'" / "Text 'It's your turn'" / "Text status link".
- **Serve now** (moves to now_serving; current one → done) — for ad-hoc "they're here, take them".
- **Move to next** · **Move up** · **Move down** (the up/down pair is side by side, 2×48+).
- **Skip** (to skipped; stays re-addable) · **No-show**.
- For skipped/no-show parties: **Put back in line** with choice "Next" / "At the end" / "In 3 spots".
- **Edit details** → H7.
- **Remove from line** (danger text button at the bottom, confirm dialog "Remove Smith Family? They'll see 'You've been removed from the line.'").

All except Remove close the sheet and show an Undo toast.

### H5 Send texts sheet (tap-to-send mode)
Purpose: send several texts as fast as possible when each one requires a hop to Messages.

- Header: "Send 3 texts" + progress "1 of 3".
- **Current message card**: recipient (name, phone), message type badge ("It's your turn" in green / "Up next" in amber), full message preview (editable via "Edit" link).
- Huge primary button (80px): **Text Garcia Family ▸** → opens `sms:+15551234567?&body=…` (iOS/Android compatible format handled by the SMS adapter).
- When the page regains focus (`visibilitychange`), the sheet auto-advances to the next message and marks the previous as "Sent ✓" (optimistic; host can tap "Didn't send" to revert).
- Secondary buttons: **Skip this one**, **Done for now** (remaining stay flagged with the dot on their row).
- Queue list below (compact): ✓ Garcia Family — It's your turn · ◆ Nguyen — Up next · ◆ Patel — Up next.
- Why not one group text: group SMS would expose everyone's numbers to each other and isn't reliable across platforms; one-per-recipient is safer and still ~2 taps each.
- No phone number: row shows "No phone — tell them in person" and is auto-skipped.

Entry points: auto after Call next; the "Text 2 ▸" chip on Up next; per-row message icon (single-message variant of this sheet, or straight to Messages if "Confirm before texting" is off).

### H6 Add people (bottom sheet)
Menu of large rows (64px, icon + title + one-line description):
1. **Type it in** — "Add one party by hand." → H7 (with "Save & add another").
2. **From your contacts** — "Pick people from your phone." Shown only when `navigator.contacts?.select` exists (Android Chrome). → native picker (multi-select name + tel) → H6a.
3. **Contact file (.vcf)** — "On iPhone: Contacts → select → Share → Save to Files." → file input `accept=".vcf,text/vcard"` → H6a. Small "How?" link opens 3-step illustrated help.
4. **Spreadsheet (Excel or CSV)** — "Columns: Party name, Size, Phone, Names." → file input `accept=".xlsx,.xls,.csv"` → H6a. Secondary link **Download template** (xlsx with header row + 2 example rows, also CSV).
5. **Let guests join themselves** — "Show a QR code or share a link." → H8.

### H6a Import review
- Title "Review 48 people", summary chips: "45 ready · 3 need attention".
- Column mapping appears only if headers don't match the template: dropdown per detected column (Party name / Size / Phone / Member names / Ignore).
- List of parsed rows with inline issue badges: "No phone" (amber, allowed), "Invalid phone" (red, tap to fix), "Possible duplicate of #12" (amber, toggle Skip/Keep).
- Order option: "Add to end of line" (default) / "Add in file order before current waiting list" / "Shuffle".
- Sticky bottom button: **Add 45 to the line**. Loading state: "Adding… 30/45". Error: parse failure card "We couldn't read this file. Try the template." with Download template.

### H7 Party editor
Full-screen sheet with Cancel / **Save** (top) and sticky bottom **Save** (56px).
- Party name (required; placeholder "e.g., Smith Family").
- Size: big stepper (− 4 +), 1–30.
- Member names: optional list of text inputs, one per person up to size; "Add names" toggle to keep simple by default.
- Phone: `type="tel"`, auto-format, country default from event; helper "Gets 'Up next' and 'Your turn' texts."
- Texting consent: checkbox "They agreed to get texts" (required to text in Twilio mode; informational in tap-to-send).
- Notes (optional, host-only, e.g., "needs wheelchair spot").
- Position (add mode only): End of line (default) / Next / After #…
- Edit mode extras: status link with **Copy** and **Text link** buttons.
- Validation inline; Save disabled while invalid. Error toast on save failure.

### H8 Share / QR
- Large QR (min 280px, black on white even in dark mode, quiet zone included) encoding `/j/{slug}`.
- Short link in large monospace text + **Copy** + **Share** (Web Share API).
- **Print sign** (A4/Letter page: event name, "Scan to join the photo line", QR, short link).
- **Open lobby display** (opens L1 in new tab; tip "Cast or open this on a TV or tablet").
- Toggle "Accept new guests" (off → join page says "The line is closed").
- Screen stays awake (Wake Lock API) while open so guests can scan the host's phone.

### H9 Settings
Grouped list, each row 56px:
- **Event**: name, date, PIN (change), End event (danger, confirm).
- **Queue**: Up-next threshold stepper, minutes per party, accept self-join toggle, show names to guests toggle, pause line.
- **Texting**: mode (Tap to send / Twilio) with Twilio credentials + Send test text; "Ask to text after Call next" toggle; "Confirm before texting" toggle; message templates.
- **Display**: Theme (Light / Dark / Auto), Max contrast toggle, Text size (Normal / Large / Extra large, scales all tokens by 1 / 1.15 / 1.3), Keep screen awake toggle.
- **Helpers**: "Helpers on this event: 1" with device list + Sign out others.
- **Data**: Export CSV (history with times), Clear done parties.

---

## 6. Guest screens

Guest pages carry no host chrome, work without JavaScript frameworks loading slowly (server-rendered shell, then live), and are fully usable at 320px wide. Language: plain, second-person.

### G1 Join the line
- Header: event name (fs-xl) + "Join the photo line". Live line length: "18 parties ahead of you · about 45–55 min".
- Fields (56px inputs, fs-base labels above, not placeholders-as-labels):
  - **Your name or family name** (required, autocomplete `name`).
  - **How many people in the photo?** Stepper (− 1 +) with large buttons.
  - **Mobile number** (`type="tel"`, autocomplete `tel`) with helper "We'll text you when you're almost up." Optional unless the event requires it.
  - **Consent checkbox** (48px hit area): "Text me updates about my place in line. Msg & data rates may apply. Reply STOP to opt out." Required only if a phone is entered; unchecked by default.
- Sticky button **Join the line** (80px).
- States: submitting ("Joining…"), validation errors inline, line closed ("The line isn't taking new people right now. Please talk to the photographer."), event ended, already joined on this device (local stored token → "You're already in line as Smith Family. **See my place**").
- Success → redirect to G2 with a one-time banner "You're in! Bookmark this page or watch for our text."

### G2 My status (primary guest screen)
Designed to be understood in 2 seconds.

Top to bottom:
1. **Header strip**: event name (small), Live pill.
2. **My card** (hero):
   - Label "Your place in line"
   - Position in `--fs-mega`: **3**
   - "Ticket #17 · Smith Family · 4 people"
   - Estimated wait: "About **5–10 min**" (fs-lg). Before estimates are reliable: "Estimating…".
   - Status badge (Waiting / Up next).
3. **Now serving** card: "Now taking photos of" + ticket badge `#14` in `--fs-display` + name "Garcia Family" (or "#14" only if names are hidden).
4. **Coming up** mini list: next 3 tickets with names; the guest's own row highlighted with "You" tag.
5. Help text: "Stay nearby. We'll text you when you're 2 away and when it's your turn." (If no phone: "Keep this page open — it updates by itself.")
6. Footer actions (secondary, 48px text buttons): **Leave the line** (confirm), **Change party size**.

**Up next state**: hero card switches to amber tint + amber bar, headline "You're up next! Head to the photo area." Position shows "Next" when position = 1 behind now-serving; vibration pulse once (if page visible). Browser tab title becomes "⚡ You're up next — PBY".

**States**:
- Loading: skeleton hero with pulsing number placeholder.
- Paused: amber banner "The photographer is taking a short break. Back around 3:15." Estimate hidden, position still shown.
- Reconnecting / offline: top banner "Reconnecting… last updated 1 min ago"; number greyed with that timestamp. Falls back to polling every 20s.
- Link invalid: "We can't find this spot in line. Check the link in your text, or ask the photographer."

### G3 It's your turn
Full-screen `now_serving` green, white text: large camera icon, "**It's your turn!**", "Come to the photographer now", "Ticket #17 · Smith Family". Double vibration and optional short chime (only if user previously interacted with the page). Tab title "📸 Your turn!". Stays until status changes.

### G4 Terminal states
All use a calm neutral card with one clear line and, where sensible, one action:
- **Done**: "✓ Thanks, Smith Family! Your photos are done." (optional link set by host, e.g., gallery).
- **Skipped**: violet: "We missed you. Find the photographer and they'll fit you back in." Position area shows "On hold".
- **No-show**: red: same message as Skipped, stronger wording "You were marked as not here."
- **Removed / Left**: "You're no longer in line." + **Rejoin** (if self-join is open).
- **Event ended**: "This photo line has ended. Thanks for coming!"

---

## 7. Texting content (defaults, editable)

Short, include the link, identify the sender. `{name}`, `{ticket}`, `{event}`, `{link}`, `{position}` placeholders.

| Trigger | Default text |
|---|---|
| Joined / imported (optional) | "{event}: You're in the photo line! Ticket #{ticket}. Track your spot: {link}" |
| Up next | "{event}: {name}, you're almost up (#{position} in line). Please head to the photo area. {link}" |
| Your turn | "{event}: {name}, it's your turn! Come to the photographer now. 📸" |
| Re-added after skip | "{event}: You're back in line at #{position}. {link}" |

Tap-to-send uses the same templates; the SMS adapter builds `sms:` links (`sms:NUMBER?&body=` works on both iOS and Android).

---

## 8. L1 Lobby display (optional)
Landscape, 16:9, dark theme forced (better on TVs), no interaction.
- Left 60%: "NOW SERVING" + ticket `#14` in 220px type + name.
- Right 40%: "UP NEXT" list of the next 4–5 tickets with names; the first N in amber.
- Bottom bar: QR code (160px) "Scan to join the line" + short link + "About 3 min per group".
- New now-serving triggers a 1s green flash and optional chime. Reconnecting indicator small in corner.

---

## 9. Accessibility checklist
- All targets ≥ 48px; primary actions 80px; sticky bottom actions respect safe areas.
- Status = color + label + icon; list rows expose `aria-label="Ticket 15, Garcia Family, 4 people, up next, not texted"`.
- Live regions: guest position and now-serving use `aria-live="polite"`; "It's your turn" uses `role="alert"`.
- Dynamic type: all sizes in `rem`; layout tested at 130% text size and 320px width.
- Focus rings visible (3px). Sheets trap focus and close on Escape / scrim tap / swipe-down handle.
- No time limits on guest pages; host Undo window is 6s but every action is also reversible from H4.
