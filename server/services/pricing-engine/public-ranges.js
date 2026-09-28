// ============================================================
// public-ranges.js — Agent-readable public price ranges
// ============================================================
// Computes a per-service low/high price range for a TYPICAL residential job
// at LIST price — standard scheduling, before WaveGuard bundle discounts,
// recurring-customer perks, and advertised waivers — by sweeping the live
// pricing engine across realistic typical-home inputs. This is NOT an
// envelope of every possible quote: larger or more complex properties,
// heavier infestations, bigger scopes, and emergency/after-hours service
// can and do quote above the published high. Consumed by GET
// /api/public/pricing-ranges (and, from there, the Astro build's
// /pricing.md agent-readable surface).
//
// Ranges are DERIVED, never hand-typed: the engine constants this module
// reads are synced from the DB-authoritative pricing_config by db-bridge,
// so a pricing change in /admin propagates here without a code change.
// Owner ruling 2026-09-27: publish the range for a TYPICAL residential job
// at LIST price, not an envelope of every possible quote. Per-property
// exact quotes stay behind the quote calculator.
//
// Copy rules enforced here (owner directives):
// - unit is "per application", never "per visit" — the only per-month
//   units are services that genuinely bill monthly.
// - no combined per-month or per-year program totals.
// - commercial is custom-quoted and excluded from the sweep.
const constants = require('./constants');
const sp = require('./service-pricing');
const { calculatePerimeter } = require('./property-calculator');

// Typical SW Florida residential property, as measured by the estimator's own
// property lookups: the 10th/25th/50th/75th/90th percentiles of the 1,022
// residential homes in property_lookups.enriched_snapshot (2026-06-12 to
// 2026-09-26, mostly Manatee and Sarasota) — the middle 80% of the homes we
// quote. Owner ruling 2026-09-27: size ranges to the homes we service.
// Re-derive these from property_lookups if the service area shifts.
const TYPICAL_HOMES = [1450, 1750, 2150, 2750, 3450]; // homeSqFt (total living area)
// Footprint-priced services take the building footprint, which the estimator
// derives as homeSqFt / stories (calculateFootprint) — percentiles of that
// per-home value, not homeSqFt (77% of the homes are one story, 22% two).
const TYPICAL_FOOTPRINTS = [1085, 1475, 1865, 2425, 3070];
const MEDIAN_FOOTPRINT = 1865;
const TYPICAL_LOTS = [5400, 7000, 8900, 12700, 22500]; // lotSqFt
const TYPICAL_TURF = [1200, 2200, 3450, 5500, 11500]; // estimatedTurfSf
// ~95% of those homes have light or moderate shrubs, trees, and landscaping
// (heavy is 5-12%); 43% have a pool cage.
const TYPICAL_LANDSCAPES = [
  { shrubs: 'light', trees: 'light', complexity: 'simple' },
  { shrubs: 'moderate', trees: 'moderate', complexity: 'moderate' },
];

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

// Rows the feed publishes only while a purchase gate is on, keyed to that
// gate. The ONE list: the sweep below reads it, the cache signature reads
// it, and consumers that freeze keys into content (the blog price card)
// exclude these rows, since a frozen key outlives a gate flip.
const PURCHASE_GATED_ROWS = Object.freeze({
  termite_station_rental: 'GATE_TERMITE_STATION_RENTAL',
  termite_bond: 'GATE_TERMITE_BOND_OPTION',
});
function purchaseGateOn(key) {
  return ['1', 'true', 'on'].includes(String(process.env[PURCHASE_GATED_ROWS[key]] || '').toLowerCase());
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
  // "9x or 12x" for two sold cadences, "6x, 9x, or 12x" for three.
  const lawnCadenceParts = visibleLawnTiers.map(([, t]) => `${t.freq}x`);
  const lawnCadenceText = lawnCadenceParts.length === 2
    ? lawnCadenceParts.join(' or ')
    : lawnCadenceParts.join(', ').replace(/, ([^,]*)$/, ', or $1');
  const b = constants.RODENT.bundles || {};
  // NOTE: only trapping+sanitation is advertised — the live bundle selector
  // matches service === 'exclusion', which the active V2 exclusion pricer
  // ('rodent_exclusion') never emits, so exclusion-inclusive bundle
  // discounts do not currently apply on exact quotes (engine defect flagged
  // to the owner; widen this note only after the selector is fixed).
  const rodentBundleTerms = `Package discount (live terms): trapping+sanitation ${Math.round(((b.trapSanitation || {}).discount || 0) * 100)}% (floor $${Math.round((b.trapSanitation || {}).floor || 0)}); other combinations are quoted at booking.`;
  const maxWaveGuardPct = Math.round(
    Math.max(...Object.values(constants.WAVEGUARD.tiers).map((t) => t.discount || 0)) * 100);

  // Typical landscaping, with and without a pool cage.
  const PEST_PROFILES = TYPICAL_LANDSCAPES
    .flatMap((features) => [features, { ...features, poolCage: true }])
    .map((features) => ({ property: { features } }));
  add('general_pest_quarterly', () => rangeRow({
    key: 'general_pest_quarterly',
    name: 'General Pest Control (WaveGuard recurring)',
    unit: 'per application',
    // Sweep every supported cadence via the engine's tiers array — monthly
    // per-application prices sit below quarterly, so quarterly-only would
    // overstate the low end of an advertised option.
    values: sweepValues(
      TYPICAL_FOOTPRINTS.flatMap((f) => PEST_PROFILES.map((p) => ({ f, p }))),
      ({ f, p }) => sp.pricePestControl({ footprint: f, propertyType: 'single_family', ...p.property }, { frequency: 'quarterly' }),
      (r) => (r.tiers || []).map((t) => t.perApp)),
    notes: `Quarterly, bi-monthly, or monthly cadence; priced by home size, landscaping, and property features — larger, more complex homes price higher. WaveGuard bundle tiers discount qualifying recurring services up to ${maxWaveGuardPct}%. A one-time $${Math.round(constants.PEST.initialFee)} initial service fee applies to standalone pest service only — waived when bundled with another recurring service or with annual prepay.`,
  }));

  add('cockroach_treatment', () => rangeRow({
    key: 'cockroach_treatment',
    name: 'Cockroach Treatment (native / palmetto / German knockdown)',
    unit: 'per treatment',
    // Standalone and recurring-plan-attached knockdowns, regular and German
    // scales, on typical homes.
    values: sweepValues(
      TYPICAL_FOOTPRINTS.flatMap((f) =>
        ['regular', 'german'].flatMap((roachType) =>
          [true, false].map((standalone) => ({ f, roachType, standalone })))),
      ({ f, roachType, standalone }) => sp.pricePestInitialRoach({ footprint: f }, { roachType, standalone }),
      (r) => r.price),
    notes: 'Standalone treatment, or added to a recurring plan at a lower rate; multi-visit German infestation cleanouts use the cleanout program. Larger homes price higher.',
  }));

  add('one_time_pest', () => rangeRow({
    key: 'one_time_pest',
    name: 'One-Time Pest Treatment',
    unit: 'per treatment',
    // Derives from the quarterly baseline, so it sweeps the same profiles.
    values: sweepValues(
      TYPICAL_FOOTPRINTS.flatMap((f) => PEST_PROFILES.map((p) => ({ f, p }))),
      ({ f, p }) => sp.priceOneTimePest({ footprint: f, propertyType: 'single_family', ...p.property }, { isRecurringCustomer: false }),
      (r) => r.price),
    notes: 'Single knockdown visit; larger or more complex homes price higher. A recurring plan prices lower per application.',
  }));

  add('german_roach_cleanout', () => rangeRow({
    key: 'german_roach_cleanout',
    name: 'German Roach Cleanout Service',
    unit: 'per program',
    values: sweepValues(
      ['light', 'moderate', 'heavy'].flatMap((severity) => TYPICAL_FOOTPRINTS.map((f) => ({ f, severity }))),
      ({ f, severity }) => sp.priceGermanRoach({ footprint: f }, { severity }),
      (r) => r.total ?? r.price),
    notes: 'Multi-visit program; visits vary by severity.',
  }));

  add('german_roach_initial', () => rangeRow({
    key: 'german_roach_initial',
    name: 'German Roach Initial Service (3-Visit)',
    unit: 'per program',
    // Agent-selectable initial series at list price; the pricer applies the
    // recurring-customer perk internally, so it is never swept.
    values: sweepValues([false],
      (isRecurringCustomer) => sp.priceGermanRoachInitial({ isRecurringCustomer }),
      (r) => r.price),
    notes: 'One program price covering the 3-visit initial series for German roach activity within a recurring plan; heavy infestations use the cleanout program.',
  }));

  add('bed_bug_treatment', () => rangeRow({
    key: 'bed_bug_treatment',
    name: 'Bed Bug Treatment Service',
    unit: 'per treatment program',
    // Typical scope: 1-3 rooms, light/moderate severity, chemical method,
    // ready prep, single-family occupancy — the auto-priced typical job.
    values: sweepValues(
      TYPICAL_FOOTPRINTS.flatMap((footprint) =>
        [1, 2, 3].flatMap((rooms) =>
          ['light', 'moderate'].map((severity) => ({ footprint, rooms, severity })))),
      ({ footprint, rooms, severity }) => sp.priceBedBugTreatment(
        { footprint, stories: 1 },
        { rooms, method: 'CHEMICAL', severity, prepStatus: 'ready', occupancyType: 'singleFamily' }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.total ?? r.price))),
    notes: '1-3 rooms; priced by rooms, severity, and home size. More rooms, heavier infestations, larger or multi-story homes, in-house heat/hybrid treatment, apartment occupancy, and under-prepared jobs price higher or are quoted after inspection.',
  }));

  // Base and heavier-pressure residential feature sets — the pricer's
  // pressure multiplier (trees, pool, irrigation) raises per-application
  // prices above a bare-lot sweep on a typical home.
  const MOSQUITO_PROFILES = [
    { trees: 'light' },
    { trees: 'moderate', pool: true, irrigation: true },
  ];
  // 82% of looked-up homes have no water, a neighborhood retention pond, or
  // an adjacent lake — the property lookup's graduated water multipliers for
  // those (calcMosquitoWaterMult in routes/property-lookup-v2.js). Pond,
  // canal, and wetland frontage price higher.
  const TYPICAL_MOSQUITO_WATER_MULTS = [1.0, 1.25, 1.3];
  add('mosquito_program', () => rangeRow({
    key: 'mosquito_program',
    name: 'Mosquito Program',
    unit: 'per application',
    values: sweepValues(
      TYPICAL_LOTS.flatMap((lotSqFt) => MOSQUITO_PROFILES.flatMap((features) =>
        TYPICAL_MOSQUITO_WATER_MULTS.map((mosquitoWaterMult) => ({ lotSqFt, features, mosquitoWaterMult })))),
      ({ lotSqFt, features, mosquitoWaterMult }) => sp.priceMosquito(
        { footprint: MEDIAN_FOOTPRINT, lotSqFt, features },
        { modifiers: { mosquitoWaterMult } }),
      (r) => (r.tiers || []).map((t) => t.perVisit)),
    notes: `Seasonal (${Number((constants.MOSQUITO.tierVisits || {}).seasonal9) || 9} applications/yr) or monthly (${Number((constants.MOSQUITO.tierVisits || {}).monthly12) || 12} applications/yr) program; priced by treatable area and mosquito pressure — larger lots and heavier pressure (trees, pool, irrigation, waterfront) price higher. WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%. Optional add-ons bill annually per unit: mosquito stations $${Math.round(constants.MOSQUITO.addOns.in2CareStation.price)} each, Bti dunks $${Math.round(constants.MOSQUITO.addOns.dunkTablet.price)} each.`,
  }));

  add('wasp_hornet_removal', () => rangeRow({
    key: 'wasp_hornet_removal',
    name: 'Wasp / Hornet / Stinging Insect Removal',
    unit: 'per job',
    // priceStingingInsect is the pricer the exact estimate branch uses —
    // typical scope: common species, the two lower difficulty tiers, no or
    // small removal, standard access.
    values: sweepValues(
      ['PAPER_WASP', 'YJ_AERIAL', 'YJ_GROUND', 'MUD_DAUBER'].flatMap((species) =>
        [1, 2].flatMap((tier) =>
          ['NONE', 'SMALL'].map((removal) => ({ species, tier, removal })))),
      (opts) => sp.priceStingingInsect(opts),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.price)),
    notes: 'Priced by species, nest difficulty, removal scope, aggressiveness, height, and access — a harder-to-reach or more aggressive nest, larger removal scope, or a less common species prices higher. Tier-1 paper wasp and mud dauber nests are included at no charge with an active recurring pest plan.',
  }));

  add('flea_elimination', () => rangeRow({
    key: 'flea_elimination',
    name: 'Flea Treatment',
    unit: 'per program',
    values: sweepValues(
      TYPICAL_FOOTPRINTS,
      (f) => sp.priceFlea({ footprint: f }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.total)),
    notes: '2-visit elimination package; priced by home size. Heavier infestation severity and an optional exterior treatment area price higher.',
  }));

  const formatSetupFee = (v) => {
    const n = Math.round(Number(v) * 100) / 100;
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  };
  add('rodent_bait_program', () => rangeRow({
    key: 'rodent_bait_program',
    name: 'Rodent Bait Station Program',
    unit: 'per application',
    // Footprint brackets (owner 2026-08-29): lot size, roof type, and the
    // retired post-exclusion modifier no longer move the price — one sweep
    // over the footprint axis covers a typical home's span.
    values: sweepValues(
      TYPICAL_FOOTPRINTS,
      (f) => sp.priceRodentBait({ footprint: f }, {}),
      (r) => r.perVisit),
    // Setup copy tracks the LIVE value to the cent and disappears when the
    // fee is disabled (0) — the public surface must match the live charge.
    notes: `Billed per application (quarterly — ${Number(constants.RODENT.baitVisitsPerYear) || 4} applications per year) with a station allowance by home size${
      Number(constants.RODENT.baitSetupFee) > 0
        ? `; a one-time $${formatSetupFee(constants.RODENT.baitSetupFee)} setup applies only without another WaveGuard recurring service.`
        : '.'
    }`,
  }));

  add('rodent_trapping', () => rangeRow({
    key: 'rodent_trapping',
    name: 'Rodent Trapping',
    unit: 'per program',
    // Standard is the only plan (owner 2026-08-26): flat program fee
    // covering the setup visit + 1 trap check; further checks are billed
    // per visit (owner ruling 2026-09-26).
    values: sweepValues(
      [{ plan: 'standard' }],
      (opts) => sp.priceRodentTrapping({}, opts),
      (r) => r.price),
    notes: `Standard plan (flat program fee — covers the setup visit plus 1 trap check for the same active trapping job; additional trap checks are $${constants.RODENT.trapping.additionalCheckPrice} each). Emergency same-day service carries a surcharge quoted at booking. ${rodentBundleTerms}`,
  }));

  add('rodent_sanitation', () => rangeRow({
    key: 'rodent_sanitation',
    name: 'Rodent Sanitation',
    unit: 'per job',
    // The two lightest tiers by LIVE base price — a typical job's scope;
    // a heavier tier, larger debris removal, or harder access price above
    // this range.
    values: sweepValues(
      (() => {
        const tiers = Object.keys(constants.RODENT.sanitation)
          .filter((t) => constants.RODENT.sanitation[t] && typeof constants.RODENT.sanitation[t] === 'object' && 'base' in constants.RODENT.sanitation[t])
          .sort((a, c) => constants.RODENT.sanitation[a].base - constants.RODENT.sanitation[c].base)
          .slice(0, 2);
        return tiers.flatMap((tier) => [250, 500, 1000].map((affectedSqFt) => ({ tier, affectedSqFt })));
      })(),
      ({ tier, affectedSqFt }) =>
        sp.priceSanitation({ tier, affectedSqFt, insulationRemovalCuFt: 0, accessType: 'normal' }),
      (r) => r.price),
    notes: `Priced by affected area and access; the heavy tier, debris removal beyond the included allowance, and crawlspace/tight access price higher. ${rodentBundleTerms}`,
  }));

  add('rodent_exclusion', () => rangeRow({
    key: 'rodent_exclusion',
    name: 'Rodent Exclusion',
    unit: 'per job',
    // Typical wire-mesh scopes with the inspection included (not waived),
    // plus the size-tier price the website's /estimate/rodent-exclusion/
    // page gets for a typical home (public-quote sends only homeSqFt and
    // stories, so the estimate engine prices it through priceExclusion) —
    // the published range must hold what that page actually quotes.
    values: sweepValues(
      [
        { standardWireMeshPoints: 5, meshSoftLF: 20 },
        { standardWireMeshPoints: 10, meshSoftLF: 50 },
      ],
      (opts) => sp.priceRodentExclusionV2(opts),
      (r) => (r.customRecommended || r.requiresCustomQuote ? NaN : (r.total ?? r.price)))
      .concat(sweepValues(TYPICAL_HOMES,
        (homeSqFt) => sp.priceExclusion({ homeSqFt, stories: 1 }),
        (r) => (r.customRecommended || r.requiresCustomQuote ? NaN : r.price))),
    notes: `Scope set by inspection findings; components price per unit (standard point $${Math.round(constants.RODENT.exclusionV2.wireMeshPoints.standard)}, advanced/roof point $${Math.round(constants.RODENT.exclusionV2.wireMeshPoints.advancedRoofHigh)}, soft mesh $${Math.round(constants.RODENT.exclusionV2.linearMesh.softRatePerLF)}/LF, concrete mesh $${Math.round(constants.RODENT.exclusionV2.linearMesh.hardRatePerLF)}/LF), so larger scopes price higher at those rates; the rodent inspection fee is included. ${rodentBundleTerms}`,
  }));

  // Bare and complex-perimeter/structural profiles — a typical home's
  // structural complexity range.
  const TERMITE_BAIT_PROFILES = [
    {},
    { complexity: 'complex' },
  ];
  add('termite_bait_install', () => rangeRow({
    key: 'termite_bait_install',
    name: 'Termite Bait System Installation (Trelona)',
    unit: 'per installation',
    values: sweepValues(
      TYPICAL_FOOTPRINTS,
      (f) => sp.priceTermiteBait({ footprint: f }, {}),
      (r) => (r.quoteRequired ? NaN : r.installation && r.installation.price)),
    notes: 'Priced by home size; larger, more complex homes or a measured perimeter override price higher.',
  }));

  add('termite_bait_monitoring', () => rangeRow({
    key: 'termite_bait_monitoring',
    name: 'Termite Bait Monitoring',
    unit: 'per application',
    values: sweepValues(
      TYPICAL_FOOTPRINTS.flatMap((f) => TERMITE_BAIT_PROFILES.map((opts) => ({ f, opts }))),
      ({ f, opts }) => sp.priceTermiteBait({ footprint: f }, opts),
      (r) => (r.quoteRequired ? NaN : r.perApp)),
    notes: `Quarterly station-check applications; priced by home size and structural complexity. WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%.`,
  }));

  // Station rental publishes only while its purchase gate is on — the
  // estimate flow's GATE_TERMITE_STATION_RENTAL is the choke point
  // (predicate mirrors estimate-engine.js). Rental rides the install price,
  // so the sweep derives per-application rental from the bait installs.
  if (purchaseGateOn('termite_station_rental')) {
    add('termite_station_rental', () => rangeRow({
      key: 'termite_station_rental',
      name: 'Termite Bait Station Rental',
      unit: 'per application',
      values: sweepValues(
        TYPICAL_FOOTPRINTS,
        (f) => sp.priceTermiteStationRental(sp.priceTermiteBait({ footprint: f }, {}).installation?.price),
        (r) => r && r.perApp),
      notes: 'Rented-station alternative to the upfront installation; rides quarterly applications.',
    }));
  }

  // Bond pricing publishes only while the purchase path exists: the estimate
  // flow's GATE_TERMITE_BOND_OPTION is the single choke point (predicate
  // mirrors estimate-engine.js), and advertising an option the exact-quote
  // flow refuses to offer would mislead agents.
  if (purchaseGateOn('termite_bond')) {
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
    name: 'Bora-Care Wood Treatment Service',
    unit: 'per job',
    values: sweepValues(
      [
        { atticSqFt: 1000 },
        { atticSqFt: 2000 },
        { surfaceLinearFt: 50, surfaceHeightFt: 2 },
      ],
      (opts) => sp.priceBoraCare({ footprint: MEDIAN_FOOTPRINT }, opts),
      (r) => (r.quoteRequired ? NaN : r.price)),
    notes: 'Borate treatment for exposed wood; priced by treated attic and surface area — larger areas price higher at the same per-area rates.',
  }));

  add('termite_trenching', () => rangeRow({
    key: 'termite_trenching',
    name: 'Termite Trenching (liquid barrier)',
    unit: 'per job',
    // Typical homes' perimeters (the engine's own footprint-to-perimeter
    // estimate at typical landscape complexity) x every product, at
    // standard scheduling.
    values: sweepValues(
      TYPICAL_FOOTPRINTS.flatMap((footprint) =>
        TYPICAL_LANDSCAPES.flatMap(({ complexity }) =>
          Object.keys(constants.SPECIALTY.trenching.products).map((productKey) => ({ footprint, complexity, productKey })))),
      ({ footprint, complexity, productKey }) => sp.priceTrenching({ footprint }, {
        perimeterLF: calculatePerimeter(footprint, complexity),
        productKey, applicationRate: 'standard', trenchDepthFt: 1, warrantyTier: 'none', concretePct: 0.2, labelConfirmed: true,
      }),
      (r) => (r.quoteRequired || !Number.isFinite(r.price) ? NaN : r.price)),
    notes: 'Priced by treated perimeter and product; longer measured perimeters, deeper trenching, a higher application rate, added warranty terms, and greater concrete coverage price higher; exact footage measured on site.',
  }));

  add('pre_slab_termiticide', () => rangeRow({
    key: 'pre_slab_termiticide',
    name: 'Pre-Slab Termiticide Treatment',
    unit: 'per job',
    // Typical slab area x every product, standalone scheduling, no volume
    // discount, no extended warranty.
    values: sweepValues(
      [1500, 2500, 3500].flatMap((slabSqFt) =>
        Object.keys(constants.SPECIALTY.preSlabTermiticide.products).map((productKey) => ({ slabSqFt, productKey }))),
      ({ slabSqFt, productKey }) => sp.pricePreSlabTermiticide({ slabSqFt }, {
        productKey, jobContext: 'standalone', volumeDiscount: 'none', includeWarrantyExtended: false, labelConfirmed: true,
      }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.price ?? r.treatmentPrice))),
    notes: 'New-construction slab pre-treatment priced by slab area and product for a standalone job — larger slabs price higher by the same usage-step formula. Builder-batch or same-trip scheduling and volume discounts can lower the price; extended warranty adds cost.',
  }));

  // Owner-set display range (ruling 2026-09-27): live engine prices are
  // merged so a price change outside it still widens the row.
  add('wdo_inspection', () => rangeRow({
    key: 'wdo_inspection',
    name: 'WDO Inspection',
    unit: 'per inspection',
    values: [150, 350].concat(sweepValues(TYPICAL_FOOTPRINTS, (f) => sp.priceWDO(f), (r) => r.price)),
    notes: 'Wood-destroying organism inspection with official FDACS report.',
  }));

  add('lawn_care_program', () => rangeRow({
    key: 'lawn_care_program',
    name: 'Lawn Care Program',
    unit: 'per application',
    values: sweepValues(
      TYPICAL_TURF.flatMap((sq) =>
        Object.keys(constants.LAWN_BRACKETS).flatMap((track) =>
          LAWN_TIER_KEYS.map((tier) => ({ sq, track, tier })))),
      ({ sq, track, tier }) => sp.priceLawnCare({ lawnSqFt: sq }, { track, tier }),
      (r) => r.perApp),
    notes: `${lawnCadenceText} applications per year by tier; priced by grass type and treatable turf area — larger or more complex lawns price higher. WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%.`,
  }));

  add('one_time_lawn', () => rangeRow({
    key: 'one_time_lawn',
    name: 'One-Time Lawn Treatment',
    unit: 'per treatment',
    values: sweepValues(
      TYPICAL_TURF.flatMap((sq) =>
        ['weed', 'fungicide', 'pest', 'fert'].flatMap((treatmentType) =>
          Object.keys(constants.LAWN_BRACKETS).flatMap((track) =>
            LAWN_TIER_KEYS.map((tier) => ({ sq, treatmentType, track, tier }))))),
      ({ sq, treatmentType, track, tier }) => sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType, track, tier, isRecurringCustomer: false }),
      (r) => r.price),
    notes: 'Priced by treatment type, grass type, and turf area. A recurring lawn plan prices lower.',
  }));

  add('lawn_pest_knockdown', () => rangeRow({
    key: 'lawn_pest_knockdown',
    name: 'Lawn Pest Knockdown Service',
    unit: 'per treatment',
    // The canonical lawnPestControl service: a standalone one-time
    // turf-pest treatment (chinch bugs, sod webworms, armyworms, grubs)
    // priced via the one-time lawn 'pest' multiplier as its own line.
    values: sweepValues(
      TYPICAL_TURF.flatMap((sq) =>
        Object.keys(constants.LAWN_BRACKETS).flatMap((track) =>
          LAWN_TIER_KEYS.map((tier) => ({ sq, track, tier })))),
      ({ sq, track, tier }) => sp.priceOneTimeLawn({ lawnSqFt: sq }, { treatmentType: 'pest', track, tier, isRecurringCustomer: false }),
      (r) => r.price),
    notes: 'Standalone turf-pest treatment (chinch bugs, sod webworms, armyworms, grubs); can be combined with a weed treatment.',
  }));

  add('dethatching', () => rangeRow({
    key: 'dethatching',
    name: 'Lawn Dethatching Service',
    unit: 'per job',
    // Bermuda/Zoysia lawns with easy access and none/light cleanup — the
    // typical auto-priced job; St. Augustine, heavier cleanup, and harder
    // access price higher or are review-gated.
    values: sweepValues(
      TYPICAL_TURF.flatMap((sq) =>
        ['bermuda', 'zoysia'].flatMap((grassType) =>
          ['none', 'light'].map((cleanupLevel) => ({ sq, grassType, cleanupLevel })))),
      ({ sq, grassType, cleanupLevel }) =>
        sp.priceDethatching(sq, { grassType, cleanupLevel, thatchDepthInches: 1, access: 'easy' }),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : (r.price ?? r.estimatedPrice))),
    notes: 'Bermuda and Zoysia lawns with easy access; moderate/heavy cleanup and harder access price higher. St. Augustine and large heavy-debris jobs are quoted after inspection.',
  }));

  add('one_time_mosquito', () => rangeRow({
    key: 'one_time_mosquito',
    name: 'One-Time Mosquito Treatment',
    unit: 'per treatment',
    values: sweepValues(
      TYPICAL_LOTS,
      (lotSqFt) => sp.priceOneTimeMosquito({ footprint: MEDIAN_FOOTPRINT, lotSqFt }, {}),
      (r) => (r.quoteRequired ? NaN : r.price)),
    notes: `Priced by treatable area — larger properties price higher by area increment. One-time add-ons per unit: mosquito stations $${Math.round(constants.ONE_TIME.mosquito.stationAddOn)} each, Bti dunks $${Math.round(constants.ONE_TIME.mosquito.dunkAddOn)} each. A recurring mosquito plan prices lower.`,
  }));

  add('lawn_plugging', () => rangeRow({
    key: 'lawn_plugging',
    name: 'Lawn Plugging Service',
    unit: 'per sq ft',
    decimals: 2,
    // Effective per-sq-ft rate varies with treated area because of the job
    // floor, so areas are swept alongside spacing (standard scheduling).
    values: sweepValues(
      [500, 1000, 3000].flatMap((area) => [6, 9, 12].map((spacing) => ({ area, spacing }))),
      ({ area, spacing }) => sp.pricePlugging(area, spacing),
      (r) => r.perSf),
    notes: 'Rate depends on plug spacing (6", 9", or 12") and treated area; small jobs carry a minimum.',
  }));

  add('top_dressing', () => rangeRow({
    key: 'top_dressing',
    name: 'Lawn Top Dressing Service',
    unit: 'per job',
    // Both pricing modes: estimated area (65% reduction) and exact-area
    // (measured, or recurring-lawn customers) on typical turf areas.
    values: sweepValues(
      TYPICAL_TURF.flatMap((sq) =>
        ['eighth', 'quarter'].flatMap((depth) => [false, true].map((exactArea) => ({ sq, depth, exactArea })))),
      ({ sq, depth, exactArea }) => sp.priceTopDressing(sq, depth, exactArea),
      (r) => r.price),
    notes: 'Recurring-plan customers receive a discounted rate; larger measured areas price higher at the same per-area rates.',
  }));

  // Auto-priced residential shapes: a bare lot and a planted/treed property
  // (bed area + tree count + access) at a typical scope.
  const TREE_SHRUB_PROFILES = [
    { property: { footprint: MEDIAN_FOOTPRINT }, options: {} },
    { property: { footprint: MEDIAN_FOOTPRINT, bedArea: 4000 }, options: { treeCount: 6, access: 'moderate' } },
  ];
  add('tree_shrub_care', () => rangeRow({
    key: 'tree_shrub_care',
    name: 'Tree & Shrub Care Program',
    unit: 'per month',
    // 'light' (4x/quarterly) is hidden:true — retired for new sales (owner
    // directive 2026-09-24: stop offering quarterly tree & shrub care) — so
    // it is never swept here.
    values: sweepValues(
      TYPICAL_LOTS.flatMap((lot) =>
        ['standard', 'enhanced'].flatMap((tier) =>
          TREE_SHRUB_PROFILES.map((p) => ({ lot, tier, p })))),
      ({ lot, tier, p }) => sp.priceTreeShrub({ ...p.property, lotSqFt: lot }, { ...p.options, tier }),
      (r) => r.monthly),
    notes: `Monthly-billed program; 6 or 9 applications per year by tier; priced by planting beds and tree count — larger counts price higher. WaveGuard bundle tiers discount up to ${maxWaveGuardPct}%.`,
  }));

  // rodent_plugging (calculatePluggingPrice) is deliberately NOT published:
  // no live route or client populates services.rodentPlugging — same
  // reachability rule as the omitted termite_foam pricer.

  // termite_foam (calculateFoamPrice) is deliberately NOT published: no live
  // route or client populates services.termiteFoam (DECISIONS.md records the
  // pricer as dead); the purchasable drill-and-foam path is the foam_drill row.

  add('rodent_wire_mesh', () => rangeRow({
    key: 'rodent_wire_mesh',
    name: 'Rodent Wire Mesh Exclusion Service',
    unit: 'per job',
    values: sweepValues(
      [30, 60, 120].flatMap((meshLinearFeet) =>
        Object.keys(constants.RODENT.wireMesh.substrates).map((meshSubstrate) => ({ meshLinearFeet, meshSubstrate }))),
      (opts) => sp.priceRodentWireMesh(opts),
      (r) => (r ? r.price : NaN)),
    notes: 'Priced per linear foot by substrate, with a job minimum; longer measured runs price higher at the same per-LF rates.',
  }));

  add('rodent_bird_boxes', () => rangeRow({
    key: 'rodent_bird_boxes',
    name: 'Roof-Entry Covers / Bird Boxes',
    unit: 'per job',
    values: sweepValues(
      ['small_bird_box', 'standard_bird_box'].flatMap((birdBoxType) =>
        [1, 2, 4].map((birdBoxQuantity) => ({ birdBoxType, birdBoxQuantity }))),
      (opts) => sp.priceRodentBirdBoxes(opts),
      (r) => (r ? r.price : NaN)),
    // Quantity is unbounded and strictly additive per unit — disclose the
    // live per-cover rates so any count or box type is quotable beyond the
    // range.
    notes: `Priced per cover: small $${Math.round(constants.RODENT.birdBoxes.small_bird_box)}, standard $${Math.round(constants.RODENT.birdBoxes.standard_bird_box)} (same-visit additional $${Math.round(constants.RODENT.birdBoxes.additional_standard_same_visit)}), large $${Math.round(constants.RODENT.birdBoxes.large_bird_box)}, oversized/custom $${Math.round(constants.RODENT.birdBoxes.oversized_complex_custom)}; larger boxes or quantities price higher at those rates.`,
  }));

  add('rodent_inspection', () => rangeRow({
    key: 'rodent_inspection',
    name: 'Rodent Inspection',
    unit: 'per inspection',
    values: [sp.priceRodentInspection({}).price].filter((v) => Number.isFinite(v) && v > 0),
    notes: `Creditable toward remediation work within ${sp.priceRodentInspection({}).creditableWithinDays} days.`,
  }));

  add('rodent_guarantee', () => rangeRow({
    key: 'rodent_guarantee',
    name: 'Rodent Guarantee Service',
    unit: 'per program',
    // Renewable guarantee premium by property tier; eligibility (completed
    // trapping/exclusion/sanitation) is a customer-state flag, not pricing.
    // Two typical property shapes — smaller/simpler and larger/complex.
    values: sweepValues(
      [
        { homeSqFt: 1500, stories: 1, roofType: 'shingle' },
        { homeSqFt: 3000, stories: 2, roofType: 'tile' },
      ],
      (opts) => sp.priceRodentGuarantee(opts),
      (r) => (r.quoteRequired || r.requiresManualReview ? NaN : r.price)),
    notes: 'Renewable 12-month rodent-free guarantee; eligibility requires completed trapping, completed exclusion, sanitation completed (or photo baseline), and no activity after the final trap check. Priced by property tier — larger, more complex properties price higher.',
  }));

  add('trap_only_retainer', () => rangeRow({
    key: 'trap_only_retainer',
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
    name: 'Recurring Termite Foam Service',
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
    name: 'Termite Foam Service',
    unit: 'per job',
    // Distinct from the termite_foam spot treatment: this is the tiered
    // drill-and-foam service the estimate path prices via priceFoamDrill.
    values: sweepValues([5, 10, 15],
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
      ].flatMap((opts) => [3, 5, 10].map((palmCount) => ({ ...opts, palmCount }))),
      (opts) => sp.pricePalmInjection({}, opts),
      // Actually-charged per palm per treatment — the per-visit minimum
      // raises small palm counts above the raw catalog rate.
      (r, { palmCount }) => r.perVisit / palmCount),
    notes: 'Nutrition, insecticide, combo, and TREE-age treatments. Larger or older palms and smaller palm counts price higher per palm. Fungal and lethal-bronzing work is diagnosed and quoted on site.',
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
  return [getLastSyncAt(), ...Object.values(PURCHASE_GATED_ROWS).map((gate) => process.env[gate] || '')].join('|');
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
    disclaimer: 'Typical ranges for a typical single-family home in our SW Florida service area, at list price under standard scheduling. WaveGuard bundles and recurring-customer discounts can lower the price. Larger or more complex properties, heavier infestations, bigger scopes, and emergency, urgent, or after-hours service price higher. Get an instant quote at https://www.wavespestcontrol.com/pest-control-calculator/. Commercial properties are custom-quoted.',
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

module.exports = { computePublicPricingRanges, lastComputeUnstable, PURCHASE_GATED_ROWS, _internals: { buildRows } };
