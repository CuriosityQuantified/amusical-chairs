# 🎵 Musical Chairs

A hybrid-meeting party game: classic musical chairs with the scramble for a
seat replaced by a **skill scramble**. One projected host screen, every player
on their own phone or laptop. 3–30 players, ~20 minutes including rules.

Every scoring round is played by **all surviving players simultaneously** —
nothing is turn-based.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

- **Host:** open `/host.html`, create a room, project the screen.
- **Players:** scan the QR / open `/?code=XXXX`, enter a name.
- Host config (games per round, durations, per-game toggles, practice round)
  lives in the lobby screen.

```bash
npm test           # unit tests + 20-bot end-to-end harness
```

## How a round works

1. Music plays on the host screen, then stops.
2. All survivors simultaneously play `m` minigames (default 2, hard cap 3) —
   drawn from a 15-game roster across 6 categories, never repeating a game in
   a session and never two of one category in a round.
3. Raw metrics are normalized per game to 0–1000 **within the round, across
   only the players who played it** (P90/P10 outlier clamps; no rank-summing).
4. Top half get a seat. Bottom half go to **redemption**: a clock-synced
   reaction test; exactly one is saved.
5. Ties at the cut line all go to redemption — never a coin flip.
6. Eliminated players vote on the next round's minigame set.
7. Repeat until 3 remain → one final minigame decides the winner.

The elimination ladder (`shared/ladder.js`) is unit-tested to strictly
decrease and terminate for every player count from 3 to 40 — e.g.
`20 → 11 → 7 → 5 → 3 → final`.

## Anti-cheat details worth knowing

- **Redemption mashing:** any press before green silently redraws the delay
  and reschedules green from the moment of the press. A masher never sees
  green, hits the 25s hard timeout, and takes last place. A single
  anticipatory press costs a fair 10% penalty.
- **Clock sync:** NTP-style offset estimation on join and again before every
  redemption round; green is scheduled at absolute server time, timed on the
  client from the rendered frame to `keydown` — network latency never touches
  the measurement. The host screen shows a per-player sync-confidence dot.
- **Space Mash:** counting requires a `keyup` between `keydown`s (holding the
  spacebar scores 1, not 300), plus a rolling 20 presses/sec anti-macro cap.
- **Color match** is scored with CIEDE2000 (perceptual), not RGB distance.

## Architecture

- Node 20 + Express + **Socket.IO** (persistent websockets — the clock sync
  depends on them). Client is vanilla JS + Canvas, no build step.
- **All state in memory. No database.** Sessions are ephemeral by design.
- Reconnects: `playerId` persists in `localStorage`; a dropped player is never
  eliminated for a wifi hiccup — missed submissions just take the P90 clamp.
- `shared/` holds pure logic (ladder, normalization, redemption state
  machine, press counter, clustering, CIEDE2000) served unmodified to the
  browser and imported directly by server + tests.

```
server/   express + socket wiring, room state machine, game metrics
shared/   pure logic used by server, client, and tests
public/   host screen, player screen, 15 minigame clients, price asset pack
test/     unit tests + room integration + 20-headless-bot harness
```

## Deployment

Deploy anywhere that holds a long-lived websocket: **Railway, Render, or
Fly.io** (`npm start`, port from `$PORT`). Vercel serverless is a poor fit —
it won't hold websockets and the clock sync degrades; if you must, swap in a
dedicated realtime service. Simplest fallback: run on the host's laptop
behind a Cloudflare Tunnel.

## Out of scope (by design)

Accounts, persistence, cross-session leaderboards, native apps, spectators
beyond eliminated players, anything requiring pre-gathered player data, and
any turn-based mechanic whatsoever.
