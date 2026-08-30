'use strict';

/**
 * Retention card template registry (rebuttals scope §4 + §8 R3).
 *
 * The rule the whole layer hangs on: NO runtime AI phrasing. Every card a
 * customer can see is one of these fixed templates with typed slots; a slot
 * that fails validation DROPS the card (resolve.js moves to the next
 * candidate), it never falls back to prose. Only facts already on file fill
 * slots — a real visit count, a real report finding, a real invoice figure.
 *
 * Copy rules baked in: "our owner", never a name; "EPA-registered", never
 * "-approved"; never "safe"; no emojis; money is never the first card.
 *
 * `action` is what accepting the card does. It is a description the
 * commit path interprets (C1) — the engine never performs it.
 */

const RETENTION_OFFER = Object.freeze({ percentOff: 15, charges: 2, capAmount: 75 });

const FAMILY_LABELS = Object.freeze({
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  tree_shrub: 'Tree & Shrub',
  mosquito: 'Mosquito',
  termite_bait: 'Termite Bait',
});

function familyLabel(key) {
  return FAMILY_LABELS[key] || null;
}

// --- slot validators ------------------------------------------------------
// Each returns the normalized value or undefined (= invalid, drop the card).
const v = {
  posInt: (x) => (Number.isInteger(x) && x > 0 ? x : undefined),
  nonNegInt: (x) => (Number.isInteger(x) && x >= 0 ? x : undefined),
  money: (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
  },
  text: (max) => (x) => {
    const s = String(x == null ? '' : x).trim();
    return s.length > 0 && s.length <= max ? s : undefined;
  },
  family: (x) => (FAMILY_LABELS[x] ? FAMILY_LABELS[x] : undefined),
  isoDate: (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : undefined),
};

function money(n) {
  return `$${Number(n).toFixed(2).replace(/\.00$/, '')}`;
}

const OFFER_LINE =
  `Stay and take ${RETENTION_OFFER.percentOff}% off your next ${RETENTION_OFFER.charges === 2 ? 'two' : RETENTION_OFFER.charges} charges for {family}` +
  ' — nothing else changes, no term, and you can still cancel any time.';

const TEMPLATES = Object.freeze([
  // ---- price --------------------------------------------------------------
  {
    id: 'price_receipt_offer',
    reason: 'price',
    headline: 'What your plan has actually done this year',
    body:
      'This year: {visits} visits, {callbacks} callbacks at no charge, and {savings} saved by WaveGuard on your invoices. ' +
      OFFER_LINE,
    slots: { visits: v.posInt, callbacks: v.nonNegInt, savings: v.money, family: v.family },
    action: { type: 'retention_offer', ...RETENTION_OFFER },
  },
  {
    id: 'price_receipt',
    reason: 'price',
    headline: 'What your plan has actually done this year',
    body: 'This year: {visits} visits, {callbacks} callbacks at no charge, and {savings} saved by WaveGuard on your invoices.',
    slots: { visits: v.posInt, callbacks: v.nonNegInt, savings: v.money },
    action: { type: 'none' },
  },
  {
    id: 'price_offer',
    reason: 'price',
    headline: 'One offer, no strings',
    body: OFFER_LINE,
    slots: { family: v.family },
    action: { type: 'retention_offer', ...RETENTION_OFFER },
  },

  // ---- results_pest -------------------------------------------------------
  {
    id: 'results_pest_fix_finding',
    reason: 'results_pest',
    headline: 'Let us fix it at no charge',
    body:
      'Your last report noted: {finding}. Our owner will come back at no charge, treat inside and out, and follow up in two weeks. ' +
      'If it is not better, cancel then.',
    slots: { finding: v.text(160) },
    action: { type: 'book_reservice', lane: 'pest' },
  },
  {
    id: 'results_pest_program_change',
    reason: 'results_pest',
    headline: 'The program is wrong, not you',
    body:
      '{callbacks} callbacks for the same problem means the program needs to change. ' +
      'We are switching the product and adding a follow-up visit at no cost.',
    slots: { callbacks: v.posInt },
    action: { type: 'book_reservice', lane: 'pest', programChange: true },
  },
  {
    id: 'results_pest_fix',
    reason: 'results_pest',
    headline: 'Let us fix it at no charge',
    body: 'Our owner will come back at no charge, treat inside and out, and follow up in two weeks. If it is not better, cancel then.',
    slots: {},
    action: { type: 'book_reservice', lane: 'pest' },
  },

  // ---- results_lawn -------------------------------------------------------
  {
    id: 'results_lawn_agronomy',
    reason: 'results_lawn',
    headline: 'The cause is on your reports',
    body:
      'Your recent reports flag: {finding}. No treatment can outrun that. Our owner will reset the plan on a no-charge visit and text you the exact watering schedule.',
    slots: { finding: v.text(160) },
    action: { type: 'book_reservice', lane: 'lawn' },
  },
  {
    id: 'results_lawn_two_seasons',
    reason: 'results_lawn',
    headline: 'Lawn recovery is a two-season job',
    body: 'You are {visits} visits in. Lawn recovery takes two seasons; your report photos show where it started. We will come out at no charge, treat what is not responding, and you decide after.',
    slots: { visits: v.posInt },
    action: { type: 'book_reservice', lane: 'lawn' },
  },
  {
    id: 'results_lawn_fix',
    reason: 'results_lawn',
    headline: 'Free corrective visit',
    body: 'We will come out at no charge, treat what is not responding, and you decide after.',
    slots: {},
    action: { type: 'book_reservice', lane: 'lawn' },
  },

  // ---- service_experience -------------------------------------------------
  {
    id: 'service_experience_known',
    reason: 'service_experience',
    headline: 'We already know, and we are sorry',
    body: 'We saw your message on {date}: "{quote}". That is not how we operate. Our owner will call you personally before your next visit.',
    slots: { date: v.isoDate, quote: v.text(140) },
    action: { type: 'owner_call' },
  },
  {
    id: 'service_experience_owner_call',
    reason: 'service_experience',
    headline: 'Our owner will call you',
    body: 'That is not how we operate. Our owner will call you personally before your next visit.',
    slots: {},
    action: { type: 'owner_call' },
  },

  // ---- away (the ONLY place pause appears) --------------------------------
  {
    id: 'away_pairing',
    reason: 'away',
    headline: 'Away Mode on pest, hold on lawn',
    body:
      'Away Mode keeps the outside of the house treated while you are gone — nobody needs to be home, reports land in your inbox. ' +
      'Lawn and mosquito go on hold: no visits, no charges, and both switch back the day you land. Your prices stay locked.',
    slots: {},
    action: { type: 'away_pairing', holdMaxDays: 180 },
  },
  {
    id: 'away_mode_pest',
    reason: 'away',
    headline: 'Keep the house protected while you are gone',
    body: 'Away Mode: we keep treating the outside while you are away — nobody needs to be home, reports land in your inbox. Price and WaveGuard level unchanged.',
    slots: {},
    action: { type: 'away_mode' },
  },
  {
    id: 'away_hold',
    reason: 'away',
    headline: 'On hold until you are back',
    body: 'No visits, no charges, we restart on the date you pick (up to six months). We text you seven days before the restart. Your other prices stay locked.',
    slots: {},
    action: { type: 'hold', holdMaxDays: 180 },
  },

  // ---- scheduling_access_communication ------------------------------------
  {
    id: 'scheduling_we_noticed',
    reason: 'scheduling_access_communication',
    headline: 'That is on us',
    body: 'You have had to move us {reschedules} times. Tell us the day and window that work, give us the gate code once, and we build the route around it. One text the day before, one report after — that is it.',
    slots: { reschedules: v.posInt },
    action: { type: 'set_preferences' },
  },
  {
    id: 'scheduling_set_once',
    reason: 'scheduling_access_communication',
    headline: 'Set it once',
    body: 'Pick your days and time window and give us the gate code once — it sticks. One text the day before, one report after; nothing else.',
    slots: {},
    action: { type: 'set_preferences' },
  },

  // ---- moving_or_property_change ------------------------------------------
  {
    id: 'moving_transfer',
    reason: 'moving_or_property_change',
    headline: 'Take WaveGuard with you',
    body: 'Your history and your WaveGuard level come along, with no setup fee at the new place. We price the new property and show you before anything changes. Last visit here, first visit there, no gap and no double charge.',
    slots: {},
    action: { type: 'transfer_request' },
  },

  // ---- no_longer_needed ---------------------------------------------------
  {
    id: 'no_longer_needed_history',
    reason: 'no_longer_needed',
    headline: 'No bugs is the plan working',
    body: 'Your first report found: {finding}. Regular visits are what has held that back — most Florida homes that stop are back to square one by summer. Cancel now and restart any time with no setup fee.',
    slots: { finding: v.text(160) },
    action: { type: 'restart_note' },
  },
  {
    id: 'no_longer_needed_note',
    reason: 'no_longer_needed',
    headline: 'No bugs is the plan working',
    body: 'Regular visits are what keeps it that way — most Florida homes that stop are back to square one by summer. Cancel now and restart any time with no setup fee.',
    slots: {},
    action: { type: 'restart_note' },
  },

  // ---- service_mix --------------------------------------------------------
  {
    id: 'service_mix_configure',
    reason: 'service_mix',
    headline: 'Keep what you value',
    body: 'Keep some services and drop the rest — we show the WaveGuard level and your new price for each combination before anything changes.',
    slots: {},
    action: { type: 'configure_services' },
  },

  // ---- diy ----------------------------------------------------------------
  {
    id: 'diy_offer',
    reason: 'diy',
    headline: 'What the store cannot sell you',
    body:
      'Over-the-counter sprays repel; ours do not, so the colony carries it home. That is the difference between fewer bugs and no bugs. ' +
      OFFER_LINE,
    slots: { family: v.family },
    action: { type: 'retention_offer', ...RETENTION_OFFER },
  },
  {
    id: 'diy_nonrepellent',
    reason: 'diy',
    headline: 'What the store cannot sell you',
    body: 'Over-the-counter sprays repel; ours do not, so the colony carries it home. That is the difference between fewer bugs and no bugs. Restart any time with no setup fee.',
    slots: {},
    action: { type: 'restart_note' },
  },

  // ---- competitor ---------------------------------------------------------
  {
    id: 'competitor_quote',
    reason: 'competitor',
    headline: 'Bring the quote',
    body: 'We have never had contracts or cancellation fees. Send us their quote and our owner will read it line by line against what you have now — if they are offering something we are not, we would rather add it than lose you.',
    slots: {},
    action: { type: 'owner_text' },
  },
  {
    id: 'competitor_history',
    reason: 'competitor',
    headline: 'What you would start over',
    body: 'You have {visits} visits of history, photos and reports here, and callbacks at no charge already earned. If they are offering something we are not, tell us — we would rather add it than lose you.',
    slots: { visits: v.posInt },
    action: { type: 'owner_text' },
  },

  // ---- hoa_or_landlord ----------------------------------------------------
  {
    id: 'hoa_check_coverage',
    reason: 'hoa_or_landlord',
    headline: 'Check what they actually cover',
    body: 'HOA contracts usually cover common areas and the exterior perimeter, not inside your home or your lawn. Want to keep just the part they do not? Restart any time either way, no setup fee.',
    slots: {},
    action: { type: 'configure_services' },
  },

  // ---- financial_hardship (no hardship hold — §8 R6) -----------------------
  {
    id: 'hardship_owner_text',
    reason: 'financial_hardship',
    headline: 'Our owner would rather work something out',
    body: 'You have been with us {years} years. Our owner would rather work something out than lose you — want a text from him?',
    slots: { years: v.posInt },
    action: { type: 'owner_text' },
  },
  {
    id: 'hardship_reduce',
    reason: 'financial_hardship',
    headline: 'Keep the one that protects the house',
    body: 'Drop everything but exterior pest control for now — the one service that protects the structure — and restart the rest when you are ready, no setup fee.',
    slots: {},
    action: { type: 'configure_services', suggest: ['pest_control'] },
  },

  // ---- health_or_chemicals (concern, not event) ---------------------------
  {
    id: 'health_exterior_baits',
    reason: 'health_or_chemicals',
    headline: 'No interior spray, same coverage',
    body: 'We can switch you to exterior-only treatment with bait stations inside — no interior spray. Everything we use is EPA-registered and applied per label; we send you the product list for your home and the re-entry guidance. Want our owner to call and walk through exactly what is applied and where?',
    slots: {},
    action: { type: 'owner_call', configure: 'exterior_baits' },
  },

  // ---- other --------------------------------------------------------------
  {
    id: 'other_receipt',
    reason: 'other',
    headline: 'What your plan has actually done this year',
    body: 'This year: {visits} visits, {callbacks} callbacks at no charge, and {savings} saved by WaveGuard on your invoices. If something is not working, tell us and we fix it first.',
    slots: { visits: v.posInt, callbacks: v.nonNegInt, savings: v.money },
    action: { type: 'none' },
  },
  {
    id: 'other_owner_text',
    reason: 'other',
    headline: 'Talk to our owner first',
    body: 'Before this closes, our owner would like to hear what is not working — want a text from him?',
    slots: {},
    action: { type: 'owner_text' },
  },
]);

const BY_ID = new Map(TEMPLATES.map((t) => [t.id, t]));

function getTemplate(id) {
  return BY_ID.get(id) || null;
}

/**
 * Validate every slot the template declares against `values` and render the
 * body. Returns null when ANY declared slot is missing or invalid — the
 * caller drops the card. Extra keys in `values` are ignored.
 */
function renderTemplate(template, values = {}) {
  const slots = {};
  for (const [name, validate] of Object.entries(template.slots || {})) {
    const ok = validate(values[name]);
    if (ok === undefined) return null;
    slots[name] = ok;
  }
  const body = template.body.replace(/\{(\w+)\}/g, (m, name) => {
    if (!(name in slots)) return m;
    const val = slots[name];
    if (name === 'savings') return money(val);
    return String(val);
  });
  // Any unreplaced token means the template declares a slot it forgot to
  // list — fail closed rather than show "{visits}" to a customer.
  if (/\{\w+\}/.test(body)) return null;
  return { templateId: template.id, headline: template.headline, body, slots, action: { ...template.action } };
}

module.exports = {
  RETENTION_OFFER,
  FAMILY_LABELS,
  TEMPLATES,
  familyLabel,
  getTemplate,
  renderTemplate,
};
