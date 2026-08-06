// ============================================================
// public-ranges.js — Agent-readable public price ranges
// ============================================================
// Computes a per-service low/high price range by sweeping the live
// pricing engine across realistic residential inputs. Consumed by
// GET /api/public/pricing-ranges (and, from there, the Astro build's
// /pricing.md agent-readable surface).
//
// Ranges are DERIVED, never hand-typed: the engine constants this module
// reads are synced from the DB-authoritative pricing_config by db-bridge,
// so a pricing change in /admin propagates here without a code change.
// Owner ruling 2026-08-06: publish ranges for ALL residential services;
// per-property exact quotes stay behind the quote calculator.
//
// Copy rules enforced here (owner directives):
// - unit is "per application", never "per visit" — the only per-month
//   units are services that genuinely bill monthly.
// - no combined per-month or per-year program totals.
// - commercial is custom-quoted and excluded from the sweep.
const constants = require('./constants');
const sp = require('./service-pricing');

const FOOTPRINTS_SQFT = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 6000];
const LOTS_SQFT = [5000, 8000, 12000, 20000, 30000];
const LAWNS_SQFT = [2000, 4000, 6000, 8000, 12000, 16000, 20000];

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null;
let cacheAt = 0;

function sweepValues(inputs, fn, pick) {
  const values = [];
  for (const input of inputs) {
    const result = fn(input);
    const picked = pick(result, input);
    if (Array.isArray(picked)) values.push(...picked);
    else values.push(picked);
  }
  return values.filter((v) => Number.isFinite(v) && v > 0);
}

function rangeRow({ key, name, unit, values, notes = null, decimals = 0 }) {
  if (!values.length) throw new Error(`No priced values for ${key}`);
  const round = (v) => (decimals ? Math.round(v * 10 ** decimals) / 10 ** decimals : Math.round(v));
  return { key, name, unit, low: round(Math.min(...values)), high: round(Math.max(...values)), notes };
}

function buildRows() {
  const rows = [];
  const errors = [];
  const add = (key, build) => {
    try {
      rows.push(build());
    } catch (err) {
      errors.push({ key, message: err.message });
    }
  };

  add('general_pest_quarterly', () => rangeRow({
    key: 'general_pest_quarterly',
    name: 'General Pest Control (WaveGuard quarterly)',
    unit: 'per application',
    values: sweepValues(FOOTPRINTS_SQFT,
      (f) => sp.pricePestControl({ footprint: f }, { frequency: 'quarterly' }),
      (r) => r.perApp),
    notes: `One-time initial service fee $${Math.round(constants.PEST.initialFee)}. Bi-monthly and monthly cadences also available.`,
  }));

  add('german_roach_cleanout', () => rangeRow({
    key: 'german_roach_cleanout',
    name: 'German Roach Cleanout',
    unit: 'per program',
    values: sweepValues(
      ['light', 'moderate', 'heavy'].flatMap((severity) => FOOTPRINTS_SQFT.map((f) => ({ f, severity }))),
      ({ f, severity }) => sp.priceGermanRoach({ footprint: f }, { severity }),
      (r) => r.total ?? r.price),
    notes: 'Multi-visit program; visits vary by severity.',
  }));

  add('bed_bug_treatment', () => rangeRow({
    key: 'bed_bug_treatment',
    name: 'Bed Bug Treatment (chemical)',
    unit: 'per treatment program',
    values: sweepValues(
      [1, 2, 3, 4].flatMap((rooms) =>
        ['light', 'moderate', 'heavy'].flatMap((severity) =>
          Object.keys(constants.BED_BUG.prepStatus).map((prepStatus) => ({ rooms, severity, prepStatus })))),
      ({ rooms, severity, prepStatus }) => sp.priceBedBugTreatment(
        { footprint: 2000, stories: 1 },
        { rooms, method: 'CHEMICAL', severity, prepStatus, occupancyType: 'singleFamily' }),
      (r) => r.total ?? r.price),
    notes: '1-4 rooms. Heat and hybrid treatments are custom-quoted after inspection.',
  }));

  add('mosquito_program', () => rangeRow({
    key: 'mosquito_program',
    name: 'Mosquito Program',
    unit: 'per application',
    values: sweepValues(LOTS_SQFT,
      (lotSqFt) => sp.priceMosquito({ footprint: 2000, lotSqFt }, {}),
      (r) => (r.tiers || []).map((t) => t.perVisit)),
    notes: 'Seasonal (9 applications/yr) or monthly (12 applications/yr) program.',
  }));

  add('wasp_hornet_removal', () => rangeRow({
    key: 'wasp_hornet_removal',
    name: 'Wasp / Hornet Nest Removal',
    unit: 'per job',
    values: [
      sp.calculateStingingPrice({ footprint: 2500 }, {}).price,
      ...(constants.SPECIALTY.wasp.tiers || []).filter(Number.isFinite),
    ].filter((v) => Number.isFinite(v) && v > 0),
    notes: 'Height, aggressiveness, and confined-space add-ons priced separately. Free with an active recurring pest plan where eligible.',
  }));

  add('flea_elimination', () => rangeRow({
    key: 'flea_elimination',
    name: 'Flea Elimination (2-visit package)',
    unit: 'per package',
    values: sweepValues(FOOTPRINTS_SQFT, (f) => sp.priceFlea({ footprint: f }), (r) => r.total),
  }));

  add('rodent_bait_program', () => rangeRow({
    key: 'rodent_bait_program',
    name: 'Rodent Bait Station Program',
    unit: 'per month',
    values: sweepValues(
      LOTS_SQFT.flatMap((lot) => FOOTPRINTS_SQFT.map((f) => ({ f, lot }))),
      ({ f, lot }) => sp.priceRodentBait({ footprint: f, lotSqFt: lot, features: {} }, {}),
      (r) => r.monthly),
    notes: 'Monthly-billed monitoring program with quarterly service visits.',
  }));

  add('rodent_trapping', () => rangeRow({
    key: 'rodent_trapping',
    name: 'Rodent Trapping',
    unit: 'per program',
    values: sweepValues(['standard', 'unlimited'], (plan) => sp.priceRodentTrapping({}, { plan }), (r) => r.price),
    notes: 'Standard (setup + 2 included callbacks) or unlimited-callback plan.',
  }));

  add('rodent_sanitation', () => rangeRow({
    key: 'rodent_sanitation',
    name: 'Rodent Sanitation',
    unit: 'per job',
    values: sweepValues(
      Object.keys(constants.RODENT.sanitation)
        .filter((tier) => constants.RODENT.sanitation[tier] && typeof constants.RODENT.sanitation[tier] === 'object' && 'base' in constants.RODENT.sanitation[tier])
        .flatMap((tier) => [250, 500, 1000, 1500].map((affectedSqFt) => ({ tier, affectedSqFt }))),
      ({ tier, affectedSqFt }) => sp.priceSanitation({ tier, affectedSqFt }),
      (r) => r.price),
  }));

  add('rodent_exclusion', () => rangeRow({
    key: 'rodent_exclusion',
    name: 'Rodent Exclusion',
    unit: 'per job',
    values: sweepValues(
      [0, 5, 10, 20].flatMap((pts) => [0, 20, 50].map((lf) => ({ pts, lf }))),
      ({ pts, lf }) => sp.priceRodentExclusionV2({ standardWireMeshPoints: pts, meshSoftLF: lf }),
      (r) => r.total ?? r.price),
    notes: 'Includes the rodent inspection fee. Scope set by inspection findings.',
  }));

  add('termite_bait_install', () => rangeRow({
    key: 'termite_bait_install',
    name: 'Termite Bait System Installation (Trelona)',
    unit: 'per installation',
    values: sweepValues(FOOTPRINTS_SQFT, (f) => sp.priceTermiteBait({ footprint: f }, {}), (r) => r.installation && r.installation.price),
  }));

  add('termite_bait_monitoring', () => rangeRow({
    key: 'termite_bait_monitoring',
    name: 'Termite Bait Monitoring',
    unit: 'per month',
    values: sweepValues(FOOTPRINTS_SQFT, (f) => sp.priceTermiteBait({ footprint: f }, {}), (r) => r.monthly),
    notes: 'Monthly-billed monitoring with quarterly station checks.',
  }));

  add('termite_bond', () => rangeRow({
    key: 'termite_bond',
    name: 'Termite Bond',
    unit: 'per year',
    values: sweepValues(Object.keys(constants.TERMITE.bond), (term) => sp.priceTermiteBond(term), (r) => r.annual),
    notes: '1, 5, and 10-year terms.',
  }));

  add('termite_trenching', () => rangeRow({
    key: 'termite_trenching',
    name: 'Termite Trenching (liquid barrier)',
    unit: 'per job',
    values: sweepValues([150, 200, 250, 300, 400],
      (perimeterLF) => sp.priceTrenching({ footprint: 2500 }, { perimeterLF, concretePct: 0.2, labelConfirmed: true }),
      (r) => r.price),
    notes: 'Scales with treated perimeter; exact footage measured on site.',
  }));

  add('pre_slab_termiticide', () => rangeRow({
    key: 'pre_slab_termiticide',
    name: 'Pre-Slab Termiticide Treatment',
    unit: 'per job',
    values: sweepValues([500, 1000, 2000, 3000, 4000],
      (slabSqFt) => sp.pricePreSlabTermiticide({ slabSqFt }, { labelConfirmed: true }),
      (r) => r.price ?? r.treatmentPrice),
    notes: 'New-construction slab pre-treatment; volume discounts available.',
  }));

  add('wdo_inspection', () => rangeRow({
    key: 'wdo_inspection',
    name: 'WDO Inspection',
    unit: 'per inspection',
    values: sweepValues([1000, 2000, 3000, 4000, 6000], (f) => sp.priceWDO(f), (r) => r.price),
    notes: 'Wood-destroying organism inspection with official FDACS report.',
  }));

  add('lawn_care_program', () => rangeRow({
    key: 'lawn_care_program',
    name: 'Lawn Care Program',
    unit: 'per application',
    values: sweepValues(
      LAWNS_SQFT.flatMap((sq) => ['standard', 'enhanced', 'premium'].map((tier) => ({ sq, tier }))),
      ({ sq, tier }) => sp.priceLawnCare({ lawnSqFt: sq }, { track: 'st_augustine', tier }),
      (r) => r.perApp),
    notes: '6x, 9x, or 12x applications per year by tier; priced by treatable turf area.',
  }));

  add('one_time_lawn', () => rangeRow({
    key: 'one_time_lawn',
    name: 'One-Time Lawn Treatment',
    unit: 'per treatment',
    values: sweepValues(
      LAWNS_SQFT.flatMap((sq) => ['weed', 'fungus', 'insect', 'fertilizer'].map((treatmentType) => ({ sq, treatmentType }))),
      ({ sq, treatmentType }) => sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType }),
      (r) => r.price),
  }));

  add('dethatching', () => rangeRow({
    key: 'dethatching',
    name: 'Lawn Dethatching',
    unit: 'per job',
    values: sweepValues(LAWNS_SQFT,
      (sq) => sp.priceDethatching(sq, { grassType: 'st_augustine', thatchDepthInches: 1 }),
      (r) => r.price ?? r.estimatedPrice),
    notes: 'Debris removal add-ons priced separately.',
  }));

  add('lawn_plugging', () => rangeRow({
    key: 'lawn_plugging',
    name: 'Lawn Plugging',
    unit: 'per sq ft',
    decimals: 2,
    values: sweepValues([6, 9, 12], (spacing) => sp.pricePlugging(1000, spacing), (r) => r.perSf),
    notes: 'Rate depends on plug spacing (6", 9", or 12").',
  }));

  add('top_dressing', () => rangeRow({
    key: 'top_dressing',
    name: 'Lawn Top Dressing',
    unit: 'per job',
    values: sweepValues(
      LAWNS_SQFT.flatMap((sq) => ['eighth', 'quarter'].map((depth) => ({ sq, depth }))),
      ({ sq, depth }) => sp.priceTopDressing(sq, depth, false),
      (r) => r.price),
  }));

  add('tree_shrub_care', () => rangeRow({
    key: 'tree_shrub_care',
    name: 'Tree & Shrub Care Program',
    unit: 'per month',
    values: sweepValues(
      LOTS_SQFT.flatMap((lot) => ['light', 'standard', 'enhanced'].map((tier) => ({ lot, tier }))),
      ({ lot, tier }) => sp.priceTreeShrub({ footprint: 2000, lotSqFt: lot }, { tier }),
      (r) => r.monthly),
    notes: 'Monthly-billed program; visits every other month.',
  }));

  add('palm_injection', () => rangeRow({
    key: 'palm_injection',
    name: 'Palm Injection',
    unit: 'per palm, per treatment',
    values: sweepValues(
      [
        ...['small', 'medium', 'large'].flatMap((palmSize) => [
          { treatmentType: 'insecticide', palmSize },
          { treatmentType: 'combo', palmSize },
        ]),
        { treatmentType: 'nutrition' },
        { treatmentType: 'treeAge', dbhInches: 8 },
        { treatmentType: 'treeAge', dbhInches: 16 },
      ].flatMap((opts) => [1, 5, 10].map((palmCount) => ({ ...opts, palmCount }))),
      (opts) => sp.pricePalmInjection({}, opts),
      (r) => r.pricePerPalm),
    notes: 'Nutrition, insecticide, combo, and TREE-age treatments. Fungal and lethal-bronzing work is diagnosed and quoted on site.',
  }));

  return { rows, errors };
}

function computePublicPricingRanges({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) return cache;
  const { rows, errors } = buildRows();
  cache = {
    generatedAt: new Date(now).toISOString(),
    currency: 'USD',
    disclaimer: 'Typical ranges for residential properties in our SW Florida service area. Your exact price depends on property size and conditions — get an instant quote at https://www.wavespestcontrol.com/pest-control-calculator/. Commercial properties are custom-quoted.',
    services: rows,
    errors,
  };
  cacheAt = now;
  return cache;
}

module.exports = { computePublicPricingRanges, _internals: { buildRows, CACHE_TTL_MS } };
