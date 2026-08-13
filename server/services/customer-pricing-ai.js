const pricingEngine = require('./pricing-engine');
const logger = require('./logger');
const { loadExistingQualifyingServiceKeys, loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
const { storiesSourceForPricing } = require('./estimator-engine/draft-builder');

const RECURRING_SERVICE_ORDER = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub'];
const TIER_MIN_SERVICE_COUNT = {
  Bronze: 1,
  Silver: 2,
  Gold: 3,
  Platinum: 4,
};
const WAVEGUARD_TIERS = Object.keys(TIER_MIN_SERVICE_COUNT);

const SERVICE_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  mosquito: 'Mosquito Control',
  tree_shrub: 'Tree & Shrub Care',
  termite: 'Termite Bait Monitoring',
  rodent_bait: 'Rodent Monitoring',
  palm: 'Palm Injection',
  one_time_lawn: 'Lawn Follow-Up Visit',
  one_time_mosquito: 'One-Time Mosquito Treatment',
};

const SERVICE_MATCHERS = [
  { key: 'one_time_lawn', re: /\b(fungicide|fungus|brown patch|lawn boost|weed treatment|weed visit|fertilization|fertilizer|turf recovery)\b/i },
  { key: 'one_time_mosquito', re: /\b(event spray|party spray|one[-\s]?time mosquito|mosquito event)\b/i },
  { key: 'lawn_care', re: /\b(lawn|grass|turf|weed control|fertiliz|chinch|sod)\b/i },
  { key: 'mosquito', re: /\b(mosquito|mosquitoes|no[-\s]?see[-\s]?um|midge)\b/i },
  { key: 'tree_shrub', re: /\b(tree|shrub|ornamental|landscape plant|hedge)\b/i },
  { key: 'palm', re: /\b(palm|palms|lethal bronzing|palm injection)\b/i },
  { key: 'termite', re: /\b(termite|wdo|swarm|swarmers)\b/i },
  { key: 'rodent_bait', re: /\b(rodent|rat|rats|mouse|mice|bait station|bait stations)\b/i },
  { key: 'pest_control', re: /\b(pest|bug|bugs|roach|roaches|ant|ants|spider|spiders|quarterly)\b/i },
];

const LINE_SERVICE_KEYS = {
  pest_control: 'pest_control',
  lawn_care: 'lawn_care',
  mosquito: 'mosquito',
  tree_shrub: 'tree_shrub',
  termite: 'termite_bait',
  rodent_bait: 'rodent_bait',
  palm: 'palm_injection',
  one_time_lawn: 'one_time_lawn',
  one_time_mosquito: 'one_time_mosquito',
};

function positiveNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function toKeyLabel(key) {
  return SERVICE_LABELS[key] || String(key || '').replace(/_/g, ' ');
}

function normalizeWaveGuardTier(value) {
  const raw = String(value || '').trim().toLowerCase();
  return WAVEGUARD_TIERS.find(tier => tier.toLowerCase() === raw) || null;
}

function normalizeGrassType(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (raw.includes('bermuda')) return 'bermuda';
  if (raw.includes('zoysia')) return 'zoysia';
  if (raw.includes('bahia')) return 'bahia';
  if (raw.includes('st_aug') || raw.includes('staug') || raw.includes('augustine')) return 'st_augustine';
  return 'st_augustine';
}

function serviceKeyFromText(value) {
  const text = String(value || '');
  if (!text.trim()) return null;
  const lower = text.toLowerCase();
  if (/\b(one[-\s]?time|callback|inspection|wdo|event spray|initial|knockdown|bed bug|flea|trapping|exclusion)\b/.test(lower)) {
    if (/\b(lawn|grass|turf|weed|fungicide|fertiliz)\b/.test(lower)) return 'one_time_lawn';
    if (/\b(mosquito|event spray)\b/.test(lower)) return 'one_time_mosquito';
    if (/\b(termite|wdo)\b/.test(lower)) return 'termite';
    return null;
  }
  for (const matcher of SERVICE_MATCHERS) {
    if (matcher.re.test(text)) return matcher.key;
  }
  return null;
}

function inferRequestedServices(prompt, currentServiceKeys = new Set()) {
  const text = String(prompt || '').trim();
  const explicit = [];
  for (const matcher of SERVICE_MATCHERS) {
    if (matcher.re.test(text) && !explicit.includes(matcher.key)) explicit.push(matcher.key);
  }
  if (explicit.length) return explicit;

  return RECURRING_SERVICE_ORDER
    .filter(key => !currentServiceKeys.has(key))
    .slice(0, 4);
}


function currentServiceObjectsFor(keys, context) {
  const services = {};
  for (const key of keys) {
    if (key === 'pest_control') services.pest = { frequency: 'quarterly' };
    if (key === 'lawn_care') services.lawn = {
      track: context.grassType,
      tier: 'enhanced',
      lawnFreq: 9,
    };
    if (key === 'mosquito') services.mosquito = { tier: 'monthly12' };
    if (key === 'tree_shrub') services.treeShrub = { tier: 'standard' };
    // Trelona-only menu (owner 2026-07-28); 'advance' is replay-only.
    if (key === 'termite') services.termite = { system: 'trelona', monitoringTier: 'basic' };
    if (key === 'rodent_bait') services.rodentBait = {};
  }
  return services;
}

function optionServices(option, context) {
  if (option.serviceKey === 'pest_control') return { pest: { frequency: option.frequency || 'quarterly' } };
  if (option.serviceKey === 'lawn_care') return {
    lawn: {
      track: context.grassType,
      tier: option.tier,
      lawnFreq: option.lawnFreq,
    },
  };
  if (option.serviceKey === 'mosquito') return { mosquito: { tier: option.program } };
  if (option.serviceKey === 'tree_shrub') return { treeShrub: { tier: option.tier } };
  if (option.serviceKey === 'termite') return { termite: { system: 'trelona', monitoringTier: 'basic' } };
  if (option.serviceKey === 'rodent_bait') return { rodentBait: {} };
  if (option.serviceKey === 'palm') return {
    palm: {
      palmCount: positiveInteger(context.palmCount),
      treatmentType: option.treatmentType || 'combo',
      palmSize: option.palmSize || 'medium',
    },
  };
  if (option.serviceKey === 'one_time_lawn') return {
    oneTimeLawn: {
      treatmentType: option.treatmentType || 'weed',
      track: context.grassType,
      tier: 'enhanced',
      lawnFreq: 9,
    },
  };
  if (option.serviceKey === 'one_time_mosquito') return { oneTimeMosquito: {} };
  return {};
}

function variantsForService(serviceKey, prompt = '', generic = false) {
  if (serviceKey === 'pest_control') {
    const all = [
      { id: 'pest-quarterly', serviceKey, label: 'Quarterly pest control', frequency: 'quarterly', cadence: '4 visits/year' },
      { id: 'pest-bimonthly', serviceKey, label: 'Bi-monthly pest control', frequency: 'bimonthly', cadence: '6 visits/year' },
      { id: 'pest-monthly', serviceKey, label: 'Monthly pest control', frequency: 'monthly', cadence: '12 visits/year' },
    ];
    return generic ? all.slice(0, 1) : all;
  }
  if (serviceKey === 'lawn_care') {
    // 'basic' (lawnFreq 4) is RETIRED for new sales (owner directive
    // 2026-07-09) — never offer or price it here. Standard stays first so
    // the portal panel (which auto-selects options[0]) keeps defaulting to
    // the 6-application plan.
    const all = [
      { id: 'lawn-standard', serviceKey, label: 'Lawn care — 6x applications/yr', tier: 'standard', lawnFreq: 6, cadence: '6 applications/yr' },
      { id: 'lawn-enhanced', serviceKey, label: 'Lawn care — 9x applications/yr', tier: 'enhanced', lawnFreq: 9, cadence: '9 applications/yr' },
      { id: 'lawn-premium', serviceKey, label: 'Lawn care — 12x applications/yr', tier: 'premium', lawnFreq: 12, cadence: '12 applications/yr' },
    ];
    if (generic) return all.filter(o => o.id === 'lawn-enhanced');
    // Tier-intent narrowing uses the tier name or application-count wording only.
    // The count form accepts an optional "x" so the "Nx applications/yr" labels
    // a customer can copy from an option ("12x applications/yr", "9x") map
    // to the right tier; a bare "Nx" token counts too. 6x is Standard, which is
    // the default returned by the fallthrough below, so it needs no branch.
    // Bare cadence words ("quarterly"/"monthly") are NOT matched: in a prompt
    // like "I have quarterly pest and want lawn care" the cadence refers to the
    // existing pest plan, so matching it would wrongly hide the other lawn tiers.
    // "basic"/"4x" prompts intentionally fall through to the full sold ladder —
    // the retired 4-application plan must neither be advertised nor silently
    // priced as a different tier under its old label.
    if (/\bpremium\b|\b12x?\s*(?:applications?|apps?|visits?|treatments?)\b|\b12x\b/i.test(prompt)) {
      return all.filter(o => o.id === 'lawn-premium');
    }
    if (/\benhanced\b|\b9x?\s*(?:applications?|apps?|visits?|treatments?)\b|\b9x\b/i.test(prompt)) {
      return all.filter(o => o.id === 'lawn-enhanced');
    }
    return all;
  }
  if (serviceKey === 'mosquito') {
    const all = [
      { id: 'mosquito-seasonal', serviceKey, label: 'Seasonal mosquito program', program: 'seasonal9', cadence: '9 visits/year' },
      { id: 'mosquito-monthly', serviceKey, label: 'Monthly mosquito program', program: 'monthly12', cadence: '12 visits/year' },
    ];
    return generic ? all.slice(1) : all;
  }
  if (serviceKey === 'tree_shrub') {
    // 6-visit Standard is the mandated default; Light (4x) is the downsell;
    // Enhanced (9x, un-retired 2026-07-24) is the every-6-weeks upsell —
    // offered, never recommended. Premium (12x) stays retired.
    const all = [
      { id: 'tree-standard', serviceKey, label: 'Standard tree & shrub care', tier: 'standard', cadence: '6 visits/year' },
      { id: 'tree-light', serviceKey, label: 'Light tree & shrub care', tier: 'light', cadence: '4 visits/year' },
      { id: 'tree-enhanced', serviceKey, label: 'Enhanced tree & shrub care', tier: 'enhanced', cadence: '9 visits/year' },
    ];
    return generic ? all.slice(0, 1) : all;
  }
  if (serviceKey === 'termite') {
    // ONE variant (owner 2026-07-28): the Premier tier is retired and the
    // station check prices by station count — two identically-priced
    // "tiers" would let a customer request a plan that no longer exists.
    return [
      { id: 'termite-basic', serviceKey, label: 'Termite bait monitoring', monitoringTier: 'basic', cadence: 'Quarterly station check, billed per application' },
    ];
  }
  if (serviceKey === 'one_time_lawn') {
    if (/fungicide|fungus|brown patch/i.test(prompt)) {
      return [{ id: 'ot-lawn-fungicide', serviceKey, label: 'Fungicide lawn follow-up', treatmentType: 'fungicide', cadence: 'One-time visit' }];
    }
    if (/fertiliz/i.test(prompt)) {
      return [{ id: 'ot-lawn-fert', serviceKey, label: 'Fertilization lawn follow-up', treatmentType: 'fert', cadence: 'One-time visit' }];
    }
    return [{ id: 'ot-lawn-weed', serviceKey, label: 'Targeted lawn follow-up', treatmentType: 'weed', cadence: 'One-time visit' }];
  }
  if (serviceKey === 'one_time_mosquito') {
    return [{ id: 'ot-mosquito', serviceKey, label: 'One-time mosquito treatment', cadence: 'One-time visit' }];
  }
  if (serviceKey === 'rodent_bait') {
    return [{ id: 'rodent-bait', serviceKey, label: 'Rodent monitoring stations', cadence: 'Quarterly station service' }];
  }
  if (serviceKey === 'palm') {
    return [{ id: 'palm-combo', serviceKey, label: 'Palm nutrition + insect protection', treatmentType: 'combo', cadence: 'Annualized palm program' }];
  }
  return [];
}

async function safeSelect(db, table, buildQuery) {
  if (!db) return [];
  try {
    return await buildQuery(db(table));
  } catch (err) {
    logger.warn(`[customer-pricing-ai] ${table} lookup skipped: ${err.message}`);
    return [];
  }
}

async function loadCurrentServiceKeys(db, customer) {
  if (!db || !customer?.id) return { currentServiceKeys: [], ownedServiceKeys: [] };
  try {
    // Scope BOTH sets to the property being priced (codex #3253 r2): this
    // panel prices the customer's PRIMARY address, so a plan active only at a
    // secondary property must neither model the baseline nor block a quote
    // here. Same stamped → creating-estimate → primary-street resolution as
    // estimate scoping (#3244); an empty primary street keeps the
    // conservative account-wide set.
    const { normalizedStampedStreet } = require('./estimate-property-linkage');
    // Locality-qualified per #3248: city/zip segments keep two same-named
    // streets in different cities from merging (empty segments wildcard).
    const primaryStreet = normalizedStampedStreet(customer.address_line1, customer.address_line2, customer.city, customer.zip);
    const streetScope = primaryStreet
      ? { estimateStreet: primaryStreet, customerPrimaryStreet: primaryStreet }
      : null;
    const mapKey = key => key === 'termite_bait' ? 'termite' : key;
    // Each lookup fails INDEPENDENTLY (codex #3253 r4): a transient failure
    // in the broader ownership query must not discard already-known
    // qualifying keys — that would treat an existing customer as owning
    // nothing and emit the fresh quote this module exists to prohibit (and
    // undercount earned tiers). ownedSet is unioned with the qualifying keys
    // downstream, so a failed ownership lookup degrades to qualifying-only.
    let currentServiceKeys = [];
    try {
      // WaveGuard is count-based across the customer's actual active
      // recurring qualifying services. A tier label alone never identifies
      // which services the customer bought, so it must not seed a
      // Pest/Lawn/Mosquito basket.
      currentServiceKeys = (await loadExistingQualifyingServiceKeys(db, customer.id, { streetScope })).map(mapKey);
    } catch (err) {
      logger.warn(`[customer-pricing-ai] qualifying service lookup skipped: ${err.message}`);
    }
    let ownedServiceKeys = [];
    let ownershipLookupFailed = false;
    try {
      // Ownership is BROADER than qualification (codex #3253 r2): recurring
      // rodent bait monitoring never raises a tier but absolutely means the
      // customer has rodent service — the never-re-price rule must see it.
      ownedServiceKeys = (await loadOwnedRecurringServiceKeys(db, customer.id, { streetScope })).map(mapKey);
    } catch (err) {
      // FAIL CLOSED (codex #3253 r4): unknown ownership must not price —
      // the caller returns manual review instead of a fresh quote the
      // customer may already be paying a different rate for.
      ownershipLookupFailed = true;
      logger.warn(`[customer-pricing-ai] ownership lookup failed — pricing withheld: ${err.message}`);
    }
    return { currentServiceKeys, ownedServiceKeys, ownershipLookupFailed };
  } catch (err) {
    logger.warn(`[customer-pricing-ai] active service lookup failed — pricing withheld: ${err.message}`);
    return { currentServiceKeys: [], ownedServiceKeys: [], ownershipLookupFailed: true };
  }
}

async function loadTurfProfile(db, customerId) {
  const rows = await safeSelect(db, 'customer_turf_profiles', q => q
    .where({ customer_id: customerId })
    .where(function activeScope() {
      this.where({ active: true }).orWhereNull('active');
    })
    .first());
  return rows || null;
}

function addressForCustomer(customer = {}) {
  return [
    customer.address_line1,
    customer.address_line2,
    customer.city,
    customer.state,
    customer.zip,
  ].filter(Boolean).join(', ');
}

function lookupEnabled() {
  return process.env.CUSTOMER_PRICING_AI_LOOKUP !== 'false';
}

// Every field the accepted-estimate seed can fill, in one list so a blanket
// rejection cannot silently miss one. A wrong-premises lookup rejects all of
// them (codex #3367 PR r18); the per-field rejections elsewhere name their
// own members. Keep in sync with the seed replay in resolvePropertyContext.
const SEED_FILLABLE_FIELDS = [
  'homeSqFt', 'lotSqFt', 'lawnSqFt', 'bedArea', 'stories',
  'propertyType', 'yearBuilt', 'constructionMaterial', 'foundationType', 'roofType',
  'pool', 'poolCage', 'poolCageSize', 'nearWater',
  'shrubs', 'trees', 'complexity', 'irrigation', 'treeCount', 'attachedGarage',
];

// Columns the `customers` table ACTUALLY has for pricing (verified against
// the live schema 2026-08-09): bed_sqft, canopy_type, lot_sqft, palm_count,
// property_sqft, property_type. Everything else this resolver used to read
// — home_sqft, square_footage, lot_size_sqft, lawn_sqft,
// estimated_bed_area_sf, stories, pool, pool_cage, near_water,
// shrub_density, tree_density, landscape_complexity, irrigation(_system),
// tree_count, year_built, construction_material, foundation_type, roof_type
// — DOES NOT EXIST. Those reads resolved to undefined and silently took the
// 'moderate' / false / 0 defaults, so a caged-pool, heavy-landscaping home
// was quoted at the bare-property price. customer_turf_profiles has no
// palm_count either. The property LOOKUP is the real source for all of
// them; the gate below is what has to open for it to be consulted.
// Shared trust predicates — the agent draft path applies the same rule.
const {
  lookupBedAreaIsTrustworthy, lookupBedAreaReadIsFlagged,
  lookupFeatureReadIsFlagged, lookupFeaturesAreTrustworthy, hasGlobalVerifyFlag,
  lookupPropertyTypeIsTrustworthy, recordPropertyTypeIsTrustworthy, lookupDimensionIsTrustworthy,
  lookupTurfEstimateIsTrustworthy, lookupTurfReadIsTrustworthy,
  lookupTurfZeroIsObserved, lookupTreeCountIsTrustworthy,
  structuralFactIsTrustworthy,
  poolFeaturesAreRecordBacked, poolCageIsRecordBacked,
} = require('./lookup-confidence');

async function resolvePropertyContext({ customer, turfProfile, propertyLookup, propertySeed = null }) {
  let source = 'customer_profile';
  const address = addressForCustomer(customer);
  // customers.property_sqft is TREATED LAWN AREA by schema (initial_schema
  // 20260401000001) — the agent path plumbs it to measuredTurfSf for exactly
  // that reason. Reading it as the building footprint mispriced every
  // footprint-driven service, and since the lookup only FILLS a missing
  // value it could never be corrected afterwards. Home square footage comes
  // from a genuine building source (the lookup) or not at all; a missing one
  // fails closed to PROPERTY_DETAILS_NEEDED, which asks rather than guesses.
  let homeSqFt = null;
  let lotSqFt = positiveNumber(customer.lot_sqft);
  // customer_turf_profiles.lawn_sqft is nullable and its admin route accepts
  // an explicit 0 — "no lawn" is a real stored measurement, and the lawn
  // pricer itself preserves any >= 0 turf figure rather than defaulting it.
  // positiveNumber would eat that zero and resurrect the stale mirrored
  // customer.property_sqft, quoting lawn care on a lawn the profile says
  // does not exist. Fall back only when the profile is SILENT (null/absent).
  const profileLawnRaw = turfProfile?.lawn_sqft;
  const profileLawn = profileLawnRaw === null || profileLawnRaw === undefined || profileLawnRaw === ''
    ? null
    : Number(profileLawnRaw);
  let lawnKnownZero = profileLawn === 0;
  let lawnSqFt = Number.isFinite(profileLawn) && profileLawn > 0
    ? profileLawn
    : (lawnKnownZero ? 0 : positiveNumber(customer.property_sqft));
  let bedArea = positiveNumber(customer.bed_sqft);
  // Provenance is load-bearing money data, not a label: the T&S pricer
  // applies its shrub-density factor to MEASURED bed areas only, so an
  // AI-derived area must never claim to be an operator measurement.
  let bedAreaSource = bedArea ? 'explicit' : undefined;
  let stories = null;
  let storiesEvidence = null;
  let propertyType = customer.property_type || 'single_family';
  // Whether the lookup/record actually SUPPLIED the type — 'single_family'
  // is also the resolver default, so the value alone can't prove provenance
  // (codex #3367 PR r3: a stale seeded 'condo'/'townhome' must not replace
  // a trusted lookup classification that happens to equal the default).
  let propertyTypeFromLookup = false;
  let yearBuilt = null;
  let constructionMaterial = null;
  let foundationType = null;
  let roofType = null;
  let palmCount = positiveNumber(customer.palm_count);
  let lookupMeta = null;
  // Feature defaults, NOT observations: the profile carries no feature
  // columns, so these stand only until the lookup answers. treeCount is
  // deliberately ABSENT, not 0 — priceTreeShrub treats any supplied count
  // (including 0) as explicit and skips its density fallback, so a default
  // zero would price no per-tree labor or material with no review warning.
  let features = {
    pool: false,
    poolCage: false,
    nearWater: false,
    shrubs: 'moderate',
    trees: 'moderate',
    complexity: 'moderate',
    irrigation: false,
  };
  // WHICH feature fields carried adopted lookup evidence (trusted vision
  // read or record-backed pool/cage). Read by the seed block below: seeded
  // feature evidence fills FIELD-BY-FIELD into the gaps the lookup left
  // (pre-push codex r11 P0: the old all-or-nothing flag let a lone
  // record-backed pool discard the seed's shrub/tree/complexity/irrigation
  // evidence that priced the accepted estimate — a bare-property rate
  // would price-lock for a home whose accepted estimate carried the
  // modifiers).
  const lookupFeatureKeys = new Set();
  // Dimensions the LOOKUP explicitly REFUSED (codex #3367 PR r14). A field
  // carrying its own fieldVerifyFlags entry — or every field, when the
  // global address flag says the lookup may describe a different premises —
  // is not adopted below because the lookup itself said to verify it first.
  // That is a rejection, not a gap, and the accepted-estimate seed fill must
  // not quietly launder an older number into the hole it left: the price is
  // graded solely on the inputs it ends up with, so a measurement the lookup
  // flagged would publish as an exact per-application figure anyway. Only
  // the seed path consults this — a rejected dimension with no seed already
  // fails closed to the pricer's own missing-property handling.
  const lookupRejectedFields = new Set();

  // The gate used to be (!homeSqFt || !lotSqFt), which meant a customer
  // whose row carried both was NEVER looked up — and therefore priced
  // forever as pool-less, moderate-density, zero-tree, because the profile
  // has no column for any of those. The lookup is the ONLY source of
  // feature evidence, and no stored value can stand in for it (bed area and
  // palm count say nothing about a pool cage or landscape complexity), so
  // it runs whenever one is available. The caller already gates on there
  // being something to price, and the route is rate-limited per customer.
  if (lookupEnabled() && address && propertyLookup) {
    try {
      const lookup = await propertyLookup(address);
      const p = lookup?.enriched || {};
      const record = lookup?.propertyRecord || lookup?.rentcast || {};
      source = homeSqFt || lotSqFt ? 'customer_profile_plus_property_lookup' : 'property_lookup';
      lookupMeta = {
        used: true,
        errors: lookup?.errors || [],
        providers: p.propertyProviders || record._aiProviders || [],
      };
      // An 'address' / 'all' flag means the lookup may describe a DIFFERENT
      // premise (geocoder snapped) or have no record at all — so nothing it
      // returned may price this customer's property, not just the bed area
      // and features. Adopt none of it; the profile's own values stand and a
      // missing home size fails closed to PROPERTY_DETAILS_NEEDED.
      const lookupDescribesThisProperty = !hasGlobalVerifyFlag(p);
      if (!lookupDescribesThisProperty) {
        // The premises itself is unverified — the lookup may describe a
        // different parcel entirely — so NOTHING may be back-filled from an
        // older estimate: not the dimensions, not the features, not the
        // classification, not the structural facts (codex #3367 PR r18).
        // Rejecting only the dimensions still let a customer whose stored
        // sqft was sufficient receive an exact price built on the older
        // estimate's modifiers, for a property we cannot prove is theirs.
        for (const field of SEED_FILLABLE_FIELDS) lookupRejectedFields.add(field);
      } else {
        // FLAG-based rejections only. The bed-area and turf-ESTIMATE
        // predicates also return false when the lookup simply carried no
        // value, which is an ordinary gap the seed exists to fill — reading
        // those as rejections would strip the seed from nearly every offer.
        // lookupTurfReadIsTrustworthy is the value-agnostic one: it fires
        // on a turf/lawn verify flag or inadequate confidence, both of
        // which are the lookup refusing its own read.
        if (!lookupDimensionIsTrustworthy(p, 'homeSqFt')) lookupRejectedFields.add('homeSqFt');
        if (!lookupDimensionIsTrustworthy(p, 'lotSqFt')) lookupRejectedFields.add('lotSqFt');
        if (!lookupDimensionIsTrustworthy(p, 'stories')) lookupRejectedFields.add('stories');
        if (!lookupTurfReadIsTrustworthy(p)) lookupRejectedFields.add('lawnSqFt');
        // Bed area is flag-rejected by its OWN flag or by the turf/imagery
        // flag it shares a picture with (codex #3367 PR r15). Only the flag
        // counts: lookupBedAreaIsTrustworthy also returns false for a
        // missing value, which is the ordinary gap the seed exists to fill.
        if (lookupBedAreaReadIsFlagged(p)) lookupRejectedFields.add('bedArea');
      }
      if (lookupDescribesThisProperty) {
      // Weak or conflicting core dimensions arrive with their own
      // fieldVerifyFlags (the flag builder marks squareFootage / lotSize /
      // stories HIGH-priority). This path has no review lane, so a flagged
      // dimension is not adopted at all — a missing required measurement
      // fails closed to PROPERTY_DETAILS_NEEDED rather than pricing on a
      // number the lookup itself said to verify first. Stored profile
      // values still win ahead of the fill either way.
      if (lookupDimensionIsTrustworthy(p, 'homeSqFt')) {
        homeSqFt = positiveNumber(homeSqFt, p.homeSqFt, record.squareFootage);
      }
      if (lookupDimensionIsTrustworthy(p, 'lotSqFt')) {
        lotSqFt = positiveNumber(lotSqFt, p.lotSqFt, record.lotSize);
      }
      // An explicit zero is a measurement, not a gap — the satellite turf
      // estimate must not overwrite it. And the estimate is a vision read
      // like the bed area: a low-confidence or turf-flagged one may not
      // become an exact self-service lawn price, so it is adopted only when
      // the lookup trusted its own read.
      if (!lawnKnownZero && lookupTurfEstimateIsTrustworthy(p)) {
        lawnSqFt = positiveNumber(lawnSqFt, p.estimatedTurfSf);
      } else if (!lawnKnownZero && !(lawnSqFt > 0) && lookupTurfZeroIsObserved(p)) {
        // A trusted vision ZERO is a measurement too (turfSource 'vision'
        // covers an observed no-lawn property; the synthetic no-basis zero
        // ships as 'none'). Without this, a no-lawn property with a lot on
        // file would fall through to the lot-based turf inference and be
        // quoted lawn care for a lawn the imagery shows does not exist. A
        // STORED positive turf measurement still wins over the vision zero.
        lawnKnownZero = true;
      }
      // Provenance rides WITH the value: a lookup-derived area is
      // 'estimated', never the operator-measured 'explicit'. And only a
      // CONFIDENT read is adopted — priceTreeShrub upgrades any bed area to
      // medium confidence with no review reason, so an area from obstructed
      // or stale imagery would become an exact customer-facing price the
      // lookup itself said needs verification. When in doubt we adopt
      // nothing and the pricer falls back to its own flagged inference.
      if (!bedArea && lookupBedAreaIsTrustworthy(p)) {
        bedAreaSource = 'estimated';
        bedArea = positiveNumber(p.estimatedBedAreaSf);
      }
      // A flagged stories read keeps the 1-story default — same doctrine as
      // the untrusted vision features: the default stands, the flag's
      // verification stays a human's job.
      if (lookupDimensionIsTrustworthy(p, 'stories')) {
        stories = positiveNumber(stories, p.stories, record.stories);
        // The AI stories-fallback stamps full provenance on the record
        // WITHOUT a fieldVerifyFlags entry — the flag check above cannot
        // see it. Carry the evidence so the provenance decision below can
        // grade a non-direct or low-confidence inference as 'estimated'
        // (same rule the agent path applies via source-arbitration).
        storiesEvidence = record._storiesEvidence || null;
      }
      // Property records normalize a missing field to the literal string
      // 'UNKNOWN', which is TRUTHY — a plain `record.x || enriched.x` chain
      // would stop there and silently drop the trusted value (costing the
      // wood-frame multiplier, the raised/crawlspace adjustment and the
      // tile-roof rodent adjustment on the structural facts below).
      const knownFact = (value) => {
        const v = String(value || '').trim();
        return v && v.toUpperCase() !== 'UNKNOWN' ? value : null;
      };
      // Property type carries its own pricing adjustment, and a
      // satellite-reclassified type ships with a fieldVerifyFlags entry
      // whose copy says confirm townhome vs single-family BEFORE pricing.
      // Now that the lookup runs even for fully populated profiles, an
      // unconditional adopt would let that unverified reclassification
      // override the customer's SAVED type on an exact quote — so a flagged
      // lookup type is ignored (county record, then stored type, stand).
      // The record fallback needs its OWN guard: the reclassifier mutates
      // the record in place (rc.propertyType, _propertyTypeSource:
      // 'satellite'), so a bare record read would hand the rejected
      // satellite type straight back.
      // The enriched propertyType may be the builder's synthesized
      // 'Single Family' display default, indistinguishable by value from
      // an observation (codex #3367 PR r7) — trust it only when the
      // profile's provenance bit says the record/vision supplied it.
      // Legacy cached profiles without _observed keep the old behavior.
      const typeObserved = !p._observed || p._observed.propertyType !== false;
      // A REFUSED classification is not a gap either (codex #3367 PR r18):
      // condo/townhome moves the price, so restoring the older estimate's
      // type publishes an exact amount on the very value the lookup says to
      // confirm first.
      // Only a type the lookup actually CARRIED can be refused. A silent
      // lookup is a gap the seed is entitled to fill (the r3 ruling), and
      // typeObserved alone does not distinguish them — it is true for a
      // legacy profile with no _observed bits at all, including one that
      // carried no classification.
      if (typeObserved && p.propertyType && !lookupPropertyTypeIsTrustworthy(p)) {
        lookupRejectedFields.add('propertyType');
      }
      const adoptedLookupType = (typeObserved && lookupPropertyTypeIsTrustworthy(p) ? p.propertyType : null)
        || (recordPropertyTypeIsTrustworthy(record) ? knownFact(record.propertyType) : null);
      if (adoptedLookupType) {
        propertyType = adoptedLookupType;
        propertyTypeFromLookup = true;
      }
      // Year built drives the pest/WDO age modifiers — same evidence gate
      // as the structural facts below (the enriched value is a mirror of
      // the same record merge, so one evidence bit covers both legs).
      if (!structuralFactIsTrustworthy({ record, field: 'yearBuilt' })) {
        // Same rejection bookkeeping as the structural facts below.
        lookupRejectedFields.add('yearBuilt');
      }
      yearBuilt = yearBuilt
        || (structuralFactIsTrustworthy({ record, field: 'yearBuilt' })
          ? (p.yearBuilt || record.yearBuilt)
          : null)
        || null;
      // Structural facts move pest, termite/WDO and rodent prices. The
      // county RECORD is authoritative and always applies (through the same
      // knownFact 'UNKNOWN' guard); the merged enriched value may have been
      // filled from vision when county data was absent, so it is adopted
      // only when the vision read is trusted.
      const visionFactsOk = lookupFeaturesAreTrustworthy(p);
      // A non-'UNKNOWN' record value is not proof of county evidence:
      // structural facts get merged into the record from listings/AI, and
      // those weak or conflicting merges carry fieldVerify on the record's
      // own _fieldEvidence. A disputed fact is withheld from BOTH legs —
      // the modifier simply does not apply, same as the untrusted-vision
      // default. (Evidence bit only — the fieldVerifyFlags stream also
      // carries same-named RISK notices on authoritative values, which must
      // keep pricing; see structuralFactIsTrustworthy.)
      const structuralFact = (field, recordValue, enrichedValue) => {
        // A disputed fact is a REJECTION, not a gap (pre-push P0): without
        // recording it, the seed block below restores the stale value the
        // lookup just refused and the engine prices on it.
        if (!structuralFactIsTrustworthy({ record, field })) {
          lookupRejectedFields.add(field);
          return null;
        }
        return knownFact(recordValue)
          || (visionFactsOk ? knownFact(enrichedValue) : null)
          || null;
      };
      constructionMaterial = constructionMaterial
        || structuralFact('constructionMaterial', record.constructionMaterial, p.constructionMaterial);
      foundationType = foundationType || structuralFact('foundationType', record.foundationType, p.foundationType);
      roofType = roofType || structuralFact('roofType', record.roofType, p.roofType);
      // p.estimatedPalmCount is deliberately NOT adopted. This is a
      // customer-facing quote route, and palmCount feeds palm-INJECTION
      // pricing through missingPropertyFor + resolvePalmCount — an AI count
      // would produce a confident per-palm price for palms nobody counted.
      // Same rule the agent draft path follows: AI counts are not
      // measurements. A missing count still routes to
      // PROPERTY_DETAILS_NEEDED, which asks the customer for it.
      // Vision-derived FEATURE modifiers all come off the same imagery read
      // the lookup grades. When it grades that read low (or flags it), none
      // of them may move a customer-facing price — the profile defaults
      // stand instead. Records-sourced facts below (year built, construction,
      // foundation, roof) are county data, not vision, so they are unaffected.
      const featuresTrusted = lookupFeaturesAreTrustworthy(p);
      // An attached garage is COUNTY data, not an imagery guess
      // (detectAttachedGarage reads the record's garageType), so it is
      // adopted at either grade — same standing as the record-backed
      // pool/cage below. Pest pricing charges a real adjustment for it and
      // the customers table has no column to fall back on, so a cached
      // lookup that KNOWS the property has one but never mapped it into the
      // features would price and lock a per-application amount BELOW the
      // true one (codex #3367 PR r16). Positive-only: detectAttachedGarage
      // returns false both for "no garage" and for "no garageType on file",
      // so a false is absence of evidence and must leave the seed's own
      // replay free to fill it.
      if (p.hasAttachedGarage === true) {
        features.attachedGarage = true;
        lookupFeatureKeys.add('attachedGarage');
      } else if (p.hasAttachedGarage === false && String(p.garageType || '').trim()) {
        // An observed NEGATIVE is evidence too (pre-push P0): the county
        // recorded a garage and it is not attached (DETACHED, CARPORT).
        // Marking only the positive lookup-backed let a stale seed restore
        // attachedGarage:true over that newer county fact and price-lock
        // the adjustment. detectAttachedGarage returns false for "no
        // garageType on file" as well, which is why the negative counts
        // only when the record actually named a garage type.
        features.attachedGarage = false;
        lookupFeatureKeys.add('attachedGarage');
      }
      // Record-backed pool/cage survive a low AI grade — assessor data, not
      // an imagery guess. Quoting a county-confirmed pool property as
      // pool-less because a photo was obstructed is the wrong failure.
      if (!featuresTrusted) {
        if (poolFeaturesAreRecordBacked(p)) {
          features.pool = p.pool === 'YES' || features.pool;
          lookupFeatureKeys.add('pool');
        }
        if (poolCageIsRecordBacked(p)) {
          features.poolCage = true;
          lookupFeatureKeys.add('poolCage');
          if (p.poolCageSize) {
            features.poolCageSize = String(p.poolCageSize).toLowerCase();
            lookupFeatureKeys.add('poolCageSize');
          }
        }
        // A FLAGGED vision read is a refusal, and a refusal is not a gap —
        // the seed may not restore the older estimate's value and let the
        // offer publish an exact price the current lookup says to verify
        // first (codex #3367 PR r17). Same rule the dimensions and
        // structural facts already follow.
        //
        // FLAG-ONLY, deliberately. This branch also covers a merely
        // LOW-GRADED read, and that case is a ruled behavior in the other
        // direction (pre-push r11 P0): weak imagery means fall back to
        // other evidence — the county-backed pool still prices and the
        // accepted-estimate seed still fills every other feature. Treating
        // a low grade as a refusal would price a bare-property rate for a
        // home whose accepted estimate carried the modifiers, which is the
        // bug that test exists to prevent.
        if (lookupFeatureReadIsFlagged(p)) {
          for (const key of ['pool', 'poolCage', 'poolCageSize', 'nearWater',
            'shrubs', 'trees', 'complexity', 'irrigation', 'treeCount']) {
            if (!lookupFeatureKeys.has(key)) lookupRejectedFields.add(key);
          }
        }
      } else {
        // A field is lookup-backed only when the trusted payload actually
        // carried a value for it — a silent field keeps its default here
        // and stays open for the seed's fill below. The densities,
        // complexity, and irrigation flags are SYNTHESIZED by
        // buildEnrichedProfile when unobserved ('MODERATE'/false), so
        // presence alone lies for them (codex #3367 PR r7) — their backing
        // comes from the profile's _observed provenance bits instead.
        // Legacy cached profiles without _observed keep presence semantics.
        const obs = (p._observed && typeof p._observed === 'object') ? p._observed : null;
        // An UNCERTAIN read is not a backing (codex #3367 PR r11): the vision
        // schema explicitly permits 'POSSIBLE' for pool and poolCage, and the
        // adoption line below maps only 'YES' to true. Counting POSSIBLE as
        // lookup-backed therefore blocks the accepted-estimate seed for a
        // field the lookup never actually decided — a previously priced
        // pool/cage silently becomes false and the report publishes an EXACT
        // per-application price BELOW the one real money was quoted on. Only
        // a decided answer backs the field; POSSIBLE stays open to the seed
        // and, with no seed, keeps the estimator's own doctrine (a satellite-
        // only pool is never charged). poolCageSize is derived from poolCage
        // (normalizePoolCageSize returns 'NONE' unless the cage is a YES), so
        // it is only decided when the cage itself is.
        const decidedFeature = (value) => {
          const v = String(value == null ? '' : value).trim().toUpperCase();
          return v === 'YES' || v === 'NO';
        };
        for (const [key, present] of Object.entries({
          // pool/cage/water are synthesized display STRINGS when unobserved
          // ('NO'/'UNKNOWN'/'NONE' — codex #3367 PR r8), so presence lies
          // for them exactly like the densities.
          pool: (obs ? !!obs.pool : !!p.pool) && decidedFeature(p.pool),
          poolCage: (obs ? !!obs.poolCage : !!p.poolCage) && decidedFeature(p.poolCage),
          poolCageSize: (obs ? !!obs.poolCageSize : !!p.poolCageSize) && decidedFeature(p.poolCage),
          nearWater: obs ? !!obs.nearWater : !!p.nearWater,
          shrubs: obs ? !!obs.shrubDensity : !!p.shrubDensity,
          trees: obs ? !!obs.treeDensity : !!p.treeDensity,
          complexity: obs ? !!obs.landscapeComplexity : !!p.landscapeComplexity,
          irrigation: obs
            ? !!obs.irrigationVisible
            : (p.irrigationVisible !== undefined && p.irrigationVisible !== null),
          treeCount: lookupTreeCountIsTrustworthy(p),
        })) {
          if (present) lookupFeatureKeys.add(key);
        }
      }
      features = !featuresTrusted ? features : {
        ...features,
        pool: p.pool === 'YES' || features.pool,
        poolCage: p.poolCage === 'YES' || features.poolCage,
        poolCageSize: String(p.poolCageSize || '').toLowerCase(),
        nearWater: p.nearWater && p.nearWater !== 'NONE' ? true : features.nearWater,
        shrubs: String(p.shrubDensity || features.shrubs || 'moderate').toLowerCase(),
        trees: String(p.treeDensity || features.trees || 'moderate').toLowerCase(),
        complexity: String(p.landscapeComplexity || features.complexity || 'moderate').toLowerCase(),
        irrigation: !!p.irrigationVisible || features.irrigation,
        // Only a POSITIVE observed count with FIELD-level confidence is a
        // count. The enriched payload coerces an absent read to 0, so zero
        // is indistinguishable from missing — and a gap-filled count from a
        // lone low-confidence provider can ride the blended average (same
        // trap as the bed area, hence the same stamped-confidence
        // predicate). Anything less stays unset and the pricer's density
        // fallback (which carries its own warning) runs.
        treeCount: lookupTreeCountIsTrustworthy(p) ? positiveNumber(p.estimatedTreeCount) : undefined,
      };
      } else {
        // Record-backed pool/cage still price — they are assessor data, not
        // a read of this (possibly wrong) parcel's imagery... except that a
        // wrong-premise flag means even the RECORD may be the wrong parcel,
        // so nothing is adopted here either. Kept explicit so the intent is
        // not mistaken for an oversight.
        lookupMeta.rejected = 'global_verify_flag';
      }
    } catch (err) {
      lookupMeta = { used: false, error: err.message };
      logger.warn(`[customer-pricing-ai] property lookup failed for customer ${customer.id}: ${err.message}`);
    }
  }

  // Gap-fill from the customer's own PRICED-ESTIMATE inputs (service-report
  // cross-sell): a dimension that already priced this property's live plan
  // may fill a gap the profile and lookup both left — it is the number real
  // money was quoted on. FILL ONLY, never override: a stored profile value,
  // an adopted lookup read, and a measured-zero lawn all outrank the seed.
  // Stories provenance replays the estimate's own storiesSource (default
  // 'estimated', which correctly keeps the stories_estimated review marker
  // for estimates that guessed).
  let storiesFromSeed = false;
  if (propertySeed) {
    // A field the lookup REJECTED is not a gap the seed may fill (codex
    // #3367 PR r14) — the lookup said to verify that measurement (or the
    // premises itself) before pricing, and the resulting price is graded on
    // whatever inputs it ends up with, so a seeded replacement publishes as
    // an exact figure with the caveat stripped off. Left unfilled, the
    // pricer's own missing-property handling applies and the offer demotes.
    const seedMayFill = (field) => !lookupRejectedFields.has(field);
    if (seedMayFill('homeSqFt') && !homeSqFt && propertySeed.homeSqFt > 0) homeSqFt = propertySeed.homeSqFt;
    if (seedMayFill('lotSqFt') && !lotSqFt && propertySeed.lotSqFt > 0) lotSqFt = propertySeed.lotSqFt;
    if (seedMayFill('lawnSqFt') && !lawnKnownZero && !(lawnSqFt > 0) && propertySeed.lawnSqFt > 0) {
      lawnSqFt = propertySeed.lawnSqFt;
    }
    if (seedMayFill('bedArea') && !bedArea && propertySeed.bedArea > 0) {
      bedArea = propertySeed.bedArea;
      // An operator-measured bed area stays explicit; anything else prices
      // as an estimate (the T&S pricer's density factor is measured-only).
      bedAreaSource = propertySeed.bedAreaSource === 'explicit' ? 'explicit' : 'estimated';
    }
    if (seedMayFill('stories') && !stories && propertySeed.stories > 0) {
      stories = propertySeed.stories;
      storiesFromSeed = true;
    }
    // Non-dimensional pricing evidence replays too (codex #3367 PR r1,
    // field-by-field per pre-push r11 P0): features (pool/cage/densities),
    // property type, and structural facts all move money — pricing a
    // seeded property against the resolver's non-observational defaults
    // would price-lock a bare-property rate for a home whose accepted
    // estimate carried the modifiers. Fill-only, PER FIELD: a lookup-backed
    // field always wins; every other field takes the seed's evidence over
    // the bare default.
    if (propertySeed.features
      && typeof propertySeed.features === 'object' && !Array.isArray(propertySeed.features)) {
      for (const [key, value] of Object.entries(propertySeed.features)) {
        if (value === undefined || value === null || value === '') continue;
        if (lookupFeatureKeys.has(key)) continue;
        // A feature the lookup REFUSED is not a gap either (codex #3367 PR
        // r17) — same bookkeeping the dimensions and structural facts use.
        if (!seedMayFill(key)) continue;
        features[key] = value;
      }
    }
    // Seed type fills only a true gap: no stored type AND no adopted
    // lookup/record classification (codex #3367 PR r3) — a trusted
    // single_family read is indistinguishable from the default by value,
    // so provenance is tracked explicitly above.
    if (seedMayFill('propertyType')
      && !customer.property_type && !propertyTypeFromLookup && propertyType === 'single_family'
      && typeof propertySeed.propertyType === 'string' && propertySeed.propertyType) {
      propertyType = propertySeed.propertyType;
    }
    // A structural fact the lookup REJECTED (weak or conflicting evidence on
    // the record's own _fieldEvidence) is not a gap the seed may refill —
    // restoring the stale value hands the engine exactly the input the
    // lookup just refused, and the offer publishes an exact price on it
    // (pre-push P0).
    if (seedMayFill('yearBuilt')) yearBuilt = yearBuilt || propertySeed.yearBuilt || null;
    if (seedMayFill('constructionMaterial')) {
      constructionMaterial = constructionMaterial || propertySeed.constructionMaterial || null;
    }
    if (seedMayFill('foundationType')) foundationType = foundationType || propertySeed.foundationType || null;
    if (seedMayFill('roofType')) roofType = roofType || propertySeed.roofType || null;
  }

  const grassType = normalizeGrassType(turfProfile?.track_key || turfProfile?.grass_type || customer.lawn_type);

  const propertyInput = {
    homeSqFt,
    lotSqFt,
    // An explicit zero rides through as 0 — the lawn pricer preserves >= 0,
    // and `undefined` would invite a downstream lot-based turf inference for
    // a lawn the profile measured as absent.
    lawnSqFt: lawnKnownZero ? 0 : (lawnSqFt || undefined),
    stories: stories || 1,
    // Provenance rides with the count: a defaulted story count (no lookup,
    // or a verify-flagged read discarded above) must say so, or the
    // story-sensitive pricers (pest per-story minutes, termite bait
    // footprint→perimeter) price a guessed one-story home with no
    // stories_estimated review marker on the quote. An adopted count is
    // graded through the SAME evidence rule the agent path uses
    // (draft-builder#storiesSourceForPricing): the AI stories-fallback
    // carries provenance without any verify flag, and a non-direct or
    // low-confidence inference must price as 'estimated', not 'lookup'.
    storiesSource: stories
      ? (storiesFromSeed
        ? (propertySeed?.storiesSource || 'estimated')
        : storiesSourceForPricing({ stories, storiesEvidence }))
      : 'default',
    propertyType,
    features,
    bedArea: bedArea || undefined,
    bedAreaSource: bedArea ? bedAreaSource : undefined,
    yearBuilt,
    constructionMaterial,
    foundationType,
    roofType,
    palmCount: positiveInteger(palmCount) || undefined,
  };

  return {
    propertyInput,
    grassType,
    palmCount,
    address,
    source,
    lookup: lookupMeta,
    hasHomeSqFt: homeSqFt > 0,
    hasLotSqFt: lotSqFt > 0,
    hasLawnSqFt: lawnSqFt > 0,
    lawnKnownZero,
    hasBedArea: bedArea > 0,
  };
}

function missingPropertyFor(serviceKeys, context) {
  // Nothing to price → nothing to measure. An owned-only request must reach
  // the not-re-pricing answer even when the profile lacks a home square
  // footage — the unconditional home_sqft check below otherwise turns it
  // into PROPERTY_DETAILS_NEEDED (codex #3253 r2).
  if (!serviceKeys.length) return null;
  // Home square footage is required only by the pricers that actually use a
  // building footprint. Now that it comes from the lookup alone (property_sqft
  // is treated LAWN area, not a footprint), an unconditional check would make
  // a failed or disabled lookup block lawn and Tree & Shrub quotes that price
  // off lot/lawn/bed measurements the profile already has.
  const OUTDOOR_ONLY_SERVICES = new Set([
    'lawn_care', 'tree_shrub', 'mosquito', 'one_time_lawn', 'one_time_mosquito', 'palm',
  ]);
  const needsHomeSqFt = serviceKeys.some(key => !OUTDOOR_ONLY_SERVICES.has(key));
  if (needsHomeSqFt && !context.hasHomeSqFt) return 'home_sqft';
  // Each outdoor pricer consumes a DIFFERENT area, so one shared
  // lot-or-lawn test both over- and under-blocks. Mosquito prices off the
  // LOT and never reads a turf figure — handed only a lawn area it emits its
  // zero-area low-confidence fallback, which this customer-facing path would
  // then quote as a real price. Tree & Shrub prices from the bed area (or a
  // lot it can infer one from), and lawn from turf (or a lot). Ask each
  // service what it actually needs.
  // A lot can stand in for an UNMEASURED lawn (the engine infers turf from
  // it) — but not for a lawn measured to be ZERO: inferring turf from the
  // lot would quote lawn care on a lawn the profile says does not exist.
  // That request routes to PROPERTY_DETAILS_NEEDED and a human instead.
  const OUTDOOR_AREA_SUFFICIENT = {
    lawn_care: (c) => c.hasLawnSqFt || (c.hasLotSqFt && !c.lawnKnownZero),
    one_time_lawn: (c) => c.hasLawnSqFt || (c.hasLotSqFt && !c.lawnKnownZero),
    mosquito: (c) => c.hasLotSqFt,
    one_time_mosquito: (c) => c.hasLotSqFt,
    tree_shrub: (c) => c.hasBedArea || c.hasLotSqFt,
  };
  const outdoorUnsatisfied = serviceKeys.some((key) => {
    const sufficient = OUTDOOR_AREA_SUFFICIENT[key];
    return sufficient ? !sufficient(context) : false;
  });
  if (outdoorUnsatisfied) return 'outdoor_sqft';
  if (serviceKeys.includes('palm') && !positiveInteger(context.palmCount)) return 'palm_count';
  return null;
}

function quoteAmountFromLine(line) {
  if (!line) return {};
  const monthly = positiveNumber(line.monthlyAfterDiscount, line.finalMonthly, line.monthly, line.monitoring?.monthly);
  const annual = positiveNumber(line.annualAfterDiscount, line.finalAnnual, line.annual, line.monitoring?.annual);
  const oneTime = positiveNumber(line.priceAfterDiscount, line.totalAfterDiscount, line.price, line.total);
  const dueAtStart = positiveNumber(line.installation?.price);
  // Per-visit must reflect the DISCOUNTED price (codex 2642 r1: line.perApp
  // is the list per-application rate; the discount pass only writes
  // monthly/annualAfterDiscount). Derive it from the discounted annual and
  // the visit count whenever both exist; the raw fields are only the
  // fallback for lines with no visit cadence.
  // line.visits covers mosquito's cadence field (codex 2642 r2); frequency
  // is numeric on lawn shapes and a string ('quarterly') on pest shapes —
  // positiveNumber ignores the string form.
  const visits = positiveNumber(line.visitsPerYear, line.visits, line.frequency);
  const perVisit = annual && visits
    ? Math.round((annual / visits) * 100) / 100
    : positiveNumber(line.perApp, line.internalPerVisitRevenue, line.perVisit);
  return { monthly, annual, oneTime, dueAtStart, perVisit };
}

function findLineItem(estimate, serviceKey) {
  const target = LINE_SERVICE_KEYS[serviceKey];
  return (estimate?.lineItems || []).find(item => item.service === target) || null;
}

function confidenceForQuote(line, estimate, propertyContext) {
  if (line?.pricingConfidence) return line.pricingConfidence;
  if (line?.turfConfidence) return String(line.turfConfidence).toLowerCase();
  if (propertyContext.source === 'property_lookup') return 'medium';
  if (estimate?.fieldVerify?.length) return 'low';
  return 'high';
}

function buildQuoteOption({
  option,
  estimate,
  currentMonthly,
  currentServiceKeys,
  propertyContext,
  showEstimatedPlanMonthly = true,
  baselineMismatch = false,
  ownedRequestNote = '',
}) {
  const line = findLineItem(estimate, option.serviceKey);
  const amount = quoteAmountFromLine(line);
  const planMonthly = positiveNumber(estimate?.summary?.recurringMonthlyAfterDiscount);
  const incrementalMonthly = amount.monthly
    ? Math.max(0, Math.round((planMonthly - currentMonthly) * 100) / 100)
    : 0;

  const notes = [];
  if (line?.customQuoteFlag) notes.push('Field verification required before final pricing.');
  if (line?.requiresManualReview) notes.push('Manual review recommended for this property.');
  if (Array.isArray(line?.warnings)) notes.push(...line.warnings.slice(0, 2));
  if (Array.isArray(estimate?.fieldVerify) && estimate.fieldVerify.length) notes.push('Property measurements should be verified on-site.');
  if (baselineMismatch) notes.push('Waves will confirm the final plan total because current billing differs from modeled pricing.');

  return {
    id: option.id,
    serviceKey: option.serviceKey,
    serviceName: toKeyLabel(option.serviceKey),
    label: option.label,
    cadence: option.cadence || '',
    alreadyHasRelatedService: currentServiceKeys.includes(option.serviceKey),
    monthly: amount.monthly || null,
    annual: amount.annual || null,
    oneTime: amount.oneTime || null,
    dueAtStart: amount.dueAtStart || null,
    perVisit: amount.perVisit || null,
    estimatedPlanMonthly: showEstimatedPlanMonthly ? planMonthly || null : null,
    estimatedAdditionalMonthly: amount.monthly ? incrementalMonthly : null,
    waveguardTier: estimate?.waveGuard?.tier || estimate?.waveGuard?.label || null,
    confidence: confidenceForQuote(line, estimate, propertyContext),
    manualReview: !!(line?.customQuoteFlag || line?.requiresManualReview || estimate?.fieldVerify?.length),
    notes: [...new Set(notes)],
    requestSubject: `Add ${toKeyLabel(option.serviceKey)} to my plan`,
    requestDescription: [
      `Customer priced ${option.label} in the portal.`,
      amount.monthly ? `Estimated price: $${amount.monthly}/mo.` : null,
      amount.oneTime ? `Estimated one-time price: $${amount.oneTime}.` : null,
      amount.dueAtStart ? `Estimated setup: $${amount.dueAtStart}.` : null,
      planMonthly ? `Estimated plan total after change: $${planMonthly}/mo.` : null,
      estimate?.waveGuard?.tier ? `Estimated WaveGuard tier: ${estimate.waveGuard.tier}.` : null,
      // Mixed prompt: the owned half of the request must reach staff through
      // the option the customer actually submits — the client sends this
      // requestDescription, not result.message (codex #3253 r2).
      ownedRequestNote || null,
    ].filter(Boolean).join(' '),
  };
}

async function maybeSyncPricingEngine(db) {
  if (!db || !db.schema || typeof db.schema.hasTable !== 'function') return;
  if (pricingEngine.needsSync && pricingEngine.needsSync()) {
    await pricingEngine.syncConstantsFromDB(db);
  }
}

// Repeatable purchases: quotable even for a current customer, because they are
// not an existing recurring obligation whose rate could disagree.
const REPEATABLE_ONE_TIME_KEYS = ['palm', 'one_time_lawn', 'one_time_mosquito'];

/** Owned by this customer AND not a repeatable one-time purchase. */
function ownedAndNotRepeatable(serviceKey, currentSet) {
  return currentSet.has(serviceKey) && !REPEATABLE_ONE_TIME_KEYS.includes(serviceKey);
}

async function buildCustomerPricingResponse({ customer, prompt, targetTier, db, propertyLookup, propertySeed = null }) {
  const text = String(prompt || '').trim();
  const { currentServiceKeys, ownedServiceKeys, ownershipLookupFailed } = await loadCurrentServiceKeys(db, customer);
  // Two sets on purpose (codex #3253 r2): currentServiceKeys (WaveGuard
  // qualifying) keeps modeling the baseline plan/tier exactly as before;
  // ownedSet is the superset every never-re-price decision reads, so a
  // non-qualifying recurring service (rodent) still blocks its own re-quote.
  const currentSet = new Set(currentServiceKeys);
  const ownedSet = new Set([...currentServiceKeys, ...ownedServiceKeys]);
  const normalizedTargetTier = normalizeWaveGuardTier(targetTier);
  const requestedServices = inferRequestedServices(text, ownedSet);

  if (normalizedTargetTier) {
    const requiredCount = TIER_MIN_SERVICE_COUNT[normalizedTargetTier];
    const additionalCount = Math.max(0, requiredCount - currentServiceKeys.length);
    return {
      ok: false,
      code: additionalCount === 0 ? 'TARGET_TIER_ALREADY_EARNED' : 'SERVICES_REQUIRED_FOR_TIER',
      mode: 'waveguard_tier',
      targetTier: normalizedTargetTier,
      message: additionalCount === 0
        ? `Your active services already meet the ${requiredCount}-service requirement for WaveGuard ${normalizedTargetTier}.`
        : `WaveGuard ${normalizedTargetTier} is earned with ${requiredCount} active qualifying services. Choose the ${additionalCount} service${additionalCount === 1 ? '' : 's'} you want to add so I can price the actual plan.`,
      currentServices: currentServiceKeys.map(toKeyLabel),
      requestedServices: [],
      alreadyIncluded: currentServiceKeys.map(toKeyLabel),
      requiredServiceCount: requiredCount,
      additionalServiceCount: additionalCount,
      property: null,
      options: [],
    };
  }

  // FAIL CLOSED (codex #3253 r4): if what the customer owns could not be
  // established, no PRICE may be generated — a fresh quote for a service
  // they already pay a (possibly different) rate for is the exact dispute
  // this module exists to prevent. Manual review instead. Checked AFTER the
  // target-tier branch (codex r5 P2): tier answers report qualifying counts,
  // never prices, so an ownership failure must not block them.
  if (ownershipLookupFailed) {
    return {
      ok: false,
      code: 'PRICING_UNAVAILABLE',
      message: 'I could not verify your current services just now, so I did not generate prices. Send Waves a request and we will price it with you.',
      currentServices: currentServiceKeys.map(toKeyLabel),
      requestedServices: [],
      alreadyIncluded: [],
      options: [],
    };
  }

  const turfProfile = await loadTurfProfile(db, customer.id);

  // A service the customer ALREADY has is never re-priced from the property
  // profile — owner ruling 2026-08-06. Their live rate may predate a price
  // change, or have been set by hand at estimate time; quoting a fresh number
  // beside it invites a "why is this different?" dispute. Upgrade wording no
  // longer opens that door (it previously did): an upgrade is a conversation,
  // routed to Waves, not a self-serve re-quote. The one-time keys stay
  // exempt — those are repeatable purchases, not an existing obligation.
  // Computed BEFORE property resolution (codex #3253 r4 P2): an owned-only
  // request generates no quote, so it must not trigger the external
  // geocoding/AI property lookup (cache writes, provider cost, latency).
  const alreadyIncluded = requestedServices.filter(key => ownedAndNotRepeatable(key, ownedSet));
  const servicesToPrice = requestedServices.filter(key => !alreadyIncluded.includes(key));

  let lookupFn = propertyLookup;
  if (!lookupFn && servicesToPrice.length) {
    try {
      ({ performPropertyLookup: lookupFn } = require('../routes/property-lookup-v2'));
    } catch {
      lookupFn = null;
    }
  }

  // Null lookup → resolvePropertyContext stays profile-only (no external
  // calls), which is all an owned-only response needs for its summary.
  // Palm-only requests skip it too: palm injection prices from the STORED
  // palm_count alone (an AI estimatedPalmCount is deliberately never
  // adopted), so on a cache miss the lookup would spend provider calls and
  // latency to produce exactly the same quote or PROPERTY_DETAILS_NEEDED.
  const lookupCanInformPricing = servicesToPrice.some((key) => key !== 'palm');
  const propertyContext = await resolvePropertyContext({
    customer,
    turfProfile,
    propertyLookup: lookupCanInformPricing ? lookupFn : null,
    propertySeed,
  });

  // Measured AFTER the exclusion: an owned service missing a measurement must
  // not short-circuit the request into PROPERTY_DETAILS_NEEDED — we are not
  // pricing it, so its gaps are irrelevant to what we CAN price (codex r1 P2).
  const missing = missingPropertyFor(servicesToPrice, propertyContext);

  if (missing) {
    return {
      ok: false,
      code: 'PROPERTY_DETAILS_NEEDED',
      message: missing === 'home_sqft'
        ? 'I need a home square footage on this property before I can price that accurately.'
        : missing === 'palm_count'
          ? 'Palm count is required for palm injection pricing.'
          : 'I need an outdoor/turf or lot measurement on this property before I can price that accurately.',
      currentServices: currentServiceKeys.map(toKeyLabel),
      requestedServices: requestedServices.map(toKeyLabel),
      alreadyIncluded: alreadyIncluded.map(toKeyLabel),
      property: summarizeProperty(propertyContext),
      options: [],
    };
  }

  await maybeSyncPricingEngine(db);

  const context = {
    grassType: propertyContext.grassType,
    palmCount: propertyContext.palmCount,
  };
  const currentServices = currentServiceObjectsFor(currentServiceKeys, context);
  const currentEstimate = Object.keys(currentServices).length
    ? pricingEngine.generateEstimate({ ...propertyContext.propertyInput, services: currentServices })
    : null;
  const actualMonthly = positiveNumber(customer.monthly_rate);
  const modeledCurrentMonthly = positiveNumber(currentEstimate?.summary?.recurringMonthlyAfterDiscount);
  const billingModelMismatch = actualMonthly > 0 && (!modeledCurrentMonthly || Math.abs(actualMonthly - modeledCurrentMonthly) > 1);
  const currentMonthly = actualMonthly || modeledCurrentMonthly;
  const quoteBaselineMonthly = modeledCurrentMonthly || 0;

  const options = [];
  const generic = !text;
  // Composed BEFORE the option loop so every priced option carries the owned
  // half of a mixed request into what staff receive (codex #3253 r2).
  const ownedRequestNote = alreadyIncluded.length
    ? `Customer also asked about ${alreadyIncluded.map(toKeyLabel).join(', ')}, already active on this account — not re-priced in the portal; review that change with them.`
    : '';
  for (const serviceKey of servicesToPrice) {
    for (const option of variantsForService(serviceKey, text, generic)) {
      const targetServices = {
        ...currentServices,
        ...optionServices(option, context),
      };
      const estimate = pricingEngine.generateEstimate({
        ...propertyContext.propertyInput,
        recurringCustomer: currentServiceKeys.length > 0,
        services: targetServices,
      });
      const quoted = buildQuoteOption({
        option,
        estimate,
        currentMonthly: quoteBaselineMonthly,
        currentServiceKeys,
        propertyContext,
        showEstimatedPlanMonthly: !billingModelMismatch,
        baselineMismatch: billingModelMismatch,
        ownedRequestNote,
      });
      // Belt-and-braces on the money rule, sharing the SAME predicate as the
      // servicesToPrice filter above (no second definition to drift): if a
      // future path ever routes an owned service here, no price for it can
      // still reach the customer.
      if (ownedAndNotRepeatable(option.serviceKey, ownedSet)) continue;
      if (quoted.monthly || quoted.oneTime || quoted.dueAtStart) options.push(quoted);
    }
  }

  // A mixed prompt ("upgrade my lawn care and add mosquito") must not lose the
  // owned half just because the new half priced (codex r1 P2).
  const ownedNote = alreadyIncluded.length
    ? `You already have ${alreadyIncluded.map(toKeyLabel).join(', ')} on this property, so I am not re-pricing that here — your current rate stands. Send Waves a request and we will review it with you.`
    : '';
  const message = options.length
    ? [`I priced ${[...new Set(servicesToPrice.map(toKeyLabel))].join(', ')} using the property tied to your portal.`, ownedNote]
      .filter(Boolean).join(' ')
    : ownedNote || 'I could not price that request automatically. Waves can review it manually.';

  return {
    ok: true,
    message,
    currentServices: currentServiceKeys.map(toKeyLabel),
    // Raw modeled-baseline keys (mapKey'd, e.g. termite_bait → termite) —
    // the report cross-sell reads these to prove every evidenced owned
    // family actually made it into the priced baseline (codex #3367 PR r1).
    currentServiceKeys: [...currentServiceKeys],
    requestedServices: requestedServices.map(toKeyLabel),
    alreadyIncluded: alreadyIncluded.map(toKeyLabel),
    property: summarizeProperty(propertyContext),
    currentMonthly: currentMonthly || null,
    options,
  };
}

function summarizeProperty(context) {
  const p = context.propertyInput || {};
  return {
    address: context.address || null,
    source: context.source,
    lookup: context.lookup,
    homeSqFt: p.homeSqFt || null,
    lotSqFt: p.lotSqFt || null,
    lawnSqFt: p.lawnSqFt || null,
    stories: p.stories || null,
    grassType: context.grassType || null,
    // The RESOLVED type (stored type + trusted lookup adoption) — consumers
    // with a commercial-suppression rule (report cross-sell) must read this,
    // not the raw customers column, or a blank column with a commercial
    // cached lookup slips past (codex #3367 r4).
    propertyType: p.propertyType || null,
  };
}

module.exports = {
  buildCustomerPricingResponse,
  // The exact address string this module hands the property lookup — a
  // consumer that must reason about that lookup independently (the
  // service-report cross-sell probes for verified corrections whether or
  // not the lookup ran) has to key on the same string, not its own guess.
  addressForCustomer,
  inferRequestedServices,
  serviceKeyFromText,
  variantsForService,
  currentServiceObjectsFor,
  optionServices,
  // First-class exports for the one-tap purchase lane (2026-08-13): the
  // purchase must re-run the pricing engine over the SAME property context
  // and line-amount arithmetic this module priced the offer with — importing
  // these (rather than re-implementing them) is what keeps the synthesized
  // estimate's per-application price equal to the offer's by construction
  // (the purchase path still asserts the parity and fails closed on drift).
  resolvePropertyContext,
  loadTurfProfile,
  findLineItem,
  quoteAmountFromLine,
  // Test hook (T&S reprice lane 2026-08-09): property-context resolution,
  // where bed-area provenance is decided.
  _private: { resolvePropertyContext, missingPropertyFor },
};
