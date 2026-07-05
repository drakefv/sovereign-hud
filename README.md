# SOVEREIGN HUD

A single-screen command terminal for a one-operator empire — trading desk, business pipelines, bot fleet, and lead rails on one dark-phosphor cockpit. Vanilla JS + Express, no build step, pm2-managed, read-only over everything except an allowlisted `pm2 restart`.

It reads the *source-of-truth artifacts other systems already write* (pm2's process list, nq-bot's JSON state, an Obsidian vault, a meme-radar data dir, a cold-email pipeline) and merges them into one live view plus a set of server-side **sentries** that push to your phone when something demands attention — even with every browser tab closed.

## The view

- **NQ DESK** — Topstep bot balance, session PnL, bias composite + why, one verdict pill (SKIP / CLEAR / UPSIZE / LOCKED), guard pills, Express fleet roster.
- **WAR ROOM** — a 7-check boot verifier: daemon/watchdog running, close-time-stop armed, bias published, guards clear, strat-log pulse, leader seatbelt. Pushes BOOT CLEAN/MISSED at 9:32 ET and audits that the time-stop actually fired at 11:35.
- **KEYSTONE** — cold-email pipeline EV, batch progress, and the **reply sniper**: when a prospect replies it surfaces the sender/subject and a one-tap download of that prospect's rendered ad.
- **THE TAPE** — one merged, timestamped event feed across every lane (pm2 transitions, NQ verdict/guard flips, keystone sends + replies, PALS status, meme fires, voice notes, econ prints).
- **LAUNCHPAD** — one-tap link groups, live-configured.
- **Center orrery** — a zoomable solar system where planets are business lanes; health rings and defcon tint track live state.
- Plus MEME FLOW, FLEET (hold-to-restart), SCHEDULED OPS, LYDIA, LEDGER, INTEL.

On mobile it collapses to three swipeable decks (DESK / CORE / OPS) with a bottom tab bar.

## The sentries

Server-side watchers that run regardless of any open tab and fire through two shared uplinks — **the tape** (in-app feed) and **web push** (your phone):

| Module | Watches | Fires on |
|---|---|---|
| `sniper.js` | the cold-email reply log | a prospect reply → push + tape + one-tap ad |
| `pals.js` | a PA license verification API (hourly) | status flips to Active |
| `warroom.js` | scheduled tasks + bot state | 9:32 ET boot verdict, 11:35 time-stop audit |
| `digest.js` | everything above | a 7 AM ET Telegram brief |
| `push.js` | pm2 + NQ guards (45s) | defcon escalation / all-clear |

## Architecture

`server.js` is the orchestrator: it owns the shared `getPm2` and `getTasks` snapshots (deduped shell-outs), the NQ desk rail, spark ring buffers, and static hosting. Everything else is an additive module installed as `require('./mod')(app, ctx)`:

- `rails.js` — second-wave read rails (flowq, keystone, ops, ledger, lydia) + the action rail (`pm2 restart`, allowlisted + PIN) + the dead-man heartbeat.
- `tape.js` — the merged event feed; returns `{ emit, getEvents }` so sentries can land events and the digest can read them.
- `push.js` — web-push VAPID uplink; returns `{ send }`.
- `verdict.js` — the **single** NQ verdict evaluator. Server attaches it to `/api/nq`; tape, war room, and the frontend all consume it instead of re-deriving the rule.
- `util.js` — shared `fileSig` / `fileAgeMin` / `readJson` / `writeJson` / `etParts` primitives.

Design rules: one source of truth (no rule copied across files), fail-closed guards, and **`directive.json` is live config** — re-read every request, edit it and the change lands within ~2s, no restart.

## Endpoints

Read: `/api/nq` `/api/fleet` `/api/tasks` `/api/tape` `/api/keystone` `/api/flowq` `/api/ops` `/api/ledger` `/api/lydia` `/api/sniper` `/api/pals` `/api/warroom` `/api/digest/preview` `/api/intel` `/api/directive` `/api/system` `/api/spark`

Write (PIN-gated): `POST /api/action/restart` · `POST /api/push/subscribe` · `POST /api/digest/send`

## Setup

```bash
npm install
cp directive.example.json directive.json   # then edit — the server also auto-seeds this on first boot
node server.js                              # or: pm2 start server.js --name sovereign-hud
```

Open `http://localhost:5300`. Binds `0.0.0.0` so a phone on the same Tailscale/LAN can reach it.

**Config** lives entirely in `directive.json` (gitignored — it holds your action PIN, beacon URL, account numbers, and personal targeting). Start from `directive.example.json`, which documents every key.

**Web push** needs VAPID keys at `data/vapid.json` (`{ "publicKey": "...", "privateKey": "..." }` — generate with `npx web-push generate-vapid-keys`). Add the HUD to your home screen and tap UPLINK to subscribe; until then, sentry pushes have nowhere to land.

**Notes on wiring:** the sentries read paths that are specific to one operator's machine (nq-bot dir, Obsidian vault, meme-radar data, a bot-army `.env` for Telegram creds). Point the paths in `directive.json` and the module constants at your own, or the rails simply return empty and the panels show "link down."

## Stack

Express + vanilla JS/CSS, `web-push`, canvas for the orrery and sparklines. Zero front-end build. Dark phosphor-green cockpit, Space Grotesk + JetBrains Mono, theme-aware defcon repaint.
