// Drop-in monetization: Google H5 Games Ads via the Ad Placement API — the
// one self-serve network that fills mobile-browser games with no brand deals.
//
// House rules (docs/ads-platform-plan.md):
//   - Fully config-gated: until the server sets ADSENSE_CLIENT, this module
//     loads no third-party code and every call is a no-op.
//   - Dead time only: ad breaks are requested exclusively from waiting
//     screens (score reveals, game over) — never during timed input, never
//     around the clock-synced finale.
//   - Our own frequency floor sits on top of Google's pacing so a fast host
//     can't turn score screens into an ad reel.
//   - Ads must never break the game: every path here swallows its errors.

let apiPush = null;    // adBreak/adConfig are the same push fn, per the API
let lastBreakAt = 0;
const MIN_GAP_MS = 3 * 60 * 1000;

export async function initAds() {
  if (apiPush) return;
  try {
    const cfg = await fetch('/api/ads-config').then((r) => r.json());
    if (!cfg || !cfg.adsenseClient) return;
    window.adsbygoogle = window.adsbygoogle || [];
    apiPush = (o) => window.adsbygoogle.push(o);
    const s = document.createElement('script');
    s.async = true;
    s.crossOrigin = 'anonymous';
    if (cfg.adsenseTest) s.dataset.adbreakTest = 'on';
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client='
      + encodeURIComponent(cfg.adsenseClient);
    document.head.append(s);
    // adConfig: interstitials are pre-fetched; sound off — the host screen
    // owns the room's audio.
    apiPush({ preloadAdBreaks: 'on', sound: 'off' });
  } catch { apiPush = null; }
}

// Request an interstitial at a named dead-time break. Google decides whether
// one actually shows; adBreakDone fires either way.
export function adBreakAt(name, { onClose } = {}) {
  if (!apiPush) return;
  const now = Date.now();
  if (now - lastBreakAt < MIN_GAP_MS) return;
  try {
    apiPush({
      type: 'next',
      name,
      beforeAd: () => { lastBreakAt = Date.now(); },
      adBreakDone: () => { try { onClose?.(); } catch { /* noop */ } },
    });
  } catch { /* ads must never break the game */ }
}
