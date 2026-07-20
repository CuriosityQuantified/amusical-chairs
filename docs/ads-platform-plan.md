# Ad Platform Research & Integration Plan

How to fill the sponsored-round slots (`server/sponsors.js`) with real, paying
sponsors. Research date: July 2026.

## What our implementation actually requires

The sponsored-rounds system imposes constraints most ad tech can't meet, so
requirements come first:

1. **Server-side, data-shaped creatives.** A "creative" for us is a JSON brand
   pack — name, icon, color, colorName, trace shape, product, sentences,
   questions — not an image or video file. The server injects it into seeded
   `clientData`; every player must receive identical content.
2. **No third-party JavaScript in the client.** The game is vanilla no-build
   JS and the finale depends on clock sync; ad-network tags add latency,
   tracking, and jank. Anything client-side is disqualified.
3. **No user-level targeting.** There are no accounts and no persistence, by
   design. Decisioning can use room context only (session size, time, host
   choice) — a privacy posture most programmatic networks can't work with.
4. **Guaranteed/direct deals, not auctions.** A session has at most 3
   sponsored rounds. Inventory is tiny, premium, and event-shaped —
   sponsorship economics, not CPM economics.
5. **Measurement = attention receipts.** We can report literal ad recall
   (Grid Flash reproduction accuracy, Color Match ΔE against the brand color)
   — far stronger than impressions. The platform should accept custom events,
   or at minimum server-fired impression confirmations.

## The landscape, mapped to those requirements

### A. HTML5 game ad networks — AdinPlay, Venatus, Google AdSense H5 Games Ads

Banner, interstitial, and rewarded-video formats injected by a client-side
tag between levels. This is precisely the interruption model the whole design
rejects, and it violates constraints 2–4 outright. **Rejected.**

### B. Intrinsic in-game ad platforms — Anzu, Frameplay, AdInMo

Philosophically closest to us ("ads that are part of the gameplay"), and Anzu
now reaches web games through its Playgama partnership. But their model is a
client SDK that streams **image textures onto 3D surfaces** (billboards,
jerseys) with viewability measurement — it cannot fill data-shaped slots like
a typing sentence, a poll question, or a brand color, which are our best
placements. Programmatic fill also assumes audience scale a party game
doesn't have. Only the Slingshot scene could even host such a texture.
**Poor fit; revisit only if we ever want programmatic fill for 3D scenes.**

### C. API-first ad serving / decisioning — Kevel

Kevel (ex-Adzerk) is "build your own ad server with APIs": your **backend**
POSTs to a Decision API and gets back a JSON response containing whatever
custom creative fields you define. That is exactly our shape — a brand pack
as a custom JSON creative template, requested server-side at room start,
no client code, first/second-price or **guaranteed** deals, impression and
custom-event tracking fired server-to-server. Constraints 1–5 all satisfied.
The catch is cost and weight: Kevel is enterprise-priced (typically four
figures monthly), absurd until there's real sponsorship revenue to manage.
**Right architecture, premature scale.**

### D. Direct-sold sponsorship ad managers — Broadstreet

Built for small publishers selling directly to advertisers (from ~$299/mo):
campaign management, sponsor reporting, sales workflow. But its delivery is
still web ad-zone oriented, so we'd use it as a **campaign bookkeeping and
reporting layer** while serving content ourselves — plausible at the
"handful of recurring sponsors" stage.

### E. No platform: first-party sponsor packs (what we ship today)

The demo pack proves the mechanism. Real deals at event scale (corporate
offsites, meetups, conference socials) are direct sponsorships: a JSON pack
per sponsor, loaded by the host. No rev-share, no SDK, no tracking, full
editorial control over voice and the difficulty-neutrality review. This is
also the door to the **self-sponsorship** model — a company running the game
at an all-hands loads a pack of its own brand and inside jokes, which is a
paid feature, not an ad.

## Recommendation: phase it

**Phase 1 — now (no external platform).** Stay first-party. Build the small
pieces that make packs sellable:
- `loadSponsorPack()` host-config upload (JSON, validated: color within the
  mid-saturation bounds, sentence lengths comparable to the house bank,
  traceShape from the roster list) with the demo pack as fallback.
- An impression log per sponsored round (room code, game, brand, player
  count) and a post-session **recall report**: Grid Flash cells-off vs.
  session average, Color Match ΔE distribution against the brand color.
  That report is the sales deck.

**Phase 2 — when sponsorships recur (Kevel Decision API).** Move pack
selection to Kevel while keeping our client untouched:
- Model each brand pack as a Kevel **custom JSON creative template**; one
  placement request per room at `start()`, decision cached on the Room so the
  seeded broadcast stays deterministic; demo pack as the no-fill fallback.
- Fire Kevel impression URLs server-side when each sponsored round actually
  plays (`scoreGame`), and recall metrics as custom events.
- Sell as **guaranteed/flat-rate flights** (Kevel supports guaranteed
  pricing), not auctions.
- Interim/lighter alternative at this stage: Broadstreet for campaign
  management + our own serving, if Kevel pricing outweighs deal flow.

**Phase 3 — only if chasing programmatic scale (Anzu-class intrinsic).**
A texture slot in the Slingshot 3D scene is the single placement compatible
with intrinsic-ad SDKs. Requires accepting a client SDK — weigh against
constraint 2 at that point; today it's a clear no.

## Integration sketch (Phase 2 target architecture)

```
Room.start()
  └─ sponsorSource.assign(queue, roomCtx)     // interface in server/sponsors.js
       ├─ DemoPackSource (today: assignSponsors + DEMO_SPONSOR_PACK)
       ├─ HostPackSource (Phase 1: host-uploaded JSON pack)
       └─ KevelSource    (Phase 2: POST /api/v2 Decision API,
                          custom JSON template → brand pack,
                          cache on room, fallback → DemoPackSource)
scoreGame(g) where g.sponsor
  └─ sponsorSource.trackImpression(g)         // server-fired beacon
  └─ recallReport.add(g)                      // gridflash diff / rgb ΔE
```

Nothing in `public/` changes in any phase — the client already renders
whatever brand pack the server seeds, and the guardrails (cap of 3, labeled
rounds) live server-side where a platform can't override them.

## Sources

- [Kevel — Decision API quickstart](https://dev.kevel.com/docs/native-ads-api-quickstart), [Decision API reference](https://dev.kevel.com/reference/request), [server-side ad serving guide](https://www.kevel.com/blog/what-is-server-side-ad-serving), [decisioning overview](https://www.kevel.com/ad-server/decisioning)
- [Anzu — intrinsic in-game advertising](https://www.anzu.io/), [Anzu × Playgama web-games partnership](https://wiki.playgama.com/playgama/intrinsic-in-game-ads)
- [Frameplay — intrinsic advertising for developers](https://frameplay.com/developers/)
- [Broadstreet — ad manager for small/direct-sold publishers](https://broadstreetads.com/), [pricing](https://broadstreetads.com/pricing/)
- [Google AdSense H5 Games Ads](https://support.google.com/adsense/answer/9959170?hl=en)
- [Publift — gaming ad networks overview](https://www.publift.com/blog/best-gaming-ad-networks), [MonetizeMore — gaming ad networks 2026](https://www.monetizemore.com/blog/top-ad-networks-gaming-vertical/), [DoonDookStudio — HTML5 game ad networks](https://doondook.studio/best-ad-networks-monetize-html5-games/)
- [Kevel — what are in-game ads (2026 guide)](https://www.kevel.com/blog/what-are-ingame-ads)
