# 🎵 Musical Chairs

A hybrid-meeting party game: classic musical chairs with the scramble for a
seat replaced by a **skill scramble**. One projected host screen, every player
on their own phone or laptop. 2–30 players, ~20 minutes including rules.

Every scoring round is played by **all surviving players simultaneously** —
nothing is turn-based.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

- **Host:** open `/host.html`, create a room, project the screen.
- **Players:** scan the QR / open `/?code=XXXX`, enter a name.
- Host config (durations, per-game toggles, practice round) lives in the
  lobby screen.

```bash
npm test           # unit tests + 20-bot end-to-end harness
```

## How a game works

Score attack — no elimination:

1. Every enabled minigame (11-game roster across 6 categories) is played
   exactly once, by **all players simultaneously**, in a seeded-shuffled
   order. Music + circling avatars play between games.
2. Before each game (and the finale), everyone sees an **animated how-to
   tutorial**: looping ✓ DO / ✗ AVOID demos of the game. Duration is a host
   config knob (default 9s, 0 = off); the host's Next — or the solo
   player's Skip — jumps straight in.
3. Raw metrics are normalized per game to 0–1000 **across only the players
   who played it** (P90/P10 outlier clamps; no rank-summing). Non-submitters
   score 0 for that game but stay in.
4. After every game, each player sees their raw result, points earned,
   running total, and rank; a **live leaderboard strip** stays pinned to the
   top of every player screen and the host screen for the whole session.
5. The finale is **musical chairs** — a bonus elimination tournament of
   clock-synced reaction rounds. With N players there are N−1 rounds; every
   round shows one chair fewer than the players still in (players − 1), the
   slowest reaction is eliminated, and everyone else's avatar visibly takes
   a chair. Play continues until one player holds the last chair. Final
   placement pays **3× bonus points** (1st = 3000 … last = 0, linear).
6. Highest cumulative total wins.

Round content is randomized **server-side** with a seeded RNG and broadcast
to every player, so everyone always plays the identical configuration:
Stop the Clock draws a random 6–10s target, Grid Flash varies pattern sizes
(6–9 cells), Slingshot jitters the distance ±25%, Trace picks from 15
shapes, and Read the Room draws from an **80-question humorous bank**
(Typing Sprint from 30 sentences) with no repeats within a session.

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
- Reconnects: `playerId` persists in `localStorage`; a dropped player never
  loses their identity or score for a wifi hiccup — missed submissions
  simply score 0 for that game.
- `shared/` holds pure logic (normalization, redemption state machine,
  press counter, CIEDE2000) served unmodified to the
  browser and imported directly by server + tests.

```
server/   express + socket wiring, room state machine, game metrics
shared/   pure logic used by server, client, and tests
public/   host screen, player screen, 11 minigame clients
test/     unit tests + room integration + 20-headless-bot harness
```

## Deployment

Deploy anywhere that holds a long-lived websocket: **Railway, Render, or
Fly.io** (`npm start`, port from `$PORT`). Vercel serverless is a poor fit —
it won't hold websockets and the clock sync degrades; if you must, swap in a
dedicated realtime service. Simplest fallback: run on the host's laptop
behind a Cloudflare Tunnel.

## Out of scope (by design)

Accounts, persistence, cross-session leaderboards, native apps, spectators,
anything requiring pre-gathered player data, and
any turn-based mechanic whatsoever.
