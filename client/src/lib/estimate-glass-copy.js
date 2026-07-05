/**
 * Glass copy pack — the owner-approved copy repositioning for the estimate
 * surface (docs/design/estimate-glass-plan.md, PR B; strings verbatim from
 * the approved blueprint's COPY object in
 * docs/design/estimate-glass-blueprint.js).
 *
 * Content rides the same `?glass=1` dark launch as the visual theme (PR A):
 * nothing here changes the estimate page until the URL opts in, so the
 * current copy stays the control for the planned v1-vs-v2 rollout test.
 * Service-agnostic strings apply to any glass estimate; the pest-specific
 * pack applies only to pest_control — other categories keep the standard
 * copy until their packs are approved (planned follow-up, not PR B).
 */
import { etDateString } from './timezone';

// Server-driven release state (GATE_ESTIMATE_GLASS → /data glassDefault).
// Module-level on purpose: dozens of components consult glassCopyActive()
// without prop threading, and the flag flips at most once per page load —
// EstimateViewPage sets it from the payload before the loaded UI renders.
let glassDefaultReleased = false;

export function setGlassDefault(on) {
  glassDefaultReleased = on === true;
}

export function glassCopyActive() {
  try {
    const param = new URLSearchParams(window.location.search).get('glass');
    if (param === '1') return true; // pre-release preview / force-on
    if (param === '0') return false; // per-link escape hatch back to the old page
    return glassDefaultReleased;
  } catch {
    return glassDefaultReleased;
  }
}

// ── Service-agnostic strings ────────────────────────────────────────────────
export const GLASS_COPY = {
  ctaMain: 'Approve my plan and schedule',
  ctaBook: 'Book my first visit',
  ctaMicro: 'No long-term contract · Unlimited free callbacks · 90-day money-back guarantee',
  askTitle: 'Still deciding? Ask anything — instant answers.',
  askExcerpt: 'Ask about pricing, treatments, scheduling, pets, kids, or what happens after approval — straight answers in seconds.',
  schedExcerpt: 'Our soonest openings — and if we’re already on your street that day, snag it and skip the line.',
  appTitle: 'Stop waiting around for service windows — watch your tech drive to your door, live',
  appExcerpt: 'Where’s the tech? Check your phone. What did we treat? Check your phone. Live GPS, photo reports, alerts you control.',
  appHouseholdLine: 'One login for the whole household — everyone in the loop, nobody playing messenger.',
  reviewsTitle: 'See why your neighbors switched to Waves',
  reviewsExcerpt: 'Real Google reviews — unedited, unfiltered, from people whose backyards look like yours.',
  callButton: 'Call us — talk to a real person',
  textButton: 'Text us — fast answers',
  setupWaivedNote: 'Pay the year up front and we waive it — instantly.',
  lawnOfferTitle: 'Add Lawn Care — save on both services',
  // The Silver/10% mechanics are only true when lawn would be the SECOND
  // service; a pest + mosquito/tree/termite plan is already past Silver, so
  // multi-service estimates get the tier-agnostic body instead of a wrong
  // percentage claim.
  lawnOfferBody: 'Bundling bumps you up to WaveGuard Silver: 10% off your pest control AND your lawn care, on every visit.',
  lawnOfferBodyMulti: 'Bundling lawn care bumps your whole plan to the next WaveGuard tier — a bigger discount on every service, every visit.',
  lawnOfferButton: 'Add Lawn Care — unlock 10% off',
  lawnOfferButtonMulti: 'Add Lawn Care — unlock the next tier',
};

// Footer city line — GBP profiles (g.page short links from
// server/config/locations.js `googleReviewUrl`, `/review` suffix stripped so
// they open the profile, not the review composer).
export const GLASS_FOOTER_CITY_LINKS = [
  { label: 'Bradenton', href: 'https://g.page/r/CVRc_P5butTMEBM' },
  { label: 'Parrish', href: 'https://g.page/r/Ca-4KKoWwFacEBM' },
  { label: 'Sarasota', href: 'https://g.page/r/CRkzS6M4EpncEBM' },
  { label: 'Venice', href: 'https://g.page/r/CURA5pQ1KatBEBM' },
];

// ── Pest-specific pack ──────────────────────────────────────────────────────
const GLASS_PEST = {
  heroH1: '{first}, your pest-free home plan is ready.',
  heroSub: 'We can start protecting your home as soon as tomorrow — quarterly exterior protection, interior treatment when needed, unlimited free callbacks, and a 90-day money-back guarantee.',
  eyebrow: 'Your pest-free home plan',
  aiTitle: 'Your price was built from your home — not somebody else’s average',
  aiBody: 'We didn’t guess. We measured your home, lot, roofline, and access points so your plan fits your actual property — not a generic average.',
  askChips: [
    'Is this safe for pets and kids?',
    'Can you treat inside?',
    'When am I charged?',
    'What if I still see bugs?',
  ],
};

export function glassEstimateCopyFor(serviceCategory) {
  if (!glassCopyActive() || serviceCategory !== 'pest_control') return null;
  return GLASS_PEST;
}

// ── Technical offer stack (pest) ────────────────────────────────────────────
// The bullets replacing the three-line pest inclusion list. The perimeter
// bullet states the real visit count when the plan carries one; the setup
// bullet renders only when the estimate actually carries a waivable setup
// fee (existing-customer pest estimates have neither the fee nor the
// annual-prepay option, so advertising the waiver there would be false).
export function glassPestInclusions(visitsPerYear, includeSetupBullet = false) {
  const visits = Number(visitsPerYear) > 0 ? Number(visitsPerYear) : 4;
  const bullets = [
    'Premium non-repellent + repellent solutions, matched to the target pest',
    `Protected ${visits}× a year — full perimeter, entry points, eaves & harborage zones, every visit`,
    'Interior treatment included — no awkward upsell, no surprise charge',
    'If pests come back, so do we — unlimited free callbacks, 100% guaranteed',
    '90-day money-back guarantee — if you don’t love it, you don’t pay',
    'No long-term contract — stay because it works, not because you’re trapped',
  ];
  if (includeSetupBullet) {
    bullets.push('$99 setup disappears with annual billing — waived instantly');
  }
  return bullets;
}

// ── Per-day value line ──────────────────────────────────────────────────────
// Recomputed per billing cadence with a cadence-matched comparison tail
// (price × periods / 365 — PriceCard's existing dayPrice math already yields
// exactly this, so only the wording changes).
export const GLASS_DAY_LINES = {
  quarterly: 'That’s about {amount}/day — less than a gas-station drink for year-round protection.',
  bi_monthly: 'That’s about {amount}/day — less than your morning coffee for year-round protection.',
  monthly: 'That’s about {amount}/day — a rounding error on the grocery bill, for always-on protection.',
};

// ── Tier display ────────────────────────────────────────────────────────────
// On a single-plan estimate there is no tier ladder to compare against, so
// "Bronze" (0% discount) reads as bottom-shelf for no reason — it displays as
// "Home Protection". Silver/Gold/Platinum connote an earned discount and keep
// their names. Comparison surfaces keep Bronze; the estimate page never
// renders a ladder.
export function glassTierDisplay(tierLabel) {
  const raw = String(tierLabel || '').replace(/^WaveGuard\s+/i, '');
  return raw.toLowerCase() === 'bronze' ? 'Home Protection' : tierLabel;
}

// ── Scheduler header qualifier ──────────────────────────────────────────────
// "Lock in your spot — openings as soon as {today|tomorrow|this week}" from
// the REAL first open slot (plan directive: dynamic, never a static claim).
// Returns null when there are no slots to make the claim from.
// Slot dates are ET wall-clock (lib/timezone.js: scheduling is ET, never
// browser-local), so "today" is measured against the ET calendar — a
// customer browsing from another timezone still sees the right label.
export function glassSchedQualifier(firstSlotYmd) {
  if (!firstSlotYmd) return null;
  const slotUtc = Date.parse(`${firstSlotYmd}T12:00:00Z`);
  const todayUtc = Date.parse(`${etDateString()}T12:00:00Z`);
  if (Number.isNaN(slotUtc) || Number.isNaN(todayUtc)) return null;
  const days = Math.round((slotUtc - todayUtc) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days <= 7) return 'this week';
  return null;
}

export function glassSchedTitle(qualifier) {
  return qualifier ? `Lock in your spot — openings as soon as ${qualifier}` : null;
}

// ── Slot-search summary rewrite ─────────────────────────────────────────────
// The find-slots summary opens on a negative ("No route near you that day
// yet, but here are N open times for …"). Under glass it leads with what IS
// available; a morning/afternoon/evening/weekend qualifier from the
// customer's own search phrasing is folded in when present.
export function glassRewriteSlotSummary(summary, query = '') {
  const text = String(summary || '');
  // The server uses singular grammar for one result ("here is 1 open time"),
  // so match both forms — a one-slot day is the case that most needs the
  // positive framing.
  const m = text.match(/^No route near you that day yet, but here (?:are|is) (\d+) open times? for ([A-Za-z]+),? (.+?)\.?$/);
  if (!m) return summary;
  const times = `open time${m[1] === '1' ? '' : 's'}`;
  const qualifier = String(query).match(/\b(morning|afternoon|evening|weekend)\b/i);
  return qualifier
    ? `${m[1]} ${times} for ${m[2]} ${qualifier[1].toLowerCase()} (${m[3]}) — pick what works:`
    : `${m[1]} ${times} for ${m[2]}, ${m[3]} — pick what works:`;
}
