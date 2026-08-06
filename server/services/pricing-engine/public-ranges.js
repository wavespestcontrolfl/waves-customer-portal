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
// Confirmed measured turf above the 20,000 sq ft table maximum still
// prices (extrapolated, provenance review only) — sweep through 30,000.
const LAWNS_SQFT = [2000, 4000, 6000, 8000, 12000, 16000, 20000, 30000, 40000];

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

// Engine-wide recurring-customer one-time perk: the discount engine is the
// authority on which service keys are eligible (excluded keys return 0%).
// Rows passing oneTimePerkKey publish the customer-paid floor alongside
// list prices.
function oneTimePerkRate(engineServiceKey) {
  const { getEffectiveDiscount } = require('./discount-engine');
  const d = getEffectiveDiscount(engineServiceKey, 'bronze', { isRecurringCustomer: true, isOneTimeService: true });
  return (d && d.effectiveDiscount) || 0;
}

function rangeRow({ key, name, unit, values, notes = null, decimals = 0, oneTimePerkKey = null }) {
  if (oneTimePerkKey) {
    const rate = oneTimePerkRate(oneTimePerkKey);
    // Perk floors: only pricers WITHOUT internal recurring-customer handling
    // carry a perk key — their lines are discounted at the estimate level
    // with no floor re-check, so the plain multiplication matches the
    // engine-charged amount.
    if (rate) values = values.concat(values.filter((v) => v > 0).map((v) => v * (1 - rate)));
  }
  values = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (!values.length) throw new Error(`No priced values for ${key}`);
  // Round outward (floor the low, ceil the high) so a valid exact engine
  // quote with cents can never fall outside the advertised range.
  const scale = 10 ** decimals;
  return {
    key,
    name,
    unit,
    low: Math.floor(Math.min(...values) * scale) / scale,
    high: Math.ceil(Math.max(...values) * scale) / scale,
    notes,
  };
}

// Customer-PAID recurring values: generateEstimate applies the WaveGuard
// tier discount (up to 20% at platinum) to qualifying recurring lines after
// the whole bundle is known — the individual pricers never see it, so the
// published lows must include these post-discount amounts.
function waveGuardBundleValues() {
  const { generateEstimate } = require('./estimate-engine');
  const out = { pest: [], mosquito: [], treeShrub: [], lawn: [], palm: [] };
  for (const footprint of FOOTPRINTS_SQFT) {
    for (const lotSqFt of [5000, 8000, 20000]) {
      for (const propertyType of ['single_family', 'condo_upper']) {
        for (const frequency of ['quarterly', 'monthly']) {
      // Dimensions are TOP-LEVEL generateEstimate inputs (a nested
      // property object is ignored by the profile builder). Two option
      // sets: defaults, and the cheapest selectable lawn/tree-shrub combo.
      for (const optionSet of [
        { lawnSqFt: 6000, lawn: {}, treeShrub: {} },
        { lawnSqFt: 1500, lawn: { track: 'bahia', tier: 'premium' }, treeShrub: { tier: 'light' } },
      ]) {
      const est = generateEstimate({
        propertyType,
        footprint,
        lotSqFt,
        lawnSqFt: optionSet.lawnSqFt,
        features: { shrubs: 'light', complexity: 'simple' },
        services: { lawn: optionSet.lawn, pest: { frequency }, mosquito: {}, treeShrub: optionSet.treeShrub, termiteBait: {}, palm: { treatmentType: 'nutrition', palmCount: 5 } },
      });
      for (const li of est.lineItems || []) {
        const ratio = li.annualBeforeDiscount > 0 && Number.isFinite(li.annualAfterDiscount)
          ? li.annualAfterDiscount / li.annualBeforeDiscount
          : 1;
        if (li.service === 'pest_control' && Number.isFinite(li.perApp)) out.pest.push(li.perApp * ratio);
        if (li.service === 'lawn_care' && Number.isFinite(li.perApp)) out.lawn.push(li.perApp * ratio);
        if (li.service === 'mosquito' && Number.isFinite(li.visits) && li.visits > 0 && Number.isFinite(li.annualAfterDiscount)) {
          out.mosquito.push(li.annualAfterDiscount / li.visits);
        }
        if (li.service === 'tree_shrub' && Number.isFinite(li.monthlyAfterDiscount)) out.treeShrub.push(li.monthlyAfterDiscount);
        if (li.service === 'palm_injection' && Number.isFinite(li.perVisit) && li.palmCount > 0
          && li.annualBeforeCredits > 0 && Number.isFinite(li.annualAfterCredits)) {
          // perVisit already carries the per-visit minimum; apply the credit
          // ratio to the actually-charged amount, not the raw catalog rate.
          out.palm.push((li.perVisit / li.palmCount) * (li.annualAfterCredits / li.annualBeforeCredits));
        }
      }
        }
      }
      }
    }
  }
  return out;
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
  const visibleLawnTiers = Object.entries(constants.LAWN_TIERS || {})
    .filter(([, t]) => !t.hidden);
  const LAWN_TIER_KEYS = visibleLawnTiers.map(([k]) => k);
  const lawnCadenceText = visibleLawnTiers
    .map(([, t]) => `${t.freq}x`).join(', ')
    .replace(/, ([^,]*)$/, ', or $1');
  const b = constants.RODENT.bundles || {};
  // NOTE: only trapping+sanitation is advertised — the live bundle selector
  // matches service === 'exclusion', which the active V2 exclusion pricer
  // ('rodent_exclusion') never emits, so exclusion-inclusive bundle
  // discounts do not currently apply on exact quotes (engine defect flagged
  // to the owner; widen this note only after the selector is fixed).
  const rodentBundleTerms = `Package discount (live terms): trapping+sanitation ${Math.round(((b.trapSanitation || {}).discount || 0) * 100)}% (floor $${Math.round((b.trapSanitation || {}).floor || 0)}); other combinations are quoted at booking.`;
  const maxWaveGuardPct = Math.round(
    Math.max(...Object.values(constants.WAVEGUARD.tiers).map((t) => t.discount || 0)) * 100);
  let bundleMemo = null;
  const bundle = (key) => {
    if (!bundleMemo) bundleMemo = waveGuardBundleValues();
    return bundleMemo[key] || [];
  };

  // Bare and complex residential profiles — the pest pricer adds charges for
  // heavy shrubs/trees, complex landscaping, indoor treatment, pool cages,
  // attached garages, and home-age adjustments, all valid auto-priced inputs.
  const PEST_PROFILES = [
    { property: {}, options: {} },
    // Light shrubs + simple landscaping subtract from the base price.
    { property: { features: { shrubs: 'light', complexity: 'simple' } }, options: {} },
    {
      property: {
        attachedGarage: true,
        nearWater: true,
        features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex', indoor: true, poolCage: true, poolCageSize: 'oversized', attachedGarage: true, nearWater: true },
      },
      // Pre-1970 homes carry the $20 age adjustment property lookup forwards.
      options: { modifiers: { pestAgeAdj: 20 } },
    },
  ];
  add('general_pest_quarterly', () => rangeRow({
    key: 'general_pest_quarterly',
    name: 'General Pest Control (WaveGuard recurring)',
    unit: 'per application',
    // Sweep every supported cadence via the engine's tiers array — monthly
    // per-application prices sit below quarterly, so quarterly-only would
    // overstate the low end of an advertised option — and every residential
    // property type (condo/townhome adjustments lower the floor).
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) =>
        PEST_PROFILES.flatMap((p) =>
          Object.keys(constants.PROPERTY_TYPE_ADJ).map((propertyType) => ({ f, p, propertyType })))),
      ({ f, p, propertyType }) => sp.pricePestControl({ footprint: f, propertyType, ...p.property }, { frequency: 'quarterly', ...p.options }),
      (r) => (r.tiers || []).map((t) => t.perApp)).concat(bundle('pest')),
    notes: `Quarterly, bi-monthly, or monthly cadence; priced by home size, landscaping, and property features; WaveGuard bundle tiers discount qualifying recurring services up to ${maxWaveGuardPct}%. A one-time $${Math.round(constants.PEST.initialFee)} initial service fee applies to standalone pest service only — waived when bundled with another recurring service or with annual prepay.`,
  }));

  add('cockroach_treatment', () => rangeRow({
    key: 'cockroach_treatment',
    oneTimePerkKey: 'pest_initial_roach',
    name: 'Cockroach Treatment (native / palmetto / German knockdown)',
    unit: 'per treatment',
    // Standalone and recurring-plan-attached knockdowns, regular and German
    // scales — the estimate path adds the non-standalone charge when a
    // recurring plan carries a roach type.
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) =>
        ['regular', 'german'].flatMap((roachType) =>
          [true, false].map((standalone) => ({ f, roachType, standalone })))),
      ({ f, roachType, standalone }) => sp.pricePestInitialRoach({ footprint: f }, { roachType, standalone }),
      (r) => r.price),
    notes: 'Standalone treatment, or added to a recurring plan at a lower rate; multi-visit German infestation cleanouts use the cleanout program.',
  }));

  add('one_time_pest', () => rangeRow({
    key: 'one_time_pest',
    name: 'One-Time Pest Treatment',
    unit: 'per treatment',
    // Derives from the quarterly baseline, so it sweeps the same profiles.
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) =>
        PEST_PROFILES.flatMap((p) =>
          Object.keys(constants.PROPERTY_TYPE_ADJ).flatMap((propertyType) =>
            // The pricer applies the recurring-customer perk INTERNALLY and
            // then reapplies its floor/clamp — never multiply externally.
            [false, true].map((isRecurringCustomer) => ({ f, p, propertyType, isRecurringCustomer }))))),
      ({ f, p, propertyType, isRecurringCustomer }) => sp.priceOneTimePest({ footprint: f, propertyType, ...p.property }, { ...p.options, isRecurringCustomer }),
      (r) => r.price),
    notes: 'Single knockdown visit; recurring plans price lower per application.',
  }));

  add('german_roach_cleanout', () => rangeRow({
    key: 'german_roach_cleanout',
    oneTimePerkKey: 'german_roach',
    name: 'German Roach Cleanout',
    unit: 'per program',
    values: sweepValues(
      ['light', 'moderate', 'heavy'].flatMap((severity) => FOOTPRINTS_SQFT.map((f) => ({ f, severity }))),
      ({ f, severity }) => sp.priceGermanRoach({ footprint: f }, { severity }),
      (r) => r.total ?? r.price),
    notes: 'Multi-visit program; visits vary by severity.',
  }));

  add('german_roach_initial', () => rangeRow({
    key: 'german_roach_initial',
    name: 'German Roach Initial (3-Visit)',
    unit: 'per program',
    // Agent-selectable initial series; the pricer applies the
    // recurring-customer perk INTERNALLY (excluded from the generic pass),
    // so sweep the flag rather than using oneTimePerkKey.
    values: sweepValues([false, true],
      (isRecurringCustomer) => sp.priceGermanRoachInitial({ isRecurringCustomer }),
      (r) => r.price),
    notes: 'One program price covering the 3-visit initial series for German roach activity within a recurring plan; heavy infestations use the cleanout program.',
  }));

  add('bed_bug_treatment', () => rangeRow({
    key: 'bed_bug_treatment',
    oneTimePerkKey: 'bed_bug',
    name: 'Bed Bug Treatment',
    unit: 'per treatment program',
    // Footprint and story count carry ordinary size/story multipliers on
    // auto-priced homes — not custom-quote territory — so both are swept.
    values: sweepValues(
      [1500, 2200, 3000, 4000, 6000, 10000, 15000].flatMap((footprint) =>
        [1, 2, 3].flatMap((stories) =>
          [1, 2, 4, 7, 10].flatMap((rooms) =>
            ['light', 'moderate', 'heavy'].flatMap((severity) =>
              Object.keys(constants.BED_BUG.prepStatus).flatMap((prepStatus) =>
                ['singleFamily', 'apartment'].flatMap((occupancyType) =>
                  // In-house heat/hybrid auto-price for non-severe, prepared
                  // jobs; chemical ignores equipment. Subcontracted equipment
                  // and quote-required combos fall out via the filter.
                  // Method combos restricted to the LIVE allowlist so an
                  // admin-disabled method can't throw the whole row.
                  [
                    { method: 'CHEMICAL' },
                    { method: 'HEAT', equipment: 'INHOUSE', heatScope: 'ROOMS_ONLY' },
                    { method: 'HEAT', equipment: 'INHOUSE', heatScope: 'WHOLE_HOME' },
                    { method: 'HYBRID', equipment: 'INHOUSE', heatScope: 'ROOMS_ONLY' },
                    { method: 'HYBRID', equipment: 'INHOUSE', heatScope: 'WHOLE_HOME' },
                  ].filter((m) => (constants.BED_BUG.allowedMethods || []).includes(m.method))
                    .map((m) => ({ footprint, stories, rooms, severity, prepStatus, occupancyType, ...m })))))))),
      ({ footprint, stories, rooms, severity, prepStatus, occupancyType, method, equipment, heatScope }) => sp.priceBedBugTreatment(
        { footprint, stories },
        { rooms, method, severity, prepStatus, occupancyType, equipment, heatScope }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.total ?? r.price))),
    notes: '1-10 rooms; priced by rooms, severity, home size, stories, occupancy, and method (chemical, or in-house heat/hybrid where eligible) — larger homes extend beyond this range at the same per-sq-ft heat rates. Severe or under-prepared jobs are quoted after inspection.',
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
      // Largest non-review add-on counts, amortized into per-application.
      addOns: { stationCount: 5, dunkCount: 9 },
    },
  ];
  add('mosquito_program', () => rangeRow({
    key: 'mosquito_program',
    name: 'Mosquito Program',
    unit: 'per application',
    values: sweepValues(
      // Through the ACRE lot category the recurring program prices directly.
      [...LOTS_SQFT, 45560].flatMap((lotSqFt) => MOSQUITO_PROFILES.map((p) => ({ lotSqFt, p }))),
      ({ lotSqFt, p }) => sp.priceMosquito({ footprint: 2000, lotSqFt, features: p.features }, { ...p.options, ...p.addOns }),
      // Per-application amount including any station/dunk add-ons amortized
      // across the program's applications (add-ons bill annually).
      (r) => (r.tiers || []).map((t) => t.perVisit + ((r.addOns && r.addOns.annualAddOns) || 0) / t.visits)).concat(bundle('mosquito')),
    notes: `Seasonal (${Number((constants.MOSQUITO.tierVisits || {}).seasonal9) || 9} applications/yr) or monthly (${Number((constants.MOSQUITO.tierVisits || {}).monthly12) || 12} applications/yr) program; priced by treatable area and mosquito pressure; WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%. Optional add-ons bill annually per unit: mosquito stations $${Math.round(constants.MOSQUITO.addOns.in2CareStation.price)} each, Bti dunks $${Math.round(constants.MOSQUITO.addOns.dunkTablet.price)} each — larger counts extend beyond this range at those rates.`,
  }));

  add('wasp_hornet_removal', () => rangeRow({
    key: 'wasp_hornet_removal',
    oneTimePerkKey: 'stinging_insect_v2',
    name: 'Wasp / Hornet / Stinging Insect Removal',
    unit: 'per job',
    // priceStingingInsect is the pricer the exact estimate branch uses —
    // sweep its scope dimensions (species, difficulty tier, removal,
    // aggressiveness, height, confined access) at standard scheduling.
    values: sweepValues(
      ['PAPER_WASP', 'YJ_AERIAL', 'YJ_GROUND', 'MUD_DAUBER', 'BALDFACED', 'CARPENTER'].flatMap((species) =>
        [1, 2, 3, 4].flatMap((tier) =>
          ['NONE', 'SMALL', 'LARGE', 'HONEYCOMB', 'RELOCATE'].flatMap((removal) =>
            [
              {},
              { aggressive: 'HIGH', height: 'HIGH', confined: 'YES' },
              { aggressive: 'EXTREME', height: 'HIGH', confined: 'YES' },
            ].map((mods) => ({ species, tier, removal, ...mods }))))),
      (opts) => sp.priceStingingInsect(opts),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.price))
      // Bundled inclusion: tier-1 paper-wasp/mud-dauber nests with an active
      // recurring pest plan price at $0 — publish that floor explicitly.
      .concat(sp.priceStingingInsect({ species: 'PAPER_WASP', tier: 1, removal: 'NONE', hasRecurringPest: true }).price === 0 ? [0] : []),
    notes: 'Priced by species, nest difficulty, removal scope, aggressiveness, height, and access. Tier-1 paper wasp and mud dauber nests are included at $0 with an active recurring pest plan.',
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
    {
      infestationComplexity: 'heavy',
      features: { trees: 'heavy', complexity: 'complex' },
      fleaExterior: true,
      // Largest directly priced exterior tier; above 20,000 sq ft is custom.
      fleaExteriorAreaSqFt: 20000,
    },
    // Selectable single-visit knockdown offer (lower entry price).
    { fleaOfferKey: 'flea_knockdown_single' },
    // The pricer applies the recurring-customer perk INTERNALLY (respecting
    // its package floor) — swept via the flag, never multiplied externally.
    { isRecurringCustomer: true },
    { fleaOfferKey: 'flea_knockdown_single', isRecurringCustomer: true },
  ];
  add('flea_elimination', () => rangeRow({
    key: 'flea_elimination',
    name: 'Flea Treatment',
    unit: 'per program',
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) => FLEA_PROFILES.map((p) => ({ f, p }))),
      ({ f, p }) => sp.priceFlea({ footprint: f, ...p }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.total)),
    notes: 'Single-visit knockdown or 2-visit elimination package; priced by home size, infestation severity, and optional exterior treatment area.',
  }));

  add('rodent_bait_program', () => rangeRow({
    key: 'rodent_bait_program',
    name: 'Rodent Bait Station Program',
    unit: 'per month',
    values: sweepValues(
      LOTS_SQFT.flatMap((lot) => FOOTPRINTS_SQFT.map((f) => ({ f, lot }))),
      ({ f, lot }) => sp.priceRodentBait({ footprint: f, lotSqFt: lot, features: {} }, {}),
      (r) => r.monthly).concat(sweepValues(
      LOTS_SQFT.flatMap((lot) => FOOTPRINTS_SQFT.map((f) => ({ f, lot }))),
      // Tile-roof properties carry the derived rodentRoofAdj the estimate
      // path forwards.
      ({ f, lot }) => sp.priceRodentBait({ footprint: f, lotSqFt: lot, features: {} }, { modifiers: { rodentRoofAdj: 50 } }),
      (r) => r.monthly)).concat(sweepValues(
      LOTS_SQFT.flatMap((lot) => FOOTPRINTS_SQFT.map((f) => ({ f, lot }))),
      // Metal roofs carry the negative adjustment property lookup forwards.
      ({ f, lot }) => sp.priceRodentBait({ footprint: f, lotSqFt: lot, features: {} }, { modifiers: { rodentRoofAdj: -5 } }),
      (r) => r.monthly)),
    notes: `Monthly-billed monitoring program with ${Number(constants.RODENT.baitVisitsPerYear) || 4} service visits per year.`,
  }));

  add('rodent_trapping', () => rangeRow({
    key: 'rodent_trapping',
    oneTimePerkKey: 'rodent_trapping',
    name: 'Rodent Trapping',
    unit: 'per program',
    // The mid-program upgrade is an incremental delta, not a program price —
    // it goes in the note (config-derived), never into the range.
    values: sweepValues(
      [
        { plan: 'standard' },
        { plan: 'unlimited' },
        // Standard plan with the configured callback allowance exhausted
        // plus billable extras (allowance read from live config). Extra
        // callbacks are additive per-unit with no cap — the note discloses
        // the live per-callback rate so any count is quotable.
        { plan: 'standard', callbacksUsed: Number(constants.RODENT.trapping.includedFollowUps) || 2, extraCallbackCount: 2 },
        { plan: 'standard', callbacksUsed: Number(constants.RODENT.trapping.includedFollowUps) || 2, extraCallbackCount: 6 },
      ],
      (opts) => sp.priceRodentTrapping({}, opts),
      (r) => r.price),
    notes: `Standard (setup + ${Number(constants.RODENT.trapping.includedFollowUps) || 2} included callbacks) or unlimited-callback plan; additional callbacks beyond the range $${Math.round(Number(constants.RODENT.trapping.additionalFollowUpRate) || 125)} each; existing Standard customers can upgrade to unlimited mid-program for $${Math.round(sp.priceRodentTrapping({}, { plan: 'standard', upgradeToUnlimited: true }).price)}. Emergency same-day service carries a surcharge quoted at booking. ${rodentBundleTerms}`,
  }));

  add('rodent_sanitation', () => rangeRow({
    key: 'rodent_sanitation',
    oneTimePerkKey: 'rodent_sanitation',
    name: 'Rodent Sanitation',
    unit: 'per job',
    // Affected area × debris removal × access type — the live path passes
    // insulationRemovalCuFt and heavy-tier crawlspace/tight access, all
    // directly priced.
    values: sweepValues(
      Object.keys(constants.RODENT.sanitation)
        .filter((tier) => constants.RODENT.sanitation[tier] && typeof constants.RODENT.sanitation[tier] === 'object' && 'base' in constants.RODENT.sanitation[tier])
        .flatMap((tier) => [250, 500, 1500, 4000, 10000].flatMap((affectedSqFt) =>
          [0, 50, 100].flatMap((insulationRemovalCuFt) =>
            ['normal', 'crawlspace', 'tight'].map((accessType) => ({ tier, affectedSqFt, insulationRemovalCuFt, accessType }))))),
      ({ tier, affectedSqFt, insulationRemovalCuFt, accessType }) =>
        sp.priceSanitation({ tier, affectedSqFt, insulationRemovalCuFt, accessType }),
      // customQuoteRecommended is routing-only; the numeric line is retained
      // by the estimate path — publish it.
      (r) => r.price),
    notes: `Priced by affected area, debris removal volume (per cu ft beyond the included allowance), and access; larger scopes extend beyond this range at the same per-unit rates. ${rodentBundleTerms}`,
  }));

  add('rodent_exclusion', () => rangeRow({
    key: 'rodent_exclusion',
    oneTimePerkKey: 'rodent_exclusion',
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
        // Inspection-waived configurations (service opt-in / qualifying total).
        { standardWireMeshPoints: 10, meshSoftLF: 50, waiveInspection: true },
        { standardWireMeshPoints: 5, meshSoftLF: 20, waiveInspection: true, hasServiceOptIn: true },
        // Floor-bound small scope with the inspection waived (true low).
        { standardWireMeshPoints: 0, waiveInspection: true, hasServiceOptIn: true },
        { standardWireMeshPoints: 20, meshSoftLF: 50 },
        { advancedWireMeshPoints: 10, meshConcreteLF: 50 },
        { standardWireMeshPoints: 10, advancedWireMeshPoints: 10, standardBirdBoxes: 2, tileHighBirdBoxes: 2, customBirdBoxes: 2, meshSoftLF: 30, meshConcreteLF: 30 },
        // Larger recorded scopes stay directly priced (no quote boundary).
        { advancedWireMeshPoints: 50 },
      ],
      (opts) => sp.priceRodentExclusionV2(opts),
      (r) => (r.customRecommended || r.requiresCustomQuote ? NaN : (r.total ?? r.price))),
    notes: `Scope set by inspection findings; components price per unit (standard point $${Math.round(constants.RODENT.exclusionV2.wireMeshPoints.standard)}, advanced/roof point $${Math.round(constants.RODENT.exclusionV2.wireMeshPoints.advancedRoofHigh)}, soft mesh $${Math.round(constants.RODENT.exclusionV2.linearMesh.softRatePerLF)}/LF, concrete mesh $${Math.round(constants.RODENT.exclusionV2.linearMesh.hardRatePerLF)}/LF), so larger scopes extend beyond this range at those rates. The low end reflects small jobs with the inspection fee waived (service opt-in or qualifying totals); otherwise the rodent inspection fee is included. ${rodentBundleTerms}`,
  }));

  // Simple and complex-perimeter/structural profiles — the exact path
  // forwards complexity plus derived construction/foundation modifiers.
  const TERMITE_BAIT_PROFILES = [
    {},
    { complexity: 'complex', modifiers: { termiteConstructionMult: 1.3, termiteFoundationAdj: 150 } },
    // Measured perimeter override — provenance review flag only; the exact
    // branch still publishes the priced line. Perimeter is unbounded; the
    // sweep covers the residential span and larger overrides scale by
    // station count.
    { perimeterLF: 1000 },
    { perimeterLF: 2000 },
  ];
  add('termite_bait_install', () => rangeRow({
    key: 'termite_bait_install',
    name: 'Termite Bait System Installation (Trelona)',
    unit: 'per installation',
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) => TERMITE_BAIT_PROFILES.map((opts) => ({ f, opts }))),
      ({ f, opts }) => sp.priceTermiteBait({ footprint: f }, opts),
      (r) => (r.quoteRequired ? NaN : r.installation && r.installation.price)),
    notes: 'Priced by home perimeter and structural complexity.',
  }));

  add('termite_bait_monitoring', () => rangeRow({
    key: 'termite_bait_monitoring',
    name: 'Termite Bait Monitoring',
    unit: 'per application',
    values: sweepValues(
      FOOTPRINTS_SQFT.flatMap((f) => TERMITE_BAIT_PROFILES.map((opts) => ({ f, opts }))),
      ({ f, opts }) => sp.priceTermiteBait({ footprint: f }, opts),
      // Bait monitoring is WaveGuard %-discount eligible — include the
      // max-tier customer-paid floor.
      (r) => {
        if (r.quoteRequired) return NaN;
        const maxDiscount = Math.max(...Object.values(constants.WAVEGUARD.tiers).map((t) => t.discount || 0));
        return [r.perApp, r.perApp * (1 - maxDiscount)];
      }),
    notes: `Quarterly station-check applications; WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%.`,
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
      values: sweepValues(
        FOOTPRINTS_SQFT.flatMap((f) => TERMITE_BAIT_PROFILES.map((opts) => ({ f, opts }))),
        ({ f, opts }) => sp.priceTermiteStationRental(sp.priceTermiteBait({ footprint: f }, opts).installation?.price),
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
    oneTimePerkKey: 'bora_care',
    name: 'Bora-Care Wood Treatment',
    unit: 'per job',
    values: sweepValues(
      [
        { atticSqFt: 500 }, { atticSqFt: 1000 }, { atticSqFt: 2000 }, { atticSqFt: 4500 },
        { surfaceLinearFt: 50, surfaceHeightFt: 2 }, { surfaceLinearFt: 150, surfaceHeightFt: 4 },
        { atticSqFt: 2000, surfaceLinearFt: 150, surfaceHeightFt: 4 },
        // Multi-day jobs stay directly priced (the flag is scheduling
        // provenance, not a quote refusal) — sweep through them.
        { atticSqFt: 8000, surfaceLinearFt: 200, surfaceHeightFt: 4 },
        { atticSqFt: 12000, surfaceLinearFt: 200, surfaceHeightFt: 4 },
        { atticSqFt: 20000, surfaceLinearFt: 300, surfaceHeightFt: 4 },
      ],
      (opts) => sp.priceBoraCare({ footprint: 2500 }, opts),
      (r) => (r.quoteRequired ? NaN : r.price)),
    notes: 'Borate treatment for exposed wood; priced by treated attic and surface area — larger areas extend beyond this range at the same per-area rates.',
  }));

  add('termite_trenching', () => rangeRow({
    key: 'termite_trenching',
    oneTimePerkKey: 'trenching',
    name: 'Termite Trenching (liquid barrier)',
    unit: 'per job',
    // Perimeter x product x application rate x depth x warranty x concrete
    // share — ordinary configuration fields the exact estimate flow passes;
    // manual-review configurations are excluded.
    values: sweepValues(
      // Measured overrides above 400 LF stay directly priced (provenance
      // review only) — sweep through 1,000 LF.
      [150, 250, 400, 700, 1000].flatMap((perimeterLF) =>
        Object.keys(constants.SPECIALTY.trenching.products).flatMap((productKey) =>
          ['standard', 'high'].flatMap((applicationRate) =>
            [0.5, 1, 1.5].flatMap((trenchDepthFt) =>
              ['none', 'one_year_retreat', 'five_year_repair_retreat'].flatMap((warrantyTier) =>
                [0.2, 0.6].map((concretePct) => ({ perimeterLF, productKey, applicationRate, trenchDepthFt, warrantyTier, concretePct }))))))),
      (opts) => sp.priceTrenching({ footprint: 2500 }, { ...opts, labelConfirmed: true }),
      // Explicit perimeter input always flags measurement-provenance review
      // reasons; that's about verifying footage on site, not a refusal to
      // quote — exclude only configurations the engine won't price.
      (r) => (r.quoteRequired || !Number.isFinite(r.price) ? NaN : r.price)),
    notes: 'Priced by treated perimeter, product, application rate, trench depth, warranty term, and concrete share; exact footage measured on site.',
  }));

  add('pre_slab_termiticide', () => rangeRow({
    key: 'pre_slab_termiticide',
    oneTimePerkKey: 'pre_slab_termiticide',
    name: 'Pre-Slab Termiticide Treatment',
    unit: 'per job',
    // Through the full auto-priced residential span — the public quote route
    // accepts slab measurements well past 4,000 sq ft with no quote boundary.
    // Slab area x product x job context x volume discount x extended
    // warranty — the selectable options the exact estimate branch forwards.
    values: sweepValues(
      [500, 1000, 2000, 4000, 6000, 8000, 12000, 20000, 30000].flatMap((slabSqFt) =>
        Object.keys(constants.SPECIALTY.preSlabTermiticide.products).flatMap((productKey) =>
          ['standalone', 'builderBatch', 'sameTripAddOn'].flatMap((jobContext) =>
            ['none', '5plus', '10plus'].flatMap((volumeDiscount) =>
              [false, true].map((includeWarrantyExtended) => ({ slabSqFt, productKey, jobContext, volumeDiscount, includeWarrantyExtended })))))),
      ({ slabSqFt, ...opts }) => sp.pricePreSlabTermiticide({ slabSqFt }, { ...opts, labelConfirmed: true }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.price ?? r.treatmentPrice))),
    notes: 'New-construction slab pre-treatment priced by slab area. The low end reflects discounted builder-batch and same-trip add-on scheduling; standalone one-off jobs price higher. Volume discounts available.',
  }));

  add('wdo_inspection', () => rangeRow({
    key: 'wdo_inspection',
    oneTimePerkKey: 'wdo_inspection',
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
          LAWN_TIER_KEYS.map((tier) => ({ sq, track, tier })))),
      ({ sq, track, tier }) => sp.priceLawnCare({ lawnSqFt: sq }, { track, tier }),
      (r) => r.perApp).concat(bundle('lawn')),
    notes: `${lawnCadenceText} applications per year by tier; priced by grass type and treatable turf area; WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%.`,
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
            LAWN_TIER_KEYS.flatMap((tier) =>
              [false, true].map((isRecurringCustomer) => ({ sq, treatmentType, track, tier, isRecurringCustomer })))))),
      ({ sq, treatmentType, track, tier, isRecurringCustomer }) => sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType, track, tier, isRecurringCustomer }),
      (r) => r.price),
    notes: 'Priced by treatment type, grass type, and turf area.',
  }));

  add('lawn_pest_knockdown', () => rangeRow({
    key: 'lawn_pest_knockdown',
    name: 'Lawn Pest Knockdown',
    unit: 'per treatment',
    // The canonical lawnPestControl service: a standalone one-time
    // turf-pest treatment (chinch bugs, sod webworms, armyworms, grubs)
    // priced via the one-time lawn 'pest' multiplier as its own line.
    values: sweepValues(
      LAWNS_SQFT.flatMap((sq) =>
        Object.keys(constants.LAWN_BRACKETS).flatMap((track) =>
          LAWN_TIER_KEYS.flatMap((tier) =>
            [false, true].map((isRecurringCustomer) => ({ sq, track, tier, isRecurringCustomer }))))),
      ({ sq, track, tier, isRecurringCustomer }) => sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType: 'pest', track, tier, isRecurringCustomer }),
      (r) => r.price),
    notes: 'Standalone turf-pest treatment (chinch bugs, sod webworms, armyworms, grubs); can be combined with a weed treatment.',
  }));

  add('dethatching', () => rangeRow({
    key: 'dethatching',
    oneTimePerkKey: 'dethatching',
    name: 'Lawn Dethatching',
    unit: 'per job',
    // Bermuda/Zoysia lawns under 10,000 sq ft with recorded thatch depth
    // auto-price; St. Augustine and heavy-cleanup jobs stay review-gated
    // and are excluded by the quote-required filter.
    values: sweepValues(
      [2000, 4000, 6000, 9000].flatMap((sq) =>
        ['bermuda', 'zoysia'].flatMap((grassType) =>
          ['none', 'light', 'moderate', 'heavy'].flatMap((cleanupLevel) =>
            ['easy', 'moderate'].map((access) => ({ sq, grassType, cleanupLevel, access }))))),
      ({ sq, grassType, cleanupLevel, access }) =>
        sp.priceDethatching(sq, { grassType, cleanupLevel, thatchDepthInches: 1, access }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.price ?? r.estimatedPrice))),
    notes: 'Bermuda and Zoysia lawns (heavy cleanup priced directly on smaller lawns); St. Augustine and large heavy-debris jobs are quoted after inspection.',
  }));

  add('one_time_mosquito', () => rangeRow({
    key: 'one_time_mosquito',
    name: 'One-Time Mosquito Treatment',
    unit: 'per treatment',
    // Station/dunk add-ons raise the high; the recurring-customer discount
    // lowers the low — both forwarded by the exact estimate path.
    values: sweepValues(
      // Through the one-acre (43,560 treatable sq ft) direct-price boundary;
      // 5 stations / 9 dunks are the largest non-review add-on counts.
      // Over-acre treatable areas stay numerically priced (review is
      // routing only) — sweep through 60,000 treatable sq ft.
      [...LOTS_SQFT, 45560, 62000].flatMap((lotSqFt) =>
        [{}, { stationCount: 5, dunkCount: 9 }, { isRecurringCustomer: true }].map((opts) => ({ lotSqFt, opts }))),
      ({ lotSqFt, opts }) => sp.priceOneTimeMosquito({ footprint: 2000, lotSqFt }, opts),
      (r) => (r.quoteRequired ? NaN : r.price)),
    notes: `Priced by treatable area — larger properties extend beyond this range by area increment. One-time add-ons per unit: mosquito stations $${Math.round(constants.ONE_TIME.mosquito.stationAddOn)} each, Bti dunks $${Math.round(constants.ONE_TIME.mosquito.dunkAddOn)} each, at any count.`,
  }));

  add('lawn_plugging', () => rangeRow({
    key: 'lawn_plugging',
    oneTimePerkKey: 'plugging',
    name: 'Lawn Plugging',
    unit: 'per sq ft',
    decimals: 2,
    // Effective per-sq-ft rate varies with treated area because of the job
    // floor, so areas are swept alongside spacing (standard scheduling).
    values: sweepValues(
      [500, 1000, 3000, 6000].flatMap((area) => [6, 9, 12].map((spacing) => ({ area, spacing }))),
      ({ area, spacing }) => sp.pricePlugging(area, spacing),
      (r) => r.perSf),
    notes: 'Rate depends on plug spacing (6", 9", or 12") and treated area; small jobs carry a minimum.',
  }));

  add('top_dressing', () => rangeRow({
    key: 'top_dressing',
    oneTimePerkKey: 'top_dressing',
    name: 'Lawn Top Dressing',
    unit: 'per job',
    // Both pricing modes: estimated area (65% reduction) and exact-area
    // (measured, or recurring-lawn customers) — the live estimate path uses
    // exact-area for measured jobs, which prices above the estimated mode.
    values: sweepValues(
      [...LAWNS_SQFT, 40000].flatMap((sq) =>
        ['eighth', 'quarter'].flatMap((depth) => [false, true].map((exactArea) => ({ sq, depth, exactArea })))),
      ({ sq, depth, exactArea }) => sp.priceTopDressing(sq, depth, exactArea),
      (r) => r.price),
    notes: 'Recurring-plan customers receive a discounted rate; larger measured areas extend beyond this range at the same per-area rates.',
  }));

  // Auto-priced residential shapes only: bare lots plus planted/treed
  // properties (bed area + tree count + access) that stay below the pricer's
  // manual-review thresholds; reviewed results are excluded.
  const TREE_SHRUB_PROFILES = [
    { property: { footprint: 2000 }, options: {} },
    { property: { footprint: 2000, bedArea: 4000 }, options: { treeCount: 6, access: 'moderate' } },
    { property: { footprint: 2000, bedArea: 7900 }, options: { treeCount: 14, access: 'moderate' } },
    // High tree counts stay numerically priced — the review flag only
    // routes the estimate; the priced line is still published.
    { property: { footprint: 2000, bedArea: 7900 }, options: { treeCount: 20, access: 'moderate' } },
    { property: { footprint: 2000, bedArea: 7900 }, options: { treeCount: 40, access: 'moderate' } },
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
      (r) => r.monthly).concat(bundle('treeShrub')),
    notes: `Monthly-billed program; 4, 6, or 9 applications per year by tier; priced by planting beds and tree count (larger counts extend beyond this range); WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%.`,
  }));

  // rodent_plugging (calculatePluggingPrice) is deliberately NOT published:
  // no live route or client populates services.rodentPlugging — same
  // reachability rule as the omitted termite_foam pricer.

  // termite_foam (calculateFoamPrice) is deliberately NOT published: no live
  // route or client populates services.termiteFoam (DECISIONS.md records the
  // pricer as dead); the purchasable drill-and-foam path is the foam_drill row.

  add('rodent_wire_mesh', () => rangeRow({
    key: 'rodent_wire_mesh',
    oneTimePerkKey: 'rodent_wire_mesh',
    name: 'Rodent Wire Mesh Exclusion',
    unit: 'per job',
    values: sweepValues(
      [0, 30, 60, 120, 200, 400].flatMap((meshLinearFeet) =>
        Object.keys(constants.RODENT.wireMesh.substrates).map((meshSubstrate) => ({ meshLinearFeet, meshSubstrate }))),
      (opts) => sp.priceRodentWireMesh(opts),
      // customQuoteRecommended only adds a review warning; the priced line
      // is retained by the estimate path — publish it.
      (r) => (r ? r.price : NaN)),
    notes: 'Priced per linear foot by substrate, with a job minimum; longer measured runs extend beyond this range at the same per-LF rates.',
  }));

  add('rodent_bird_boxes', () => rangeRow({
    key: 'rodent_bird_boxes',
    oneTimePerkKey: 'rodent_bird_boxes',
    name: 'Roof-Entry Covers / Bird Boxes',
    unit: 'per job',
    values: sweepValues(
      ['small_bird_box', 'standard_bird_box', 'large_bird_box', 'oversized_complex_custom'].flatMap((birdBoxType) =>
        [1, 2, 4, 8].map((birdBoxQuantity) => ({ birdBoxType, birdBoxQuantity }))),
      (opts) => sp.priceRodentBirdBoxes(opts),
      (r) => (r ? r.price : NaN)),
    // Quantity is unbounded and strictly additive per unit — disclose the
    // live per-cover rates so any count is quotable beyond the range.
    notes: `Priced per cover: small $${Math.round(constants.RODENT.birdBoxes.small_bird_box)}, standard $${Math.round(constants.RODENT.birdBoxes.standard_bird_box)} (same-visit additional $${Math.round(constants.RODENT.birdBoxes.additional_standard_same_visit)}), large $${Math.round(constants.RODENT.birdBoxes.large_bird_box)}, oversized/custom $${Math.round(constants.RODENT.birdBoxes.oversized_complex_custom)}; larger quantities extend beyond this range at those rates.`,
  }));

  add('rodent_inspection', () => rangeRow({
    key: 'rodent_inspection',
    oneTimePerkKey: 'rodent_inspection',
    name: 'Rodent Inspection',
    unit: 'per inspection',
    values: [sp.priceRodentInspection({}).price].filter((v) => Number.isFinite(v) && v > 0),
    notes: `Creditable toward remediation work within ${sp.priceRodentInspection({}).creditableWithinDays} days.`,
  }));

  add('rodent_guarantee', () => rangeRow({
    key: 'rodent_guarantee',
    name: 'Rodent Guarantee',
    unit: 'per program',
    // Renewable guarantee premium by property tier; eligibility (completed
    // trapping/exclusion/sanitation) is a customer-state flag, not pricing.
    // Tier derives from home size / stories / roof — sweep the property
    // shapes rather than naming tiers directly.
    values: sweepValues(
      [
        { homeSqFt: 1500, stories: 1, roofType: 'shingle' },
        { homeSqFt: 3000, stories: 2, roofType: 'tile' },
        { homeSqFt: 5000, stories: 2, roofType: 'tile', sealedPoints: 20, totalLinearMeshLF: 60 },
        { homeSqFt: 7000, stories: 3, roofType: 'tile', sealedPoints: 40, totalLinearMeshLF: 120 },
      ],
      (opts) => sp.priceRodentGuarantee(opts),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.price)),
    notes: 'Renewable 12-month rodent-free guarantee; eligibility requires completed trapping, completed exclusion, sanitation completed (or photo baseline), and no activity after the final trap check. Priced by property tier.',
  }));

  add('trap_only_retainer', () => rangeRow({
    key: 'trap_only_retainer',
    oneTimePerkKey: 'trap_only_retainer',
    name: 'Trap-Only Rodent Monitoring Retainer',
    unit: 'per month',
    // Both billing modes, annual prepay normalized to per-month.
    values: sweepValues(
      Object.keys(constants.RODENT.trapOnlyRetainer.plans).flatMap((plan) =>
        ['monthly', 'annual'].map((billing) => ({ plan, billing }))),
      (opts) => sp.priceTrapOnlyRetainer(opts),
      (r) => (r.trapOnlyRetainerBilling === 'annual'
        ? r.trapOnlyRetainerAnnualPrice / 12
        : r.trapOnlyRetainerMonthlyPrice)),
    notes: `Monitoring with scheduled visits and included response callbacks; monthly billing, or discounted annual prepay (setup fee waived). A one-time $${Math.round(Number(constants.RODENT.trapOnlyRetainer.setupFee) || 0)} setup fee applies to monthly billing, and callbacks beyond the included allowance bill $${Math.round(Number(constants.RODENT.trapOnlyRetainer.extraCallbackRate) || 0)} each. No structural warranty without exclusion.`,
  }));

  add('recurring_foam', () => rangeRow({
    key: 'recurring_foam',
    name: 'Recurring Foam Treatment',
    unit: 'per application',
    values: sweepValues(
      // 20 points is the configured recurring-foam maximum; larger jobs are
      // one-time foam or custom.
      [5, 12, 20].flatMap((points) =>
        ['quarterly', 'bimonthly', 'monthly'].map((cadence) => ({ points, cadence }))),
      ({ points, cadence }) => sp.priceRecurringFoam(points, { cadence }),
      (r) => r.perTreatment),
    notes: 'Quarterly, bi-monthly, or monthly foam program; discounted vs one-time treatments.',
  }));

  add('foam_drill', () => rangeRow({
    key: 'foam_drill',
    oneTimePerkKey: 'foam_drill',
    name: 'Drill-and-Foam Termite Treatment',
    unit: 'per job',
    // Distinct from the termite_foam spot treatment: this is the tiered
    // drill-and-foam service the estimate path prices via priceFoamDrill.
    values: sweepValues([5, 10, 15, 20],
      (points) => sp.priceFoamDrill(points, {}),
      (r) => r.price),
    notes: 'Tiered by drill-point count; standard scheduling.',
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
      // Actually-charged per palm per treatment — the per-visit minimum
      // raises small palm counts above the raw catalog rate.
      (r, { palmCount }) => r.perVisit / palmCount).concat(bundle('palm')),
    notes: 'Nutrition, insecticide, combo, and TREE-age treatments. Fungal and lethal-bronzing work is diagnosed and quoted on site.',
  }));

  return { rows, errors };
}

// Sync-keyed cache: the sweep is thousands of pricing calls (~100ms), so an
// unauthenticated bot ignoring Cache-Control must not be able to burn CPU per
// request — but a memo must never outlive a pricing edit either. The cache
// key is db-bridge's last-successful-sync timestamp (so ANY sync — this
// route's, or an admin pricing-proposal approval — invalidates it) plus the
// purchase-gate signature (gate flips change the row set). `refresh: true`
// remains as an explicit override for tests/tools.
const { getLastSyncAt, isSyncInFlight } = require('./db-bridge');
let cached = null;
let cachedKey = null;
let lastUnstable = false;
function lastComputeUnstable() {
  return lastUnstable;
}

function gateSignature() {
  return `${getLastSyncAt()}|${process.env.GATE_TERMITE_BOND_OPTION || ''}|${process.env.GATE_TERMITE_STATION_RENTAL || ''}`;
}

function computePublicPricingRanges({ refresh = false } = {}) {
  let sig = gateSignature();
  if (!refresh && cached && cachedKey === sig) {
    lastUnstable = false;
    return cached;
  }
  // Admin routes call syncConstantsFromDB directly and mutate the shared
  // constants object before stamping _lastSync — if a sync lands while we
  // sweep, the payload could mix pre/post-edit values. Rebuild until the
  // sync stamp is unchanged across the sweep (bounded retries).
  let rows;
  let errors;
  let sawInFlight = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inFlightBefore = isSyncInFlight();
    ({ rows, errors } = buildRows());
    const inFlightAfter = isSyncInFlight();
    sawInFlight = sawInFlight || inFlightBefore || inFlightAfter;
    const after = gateSignature();
    if (after === sig && !inFlightBefore && !inFlightAfter) break;
    sig = after;
  }
  cached = {
    generatedAt: new Date().toISOString(),
    currency: 'USD',
    disclaimer: 'Typical ranges for residential properties in our SW Florida service area under standard scheduling. Emergency, urgent, or after-hours service carries surcharges quoted at booking. Your exact price depends on property size and conditions — get an instant quote at https://www.wavespestcontrol.com/pest-control-calculator/. Commercial properties are custom-quoted.',
    services: rows,
    errors,
  };
  // A sweep that overlapped an in-flight sync may mix pre/post-edit
  // constants (db-bridge mutates before stamping) — serve it, but don't
  // cache it (in-process OR downstream); the next request rebuilds from
  // settled constants. The route reads lastComputeUnstable to send no-store.
  lastUnstable = sawInFlight;
  if (sawInFlight) {
    const uncachedPayload = cached;
    cached = null;
    cachedKey = null;
    return uncachedPayload;
  }
  cachedKey = sig;
  return cached;
}

module.exports = { computePublicPricingRanges, lastComputeUnstable, _internals: { buildRows } };
