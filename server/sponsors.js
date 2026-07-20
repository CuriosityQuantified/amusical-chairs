// Sponsored rounds: ads as game content, never as interruption. A sponsored
// round occupies attention the game already demands — it never adds time,
// taps, or difficulty. Guardrails (docs/ads-brainstorm.md):
//   - hard cap: at most SPONSOR_CAP sponsored games per session
//   - every sponsored round is labeled ("Sponsored round" chip) — transparency
//     reads playful, stealth reads gross
//   - content is seeded server-side like everything else, so all players see
//     the identical sponsored round and per-game normalization keeps it fair
//
// Real trademarks require a real sponsor deal, so the shipped pack is
// fictional demo brands written in the house humorous voice. A future
// sponsor pack is a drop-in replacement for DEMO_SPONSOR_PACK.

import { shuffle, pick } from '../shared/rng.js';

export const SPONSOR_CAP = 3;

// Games that have a sponsored variant. Odd One Out is deliberately absent.
// Bisect and Stop the Clock have no natural content slot (a number is a
// number), so they stay ad-free too.
export const SPONSORABLE = new Set([
  'rgb', 'trace', 'dots', 'gridflash', 'readroom', 'typing', 'spacemash', 'slingshot',
]);

// Brand fields and where they surface:
//   color/colorName → RGB Color Match target ("match Volt Yellow")
//   traceShape      → Trace the Shape draws the brand's "logo" (an existing
//                     roster shape, so difficulty stays comparable)
//   icon            → Grid Flash lit cells + Dots in the Jar dots
//   product         → Space Mash ("shake the …") and Slingshot flavor text
//   sentences       → Typing Sprint (house-voice taglines)
//   questions       → Read the Room (poll-style, brand-adjacent)
// All colors sit mid-saturation/mid-lightness like the random RGB targets, so
// a sponsored color round is neither easier nor harder than a normal one.
export const DEMO_SPONSOR_PACK = {
  name: 'Demo brands (fictional)',
  brands: [
    {
      key: 'volt',
      name: 'Volt Cola',
      icon: '⚡',
      tagline: 'Lightning in a can.',
      color: { r: 205, g: 172, b: 54 },
      colorName: 'Volt Yellow',
      traceShape: 'bolt',
      product: 'can of Volt Cola',
      sentences: [
        'Volt Cola: all the lightning, none of the cloud, some of the thunder.',
        'Legal requires us to say Volt Cola does not actually contain lightning.',
      ],
      questions: [
        'Have you ever had a soda before 9am and told no one?',
        'Do you shake a can to guess how full it is?',
      ],
    },
    {
      key: 'glacier',
      name: 'Glacier Fizz',
      icon: '❄️',
      tagline: 'Sparkling water with a superiority complex.',
      color: { r: 84, g: 168, b: 199 },
      colorName: 'Glacier Blue',
      traceShape: 'diamond',
      product: 'bottle of Glacier Fizz',
      sentences: [
        'Glacier Fizz is just water that went to art school and came back sparkling.',
        'Our water is filtered through rocks that have never once been to a meeting.',
      ],
      questions: [
        'Do you secretly think sparkling water tastes like static?',
        'Have you ever pretended to like a fancy drink to fit in?',
      ],
    },
    {
      key: 'comet',
      name: 'Comet Cookies',
      icon: '🍪',
      tagline: 'Gone before the crumbs land.',
      color: { r: 166, g: 112, b: 62 },
      colorName: 'Cookie Bronze',
      traceShape: 'circle',
      product: 'jar of Comet Cookies',
      sentences: [
        'Comet Cookies vanish so fast we legally cannot call them a shareable snack.',
        'A balanced diet is a Comet Cookie in each hand and no witnesses nearby.',
      ],
      questions: [
        'Have you ever hidden a snack from the people you live with?',
        'Do you eat the cookie part first and save the middle for last?',
      ],
    },
    {
      key: 'pixel',
      name: 'Pixel Pizza',
      icon: '🍕',
      tagline: 'Delivered in 8 bits or less.',
      color: { r: 199, g: 82, b: 58 },
      colorName: 'Pepperoni Red',
      traceShape: 'triangle',
      product: 'slice of Pixel Pizza',
      sentences: [
        'Pixel Pizza arrives so hot our boxes are technically a fire hazard.',
        'Every Pixel Pizza is a perfect triangle unless you look at it closely.',
      ],
      questions: [
        'Have you ever eaten pizza for breakfast, lunch, and dinner in one day?',
        'Do you judge people who eat pizza with a knife and fork?',
      ],
    },
  ],
};

// The subset of clientData/broadcast-safe brand info players see.
export function sponsorClientInfo(brand) {
  if (!brand) return null;
  return {
    key: brand.key,
    name: brand.name,
    icon: brand.icon,
    tagline: brand.tagline,
    colorName: brand.colorName,
    product: brand.product,
    css: `rgb(${brand.color.r},${brand.color.g},${brand.color.b})`,
  };
}

// Pick at most SPONSOR_CAP games from this session's queue to sponsor and
// assign each a distinct brand. Seeded, so the choice is deterministic per
// room. Returns Map(gameKey -> brand).
export function assignSponsors(rng, queueKeys, pack = DEMO_SPONSOR_PACK) {
  const assignments = new Map();
  const candidates = queueKeys.filter((k) => SPONSORABLE.has(k));
  if (!candidates.length || !pack?.brands?.length) return assignments;
  const chosen = shuffle(rng, candidates).slice(0, Math.min(SPONSOR_CAP, pack.brands.length));
  const brands = shuffle(rng, pack.brands);
  chosen.forEach((key, i) => assignments.set(key, brands[i]));
  return assignments;
}

// A single seeded brand for lobby solo-tests of one game.
export function pickTestBrand(rng, pack = DEMO_SPONSOR_PACK) {
  return pack?.brands?.length ? pick(rng, pack.brands) : null;
}
