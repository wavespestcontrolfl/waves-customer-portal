/**
 * Glass copy pack — the owner-approved copy repositioning for the estimate
 * surface (docs/design/estimate-glass-plan.md, PR B; strings verbatim from
 * the approved blueprint's COPY object in
 * docs/design/estimate-glass-blueprint.js).
 *
 * Content activation is server-driven: the /data payload's glassDefault flag
 * releases the copy per category (GATE_ESTIMATE_GLASS_CATEGORIES; unset = all).
 * The old `?glass=1` / `?glass=0` URL override was retired 2026-07-07 (owner
 * decision) — glass is the only customer theme, so the per-link escape hatch
 * back to the pre-glass page no longer exists.
 */
import { etDateString } from './timezone';

// Estimate glass COPY release — category-scoped server-side. NOTE: only the
// marketing COPY still rides this flag; the glass THEME is now unconditional
// on every estimate. The server sends glassDefault per eligible category and
// EstimateViewPage calls setGlassDefault() from the /data payload before the
// loaded UI renders.
let glassDefaultReleased = false;

export function setGlassDefault(on) {
  glassDefaultReleased = on === true;
}

export function glassCopyActive() {
  return glassDefaultReleased;
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

// ── Per-service packs ───────────────────────────────────────────────────────
// One pack per deriveServiceCategory value (server narrow list) + 'bundle'.
// Every factual claim is grounded in an already-shipped surface: the
// SERVICE_COPY baseline (estimate-copy.js), PriceCard's default guarantee
// line (all single-service categories), or GuaranteeStrip (all estimates).
// The voice repositioning changes TONE only — no new guarantees, products,
// or numbers are introduced here.
const GLASS_PEST = {
  heroH1: 'Hello {first}, your pest-free {city} plan is ready!',
  heroSub: 'We can start protecting your home as soon as {date}. Your plan includes quarterly exterior barrier service, interior treatment when needed, unlimited free callbacks, and a 90-day money-back guarantee \u2014 so you\u2019re not paying and praying the bugs stay gone in {city}.',
  eyebrow: 'Your pest-free home plan',
  aiTitle: 'Your price was built from your {city} home — not somebody else’s.',
  aiBody: 'We didn’t guess. We measured your home, lot, roofline, and access points so your plan fits your actual property — not a generic average.',
  askChips: [
    'Is this safe for pets and kids?',
    'Can you treat inside?',
    'When am I charged?',
    'What if I still see bugs?',
  ],
};

// One-time project quotes have different terms than recurring plans (no
// cancel-anytime framing, no callback promise), so their micro line sticks
// to claims GuaranteeStrip already makes on every estimate. The license
// NUMBER itself is deliberately not repeated here — GuaranteeStrip renders
// the configured one (estimate.licenseNumber) in the same viewport, and a
// hardcoded copy would drift if the config changes.
const ONE_TIME_CTA_MICRO = 'Licensed & insured · Satisfaction guaranteed · Approve online in 60 seconds';

// Terms-neutral micro line: used whenever we cannot verify that the
// recurring contract/callback/guarantee terms apply to EVERY service the
// CTA covers (rodent plans, unknown/mixed compositions).
const NEUTRAL_CTA_MICRO = 'Licensed & insured · Satisfaction guaranteed · No pressure — approve when you’re ready';

const GLASS_PACKS = {
  pest_control: GLASS_PEST,
  lawn_care: {
    heroH1: 'Hello {first}, your greener-lawn game plan is ready!',
    heroSub: 'Built for your actual turf — feeding, weed control, and fungus watch on a program that fits your lawn, backed by a 90-day money-back guarantee.',
    eyebrow: 'Your custom lawn program',
    aiTitle: 'Your price was built from your lawn — not somebody else’s',
    aiBody: 'We reviewed your lawn size, turf type, and current condition before pricing this program — your lawn, your price, nothing generic.',
    askChips: [
      'When will I see results?',
      'What about weeds?',
      'Is it safe for pets and kids?',
      'When do visits start?',
    ],
  },
  mosquito: {
    heroH1: 'Hello {first}, your mosquito-free backyard plan is ready!',
    heroSub: 'Targeted barrier protection where mosquitoes actually breed and rest — so evenings outside belong to you again, not the bugs.',
    eyebrow: 'Your mosquito protection plan',
    aiTitle: 'Priced from your actual lot — not a guess',
    aiBody: 'We reviewed your lot, vegetation, and mosquito resting zones before pricing this plan — treatment goes where the pressure actually is.',
    askChips: [
      'How fast does it work?',
      'Is it safe for pets and kids?',
      'What about my pool area?',
      'When does the season start?',
    ],
  },
  tree_shrub: {
    heroH1: 'Hello {first}, your landscape protection plan is ready!',
    heroSub: 'Professional care for the palms, trees, and shrubs you’ve invested in — insects, mites, disease, and nutrition handled before problems cost you a plant.',
    eyebrow: 'Your tree & shrub program',
    aiTitle: 'Priced from your actual landscape — bed by bed',
    aiBody: 'We reviewed your beds, trees, and treatment needs before pricing this program — care matched to what’s actually planted.',
    askChips: [
      'Which trees get treated?',
      'What gets applied?',
      'When do visits start?',
      'Can I prepay annually?',
    ],
  },
  termite_bait: {
    heroH1: 'Hello {first}, your termite defense plan is ready!',
    heroSub: 'Bait stations standing guard around your home’s perimeter, monitored and documented — protection that’s working while you’re not thinking about it.',
    eyebrow: 'Your termite defense plan',
    aiTitle: 'Your price was built from your home’s actual perimeter',
    aiBody: 'We measured your home and its termite perimeter before pricing this protection — station coverage matched to your footprint.',
    askChips: [
      'What’s monitored?',
      'How often are stations checked?',
      'Basic vs Premier?',
      'What about active termites?',
    ],
  },
  foam_recurring: {
    heroH1: 'Hello {first}, your recurring foam treatment plan is ready!',
    heroSub: 'Targeted drill-and-foam treatment at the points that matter, on a schedule that keeps the pressure down — documented every visit.',
    eyebrow: 'Your foam treatment plan',
    aiTitle: 'Scoped from your actual treatment points',
    aiBody: 'We reviewed the drill points and treatment areas before pricing this recurring plan — you’re paying for your home’s scope, not a flat guess.',
    askChips: [
      'What does each visit cover?',
      'How often do you come out?',
      'Can I prepay annually?',
      'What about active termites?',
    ],
  },
  termite_trenching: {
    heroH1: 'Hello {first}, your termite barrier quote is ready!',
    heroSub: 'A full liquid barrier around your home — measured from your actual linear footage, applied by licensed pros, documented when it’s done.',
    eyebrow: 'Your termite barrier quote',
    aiTitle: 'Measured from your home — not a ballpark',
    aiBody: 'We mapped the trenching path and measured the exact linear footage behind this quote — the price fits your foundation, not an average one.',
    askChips: [
      'How long does the barrier last?',
      'Do you drill the concrete or driveway?',
      'What product is used?',
      'What’s covered?',
    ],
    ctaMicro: ONE_TIME_CTA_MICRO,
  },
  pre_slab_termiticide: {
    heroH1: 'Hello {first}, your pre-slab termite treatment quote is ready!',
    heroSub: 'Treat the soil right before the slab pours — measured area, professional product, and documentation for your records.',
    eyebrow: 'Your pre-slab treatment quote',
    aiTitle: 'Priced from the measured slab area',
    aiBody: 'This quote comes from the measured slab area, the selected product, and your warranty option — nothing padded, nothing guessed.',
    askChips: [
      'What product is used?',
      'Do I get documentation?',
      'What warranty is selected?',
      'When should this be done?',
    ],
    ctaMicro: ONE_TIME_CTA_MICRO,
  },
  bora_care: {
    heroH1: 'Hello {first}, your Bora-Care wood treatment quote is ready!',
    heroSub: 'Borate protection for the wood itself — measured from your actual treatment areas, applied once, defending long after we leave.',
    eyebrow: 'Your wood treatment quote',
    aiTitle: 'Priced from your measured treatment areas',
    aiBody: 'We priced this from the measured attic and surface areas and the product application rate — your square footage, your price.',
    askChips: [
      'What does Bora-Care treat?',
      'Is Bora-Care safe for pets and kids?',
      'How long does it last?',
      'When should this be done?',
    ],
    ctaMicro: ONE_TIME_CTA_MICRO,
  },
  // Scope-neutral on purpose: this category covers everything from
  // bait-station-only monitoring plans to full trapping + exclusion
  // remediation, so the hero must not promise removal or exclusion work —
  // the priced line items state what's actually included.
  rodent: {
    heroH1: 'Hello {first}, your rodent defense plan is ready!',
    heroSub: 'Built for YOUR rodent situation — priced from your property’s actual conditions, with every visit documented, not a one-size-fits-all box of traps.',
    eyebrow: 'Your rodent defense plan',
    aiTitle: 'Built from your home’s actual entry risks',
    aiBody: 'We reviewed the conditions and entry risks driving rodent pressure at your property before pricing this plan — the plan matches the problem.',
    askChips: [
      'Trapping vs exclusion?',
      'Do I need sanitation?',
      'Is the inspection fee credited?',
      'How long until they’re gone?',
    ],
    ctaMicro: NEUTRAL_CTA_MICRO,
  },
  bundle: {
    heroH1: 'Hello {first}, your complete home protection plan is ready!',
    heroSub: 'Every service on this plan was priced from your actual property — one plan, one team accountable for all of it.',
    eyebrow: 'Your custom Waves plan',
    aiTitle: 'Your price was built from your property — not somebody else’s',
    aiBody: 'We reviewed your home, lot, and every service on this plan before pricing it — nothing here is generic.',
    askChips: [
      'What’s included in this plan?',
      'How do the services work together?',
      'Are pets and kids safe?',
      'When am I charged?',
    ],
  },
};

export function glassEstimateCopyFor(serviceCategory) {
  if (!glassCopyActive()) return null;
  // Unknown/unclassified categories get the bundle pack — property-generic
  // claims only, so nothing service-specific can be wrong.
  return GLASS_PACKS[serviceCategory] || GLASS_PACKS.bundle;
}

// CTA micro line under the primary booking CTA. Recurring plans keep the
// service-agnostic recurring terms (contract/callbacks/guarantee — all
// already shipped on pest+lawn); packs override where those terms don't
// apply (one-time projects, rodent remediation).
export function glassCtaMicroFor(serviceCategory) {
  // Row/section slugs (PriceCard serviceKey) and page categories
  // (deriveServiceCategory) name rodent differently — fold them together.
  const category = serviceCategory === 'rodent_bait' ? 'rodent' : serviceCategory;
  const pack = GLASS_PACKS[category];
  return pack?.ctaMicro || GLASS_COPY.ctaMicro;
}

// Micro line for a CTA that covers MULTIPLE services (combined bundle CTA,
// or a synthetic unsplit-bundle section resolved via its memberKeys). The
// recurring terms line renders only when every covered service carries
// those terms; any override (rodent) or unresolvable key (synthetic
// 'bundle' with unknown composition) demotes to the terms-neutral line —
// a split rodent+lawn bundle must not advertise callback terms the rodent
// copy deliberately avoids (codex rd2).
export function glassCtaMicroForKeys(keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return NEUTRAL_CTA_MICRO;
  const micros = list.map((key) => {
    const slug = glassServiceSlug(String(key));
    return slug ? glassCtaMicroFor(slug) : null;
  });
  if (micros.includes(null)) return NEUTRAL_CTA_MICRO;
  const distinct = [...new Set(micros)];
  return distinct.length === 1 ? distinct[0] : NEUTRAL_CTA_MICRO;
}

// Section-key → glass slug. Same substring vocabulary as PriceCard's
// serviceKey(), with two deliberate differences: 'pest' is checked FIRST
// (matching the server's recurringServiceKey semantics, where lawn_pest_*
// resolves to pest), and no match returns null instead of defaulting to
// pest_control — the server can emit synthetic section keys (e.g. the
// unsplittable multi-service 'bundle' section) that must NOT inherit
// pest copy, so callers keep the server-provided wording on null.
export function glassServiceSlug(keyOrLabel) {
  const raw = String(keyOrLabel || '').toLowerCase();
  if (raw.includes('pest')) return 'pest_control';
  if (raw.includes('lawn')) return 'lawn_care';
  if (raw.includes('mosquito')) return 'mosquito';
  if (raw.includes('tree') || raw.includes('shrub')) return 'tree_shrub';
  if (raw.includes('foam')) return 'foam_recurring';
  if (raw.includes('termite')) return 'termite_bait';
  if (raw.includes('palm')) return 'palm_injection';
  if (raw.includes('rodent') || raw.includes('bait station')) return 'rodent_bait';
  return null;
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

// ── Technical offer stacks (non-pest rows) ──────────────────────────────────
// Glass rewrites of PriceCard's SERVICE_INCLUSIONS, keyed by the same
// serviceKey() slugs. Same facts as the baseline lists (what each program
// actually does) plus guarantee lines already shipped elsewhere on the page
// (PriceCard guaranteeLine, GuaranteeStrip) — tone changes, claims don't.
const GLASS_SERVICE_INCLUSIONS = {
  lawn_care: [
    'Seasonal treatments matched to YOUR turf and program — never a one-size-fits-all spray',
    'Weed, fungus, and chinch-bug pressure checked every visit — caught early, not after the brown patch',
    'Every treatment documented and carried forward — your lawn’s history drives the next visit',
    '90-day money-back guarantee — if you don’t love it, you don’t pay',
    'No long-term contract — stay because the lawn proves it',
  ],
  mosquito: [
    'Barrier treatment where mosquitoes actually rest — shaded foliage and harborage, not a fog-and-go',
    'Standing-water and breeding-pressure checks every visit — we cut the problem at its source',
    'Weather-aware timing so treatments work instead of washing away',
    '90-day money-back guarantee — if you don’t love it, you don’t pay',
    'No long-term contract — cancel anytime',
  ],
  tree_shrub: [
    'Ornamentals inspected at every visit — insect, mite, and disease pressure caught before it costs you a plant',
    'Seasonal plant-health treatments matched to what’s actually planted',
    'Observations carried forward — your landscape’s health history in one place',
    'No long-term contract — cancel anytime',
  ],
  termite_bait: [
    'Bait stations on duty around your home’s perimeter — termites work around the clock, so do the stations',
    'Every station check documented — you see the evidence, not just a bill',
    'Annual termite inspection support included',
    'No long-term contract — protection you keep because it’s working',
  ],
  palm_injection: [
    'Palm health and canopy checked at every service',
    'Nutrition and pest-pressure support dosed per palm — not per averages',
    'Decline or recovery tracked visit to visit, in writing',
  ],
  rodent_bait: [
    'Exterior bait stations monitored and documented every visit',
    'Activity tracked so you can SEE the pressure drop',
    'Entry-point observations flagged before they become invasions',
  ],
  foam_recurring: [
    'Targeted drill-and-foam treatment at active termite points — not blanket spraying',
    'Recurring coverage on your selected cadence — pressure stays down because we keep showing up',
    'Every treatment documented and carried forward',
  ],
};

// Row-level inclusions under glass: pest keeps its visit-count-aware stack;
// every other service gets its glass rewrite; unknown keys fall back to
// null so PriceCard keeps the baseline SERVICE_INCLUSIONS list (fail-safe:
// no glass list means no new claims).
export function glassRowInclusions(rowServiceKey, visitsPerYear, includeSetupBullet = false) {
  if (rowServiceKey === 'pest_control') {
    return glassPestInclusions(visitsPerYear, includeSetupBullet);
  }
  return GLASS_SERVICE_INCLUSIONS[rowServiceKey] || null;
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

// Per-day lines for the other recurring programs — one line per service (the
// comparison anchors the value, so it's service-matched rather than
// cadence-matched like pest). Keys mirror PriceCard's serviceKey() slugs;
// each value fans out to every billing cadence PriceCard can render.
const GLASS_SERVICE_DAY_LINES = {
  lawn_care: 'That’s about {amount}/day — a fraction of what re-sodding costs, for turf that’s handled all year.',
  mosquito: 'That’s about {amount}/day — less than a can of repellent, for a backyard you actually get to use.',
  tree_shrub: 'That’s about {amount}/day — less than replacing one dead shrub, to keep the whole landscape thriving.',
  termite_bait: 'That’s about {amount}/day — pennies next to what termite damage costs to repair, for protection that never clocks out.',
  palm_injection: 'That’s about {amount}/day — less than one replacement palm, to keep the ones you have healthy.',
  rodent_bait: 'That’s about {amount}/day for round-the-clock rodent monitoring.',
  foam_recurring: 'That’s about {amount}/day for targeted termite treatment that keeps the pressure down.',
};

const DAY_LINE_CADENCE_KEYS = ['quarterly', 'bi_monthly', 'monthly'];

// Day-line pack for a price section. Pest keeps its cadence-matched trio;
// other services expand their single line across the cadence keys; unknown
// keys return null so PriceCard falls back to the server-provided wording.
export function glassDayLinesFor(sectionServiceKey) {
  if (sectionServiceKey === 'pest_control') return GLASS_DAY_LINES;
  const line = GLASS_SERVICE_DAY_LINES[sectionServiceKey];
  if (!line) return null;
  return Object.fromEntries(DAY_LINE_CADENCE_KEYS.map((key) => [key, line]));
}

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
