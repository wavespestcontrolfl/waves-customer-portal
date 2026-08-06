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

  // Bare and complex residential profiles — the pest pricer adds charges for
  // heavy shrubs/trees, complex landscaping, indoor treatment, pool cages,
  // attached garages, and home-age adjustments, all valid auto-priced inputs.
  const PEST_PROFILES = [
    { property: {}, options: {} },
    {
      property: { features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex', indoor: true, poolCage: true, poolCageSize: 'large' } },
      options: { modifiers: { pestAgeAdj: 10 } },
    },
  ];
  add('general_pest_quarterly', () => rangeRow({
    key: 'general_pest_quarterly',
    name: 'General Pest Control (WaveGuard recurring)',
    unit: 'per application',
    // Sweep every supported cadence via the engine's tiers array — monthly
    // per-application prices sit below quarterly, so quarterly-only would
    // overstate the low end of an advertised option.
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) => PEST_PROFILES.map((p) => ({ f, p }))),
      ({ f, p }) => sp.pricePestControl({ footprint: f, ...p.property }, { frequency: 'quarterly', ...p.options }),
      (r) => (r.tiers || []).map((t) => t.perApp)),
    notes: `Quarterly, bi-monthly, or monthly cadence; priced by home size, landscaping, and property features. One-time initial service fee $${Math.round(constants.PEST.initialFee)}.`,
  }));

  add('cockroach_treatment', () => rangeRow({
    key: 'cockroach_treatment',
    name: 'Cockroach Treatment (native / palmetto)',
    unit: 'per treatment',
    values: sweepValues(FOOTPRINTS_SQFT,
      (f) => sp.pricePestInitialRoach({ footprint: f }, { roachType: 'regular', standalone: true }),
      (r) => r.price),
    notes: 'Standalone treatment for SWFL native roaches; German roach infestations use the cleanout program.',
  }));

  add('one_time_pest', () => rangeRow({
    key: 'one_time_pest',
    name: 'One-Time Pest Treatment',
    unit: 'per treatment',
    // Derives from the quarterly baseline, so it sweeps the same profiles.
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) => PEST_PROFILES.map((p) => ({ f, p }))),
      ({ f, p }) => sp.priceOneTimePest({ footprint: f, ...p.property }, { ...p.options }),
      (r) => r.price),
    notes: 'Single knockdown visit; recurring plans price lower per application.',
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
    // Footprint and story count carry ordinary size/story multipliers on
    // auto-priced homes — not custom-quote territory — so both are swept.
    values: sweepValues(
      [1500, 2200, 3000, 4000].flatMap((footprint) =>
        [1, 2, 3].flatMap((stories) =>
          [1, 2, 3, 4].flatMap((rooms) =>
            ['light', 'moderate', 'heavy'].flatMap((severity) =>
              Object.keys(constants.BED_BUG.prepStatus).map((prepStatus) => ({ footprint, stories, rooms, severity, prepStatus })))))),
      ({ footprint, stories, rooms, severity, prepStatus }) => sp.priceBedBugTreatment(
        { footprint, stories },
        { rooms, method: 'CHEMICAL', severity, prepStatus, occupancyType: 'singleFamily' }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.total ?? r.price))),
    notes: '1-4 rooms; priced by rooms, severity, home size, and stories. Heat and hybrid treatments are custom-quoted after inspection.',
  }));

  // Low- and high-pressure residential feature sets — the pricer's pressure
  // multiplier (trees, landscaping complexity, pool, nearby water,
  // irrigation) raises per-application prices well above a bare-lot sweep.
  const MOSQUITO_PROFILES = [
    { features: {}, options: {} },
    // Waterfront worst case: binary features plus the graduated water
    // modifier the live estimate path forwards — reaches the pricer's
    // pressure cap, which a feature-only profile cannot.
    {
      features: { trees: 'heavy', complexity: 'complex', pool: true, nearWater: true, irrigation: true },
      options: { modifiers: { mosquitoWaterMult: 2.0 } },
    },
  ];
  add('mosquito_program', () => rangeRow({
    key: 'mosquito_program',
    name: 'Mosquito Program',
    unit: 'per application',
    values: sweepValues(
      LOTS_SQFT.flatMap((lotSqFt) => MOSQUITO_PROFILES.map((p) => ({ lotSqFt, p }))),
      ({ lotSqFt, p }) => sp.priceMosquito({ footprint: 2000, lotSqFt, features: p.features }, p.options),
      (r) => (r.tiers || []).map((t) => t.perVisit)),
    notes: 'Seasonal (9 applications/yr) or monthly (12 applications/yr) program; priced by treatable area and mosquito pressure.',
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

  // Base, worst-case (heavy infestation, dense landscaping, priced exterior
  // add-on), and recurring-customer (discounted low) flea profiles — all
  // auto-priced by the live estimate path.
  const FLEA_PROFILES = [
    {},
    {
      infestationComplexity: 'heavy',
      features: { trees: 'heavy', complexity: 'complex' },
      fleaExterior: true,
      fleaExteriorAreaSqFt: 4000,
    },
    { isRecurringCustomer: true },
  ];
  add('flea_elimination', () => rangeRow({
    key: 'flea_elimination',
    name: 'Flea Elimination (2-visit package)',
    unit: 'per package',
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) => FLEA_PROFILES.map((p) => ({ f, p }))),
      ({ f, p }) => sp.priceFlea({ footprint: f, ...p }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.total)),
    notes: 'Priced by home size, infestation severity, and optional exterior treatment area.',
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
    // Affected area × debris removal × access type — the live path passes
    // insulationRemovalCuFt and heavy-tier crawlspace/tight access, all
    // directly priced.
    values: sweepValues(
      Object.keys(constants.RODENT.sanitation)
        .filter((tier) => constants.RODENT.sanitation[tier] && typeof constants.RODENT.sanitation[tier] === 'object' && 'base' in constants.RODENT.sanitation[tier])
        .flatMap((tier) => [250, 500, 1000, 1500].flatMap((affectedSqFt) =>
          [0, 50].flatMap((insulationRemovalCuFt) =>
            ['normal', 'crawlspace', 'tight'].map((accessType) => ({ tier, affectedSqFt, insulationRemovalCuFt, accessType }))))),
      ({ tier, affectedSqFt, insulationRemovalCuFt, accessType }) =>
        sp.priceSanitation({ tier, affectedSqFt, insulationRemovalCuFt, accessType }),
      (r) => (r.customQuoteRecommended ? NaN : r.price)),
    notes: 'Priced by affected area, debris removal volume, and access.',
  }));

  add('rodent_exclusion', () => rangeRow({
    key: 'rodent_exclusion',
    name: 'Rodent Exclusion',
    unit: 'per job',
    // Every component type the exact estimate path forwards: standard and
    // advanced wire-mesh points, bird boxes (incl. tile-high), soft and
    // concrete linear mesh.
    values: sweepValues(
      [
        { standardWireMeshPoints: 0 },
        { standardWireMeshPoints: 5, meshSoftLF: 20 },
        { standardWireMeshPoints: 10, meshSoftLF: 50 },
        { standardWireMeshPoints: 20, meshSoftLF: 50 },
        { advancedWireMeshPoints: 10, meshConcreteLF: 50 },
        { standardWireMeshPoints: 10, advancedWireMeshPoints: 10, standardBirdBoxes: 2, tileHighBirdBoxes: 2, meshSoftLF: 30, meshConcreteLF: 30 },
      ],
      (opts) => sp.priceRodentExclusionV2(opts),
      (r) => (r.customRecommended || r.requiresCustomQuote ? NaN : (r.total ?? r.price))),
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
    unit: 'per application',
    values: sweepValues(FOOTPRINTS_SQFT, (f) => sp.priceTermiteBait({ footprint: f }, {}), (r) => r.perApp),
    notes: 'Quarterly station-check applications.',
  }));

  // Station rental publishes only while its purchase gate is on — the
  // estimate flow's GATE_TERMITE_STATION_RENTAL is the choke point
  // (predicate mirrors estimate-engine.js). Rental rides the install price,
  // so the sweep derives per-application rental from the bait installs.
  const rentalGateOn = ['1', 'true', 'on'].includes(String(process.env.GATE_TERMITE_STATION_RENTAL || '').toLowerCase());
  if (rentalGateOn) {
    add('termite_station_rental', () => rangeRow({
      key: 'termite_station_rental',
      name: 'Termite Bait Station Rental',
      unit: 'per application',
      values: sweepValues(FOOTPRINTS_SQFT,
        (f) => sp.priceTermiteStationRental(sp.priceTermiteBait({ footprint: f }, {}).installation?.price),
        (r) => r && r.perApp),
      notes: 'Rented-station alternative to the upfront installation; rides quarterly applications.',
    }));
  }

  // Bond pricing publishes only while the purchase path exists: the estimate
  // flow's GATE_TERMITE_BOND_OPTION is the single choke point (predicate
  // mirrors estimate-engine.js), and advertising an option the exact-quote
  // flow refuses to offer would mislead agents.
  const bondGateOn = ['1', 'true', 'on'].includes(String(process.env.GATE_TERMITE_BOND_OPTION || '').toLowerCase());
  if (bondGateOn) {
    add('termite_bond', () => rangeRow({
      key: 'termite_bond',
      name: 'Termite Bond',
      unit: 'per application',
      values: sweepValues(Object.keys(constants.TERMITE.bond), (term) => sp.priceTermiteBond(term), (r) => r.perApp),
      notes: 'Rides quarterly service applications; 1, 5, and 10-year terms.',
    }));
  }

  add('bora_care', () => rangeRow({
    key: 'bora_care',
    name: 'Bora-Care Wood Treatment',
    unit: 'per job',
    values: sweepValues(
      [
        { atticSqFt: 500 }, { atticSqFt: 1000 }, { atticSqFt: 2000 },
        { surfaceLinearFt: 50, surfaceHeightFt: 2 }, { surfaceLinearFt: 150, surfaceHeightFt: 4 },
      ],
      (opts) => sp.priceBoraCare({ footprint: 2500 }, opts),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.price)),
    notes: 'Borate treatment for exposed wood; priced by treated attic or surface area.',
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
    // Through the full auto-priced residential span — the public quote route
    // accepts slab measurements well past 4,000 sq ft with no quote boundary.
    values: sweepValues([500, 1000, 2000, 4000, 6000, 8000, 12000, 20000],
      (slabSqFt) => sp.pricePreSlabTermiticide({ slabSqFt }, { labelConfirmed: true }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.price ?? r.treatmentPrice))),
    notes: 'New-construction slab pre-treatment; priced by slab area, volume discounts available.',
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
      LAWNS_SQFT.flatMap((sq) =>
        Object.keys(constants.LAWN_BRACKETS).flatMap((track) =>
          ['standard', 'enhanced', 'premium'].map((tier) => ({ sq, track, tier })))),
      ({ sq, track, tier }) => sp.priceLawnCare({ lawnSqFt: sq }, { track, tier }),
      (r) => r.perApp),
    notes: '6x, 9x, or 12x applications per year by tier; priced by grass type and treatable turf area.',
  }));

  add('one_time_lawn', () => rangeRow({
    key: 'one_time_lawn',
    name: 'One-Time Lawn Treatment',
    unit: 'per treatment',
    // Track and tier feed the recurring baseline this pricer derives from,
    // so both are swept alongside treatment type.
    values: sweepValues(
      LAWNS_SQFT.flatMap((sq) =>
        ['weed', 'fungicide', 'pest', 'fert'].flatMap((treatmentType) =>
          Object.keys(constants.LAWN_BRACKETS).flatMap((track) =>
            ['standard', 'enhanced', 'premium'].map((tier) => ({ sq, treatmentType, track, tier }))))),
      ({ sq, treatmentType, track, tier }) => sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType, track, tier }),
      (r) => r.price),
    notes: 'Priced by treatment type, grass type, and turf area.',
  }));

  // Dethatching is deliberately NOT published: priceDethatching returns
  // quoteRequired/manual-review for every residential input, so the engine
  // refuses to auto-quote it — publishing a range would contradict the
  // authoritative quote path. It stays in the custom-quoted bucket.

  add('one_time_mosquito', () => rangeRow({
    key: 'one_time_mosquito',
    name: 'One-Time Mosquito Treatment',
    unit: 'per treatment',
    values: sweepValues(LOTS_SQFT,
      (lotSqFt) => sp.priceOneTimeMosquito({ footprint: 2000, lotSqFt }, {}),
      (r) => r.price),
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
    // Both pricing modes: estimated area (65% reduction) and exact-area
    // (measured, or recurring-lawn customers) — the live estimate path uses
    // exact-area for measured jobs, which prices above the estimated mode.
    values: sweepValues(
      LAWNS_SQFT.flatMap((sq) =>
        ['eighth', 'quarter'].flatMap((depth) => [false, true].map((exactArea) => ({ sq, depth, exactArea })))),
      ({ sq, depth, exactArea }) => sp.priceTopDressing(sq, depth, exactArea),
      (r) => r.price),
  }));

  // Auto-priced residential shapes only: bare lots plus planted/treed
  // properties (bed area + tree count + access) that stay below the pricer's
  // manual-review thresholds; reviewed results are excluded.
  const TREE_SHRUB_PROFILES = [
    { property: { footprint: 2000 }, options: {} },
    { property: { footprint: 2000, bedArea: 4000 }, options: { treeCount: 6, access: 'moderate' } },
    { property: { footprint: 2000, bedArea: 7900 }, options: { treeCount: 14, access: 'moderate' } },
  ];
  add('tree_shrub_care', () => rangeRow({
    key: 'tree_shrub_care',
    name: 'Tree & Shrub Care Program',
    unit: 'per month',
    values: sweepValues(
      LOTS_SQFT.flatMap((lot) =>
        ['light', 'standard', 'enhanced'].flatMap((tier) =>
          TREE_SHRUB_PROFILES.map((p) => ({ lot, tier, p })))),
      ({ lot, tier, p }) => sp.priceTreeShrub({ ...p.property, lotSqFt: lot }, { ...p.options, tier }),
      (r) => (r.requiresManualReview ? NaN : r.monthly)),
    notes: 'Monthly-billed program; 4, 6, or 9 applications per year by tier; priced by planting beds and tree count.',
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
        // 20" is the largest auto-priced Tree-Age tier; bigger palms are quote-based.
        { treatmentType: 'treeAge', dbhInches: 20 },
      ].flatMap((opts) => [1, 5, 10].map((palmCount) => ({ ...opts, palmCount }))),
      (opts) => sp.pricePalmInjection({}, opts),
      (r) => r.pricePerPalm),
    notes: 'Nutrition, insecticide, combo, and TREE-age treatments. Fungal and lethal-bronzing work is diagnosed and quoted on site.',
  }));

  return { rows, errors };
}

// No in-process cache: the sweep is a few ms of pure constants reads, and any
// memoization here would keep serving pre-edit ranges after an admin pricing
// sync (the route re-syncs constants per request; the HTTP Cache-Control is
// the one explicit, bounded staleness window).
function computePublicPricingRanges() {
  const { rows, errors } = buildRows();
  return {
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    disclaimer: 'Typical ranges for residential properties in our SW Florida service area. Your exact price depends on property size and conditions — get an instant quote at https://www.wavespestcontrol.com/pest-control-calculator/. Commercial properties are custom-quoted.',
    services: rows,
    errors,
  };
}

module.exports = { computePublicPricingRanges, _internals: { buildRows } };
