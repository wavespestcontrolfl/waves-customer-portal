/**
 * Lawn expectations table (lawn report rebuild, P10). Ships DARK: nothing
 * reads this file in customer output yet (P14 wires the writer, P16 routes the
 * deterministic copy). Pure data, no I/O.
 *
 * Source of the rows: scope appendix fable-plan-review.md section (B) and the
 * W5 draft rows. EVERY row ships `approved: false`. A row only reaches a
 * customer after the owner signs its windows, which is a one-line flip of
 * `approved` here (the engine withholds unapproved rows unless a test or
 * preview asks for them explicitly).
 *
 * Rules that bind this file (owner rulings 2026-09-28 / 09-29):
 *  - Product rows are keyed by the EXACT catalog product name (pest
 *    precedent: pest-report-expectations.js PRODUCT_EXPECTATION_CLASS).
 *    Never inferred from active ingredient, category or formulation. A name
 *    that is not in PRODUCT_CLASS gets NO line (fail closed). A name mapped
 *    to `null` is a recorded decision to say nothing.
 *  - Every window carries `source`: 'proposed' (a default awaiting owner
 *    sign-off) or 'catalog' (the number is quoted from a species-catalog
 *    recovery_note; `catalogQuote` holds the verbatim note so a test can prove
 *    it still exists).
 *  - Short-lived products (iron, potassium) are `transient`: they can never
 *    yield a "behind" progress state.
 *  - Customer lines say nothing about watering, rain, sprinklers, mowing,
 *    clock times, brands, rates, plan tiers, or any county ordinance,
 *    blackout or law. Lines never depend on a plan tier or lawn program: the
 *    only inputs are the applied product, tagged targets, named issues and
 *    the visit gap.
 *  - Each customer line is at most 33 words.
 */

const ENGINE_VERSION = 'lawn_expectations_v1';

// Celsius WG label/protocol cap: 3 applications per property per year
// (server/config/protocols.json lawn notes, "CELSIUS CAP"). The caller passes
// the year-to-date count INCLUDING any application on this visit; at the cap
// the second-application line swaps to the "different product" line.
const CELSIUS_YTD_CAP = 3;

const MAX_LINE_WORDS = 33;

// ── Product name -> family ────────────────────────────────────────────────
// Value is { family, modeLock? }, or null for an explicit "no line" decision.
// Names are the catalog's own `products_catalog.name` strings as seeded by the
// migrations (a test cross-checks each key against the migration sources) plus
// the short display spellings the completion card writes into
// service_products.product_name. Matching is case-insensitive on the whole
// trimmed name, never a prefix or substring.
const FAMILY = {
  BROADLEAF: 'herbicide_broadleaf',
  SEDGE: 'herbicide_sedge',
  PRE_EMERGENT: 'pre_emergent',
  GRANULAR_N: 'granular_fertilizer',
  POTASSIUM: 'potassium_feed',
  IRON_MICROS: 'iron_micros',
  FUNGICIDE: 'fungicide',
  INSECTICIDE: 'insecticide',
};

const PRODUCT_CLASS_ENTRIES = [
  // Post-emergent broadleaf herbicide, spray
  ['Celsius WG', FAMILY.BROADLEAF],
  ['SpeedZone Southern', FAMILY.BROADLEAF],
  ['SpeedZone Southern EW', FAMILY.BROADLEAF],
  ['LESCO Three-Way Selective Herbicide', FAMILY.BROADLEAF],
  ['Atrazine 4L', FAMILY.BROADLEAF],

  // Sedge herbicide
  ['SedgeHammer Plus', FAMILY.SEDGE],
  ['Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide', FAMILY.SEDGE],
  ['Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide', FAMILY.SEDGE],
  ['Dismiss', FAMILY.SEDGE],
  ['Dismiss 64 oz', FAMILY.SEDGE],
  ['Dismiss NXT', FAMILY.SEDGE],

  // Pre-emergent (judged by absence)
  ['Prodiamine 65 WDG', FAMILY.PRE_EMERGENT],
  ['Barricade 65WG', FAMILY.PRE_EMERGENT],
  ['Barricade 4FL', FAMILY.PRE_EMERGENT],
  ['LESCO Stonewall 4FL', FAMILY.PRE_EMERGENT],

  // Granular slow-release nitrogen
  ['LESCO 24-0-11', FAMILY.GRANULAR_N],
  ['LESCO 24-0-11 with PolyPlus OPTI', FAMILY.GRANULAR_N],
  ['LESCO 24-2-11', FAMILY.GRANULAR_N],
  ['LESCO 24-2-11 50% NOS Plus BIO 6% Fe', FAMILY.GRANULAR_N],

  // Potassium feed (transient, never "behind")
  ['K-Flow 0-0-25', FAMILY.POTASSIUM],
  ['LESCO K-Flow 0-0-25', FAMILY.POTASSIUM],
  ['LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', FAMILY.POTASSIUM],
  ['LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer', FAMILY.POTASSIUM],
  ['LESCO 0-0-18 Bio KMAG', FAMILY.POTASSIUM],
  ['LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer', FAMILY.POTASSIUM],
  ['LESCO Elite 0-0-28', FAMILY.POTASSIUM],
  ['LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer', FAMILY.POTASSIUM],

  // Iron / micronutrient foliar (transient, never "behind")
  ['Chelated AM + Micros', FAMILY.IRON_MICROS],
  ['LESCO Chelated AM + Micros', FAMILY.IRON_MICROS],
  ['LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient', FAMILY.IRON_MICROS],
  ['Chelated Iron Plus', FAMILY.IRON_MICROS],
  ['LESCO Chelated Iron Plus', FAMILY.IRON_MICROS],
  ['LESCO Chelated Iron Plus 12-0-0', FAMILY.IRON_MICROS],
  ['LESCO 12-0-0 Chelated Iron Plus', FAMILY.IRON_MICROS],
  ['High Manganese Combo', FAMILY.IRON_MICROS],
  ['LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer', FAMILY.IRON_MICROS],
  ['LESCO High Manganese Combo Chelated Micronutrients AM 1% Mg 5.75% S 3% Fe 4% Mn Micronutrient Liquid Soil Amendment', FAMILY.IRON_MICROS],

  // Fungicide (curative needs a tagged target or a named issue, else preventive)
  ['Artavia 2 SC', FAMILY.FUNGICIDE],
  ['Artavia 2 SC (Azoxy)', FAMILY.FUNGICIDE],
  ['LESCO T-Storm Fungicide', FAMILY.FUNGICIDE],
  ['LESCO T-Storm 2G Fungicide', FAMILY.FUNGICIDE],
  ['LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide', FAMILY.FUNGICIDE],
  ['Torque SC', FAMILY.FUNGICIDE],
  ['Medallion SC', FAMILY.FUNGICIDE],
  ['Headway G', FAMILY.FUNGICIDE],
  ['Headway Fungicide', FAMILY.FUNGICIDE],

  // Insecticide (curative needs a tagged target or a named issue, else preventive)
  ['Atticus Talak', FAMILY.INSECTICIDE],
  ['Atticus Talak 7.9 F', FAMILY.INSECTICIDE],
  ['Talak 7.9 F', FAMILY.INSECTICIDE],
  ['Arena 50 WDG', FAMILY.INSECTICIDE],
  // Acelepryn is a preventive grub/caterpillar product: never curative.
  ['Acelepryn Xtra', FAMILY.INSECTICIDE, { modeLock: 'preventive' }],
  ['Acelepryn Insecticide', FAMILY.INSECTICIDE, { modeLock: 'preventive' }],

  // Explicit "no line" decisions. Each is a decision, not an omission.
  // Adjuvants and wetting agents: no result to describe.
  ['LESCO 90/10 Nonionic Surfactant', null],
  ['Dispatch Sprayable Wetting Agent', null],
  // Growth regulator: its only honest line is mowing advice, which is out.
  ['Primo Maxx', null],
  ['Primo Maxx Plant Growth Regulator for Turf', null],
  // Soil support: gradual, no claim the owner has approved.
  ['LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment', null],
  ['Hydretain Liquid Humectant', null],
  ['LESCO Moisture Manager', null],
  // Calcium feed and other herbicides not in the owner table.
  ['LESCO Green Flo 6-0-0 10% Ca', null],
  ['Drive XLR8 Post Emergent Liquid Herbicide', null],
  ['Tenacity Herbicide', null],
  ['Certainty Turf Herbicide', null],
  ['Blindside Herbicide', null],
];

function normalizeProductName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toLowerCase();
}

const PRODUCT_CLASS = new Map(
  PRODUCT_CLASS_ENTRIES.map(([name, family, opts]) => [
    normalizeProductName(name),
    family ? { family, modeLock: opts?.modeLock || null } : null,
  ]),
);

// ── Rows ──────────────────────────────────────────────────────────────────
// A window is { minDays, maxDays, source, ... }. minDays/maxDays are null for
// a qualitative window ("over several weeks") that carries `text` instead.
const proposed = (minDays, maxDays, extra = {}) => ({ minDays, maxDays, source: 'proposed', ...extra });
const catalog = (minDays, maxDays, catalogRef, extra = {}) => ({
  minDays, maxDays, source: 'catalog', catalogRef, ...extra,
});

// A progress window for ONE metric. mode 'gain': the score is expected to
// rise, so "behind" needs no gain by closeDays. mode 'hold': the score is
// expected to stop falling, so "behind" needs a drop of a full band still
// happening at closeDays. A metric with no entry in a row's metricWindows is
// never judged, and no verdict is "behind" before closeDays passes.
const judged = (mode, extra = {}) => ({
  mode, fullMinDays: null, source: 'proposed', ...extra,
});

// `byNextVisit` keys: too_early (the next visit lands before the first
// visible change), partial (some change, the full result not yet), visible
// (inside the full window), complete (past the full window), absence (rows
// judged by the absence of a problem). The engine falls back from a missing
// state to the nearest defined one.
const PRODUCT_ROWS = {
  herbicide_broadleaf: {
    id: 'herbicide_broadleaf',
    family: FAMILY.BROADLEAF,
    mode: null,
    appliesTo: 'selective weed control',
    metric: 'weed_suppression',
    metricWindows: {
      weed_suppression: judged('gain', { startDays: 3, fullMinDays: 14, closeDays: 21 }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: proposed(3, 7),
      full: proposed(14, 21),
    },
    visibleChange: 'Weeds usually start to yellow or curl within about 3 to 7 days, then brown and die back over about 2 to 3 weeks.',
    limits: [],
    secondApp: {
      possible: true,
      line: 'Larger or deeper-rooted weeds can need a second application at a later visit.',
      cappedLine: 'A different weed-control product may be used at a later visit if weeds remain.',
      cappedBy: 'celsius',
      cap: CELSIUS_YTD_CAP,
    },
    byNextVisit: {
      too_early: 'Weeds usually take about a week to show a change, so your next visit is early for a final read.',
      partial: 'By your next visit, treated weeds should be yellowing or curling, with browning still to come.',
      visible: 'By your next visit, most treated weeds should be browning or fading.',
      complete: 'By your next visit, most treated weeds should be brown or fading. Any still green then get a second look.',
    },
    contactTrigger: 'If treated weeds are still fully green after about 3 weeks, let us know.',
  },

  herbicide_sedge: {
    id: 'herbicide_sedge',
    family: FAMILY.SEDGE,
    mode: null,
    appliesTo: 'sedge control',
    metric: 'weed_suppression',
    metricWindows: {
      weed_suppression: judged('gain', { startDays: 7, fullMinDays: 21, closeDays: 28, needsLabelCheck: true }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: proposed(7, 14, { needsLabelCheck: true }),
      full: proposed(21, 28, { needsLabelCheck: true }),
    },
    visibleChange: 'Sedge usually yellows within about 1 to 2 weeks and browns down over about 3 to 4 weeks.',
    limits: ['It regrows from underground tubers, so repeat treatment is common.'],
    secondApp: null,
    byNextVisit: {
      too_early: 'Sedge usually takes 1 to 2 weeks to show a change, so your next visit is early for a final read.',
      partial: 'By your next visit, treated sedge should be yellowing, with browning still to come.',
      visible: 'By your next visit, treated sedge should be browning down.',
      complete: 'By your next visit, treated sedge should be brown. Regrowth from the tubers is common, and a repeat treatment is expected.',
    },
    contactTrigger: 'If sedge is still fully green after about 4 weeks, let us know.',
  },

  pre_emergent: {
    id: 'pre_emergent',
    family: FAMILY.PRE_EMERGENT,
    mode: null,
    appliesTo: 'weed prevention',
    metric: 'weed_suppression',
    transient: false,
    judgedByAbsence: true,
    approved: false,
    windows: { first: null, full: null },
    visibleChange: 'There is nothing to see today. Success looks like the weeds that never sprout over the coming weeks and months.',
    limits: ['A few weeds can still break through where the barrier was disturbed or where they were already growing.'],
    secondApp: null,
    byNextVisit: {
      absence: 'By your next visit there is usually little to see. Success is weeds that never sprouted.',
    },
    contactTrigger: 'If a new flush of weeds appears across the lawn within about 4 to 8 weeks, let us know.',
    contactWindow: proposed(28, 56),
  },

  granular_fertilizer: {
    id: 'granular_fertilizer',
    family: FAMILY.GRANULAR_N,
    mode: null,
    appliesTo: 'slow-release feed',
    metric: 'color_health',
    metricWindows: {
      // Color and density are separate metrics with separate windows: color
      // judged against 7-21 days, density only against 60-90 days.
      color_health: judged('gain', { startDays: 7, fullMinDays: 14, closeDays: 21 }),
      turf_density: judged('gain', { startDays: 60, fullMinDays: 60, closeDays: 90, existingPromptTiming: true }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: proposed(7, 14),
      // Same numbers the existing diagnostic prompt carries (2-3 weeks
      // color); not a catalog quote, so still 'proposed'.
      full: proposed(14, 21, { existingPromptTiming: true }),
    },
    visibleChange: 'Greening usually starts in about 7 to 14 days and builds as the feed releases. Color comes first and thickening takes longer.',
    limits: ['Thickening can take about 60 to 90 days.'],
    secondApp: null,
    byNextVisit: {
      too_early: 'Greening usually starts in about 1 to 2 weeks, so your next visit is early for a first read.',
      partial: 'By your next visit, greening should be starting. Thickening takes longer.',
      visible: 'By your next visit, color should be building. Thickening takes longer.',
      complete: 'By your next visit, color should be up. Thickening takes longer.',
    },
    contactTrigger: 'If there is no green-up after about 3 weeks in growing weather, let us know.',
  },

  potassium_feed: {
    id: 'potassium_feed',
    family: FAMILY.POTASSIUM,
    mode: null,
    appliesTo: 'potassium feed',
    metric: 'color_health',
    transient: true,
    judgedByAbsence: true,
    approved: false,
    windows: { first: null, full: null },
    visibleChange: 'This feed supports the lawn through heat and dry spells, so a quick color change is not the goal.',
    limits: ['Its effect shows over the coming weeks as the lawn holds its color under stress.'],
    secondApp: null,
    byNextVisit: {
      absence: 'By your next visit, color should look about like today or hold up better under stress. It is not expected to jump.',
    },
    contactTrigger: 'If color drops sharply with no clear heat, drought or disease cause, let us know.',
  },

  iron_micros: {
    id: 'iron_micros',
    family: FAMILY.IRON_MICROS,
    mode: null,
    appliesTo: 'iron and micronutrient spray',
    metric: 'color_health',
    transient: true,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: proposed(3, 5),
      full: null,
    },
    visibleChange: 'Color often deepens within about 3 to 5 days. That lift can fade as new growth comes in.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      too_early: 'Color often deepens within about 3 to 5 days, so your next visit is early for a read.',
      visible: 'By your next visit, color should be about like today. The lift from this spray is short-lived.',
    },
    contactTrigger: 'If there is no color change after about 7 days in clear photos, let us know.',
  },

  fungicide_curative: {
    id: 'fungicide_curative',
    family: FAMILY.FUNGICIDE,
    mode: 'curative',
    appliesTo: 'disease control',
    metric: 'stress_damage',
    metricWindows: {
      // Spread stopping (a score that stops falling), NOT regrowth: regrowth
      // takes 2 to 4 weeks (large patch: weeks to months) and is not judged.
      stress_damage: judged('hold', { startDays: 3, closeDays: 10 }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      // Catalog wording is "within days" and "weeks to months"; the numeric
      // bounds below are proposed (owner brief: spread slows in days, new
      // leaves in 2 to 4 weeks).
      first: proposed(3, 7, { catalogPhrase: 'within days' }),
      full: proposed(14, 28),
    },
    visibleChange: 'This treatment often slows the spread of the disease within days.',
    limits: ['Brown grass does not turn green again. New leaves have to grow in, which usually takes about 2 to 4 weeks.'],
    secondApp: null,
    byNextVisit: {
      too_early: 'Spread often slows within days, so your next visit is early for a read on the full result.',
      partial: 'By your next visit, patch edges should be holding steady, with new growth still filling in.',
      visible: 'By your next visit, patch edges should be steady and new leaves should be growing in.',
      complete: 'By your next visit, patch edges should be steady and regrowth should be under way.',
    },
    contactTrigger: 'If a patch is still growing after about 7 to 10 days, let us know.',
    // Owner 09-29: when the longer catalog window for a named large patch
    // conflicts with the 2 to 4 week default, the longer window wins.
    issueOverrides: {
      large_patch: {
        limits: ['Brown grass does not turn green again. Browned turf regrows over weeks to months as conditions improve.'],
        windows: {
          full: catalog(null, null, 'large-patch', { text: 'weeks to months' }),
        },
        byNextVisit: {
          too_early: 'Spread often slows within days, so your next visit is early for a read on regrowth.',
          partial: 'By your next visit, the patch edge should be steady, with regrowth still under way over weeks to months.',
        },
      },
    },
  },

  fungicide_preventive: {
    id: 'fungicide_preventive',
    family: FAMILY.FUNGICIDE,
    mode: 'preventive',
    appliesTo: 'disease prevention',
    metric: 'stress_damage',
    transient: false,
    judgedByAbsence: true,
    approved: false,
    windows: { first: null, full: null },
    visibleChange: 'This is a protective treatment, so nothing changes visibly. It helps protect the turf through wet, humid stretches.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      absence: 'By your next visit, success is no new outbreak through the wet stretch.',
    },
    contactTrigger: 'If a new outbreak appears soon after this treatment, let us know.',
  },

  insecticide_curative: {
    id: 'insecticide_curative',
    family: FAMILY.INSECTICIDE,
    mode: 'curative',
    appliesTo: 'insect control',
    metric: 'stress_damage',
    metricWindows: {
      // Activity stopping (a score that stops falling), NOT fill-in, which
      // takes several weeks and has no number to judge against.
      stress_damage: judged('hold', { startDays: 3, closeDays: 7 }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: proposed(3, 7),
      full: proposed(null, null, { text: 'several weeks' }),
    },
    visibleChange: 'Insect activity usually stops within about 3 to 7 days.',
    limits: [
      'Grass the insects already killed does not turn green again. Healthy runners fill in over several weeks in warm weather.',
      'Badly damaged patches can need new sod.',
    ],
    secondApp: null,
    byNextVisit: {
      too_early: 'Insect activity usually stops within about 3 to 7 days, so your next visit is early for a read.',
      partial: 'By your next visit, insect activity should have stopped and the patch edge should be holding. Fill-in takes several weeks.',
    },
    contactTrigger: 'If a patch is still spreading a week after treatment, let us know.',
  },

  insecticide_preventive: {
    id: 'insecticide_preventive',
    family: FAMILY.INSECTICIDE,
    mode: 'preventive',
    appliesTo: 'insect prevention',
    metric: 'stress_damage',
    transient: false,
    judgedByAbsence: true,
    approved: false,
    windows: { first: null, full: null },
    visibleChange: 'Nothing changes visibly. This works ahead of the pests, so success looks like damage that never shows up.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      absence: 'By your next visit, success is damage that never showed up.',
    },
    contactTrigger: 'If new patches expand along sunny edges, let us know.',
  },
};

// ── Issue rows ────────────────────────────────────────────────────────────
// Keyed by issue key. `catalogQuote` is the verbatim species-catalog
// recovery_note behind a catalog window (a test proves it still exists). The
// customer line is the quote with watering and mowing words removed, because
// the customer copy never carries watering or mowing wording.
const ISSUE_ROWS = {
  dry_spot: {
    id: 'issue_dry_spot',
    issueKey: 'dry_spot',
    kind: 'issue',
    appliesTo: 'dry or uneven area',
    metric: 'color_health',
    metricWindows: {
      color_health: judged('gain', {
        startDays: 0, fullMinDays: 14, closeDays: 21, source: 'catalog', catalogRef: 'drought-irrigation-stress',
      }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: null,
      full: catalog(14, 21, 'drought-irrigation-stress'),
    },
    catalogQuote: 'Color and green-up often follow within 2-3 weeks once watering is corrected.',
    visibleChange: 'Color and green-up often follow within about 2 to 3 weeks once the cause of the dry area is corrected.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      partial: 'Green-up often takes about 2 to 3 weeks, so your next visit is early for a final read on that area.',
      visible: 'By your next visit, the area should match the rest of the lawn. If it does not, we can look at other causes.',
    },
    contactTrigger: 'If there is no response after about 3 weeks, let us know.',
  },

  chinch: {
    id: 'issue_chinch',
    issueKey: 'chinch',
    kind: 'issue',
    appliesTo: 'chinch bug damage',
    metric: 'stress_damage',
    metricWindows: {
      stress_damage: judged('hold', { startDays: 3, closeDays: 7 }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: proposed(3, 7),
      full: proposed(null, null, { text: 'several weeks' }),
    },
    visibleChange: 'Insect activity usually stops within about 3 to 7 days. Fill-in takes several weeks in warm weather.',
    limits: ['Badly damaged patches can need new sod.'],
    secondApp: null,
    byNextVisit: {
      too_early: 'Activity usually stops within about 3 to 7 days, so your next visit is early for a read.',
      partial: 'By your next visit, the edge of the patch should have stopped moving, with fill-in still under way.',
    },
    contactTrigger: 'If the patch keeps spreading after a week, let us know.',
  },

  large_patch: {
    id: 'issue_large_patch',
    issueKey: 'large_patch',
    kind: 'issue',
    appliesTo: 'large patch',
    metric: 'stress_damage',
    metricWindows: {
      // Spread slowing ("within days", catalog) is judged at about a week;
      // regrowth ("weeks to months") has no number and is not judged.
      stress_damage: judged('hold', { startDays: 3, closeDays: 7, catalogPhrase: 'within days' }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: catalog(null, null, 'large-patch', { text: 'within days' }),
      full: catalog(null, null, 'large-patch', { text: 'weeks to months' }),
    },
    catalogQuote: 'Spread often slows within days; browned turf regrows over weeks to months as conditions improve.',
    visibleChange: 'Spread often slows within days, and browned turf regrows over weeks to months as conditions improve.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      partial: 'By your next visit, the edge of the patch should be steady, with regrowth still under way.',
    },
    contactTrigger: 'If the ring is still enlarging after about a week, let us know.',
  },

  thin_shade: {
    id: 'issue_thin_shade',
    issueKey: 'thin_shade',
    kind: 'issue',
    appliesTo: 'thin or shaded turf',
    metric: 'turf_density',
    transient: false,
    judgedByAbsence: false,
    // A site limit, not a failure: never "behind".
    behindEligible: false,
    approved: false,
    windows: {
      first: null,
      full: catalog(60, 90, 'shade-thinning'),
    },
    catalogQuote: 'Density rarely improves without more light; fill-in elsewhere can take 60-90 days once shade is reduced.',
    visibleChange: 'Density rarely improves without more light. Fill-in elsewhere can take about 60 to 90 days once shade is reduced.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      partial: 'Shade is a site condition, so thickness in shaded spots changes slowly. Other areas can fill in over about 60 to 90 days.',
    },
    contactTrigger: null,
  },

  seasonal_dip: {
    id: 'issue_seasonal_dip',
    issueKey: 'seasonal_dip',
    kind: 'issue',
    appliesTo: 'seasonal color dip',
    metric: 'color_health',
    transient: false,
    judgedByAbsence: true,
    behindEligible: false,
    approved: false,
    // Only Nov to Feb, and never for a new or worsening problem.
    months: [11, 12, 1, 2],
    windows: { first: null, full: null },
    visibleChange: 'Color is muted for this cooler stretch and often returns as nights warm.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      absence: 'By your next visit, color should still be muted until nights warm.',
    },
    contactTrigger: null,
  },

  mowed_short: {
    id: 'issue_mowed_short',
    issueKey: 'mowed_short',
    kind: 'issue',
    appliesTo: 'turf cut short',
    metric: 'turf_density',
    metricWindows: {
      // The row's metric is density: judged against the density window
      // (60-90 days), never the 2-3 week color window.
      turf_density: judged('gain', {
        startDays: 60, fullMinDays: 60, closeDays: 90, source: 'catalog', catalogRef: 'mower-scalping',
      }),
      color_health: judged('gain', {
        startDays: 0, fullMinDays: 14, closeDays: 21, source: 'catalog', catalogRef: 'mower-scalping',
      }),
    },
    transient: false,
    judgedByAbsence: false,
    approved: false,
    windows: {
      first: null,
      full: catalog(14, 21, 'mower-scalping'),
    },
    catalogQuote: 'Color often returns within 2-3 weeks; density can take 60-90 days at a corrected mowing height.',
    visibleChange: 'Color often returns within about 2 to 3 weeks, and density can take about 60 to 90 days at a corrected height.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      partial: 'Color often returns within about 2 to 3 weeks, so your next visit is early for a final read.',
      visible: 'By your next visit, color should be back, with density still building.',
    },
    contactTrigger: null,
  },

  weeds_untreated: {
    id: 'issue_weeds_untreated',
    issueKey: 'weeds_untreated',
    kind: 'issue',
    appliesTo: 'weeds seen, none treated today',
    metric: 'weed_suppression',
    transient: false,
    judgedByAbsence: true,
    behindEligible: false,
    approved: false,
    // Only used when no herbicide row applies on this visit.
    onlyWithoutRows: [FAMILY.BROADLEAF, FAMILY.SEDGE],
    windows: { first: null, full: null },
    visibleChange: 'Treatment for the weeds seen is planned for the next visit.',
    limits: [],
    secondApp: null,
    byNextVisit: {
      absence: 'The weeds seen are planned for treatment at your next visit.',
    },
    contactTrigger: null,
  },
};

// Priority when more than one row applies (primary row first).
const ROW_PRIORITY = [
  'herbicide_broadleaf',
  'herbicide_sedge',
  'fungicide_curative',
  'insecticide_curative',
  'granular_fertilizer',
  'iron_micros',
  'potassium_feed',
  'pre_emergent',
  'fungicide_preventive',
  'insecticide_preventive',
  'issue_large_patch',
  'issue_chinch',
  'issue_dry_spot',
  'issue_mowed_short',
  'issue_thin_shade',
  'issue_seasonal_dip',
  'issue_weeds_untreated',
];

// Tech-tagged application targets that make a fungicide or insecticide
// application curative rather than preventive. Matched on the controlled
// target tag text, never on free text.
const CURATIVE_TARGET_PATTERNS = {
  [FAMILY.FUNGICIDE]: /\b(?:large patch|brown patch|take[- ]all|dollar spot|gray leaf spot|fung(?:us|al)|disease|patch(?:es)?|blight)\b/i,
  [FAMILY.INSECTICIDE]: /\b(?:chinch|insects?|bugs?|armyworms?|sod webworms?|mole crickets?|grubs?)\b/i,
};

// Named issues that establish a curative cause for a family even with no
// tagged target on the application.
const CURATIVE_ISSUE_KEYS = {
  [FAMILY.FUNGICIDE]: ['large_patch'],
  [FAMILY.INSECTICIDE]: ['chinch'],
};

module.exports = {
  ENGINE_VERSION,
  CELSIUS_YTD_CAP,
  MAX_LINE_WORDS,
  FAMILY,
  PRODUCT_CLASS,
  PRODUCT_CLASS_ENTRIES,
  PRODUCT_ROWS,
  ISSUE_ROWS,
  ROW_PRIORITY,
  CURATIVE_TARGET_PATTERNS,
  CURATIVE_ISSUE_KEYS,
  normalizeProductName,
};
