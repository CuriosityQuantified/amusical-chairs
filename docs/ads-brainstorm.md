# Ads Without Annoyance — Brainstorm

The core insight (from the Grid Flash idea): in a skill game, **player attention
is the gameplay**. If the ad *is* the game content — the thing you must
memorize, trace, count, or match — you get deeper engagement than any banner,
with zero added friction. The player never waits, clicks, or dismisses
anything. The rule that makes this work:

> **Ads may occupy attention the game already demands. They may never add
> time, add taps, cover gameplay, or change difficulty.**

## Tier 1 — Ads as game content (the good stuff)

Every one of these slots into an existing minigame with no new mechanics:

| Game | Sponsored variant |
|---|---|
| **Grid Flash** | The flashed cells show the sponsor's logo/product instead of plain fills. Memorizing the ad *is* the round. Bonus: post-game you can report literal ad-recall accuracy to the sponsor. |
| **RGB Color Match** | "Match **Sponsor Red**." Brands are obsessive about their colors; players discover how well (or badly) they know them. Naturally funny reveal. |
| **Odd One Out** | Grid of identical logos, one subtly wrong (flipped, off-color, misspelled). "Spot the counterfeit" — brands love logo-literacy. |
| **Trace the Shape** | Trace the sponsor's logo outline. A swoosh or bitten apple is exactly the kind of shape this game already uses. |
| **Dots in the Jar** | Count the products: coffee beans in the sponsor's mug, candies in the sponsor's jar. The product is the container/objects. |
| **Typing Sprint** | Sponsored sentences in the 30-sentence bank — self-aware taglines in the same humorous voice as the existing content. |
| **Read the Room** | Sponsored poll questions ("What fraction of this room ordered delivery after midnight this week?"). Doubles as market research the sponsor actually values. |
| **Slingshot** | Launch the sponsor's product into the target (soda can → cooler). |
| **Space Mash** | Mashing "shakes" a branded bottle / fills a branded meter. Pure skin, zero mechanical change. |

## Tier 2 — Dead-time placements (jumbotron model)

The game already has natural pauses; these cost the player nothing:

- **Intermission** (music + circling avatars between games): sponsor card on
  the **host/projector screen only**. Exactly like stadium jumbotron ads.
- **Tutorial screens**: a small "This round brought to you by X" chip on the
  9-second how-to loop. Attention is already parked there.
- **Lobby / QR join screen**: event-sponsorship logo while people trickle in.
- **Leaderboard strip / finale podium**: "Leaderboard powered by X."
- **Prize integration**: "Winner gets a Sponsor gift card" — the single most
  welcome ad possible; it raises stakes instead of stealing attention.
- **Music**: the game is *aMuseical* Chairs — the between-round tracks are a
  natural artist/label promotion slot.

## Tier 3 — The sleeper business model: self-sponsorship

This game's habitat is corporate offsites and all-hands. The "advertiser" is
often **the host's own organization**: their logo in Grid Flash, their brand
color in Color Match, inside jokes in Typing Sprint, real company questions in
Read the Room. Ship it as a **host-configurable sponsor pack** (JSON manifest +
image assets, uploaded in the lobby config) and it's simultaneously:

1. an ad system for sponsored public events,
2. a customization *feature* for private ones — people pay for that instead of
   tolerating it.

## Implementation status

Tier 1 is **implemented** (`server/sponsors.js`) for every game except Odd One
Out — Grid Flash, RGB Color Match, Trace the Shape, Dots in the Jar, Typing
Sprint, Read the Room, Space Mash, and Slingshot all have sponsored variants,
driven by a fictional demo brand pack. Bisect the Line and Stop the Clock have
no natural content slot and stay ad-free. The two hard guardrails below (the
per-session cap and the sponsored-round label) are enforced in code, not just
policy; the host toggle lives in the lobby config panel.

## Anti-annoyance guardrails

- **Frequency cap** *(implemented — `SPONSOR_CAP = 3`)*: at most 3 of the 11
  games are sponsored per session, chosen seeded per room, one distinct brand
  each. Scarcity keeps it charming.
- **Label it** *(implemented)*: every sponsored round wears a
  "✦ Sponsored round · brand" chip on the player screen, the host/projector
  screen, the tutorial, and the score reveal. Transparency reads as playful;
  stealth reads as gross.
- **Player screens stay clean during timed input.** Passive branding lives on
  the host screen; on player devices the ad only appears where it is the
  gameplay object itself.
- **Never audio-interrupt, never interstitial, never a countdown you wait
  through.** The intermission music/ambience is sacred.
- **Match the house voice**: the question bank is humorous; sponsored content
  must be written in the same register or it will stick out as an ad.

## Fairness & technical constraints

- **Difficulty must be content-neutral.** Server-side seeded RNG already
  guarantees everyone sees identical content, and normalization is per-game
  across only its players — so a sponsored round can't disadvantage anyone
  relative to the room. Still: a famous logo is easier to memorize/trace than
  an abstract pattern, so sponsored assets should be validated for comparable
  complexity (cell count, path length) to keep 0–1000 scores meaningful
  across sessions.
- **Color Match caveat**: matching a known brand color shifts the skill from
  perception toward recall. Fun, but it's a different test — worth embracing
  deliberately ("how well do you *really* know Sponsor Red?") rather than
  pretending it's the same game.
- **No third-party ad networks.** The client is vanilla no-build JS and the
  finale depends on clock sync; injecting ad-network scripts would add
  latency, tracking, and jank. Sponsor packs are static assets served from
  our own origin, preloaded during intermission so timing games never stall.
- **Trademark reality**: logo-based variants (Trace, Odd One Out) require an
  actual sponsor relationship — you can't demo with real marks you don't
  have rights to. Ship with fictional placeholder brands.

## Measurement pitch (why sponsors would pay)

Memory and perception games produce something banner ads can't: **attention
receipts**. "Players reproduced your logo placement with 87% accuracy after a
1.2-second exposure" is a wildly better sponsorship report than impressions.
Grid Flash recall, Color Match error in ΔE, Odd One Out spot-rate — the
scoring pipeline already computes all of it.

## Suggested first experiment

Smallest end-to-end slice: a `sponsorPack` field in host config → Grid Flash
renders pack images in flashed cells + one intermission card on the host
screen → post-game screen shows "recall accuracy" alongside score. One pack of
fictional brands ships as the demo.
