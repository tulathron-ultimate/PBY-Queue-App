# PBY Queue App — Product Decisions

Purpose: help a photographer ("host") manage a large number of people waiting for photos.
People are imported or sign up, get placed in a queue, get texted when they are "Up next"
and when it is their turn, and can view a live page showing their position and who is currently up.

## Locked decisions

| Area | Decision |
|------|----------|
| Platform | Installable PWA (mobile-first website, "Add to Home Screen"). Architected so it can be wrapped with Capacitor as a native iOS/Android app later (keep platform-specific code behind small adapters: contacts, SMS, notifications). |
| Contact import | (1) Contact Picker API where supported (Android Chrome); (2) vCard `.vcf` file import (iPhone path); (3) Excel/CSV template upload; (4) manual entry; (5) guest self-join via QR code / link. |
| SMS | Pluggable `SmsProvider` interface. **Tap-to-send** (opens device Messages app via `sms:` link with prefilled body; host taps Send) is the default and needs no setup. **Twilio** provider can be enabled per event when credentials are configured. Switchable in event settings. |
| Hosting | Single Docker container: Node.js (TypeScript) server + SQLite + WebSocket live updates, serving the built PWA. Same image runs on **Unraid** (exposed via Cloudflare Tunnel) or a **cloud host** (Fly.io / Render). Config via env vars. |
| Queue entries | A **party**: display name, size (1+ people, optional member names), one contact phone number that receives texts. Individuals are parties of size 1. |
| Guests | No accounts. Each party gets a unique unguessable status link (texted to them) showing their position, who is currently up, and estimated wait. |
| Host | Protected by a per-event host PIN/password. One host device primary; additional helper devices can join with the PIN. |

## Core queue flow

`waiting` → `up_next` (auto when within N spots, default 2) → `now_serving` (host taps "Call next") → `done`
Side states: `skipped` / `no_show` (host can re-insert them later), `removed`.

## Stack (proposed)

- Frontend: React + Vite + TypeScript, PWA (vite-plugin-pwa), mobile-first.
- Backend: Node + Fastify (or Express) + TypeScript, SQLite (better-sqlite3), WebSockets.
- Tests: Vitest (unit), Playwright (e2e — Chromium preinstalled).
- Excel parsing: SheetJS (`xlsx`) client-side; vCard parsing: small in-house parser.
