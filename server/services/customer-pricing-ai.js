const pricingEngine = require('./pricing-engine');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const RECURRING_SERVICE_ORDER = ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub'];
const TIER_SERVICE_KEYS = {
  Bronze: ['pest_control'],
  Silver: ['pest_control', 'lawn_care'],
  Gold: ['pest_control', 'lawn_care', 'mosquito'],
  Platinum: ['pest_control', 'lawn_care', 'mosquito', 'tree_shrub'],
};
const WAVEGUARD_TIERS = Object.keys(TIER_SERVICE_KEYS);

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

const INACTIVE_SCHEDULE_STATUSES = new Set([
  'cancelled',
  'canceled',
  'completed',
  'complete',
  'skipped',
  'rescheduled',
  'no_show',
]);

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

function tierServicesForCustomer(customer = {}) {
  const tier = customer.waveguard_tier || customer.tier;
  if (!tier || tier === 'One-Time') return [];
  return TIER_SERVICE_KEYS[tier] || [];
}

function normalizeWaveGuardTier(value) {
  const raw = String(value || '').trim().toLowerCase();
  return WAVEGUARD_TIERS.find(tier => tier.toLowerCase() === raw) || null;
}

function tierRank(tier) {
  return WAVEGUARD_TIERS.indexOf(tier);
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

function hasUpgradeIntent(prompt) {
  return /\b(upgrade|premium|enhanced|more frequent|monthly|higher|better plan|bigger plan)\b/i.test(String(prompt || ''));
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
    if (key === 'termite') services.termite = { system: 'advance', monitoringTier: 'basic' };
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
  if (option.serviceKey === 'termite') return { termite: { system: 'advance', monitoringTier: option.monitoringTier } };
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
    // 'basic' (lawnFreq 4) is now a sold tier and prices distinctly as the
    // 4-application plan, so it is offered alongside Standard/Enhanced/Premium.
    // Standard stays first so the portal panel (which auto-selects options[0])
    // keeps defaulting to the 6-application plan, not the new 4-application one.
    const all = [
      { id: 'lawn-standard', serviceKey, label: 'Standard lawn care', tier: 'standard', lawnFreq: 6, cadence: '6 visits/year' },
      { id: 'lawn-enhanced', serviceKey, label: 'Enhanced lawn care', tier: 'enhanced', lawnFreq: 9, cadence: '9 visits/year' },
      { id: 'lawn-premium', serviceKey, label: 'Premium lawn care', tier: 'premium', lawnFreq: 12, cadence: '12 visits/year' },
      { id: 'lawn-basic', serviceKey, label: 'Basic lawn care', tier: 'basic', lawnFreq: 4, cadence: '4 visits/year' },
    ];
    if (generic) return all.filter(o => o.id === 'lawn-enhanced');
    // Tie the bare digit in tier-intent matches to cadence wording so a stray
    // number (e.g. "4,000 sq ft", "123 4th Ave") doesn't collapse the quote to a
    // single tier.
    if (/premium|monthly|\b12\s*(?:applications?|apps?|visits?|treatments?)\b/i.test(prompt)) {
      return all.filter(o => o.id === 'lawn-premium');
    }
    if (/\bbasic\b|quarterly|\b4\s*(?:applications?|apps?|visits?|treatments?)\b/i.test(prompt)) {
      return all.filter(o => o.id === 'lawn-basic');
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
    // 6-visit Standard is the mandated default; Light (4x) is the downsell.
    // Enhanced (9x) / Premium (12x) are retired — do not offer them.
    const all = [
      { id: 'tree-standard', serviceKey, label: 'Standard tree & shrub care', tier: 'standard', cadence: '6 visits/year' },
      { id: 'tree-light', serviceKey, label: 'Light tree & shrub care', tier: 'light', cadence: '4 visits/year' },
    ];
    return generic ? all.slice(0, 1) : all;
  }
  if (serviceKey === 'termite') {
    const all = [
      { id: 'termite-basic', serviceKey, label: 'Termite bait monitoring', monitoringTier: 'basic', cadence: 'Monthly monitoring billing' },
      { id: 'termite-premier', serviceKey, label: 'Premier termite monitoring', monitoringTier: 'premier', cadence: 'Monthly monitoring billing' },
    ];
    return generic ? all.slice(0, 1) : all;
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
  const keys = new Set(tierServicesForCustomer(customer));
  const customerId = customer.id;
  const today = etDateString();

  const scheduled = await safeSelect(db, 'scheduled_services', q => q
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', today)
    .whereNotIn('status', Array.from(INACTIVE_SCHEDULE_STATUSES))
    .select('service_type', 'status', 'scheduled_date')
    .limit(200));
  for (const row of scheduled) {
    const status = String(row.status || '').toLowerCase();
    const scheduledDate = String(row.scheduled_date || row.scheduledDate || '').slice(0, 10);
    if (INACTIVE_SCHEDULE_STATUSES.has(status) || !scheduledDate || scheduledDate < today) continue;
    const key = serviceKeyFromText(row.service_type);
    if (key && !key.startsWith('one_time')) keys.add(key);
  }

  return Array.from(keys);
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

async function resolvePropertyContext({ customer, turfProfile, propertyLookup }) {
  let source = 'customer_profile';
  const address = addressForCustomer(customer);
  let homeSqFt = positiveNumber(customer.home_sqft, customer.property_sqft, customer.square_footage);
  let lotSqFt = positiveNumber(customer.lot_sqft, customer.lot_size_sqft);
  let lawnSqFt = positiveNumber(turfProfile?.lawn_sqft, customer.lawn_sqft);
  let bedArea = positiveNumber(customer.bed_sqft, customer.estimated_bed_area_sf);
  let stories = positiveNumber(customer.stories);
  let propertyType = customer.property_type || 'single_family';
  let yearBuilt = customer.year_built || null;
  let constructionMaterial = customer.construction_material || null;
  let foundationType = customer.foundation_type || null;
  let roofType = customer.roof_type || null;
  let palmCount = positiveNumber(customer.palm_count, turfProfile?.palm_count);
  let lookupMeta = null;
  let features = {
    pool: !!customer.pool,
    poolCage: !!(customer.pool_cage || customer.poolCage),
    nearWater: !!(customer.near_water || customer.nearWater),
    shrubs: customer.shrub_density || 'moderate',
    trees: customer.tree_density || 'moderate',
    complexity: customer.landscape_complexity || 'moderate',
    largeDriveway: !!(customer.large_driveway || customer.has_large_driveway),
    irrigation: !!(customer.irrigation_system || customer.irrigation),
    treeCount: Number(customer.tree_count || 0) || 0,
  };

  if ((!homeSqFt || !lotSqFt) && lookupEnabled() && address && propertyLookup) {
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
      homeSqFt = positiveNumber(homeSqFt, p.homeSqFt, record.squareFootage);
      lotSqFt = positiveNumber(lotSqFt, p.lotSqFt, record.lotSize);
      lawnSqFt = positiveNumber(lawnSqFt, p.estimatedTurfSf);
      bedArea = positiveNumber(bedArea, p.estimatedBedAreaSf);
      stories = positiveNumber(stories, p.stories, record.stories);
      propertyType = p.propertyType || record.propertyType || propertyType;
      yearBuilt = yearBuilt || p.yearBuilt || record.yearBuilt || null;
      constructionMaterial = constructionMaterial || p.constructionMaterial || record.constructionMaterial || null;
      foundationType = foundationType || p.foundationType || record.foundationType || null;
      roofType = roofType || p.roofType || record.roofType || null;
      palmCount = positiveNumber(palmCount, p.estimatedPalmCount);
      features = {
        ...features,
        pool: p.pool === 'YES' || features.pool,
        poolCage: p.poolCage === 'YES' || features.poolCage,
        poolCageSize: String(p.poolCageSize || '').toLowerCase(),
        nearWater: p.nearWater && p.nearWater !== 'NONE' ? true : features.nearWater,
        shrubs: String(p.shrubDensity || features.shrubs || 'moderate').toLowerCase(),
        trees: String(p.treeDensity || features.trees || 'moderate').toLowerCase(),
        complexity: String(p.landscapeComplexity || features.complexity || 'moderate').toLowerCase(),
        largeDriveway: !!p.largeDriveway || features.largeDriveway,
        irrigation: !!p.irrigationVisible || features.irrigation,
        treeCount: positiveNumber(p.estimatedTreeCount, features.treeCount),
      };
    } catch (err) {
      lookupMeta = { used: false, error: err.message };
      logger.warn(`[customer-pricing-ai] property lookup failed for customer ${customer.id}: ${err.message}`);
    }
  }

  const grassType = normalizeGrassType(turfProfile?.track_key || turfProfile?.grass_type || customer.lawn_type);

  const propertyInput = {
    homeSqFt,
    lotSqFt,
    lawnSqFt: lawnSqFt || undefined,
    stories: stories || 1,
    propertyType,
    features,
    bedArea: bedArea || undefined,
    bedAreaSource: bedArea ? 'explicit' : undefined,
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
  };
}

function missingPropertyFor(serviceKeys, context) {
  if (!context.hasHomeSqFt) return 'home_sqft';
  const needsOutdoor = serviceKeys.some(key => ['lawn_care', 'mosquito', 'tree_shrub', 'one_time_lawn', 'one_time_mosquito'].includes(key));
  if (needsOutdoor && !context.hasLotSqFt && !context.hasLawnSqFt) return 'outdoor_sqft';
  if (serviceKeys.includes('palm') && !positiveInteger(context.palmCount)) return 'palm_count';
  return null;
}

function quoteAmountFromLine(line) {
  if (!line) return {};
  const monthly = positiveNumber(line.monthlyAfterDiscount, line.finalMonthly, line.monthly, line.monitoring?.monthly);
  const annual = positiveNumber(line.annualAfterDiscount, line.finalAnnual, line.annual, line.monitoring?.annual);
  const oneTime = positiveNumber(line.priceAfterDiscount, line.totalAfterDiscount, line.price, line.total);
  const dueAtStart = positiveNumber(line.installation?.price);
  const perVisit = positiveNumber(line.perApp, line.internalPerVisitRevenue, line.perVisit);
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
    ].filter(Boolean).join(' '),
  };
}

function confidenceForEstimate(estimate, propertyContext) {
  if (propertyContext.source === 'property_lookup') return 'medium';
  if (estimate?.fieldVerify?.length) return 'low';
  return 'high';
}

function warningMessage(warning) {
  if (!warning) return null;
  if (typeof warning === 'string') return warning;
  if (typeof warning === 'object') {
    return warning.message || warning.warning || warning.reason || warning.code || null;
  }
  return null;
}

function tierReviewSummary(estimate) {
  const lineItems = Array.isArray(estimate?.lineItems) ? estimate.lineItems : [];
  const warnings = [];
  let customQuote = false;
  let requiresManualReview = false;

  for (const line of lineItems) {
    if (line?.customQuoteFlag) customQuote = true;
    if (line?.requiresManualReview) requiresManualReview = true;
    if (Array.isArray(line?.warnings)) {
      warnings.push(...line.warnings.map(warningMessage).filter(Boolean));
    }
  }

  return {
    customQuote,
    requiresManualReview,
    warnings: [...new Set(warnings)],
  };
}

function buildTierQuoteOption({
  targetTier,
  targetKeys,
  currentServiceKeys,
  estimate,
  modeledCurrentMonthly,
  billingModelMismatch,
  propertyContext,
}) {
  const planMonthly = positiveNumber(estimate?.summary?.recurringMonthlyAfterDiscount);
  const addedKeys = targetKeys.filter(key => !currentServiceKeys.includes(key));
  const incrementalMonthly = modeledCurrentMonthly
    ? Math.max(0, Math.round((planMonthly - modeledCurrentMonthly) * 100) / 100)
    : null;
  const review = tierReviewSummary(estimate);
  const manualReview = !!(
    review.customQuote ||
    review.requiresManualReview ||
    review.warnings.length ||
    estimate?.fieldVerify?.length
  );
  const notes = [];
  if (review.customQuote) notes.push('Field verification required before final pricing.');
  if (review.requiresManualReview) notes.push('Manual review recommended for this property.');
  if (review.warnings.length) notes.push(...review.warnings.slice(0, 3));
  if (Array.isArray(estimate?.fieldVerify) && estimate.fieldVerify.length) {
    notes.push('Property measurements should be verified on-site.');
  }
  if (billingModelMismatch) {
    notes.push('Waves will confirm the final plan total because current billing differs from modeled pricing.');
  }

  return {
    id: `waveguard-${targetTier.toLowerCase()}`,
    serviceKey: 'waveguard_tier',
    serviceName: `WaveGuard ${targetTier}`,
    label: `WaveGuard ${targetTier}`,
    cadence: `Includes ${targetKeys.map(toKeyLabel).join(', ')}`,
    alreadyHasRelatedService: addedKeys.length === 0,
    monthly: planMonthly || null,
    annual: planMonthly ? Math.round(planMonthly * 12 * 100) / 100 : null,
    oneTime: null,
    dueAtStart: null,
    perVisit: null,
    estimatedPlanMonthly: billingModelMismatch ? null : planMonthly || null,
    estimatedAdditionalMonthly: incrementalMonthly,
    waveguardTier: normalizeWaveGuardTier(estimate?.waveGuard?.tier) || targetTier,
    confidence: manualReview ? 'low' : confidenceForEstimate(estimate, propertyContext),
    manualReview,
    notes: [...new Set(notes)],
    requestSubject: `Upgrade to WaveGuard ${targetTier}`,
    requestDescription: [
      `Customer priced WaveGuard ${targetTier} in the portal.`,
      addedKeys.length ? `Adds: ${addedKeys.map(toKeyLabel).join(', ')}.` : 'No additional recurring services were identified.',
      planMonthly ? `Estimated plan total: $${planMonthly}/mo.` : null,
      incrementalMonthly != null ? `Estimated added monthly: $${incrementalMonthly}/mo.` : null,
    ].filter(Boolean).join(' '),
  };
}

async function maybeSyncPricingEngine(db) {
  if (!db || !db.schema || typeof db.schema.hasTable !== 'function') return;
  if (pricingEngine.needsSync && pricingEngine.needsSync()) {
    await pricingEngine.syncConstantsFromDB(db);
  }
}

async function buildCustomerPricingResponse({ customer, prompt, targetTier, db, propertyLookup }) {
  const text = String(prompt || '').trim();
  const currentServiceKeys = await loadCurrentServiceKeys(db, customer);
  const currentSet = new Set(currentServiceKeys);
  const normalizedTargetTier = normalizeWaveGuardTier(targetTier);
  const targetTierServiceKeys = normalizedTargetTier ? TIER_SERVICE_KEYS[normalizedTargetTier] : null;
  const requestedServices = targetTierServiceKeys || inferRequestedServices(text, currentSet);
  const currentWaveGuardTier = normalizeWaveGuardTier(customer.waveguard_tier || customer.tier);
  const turfProfile = await loadTurfProfile(db, customer.id);

  if (
    normalizedTargetTier &&
    currentWaveGuardTier &&
    tierRank(normalizedTargetTier) <= tierRank(currentWaveGuardTier)
  ) {
    return {
      ok: false,
      code: 'TARGET_TIER_NOT_UPGRADE',
      mode: 'waveguard_tier',
      targetTier: normalizedTargetTier,
      currentTier: currentWaveGuardTier,
      message: normalizedTargetTier === currentWaveGuardTier
        ? `You're already on WaveGuard ${currentWaveGuardTier}.`
        : `WaveGuard ${normalizedTargetTier} is below your current WaveGuard ${currentWaveGuardTier} plan, so Waves will review that change manually.`,
      currentServices: currentServiceKeys.map(toKeyLabel),
      requestedServices: targetTierServiceKeys.map(toKeyLabel),
      alreadyIncluded: targetTierServiceKeys.filter(key => currentSet.has(key)).map(toKeyLabel),
      property: null,
      options: [],
    };
  }

  let lookupFn = propertyLookup;
  if (!lookupFn) {
    try {
      ({ performPropertyLookup: lookupFn } = require('../routes/property-lookup-v2'));
    } catch {
      lookupFn = null;
    }
  }

  const propertyContext = await resolvePropertyContext({ customer, turfProfile, propertyLookup: lookupFn });
  const missing = missingPropertyFor(requestedServices, propertyContext);
  const upgradeIntent = hasUpgradeIntent(text);

  const alreadyIncluded = requestedServices.filter(key =>
    currentSet.has(key) &&
    !upgradeIntent &&
    !['palm', 'one_time_lawn', 'one_time_mosquito'].includes(key)
  );
  const servicesToPrice = requestedServices.filter(key => !alreadyIncluded.includes(key));

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

  if (normalizedTargetTier) {
    let quotedTier = normalizedTargetTier;
    let quotedTierServiceKeys = targetTierServiceKeys;
    let targetServices = {
      ...currentServices,
      ...currentServiceObjectsFor(quotedTierServiceKeys, context),
    };
    let targetEstimate = pricingEngine.generateEstimate({
      ...propertyContext.propertyInput,
      recurringCustomer: currentServiceKeys.length > 0,
      services: targetServices,
    });
    const derivedTier = normalizeWaveGuardTier(targetEstimate?.waveGuard?.tier);
    if (derivedTier && tierRank(derivedTier) > tierRank(quotedTier)) {
      quotedTier = derivedTier;
      quotedTierServiceKeys = TIER_SERVICE_KEYS[quotedTier];
      targetServices = {
        ...currentServices,
        ...currentServiceObjectsFor(quotedTierServiceKeys, context),
      };
      targetEstimate = pricingEngine.generateEstimate({
        ...propertyContext.propertyInput,
        recurringCustomer: currentServiceKeys.length > 0,
        services: targetServices,
      });
    }
    const option = buildTierQuoteOption({
      targetTier: quotedTier,
      targetKeys: quotedTierServiceKeys,
      currentServiceKeys,
      estimate: targetEstimate,
      modeledCurrentMonthly,
      billingModelMismatch,
      propertyContext,
    });

    return {
      ok: true,
      mode: 'waveguard_tier',
      targetTier: quotedTier,
      selectedTier: normalizedTargetTier,
      message: quotedTier === normalizedTargetTier
        ? `I priced WaveGuard ${quotedTier} using the property tied to your portal.`
        : `Your existing recurring services qualify this as WaveGuard ${quotedTier}, so I priced that tier using the property tied to your portal.`,
      currentServices: currentServiceKeys.map(toKeyLabel),
      requestedServices: quotedTierServiceKeys.map(toKeyLabel),
      alreadyIncluded: quotedTierServiceKeys.filter(key => currentSet.has(key)).map(toKeyLabel),
      property: summarizeProperty(propertyContext),
      currentMonthly: currentMonthly || null,
      options: option.monthly ? [option] : [],
    };
  }

  const options = [];
  const generic = !text;
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
      });
      if (quoted.monthly || quoted.oneTime || quoted.dueAtStart) options.push(quoted);
    }
  }

  const message = alreadyIncluded.length && !options.length
    ? `You already have ${alreadyIncluded.map(toKeyLabel).join(', ')} on this property.`
    : options.length
      ? `I priced ${[...new Set(servicesToPrice.map(toKeyLabel))].join(', ')} using the property tied to your portal.`
      : 'I could not price that request automatically. Waves can review it manually.';

  return {
    ok: true,
    message,
    currentServices: currentServiceKeys.map(toKeyLabel),
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
  };
}

module.exports = {
  buildCustomerPricingResponse,
  inferRequestedServices,
  serviceKeyFromText,
  tierServicesForCustomer,
  variantsForService,
  currentServiceObjectsFor,
  optionServices,
};
