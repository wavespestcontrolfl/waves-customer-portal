// ============================================================
// estimate-kb.js — Knowledge base for the customer-facing
// AI chatbot embedded in the estimate view.
//
// Pricing values are NOT hardcoded here — they are derived at
// module load from server/services/pricing-engine/constants.js
// so the KB can never drift from what the engine actually quotes.
//
// Free-text service descriptions live in the SERVICE_DETAILS
// object in client/src/pages/EstimateViewPage.jsx. Rather than
// duplicating ~400 lines of marketing copy here, the chatbot
// loads that object on demand (see tools layer).
//
// TODO(waves): the sections marked `NEEDS_WAVES_INPUT` are gaps
// where the authoritative answer is not in the repo. Do not
// guess — ask Waves and fill in before shipping.
// ============================================================

const {
  WAVEGUARD,
  MOSQUITO,
  LAWN_TIERS,
  LAWN_BRACKETS,
  TREE_SHRUB,
  PALM,
  TERMITE,
  PEST,
  ZONES,
} = require('../../pricing-engine/constants');

// ── WaveGuard bundle explained for customers ──────────────────
const waveguard = {
  summary:
    'WaveGuard is our membership program. The more recurring services you bundle, the bigger your monthly discount.',
  tiers: [
    { name: 'Bronze',   minServices: WAVEGUARD.tiers.bronze.minServices,   discountPct: WAVEGUARD.tiers.bronze.discount   * 100 },
    { name: 'Silver',   minServices: WAVEGUARD.tiers.silver.minServices,   discountPct: WAVEGUARD.tiers.silver.discount   * 100 },
    { name: 'Gold',     minServices: WAVEGUARD.tiers.gold.minServices,     discountPct: WAVEGUARD.tiers.gold.discount     * 100 },
    { name: 'Platinum', minServices: WAVEGUARD.tiers.platinum.minServices, discountPct: WAVEGUARD.tiers.platinum.discount * 100 },
  ],
  qualifyingServices: WAVEGUARD.qualifyingServices,
  notes: [
    'Palm injection and rodent control do not qualify for tier upgrades — they have their own flat member perks instead.',
    'WaveGuard members get 15% off any one-time service (excludes Bora-Care and pre-slab Termidor).',
    'Gold and Platinum members get a $10/palm/year credit on palm injection treatments.',
    'Rodent bait-station customers get a $50 setup credit when they are WaveGuard members.',
  ],
};

// ── Lawn care tracks ──────────────────────────────────────────
const lawnCare = {
  tracks: Object.keys(LAWN_BRACKETS),
  tiers: Object.entries(LAWN_TIERS).map(([key, v]) => ({
    key,
    visitsPerYear: v.freq,
  })),
  note:
    'Lawn pricing is bracket-based by grass type (St. Augustine, Bermuda, Zoysia, Bahia) and turf square footage. The chatbot should NEVER quote a price outside the customer\'s own estimate — defer to the line item on their estimate.',
};

// ── Mosquito tiers ────────────────────────────────────────────
const mosquito = {
  lotCategories: MOSQUITO.lotCategories.map((l) => ({ key: l.key, label: l.label })),
  visitsByTier: MOSQUITO.tierVisits, // { bronze: 12, silver: 12, gold: 15, platinum: 17 }
  peakSeason: 'April through October',
  note:
    'Higher WaveGuard tiers add more mosquito visits per year (Bronze/Silver: 12/yr, Gold: 15/yr, Platinum: 17/yr) — not a price cut, more actual visits.',
};

// ── Tree & shrub ──────────────────────────────────────────────
const treeShrub = {
  tiers: Object.entries(TREE_SHRUB.tiers).map(([key, v]) => ({
    key, visitsPerYear: v.freq, label: v.label,
  })),
};

// ── Palm injection ────────────────────────────────────────────
const palm = {
  treatmentTypes: Object.entries(PALM.treatmentTypes).map(([key, v]) => ({
    key, label: v.label, appsPerYear: v.appsPerYear, quoteBased: !!v.quoteBased,
  })),
  memberCredit: `$${PALM.flatCreditPerPalm}/palm/year for ${PALM.flatCreditMinTier.charAt(0).toUpperCase() + PALM.flatCreditMinTier.slice(1)}+ WaveGuard members`,
};

// ── Termite (with gaps flagged) ───────────────────────────────
const termite = {
  systemsOffered: Object.entries(TERMITE.systems).map(([key, v]) => ({
    key, label: v.label,
  })),
  stationSpacing: `Approximately every ${TERMITE.stationSpacing} feet, minimum ${TERMITE.minStations} stations`,
  monitoringTiers: Object.entries(TERMITE.monitoring).map(([key, v]) => ({
    key, label: v.label, monthlyPrice: v.monthly,
  })),

  // Species coverage (documented in SERVICE_DETAILS.termite sections 8)
  speciesCovered: {
    subterranean: ['Eastern subterranean', 'Formosan subterranean'],
    premierAlsoCovers: ['Drywood termites', 'Powderpost beetles', 'Old house borers'],
  },

  warranty: {
    maxCoverage: '$500,000 per occurrence',
    retreatments: 'Unlimited at no additional cost',
    terms: ['1 year', '5 years', '10 years'],
    transferable: true,
    // NEEDS_WAVES_INPUT: exact price difference between 1/5/10 year warranty terms
    termPricingNote: 'TODO: pricing differential between 1-yr vs 5-yr vs 10-yr warranty terms',
  },

  // NEEDS_WAVES_INPUT — these are the gaps the chatbot will get
  // asked about but the repo does not have authoritative answers
  gaps: {
    activeIngredient:
      'TODO: disclose bait matrix active ingredient name (IGR class) for pet/kid safety Q&A',
    petSafety:
      'TODO: approved talking points for "is the bait safe for pets/children?" — stations are tamper-resistant but the full safety message needs Waves sign-off',
    drywoodStandalone:
      'TODO: do we offer drywood-only treatments outside the premier warranty tier? (fumigation / localized)',
  },
};

// ── Pest control ──────────────────────────────────────────────
const pestControl = {
  frequencies: Object.keys(PEST.frequencies), // ['quarterly', 'bimonthly', 'monthly']
  targetPestCount: '75+ common household pests',
  initialFee: `Initial WaveGuard membership fee of $${PEST.initialFee} (waived with annual prepay)`,
};

// ── Service area ──────────────────────────────────────────────
const serviceArea = {
  zones: Object.entries(ZONES)
    .filter(([k]) => k !== 'UNKNOWN')
    .map(([key, v]) => ({ key, name: v.name })),
  primaryCounties: ['Manatee', 'Sarasota', 'Charlotte'], // per CLAUDE.md
};

// ── Company facts ─────────────────────────────────────────────
// NEEDS_WAVES_INPUT for most of these — the chatbot will get
// asked factual questions that aren't in the repo.
const company = {
  name: 'Waves Pest Control & Lawn Care',
  ownerOperator: 'Waves', // per CLAUDE.md
  familyOwned: true,
  region: 'Southwest Florida',

  // NEEDS_WAVES_INPUT
  licensing: {
    floridaPCO: 'TODO: Florida pest control operator license number',
    floridaLawn: 'TODO: FL Department of Agriculture lawn/ornamental license number',
    insurance: 'TODO: general liability policy limits for customer reassurance',
  },

  contact: {
    officePhone: '(941) 318-7612', // from server/routes/estimate-public.js WAVES_OFFICE_PHONE
    website: 'https://www.wavespestcontrol.com',
    // NEEDS_WAVES_INPUT
    hours: 'TODO: confirm office hours Waves wants the chatbot to state',
    emergencyAfterHours: 'TODO: after-hours policy for active infestations / emergencies',
  },
};

// ── Guarantee ─────────────────────────────────────────────────
// The live guarantee text comes from the offer_packages table
// (see server/routes/estimate-public.js:72). The pageData passed
// to the chatbot already includes `guaranteeText` — prefer that
// over this static fallback.
const guarantee = {
  defaultText:
    "100% Satisfaction Guarantee — If you're not completely satisfied after your first service, we'll re-treat for free or refund your money. No questions asked.",
  source: 'offer_packages table → pageData.guaranteeText',
};

// ── FAQ — common customer questions ───────────────────────────
// Kept minimal and factual. Anything requiring a judgment call
// (scheduling, custom quotes, safety claims) is explicitly
// routed back to the office instead of answered by the bot.
const faq = [
  {
    q: 'What is WaveGuard?',
    a: 'WaveGuard is our membership program. You bundle 1–4+ recurring services (pest, lawn, tree & shrub, mosquito, termite baiting) and save 0–20% off monthly — Bronze, Silver, Gold, Platinum.',
  },
  {
    q: 'Is the bait/spray safe for my pets and kids?',
    a: 'NEEDS_WAVES_INPUT — defer to office.',
  },
  {
    q: 'Can I change my service frequency later?',
    a: 'Yes. Frequency changes, tier upgrades/downgrades, and service additions are handled by our office team — text or call and we\'ll update your plan.',
  },
  {
    q: 'When will my first service be scheduled?',
    a: 'Scheduling happens after you accept your estimate. You\'ll get a booking link by text; the office will confirm your first visit within one business day.',
  },
  {
    q: 'What if I\'m not satisfied?',
    a: '100% Satisfaction Guarantee — we\'ll re-treat for free or refund your money. (See guarantee shown on your estimate for exact terms.)',
  },
];

// ── Safety rails for the chatbot ──────────────────────────────
// Referenced by the system prompt. DO NOT let the model answer
// these — always route to office.
const doNotAnswer = [
  'Pricing for services not on this customer\'s estimate',
  'Specific appointment times or technician ETAs',
  'Medical advice about pesticide exposure',
  'Promises about pest elimination timelines',
  'Claims about products being "safe" without Waves-approved language',
];

module.exports = {
  waveguard,
  lawnCare,
  mosquito,
  treeShrub,
  palm,
  termite,
  pestControl,
  serviceArea,
  company,
  guarantee,
  faq,
  doNotAnswer,
};
