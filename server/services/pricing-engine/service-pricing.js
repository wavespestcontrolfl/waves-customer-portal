// ============================================================
// service-pricing.js — All service line pricing calculations
// ============================================================
const {
  GLOBAL, PROPERTY_TYPE_ADJ, PEST, LAWN_TIERS, LAWN_FREQS,
  LAWN_TABLE_MAX_SQFT, LAWN_TRACK_DISPLAY, GRASS_TYPE_ALIASES, LAWN_BRACKETS,
  TREE_SHRUB, BED_DENSITY, BED_AREA_CAP, PALM, MOSQUITO, TERMITE, RODENT, ONE_TIME, SPECIALTY, BED_BUG, URGENCY,
  WAVEGUARD,
} = require('./constants');

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function roundRatio(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

// ── Utility: Linear interpolation between brackets ────────────
function interpolate(value, brackets, valueKey = 0, resultKey = 1) {
  if (!brackets.length) return 0;
  if (value <= brackets[0][valueKey]) return brackets[0][resultKey];
  if (value >= brackets[brackets.length - 1][valueKey]) return brackets[brackets.length - 1][resultKey];
  for (let i = 0; i < brackets.length - 1; i++) {
    const lo = brackets[i], hi = brackets[i + 1];
    if (value >= lo[valueKey] && value <= hi[valueKey]) {
      const span = hi[valueKey] - lo[valueKey];
      if (span === 0) return lo[resultKey];
      const ratio = (value - lo[valueKey]) / span;
      return lo[resultKey] + ratio * (hi[resultKey] - lo[resultKey]);
    }
  }
  return brackets[brackets.length - 1][resultKey];
}

// ── Labor cost helper ─────────────────────────────────────────
function laborCost(onSiteMinutes) {
  return GLOBAL.LABOR_RATE * (GLOBAL.DRIVE_TIME + onSiteMinutes) / 60;
}

function normalizePoolCageSize(value, hasPoolCage = false) {
  const raw = String(value || '').trim().toLowerCase();
  if (['small', 'medium', 'large', 'oversized'].includes(raw)) return raw;
  return hasPoolCage ? 'medium' : 'none';
}

function poolCageAdjustment(features = {}) {
  const hasPoolCage = !!features.poolCage;
  const size = normalizePoolCageSize(features.poolCageSize, hasPoolCage);
  if (!hasPoolCage || size === 'none') return 0;
  const key = {
    small: 'poolCageSmall',
    medium: 'poolCageMedium',
    large: 'poolCageLarge',
    oversized: 'poolCageOversized',
  }[size];
  return PEST.additionalAdjustments[key] ?? PEST.additionalAdjustments.poolCage;
}

function calculatePestProductionDiagnostics(property) {
  const cfg = PEST.productionDiagnostics || {};
  const f = property.features || {};
  const footprint = Number(property.footprint) || 0;
  const lotSqFt = Number(property.lotSqFt) || 0;
  const homeSqFt = Number(property.homeSqFt) || 0;
  const storiesSource = String(property.storiesSource || '').toLowerCase();
  const poolCageSize = normalizePoolCageSize(f.poolCageSize, !!f.poolCage);
  const rawPoolCageSize = String(f.poolCageSize || '').trim().toLowerCase();
  const poolCageSizeInferred = !!f.poolCage && !['small', 'medium', 'large', 'oversized'].includes(rawPoolCageSize);
  const round1 = value => Math.round(value * 10) / 10;
  const outbuildingCount = Math.max(0, Math.floor(Number(property.outbuildingCount) || 0));

  const breakdown = {
    baseStop: cfg.baseStopMinutes || 20,
    footprint: round1(interpolate(footprint, cfg.footprintMinutes || [], 'sqft', 'minutes')),
    lot: round1(interpolate(lotSqFt, cfg.lotMinutes || [], 'sqft', 'minutes')),
    poolCage: f.poolCage ? (cfg.poolCageMinutes?.[poolCageSize] || 0) : 0,
    pool: !f.poolCage && f.pool ? (cfg.poolNoCageMinutes || 0) : 0,
    shrubs: cfg.shrubMinutes?.[f.shrubs] || 0,
    trees: cfg.treeMinutes?.[f.trees] || 0,
    complexity: cfg.complexityMinutes?.[f.complexity] || 0,
    largeDriveway: f.largeDriveway ? (cfg.largeDrivewayMinutes || 0) : 0,
    nearWater: f.nearWater ? (cfg.nearWaterMinutes || 0) : 0,
    attachedGarage: property.attachedGarage ? (cfg.attachedGarageMinutes || 0) : 0,
    outbuildings: outbuildingCount * (cfg.outbuildingMinutes || 0),
  };

  const estimatedMinutes = Math.max(10, round1(Object.values(breakdown).reduce((sum, n) => sum + (Number(n) || 0), 0)));
  const manualReviewReasons = [];
  const lowConfidenceReasons = [];

  if (!homeSqFt || !footprint) lowConfidenceReasons.push('missing_home_sqft');
  if (!lotSqFt) lowConfidenceReasons.push('missing_lot_size');
  if (storiesSource === 'default' || storiesSource === 'estimated') manualReviewReasons.push('stories_estimated');
  if (poolCageSizeInferred) manualReviewReasons.push('pool_cage_size_inferred');
  if (lotSqFt > (cfg.lowConfidenceLotSqFt || 40000)) lowConfidenceReasons.push('very_large_lot');
  else if (lotSqFt > (cfg.manualReviewLotSqFt || 20000)) manualReviewReasons.push('large_lot');
  if (poolCageSize === 'oversized') lowConfidenceReasons.push('oversized_pool_cage');
  else if (poolCageSize === 'large') manualReviewReasons.push('large_pool_cage');
  if (f.complexity === 'complex' && (f.shrubs === 'heavy' || f.trees === 'heavy')) manualReviewReasons.push('complex_heavy_vegetation');
  if (outbuildingCount >= 2) manualReviewReasons.push('multiple_outbuildings');
  if (estimatedMinutes >= (cfg.lowConfidenceMinutes || 60)) lowConfidenceReasons.push('estimated_service_time_60_plus');
  else if (estimatedMinutes >= (cfg.manualReviewMinutes || 45)) manualReviewReasons.push('estimated_service_time_45_plus');

  const reviewReasons = [...new Set([...lowConfidenceReasons, ...manualReviewReasons])];
  const pricingConfidence = lowConfidenceReasons.length ? 'low' : manualReviewReasons.length ? 'medium' : 'high';

  return {
    estimatedMinutes,
    breakdown,
    poolCageSize,
    poolCageSizeSource: f.poolCage ? (poolCageSizeInferred ? 'inferred' : 'explicit') : 'none',
    poolCageSizeInferred,
    pricingMode: 'shadow_only',
    pricingConfidence,
    confidence: pricingConfidence,
    manualReview: reviewReasons.length > 0,
    reviewReasons,
    manualReviewReasons: reviewReasons,
  };
}

// ── Urgency multiplier helper (matches v2 applyOT — urgency only, ────
// not recurring-customer discount which is handled by discount-engine) ─
function applyUrgency(price, urgency = 'ROUTINE', afterHours = false) {
  let mult = 1.0;
  if (urgency === 'SOON') mult = afterHours ? 1.50 : 1.25;
  else if (urgency === 'URGENT') mult = afterHours ? 2.0 : 1.50;
  return Math.round(price * mult);
}

function getOneTimeUrgencyMultiplier({ urgency = 'NONE', afterHours = false } = {}) {
  const key = String(urgency || 'NONE').toUpperCase();
  const cfg = URGENCY[key] || URGENCY.NONE;
  return afterHours ? (cfg.afterHours || cfg.standard || 1) : (cfg.standard || 1);
}

function applyOneTimeRecurringCustomerDiscount(price, { isRecurringCustomer = false } = {}) {
  const rate = isRecurringCustomer ? WAVEGUARD.recurringCustomerOneTimePerk : 0;
  const discounted = Math.round(price * (1 - rate));
  return {
    price: discounted,
    rate,
    amount: Math.max(0, Math.round(price) - discounted),
  };
}

function applyOneTimeFloor(price, floor) {
  return Math.max(floor, price);
}

function normalizeMosquitoProgramKey(value) {
  if (value == null || value === '') return null;
  const raw = String(value).toLowerCase();
  if (raw === 'seasonal9' || raw === 'monthly12') return raw;
  if (raw === 'seasonal') return 'seasonal9';
  if (raw === 'monthly') return 'monthly12';
  if (raw === 'residual_seasonal' || raw === 'scion_seasonal' || raw === 'upgraded_seasonal' || raw === 'upgrade_seasonal') return 'seasonal9';
  if (raw === 'residual_monthly' || raw === 'scion_monthly' || raw === 'scion' || raw === 'upgraded' || raw === 'upgrade') return 'monthly12';
  if (raw === 'bronze') return 'seasonal9';
  if (raw === 'silver' || raw === 'gold' || raw === 'platinum') return 'monthly12';
  return raw;
}

// ============================================================
// PEST CONTROL
// ============================================================
function pricePestControl(property, options = {}) {
  const {
    frequency = 'quarterly',
    pricingVersion = 'v1',
    roachType = 'none',
    modifiers = {},
  } = options;

  const footprint = property.footprint;
  const footprintAdj = interpolate(
    footprint,
    PEST.footprintBrackets.map(b => [b.sqft, b.adj])
  );

  let additionalAdj = 0;
  const f = property.features || {};
  if (f.indoor) additionalAdj += PEST.additionalAdjustments.indoor;
  if (f.shrubs === 'heavy') additionalAdj += PEST.additionalAdjustments.shrubs_heavy;
  else if (f.shrubs === 'moderate') additionalAdj += PEST.additionalAdjustments.shrubs_moderate;
  else if (f.shrubs === 'light') additionalAdj += (PEST.additionalAdjustments.shrubs_light || 0);
  if (f.poolCage) additionalAdj += poolCageAdjustment(f);
  else if (f.pool) additionalAdj += PEST.additionalAdjustments.poolNoCage;
  if (f.trees === 'heavy') additionalAdj += PEST.additionalAdjustments.trees_heavy;
  else if (f.trees === 'moderate') additionalAdj += PEST.additionalAdjustments.trees_moderate;
  else if (f.trees === 'light') additionalAdj += (PEST.additionalAdjustments.trees_light || 0);
  if (f.complexity === 'complex') additionalAdj += PEST.additionalAdjustments.complexity_complex;
  else if (f.complexity === 'moderate') additionalAdj += (PEST.additionalAdjustments.complexity_moderate || 0);
  else if (f.complexity === 'simple') additionalAdj += (PEST.additionalAdjustments.complexity_simple || 0);
  if (f.nearWater) additionalAdj += PEST.additionalAdjustments.nearWater;
  if (f.largeDriveway) additionalAdj += PEST.additionalAdjustments.largeDriveway;

  const propAdj = PROPERTY_TYPE_ADJ[property.propertyType] || 0;
  const ageAdj = modifiers.pestAgeAdj || 0;
  if (property.attachedGarage) additionalAdj += 5;
  let basePrice = Math.max(PEST.floor, PEST.base + Math.round(footprintAdj) + additionalAdj + propAdj + ageAdj);

  const roachMod = PEST.roachModifier[roachType] || 0;
  // Session 11a Step 2b-3: 2-decimal rounding matches v2 (pricing-engine-v2.js:743).
  const roachAddOn = Math.round(basePrice * roachMod * 100) / 100;

  const freqDiscounts = pricingVersion === 'v2' ? PEST.frequencyDiscounts.v2 : PEST.frequencyDiscounts.v1;
  const freqMult = freqDiscounts[frequency] || 1.0;
  const visitsPerYear = PEST.frequencies[frequency] || 4;

  // 2-decimal rounding to match v2 (pricing-engine-v2.js:758). Prior integer
  // round was the source of $0.02/mo drift on bimonthly/monthly cadences vs
  // v2's live output.
  const perApp = Math.round((basePrice * freqMult + roachAddOn) * 100) / 100;
  const annual = Math.round(perApp * visitsPerYear * 100) / 100;
  const monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate — fully allocated (on-site + drive time + chemicals)
  const chemCost = { talak: 1.30, taurus: 4.87, surfactant: 0.50 }; // per service
  const materialPerVisit = (roachType === 'german' ? 15 : roachType === 'regular' ? 10 : chemCost.talak + chemCost.taurus + chemCost.surfactant);
  const onSiteMin = frequency === 'monthly' ? 20 : 25;
  const onSiteLaborCost = GLOBAL.LABOR_RATE * onSiteMin / 60;
  const driveLaborCost = GLOBAL.LABOR_RATE * GLOBAL.DRIVE_TIME / 60;
  const directServiceCost = onSiteLaborCost + materialPerVisit; // no drive
  const fullyAllocatedCost = directServiceCost + driveLaborCost; // includes drive
  const annualCost = fullyAllocatedCost * visitsPerYear + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  // ── Tier array: quarterly / bimonthly / monthly pre-priced ──
  // Consumed by property-lookup-v2 /calculate-estimate and future tier UIs.
  const tiers = Object.keys(PEST.frequencies).map((freqKey) => {
    const v = PEST.frequencies[freqKey];
    const fm = freqDiscounts[freqKey] || 1.0;
    const pa = Math.round((basePrice * fm + roachAddOn) * 100) / 100;
    const ann = Math.round(pa * v * 100) / 100;
    return {
      frequency: freqKey,
      freq: v,
      perApp: pa,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      label: freqKey === 'monthly' ? 'Monthly' : freqKey === 'bimonthly' ? 'Bi-Monthly' : 'Quarterly',
      recommended: freqKey === frequency,
    };
  });

  return {
    service: 'pest_control',
    basePrice, footprintAdj: Math.round(footprintAdj), additionalAdj, propAdj,
    roachType, roachAddOn, freqMult, frequency, visitsPerYear, pricingVersion,
    perApp, annual, monthly,
    tiers,
    costs: {
      materialPerVisit: Math.round(materialPerVisit * 100) / 100,
      onSiteLaborCost: Math.round(onSiteLaborCost * 100) / 100,
      driveLaborCost: Math.round(driveLaborCost * 100) / 100,
      directServiceCost: Math.round(directServiceCost * 100) / 100,
      fullyAllocatedCost: Math.round(fullyAllocatedCost * 100) / 100,
      annualCost: Math.round(annualCost),
    },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    initialFee: PEST.initialFee,
    productionDiagnostics: calculatePestProductionDiagnostics(property),
  };
}

// ============================================================
// PEST — INITIAL ROACH KNOCKDOWN (one-time)
// ============================================================
// Auto-added by estimate-engine when recurring pest is booked with a
// non-none roach type. Covers the heavier visit-1 treatment cost
// regardless of whether the customer keeps the recurring program —
// closes the adverse-selection gap left by the old multiplicative
// roachModifier (which only paid back after ~3 visits).
//
// Sliding scale by footprint and species — German is materially harder
// than palmetto (longer visit, more product, multi-visit follow-up).
// The dedicated `priceGermanRoach` ($450+ multi-visit cleanout) is
// still available for severe colonies; this is the auto-fire for the
// everyday "I saw one or two" case.
function pricePestInitialRoach(property, options = {}) {
  const { roachType = 'none', standalone = false } = options;
  if (roachType === 'none') return null;

  // Standalone Cockroach Treatment (without recurring pest) uses a higher
  // scale — no future visits to amortize the heavier visit-1 burden across.
  const scaleKey = standalone && roachType === 'regular' ? 'regular_standalone' : roachType;
  const scale = PEST.pestInitialRoach?.[scaleKey];
  if (!Array.isArray(scale) || scale.length === 0) return null;
  const footprint = property?.footprint || 0;
  const bracket = scale.find((b) => footprint < b.sqft) || scale[scale.length - 1];
  const price = bracket.price;

  // Cost detail mirrors pricePestControl's costing block so the margin
  // panel can reason about the fee. Visit-1 burden estimate: heavier
  // chemical rotation + extra on-site labor at GLOBAL.LABOR_RATE.
  const extraMaterial = roachType === 'german' ? 25 : 20;
  const extraOnSiteMin = roachType === 'german' ? 25 : 15;
  const extraLabor = GLOBAL.LABOR_RATE * extraOnSiteMin / 60;
  const incrementalCost = extraMaterial + extraLabor;
  const margin = price > 0 ? (price - incrementalCost) / price : 0;

  const isGerman = roachType === 'german';
  return {
    service: 'pest_initial_roach',
    label: isGerman ? 'Initial German Roach Knockdown' : 'Initial Native Roach Knockdown',
    detail: isGerman
      ? 'Heavier first visit for German roaches (the small indoor / kitchen kind) — interior spray, gel bait at hot spots, and a growth regulator to break the breeding cycle.'
      : 'Heavier first visit for SWFL native roaches (American / palmetto, smoky brown, Australian, Florida woods) — interior spray, bait at hot spots, and perimeter granular.',
    price,
    roachType,
    oneTime: true,
    footprintBracket: bracket.sqft === Infinity ? '2500+' : `<${bracket.sqft}`,
    costs: {
      extraMaterial,
      extraLaborMin: extraOnSiteMin,
      incrementalCost: Math.round(incrementalCost * 100) / 100,
    },
    margin: Math.round(margin * 1000) / 1000,
  };
}

// ============================================================
// LAWN CARE
// ============================================================
function normalizeGrassType(grassType) {
  const raw = String(grassType || '').trim();
  const upper = raw.toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, '');
  for (const [track, aliases] of Object.entries(GRASS_TYPE_ALIASES)) {
    if (raw === track) return track;
    for (const alias of aliases) {
      const aliasRaw = String(alias).trim();
      const aliasCompact = aliasRaw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (upper === aliasRaw.toUpperCase() || compact === aliasCompact) return track;
    }
  }
  return 'st_augustine';
}

function resolveLawnTier(tier, lawnFreq) {
  const freq = Number(lawnFreq);
  if (LAWN_FREQS.includes(freq)) {
    const match = Object.entries(LAWN_TIERS).find(([, cfg]) => cfg.freq === freq);
    if (match) return match[0];
  }
  return LAWN_TIERS[tier] ? tier : 'enhanced';
}

function lookupLawnBracket(lawnSqFt, tierIndex, track = 'st_augustine') {
  const brackets = LAWN_BRACKETS[track];
  if (!brackets || !brackets.length) {
    return { monthly: 0, pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  }

  if (lawnSqFt <= brackets[0][0]) {
    return { monthly: brackets[0][tierIndex + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  }
  if (lawnSqFt > LAWN_TABLE_MAX_SQFT) {
    const lo = brackets[brackets.length - 2];
    const hi = brackets[brackets.length - 1];
    const slope = (hi[tierIndex + 1] - lo[tierIndex + 1]) / (hi[0] - lo[0]);
    return {
      monthly: Math.round(hi[tierIndex + 1] + (lawnSqFt - hi[0]) * slope),
      pricingBasis: 'EXTRAPOLATED_ABOVE_TABLE_MAX',
      pricingSource: 'EXTRAPOLATED_TABLE',
    };
  }
  if (lawnSqFt >= brackets[brackets.length - 1][0]) {
    return { monthly: brackets[brackets.length - 1][tierIndex + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
  }

  for (let i = 0; i < brackets.length - 1; i++) {
    if (lawnSqFt >= brackets[i][0] && lawnSqFt <= brackets[i + 1][0]) {
      const lo = brackets[i], hi = brackets[i + 1];
      const ratio = (lawnSqFt - lo[0]) / (hi[0] - lo[0]);
      return {
        monthly: Math.round(lo[tierIndex + 1] + ratio * (hi[tierIndex + 1] - lo[tierIndex + 1])),
        pricingBasis: 'TABLE_INTERPOLATION',
        pricingSource: 'MARKET_TABLE',
      };
    }
  }
  return { monthly: brackets[brackets.length - 1][tierIndex + 1], pricingBasis: 'TABLE_INTERPOLATION', pricingSource: 'MARKET_TABLE' };
}

function calcLawnAnnualCostFloor(lawnSqFt, track, visits, property = {}, options = {}) {
  const turfK = lawnSqFt / 1000;
  const materialCostPerK = Number.isFinite(Number(options.lawnMaterialCostPerK))
    ? Math.max(0, Number(options.lawnMaterialCostPerK))
    : 8;
  const laborMinutesBase = Number.isFinite(Number(options.lawnLaborMinutesBase))
    ? Math.max(0, Number(options.lawnLaborMinutesBase))
    : 12;
  const laborMinutesPerK = Number.isFinite(Number(options.lawnLaborMinutesPerK))
    ? Math.max(0, Number(options.lawnLaborMinutesPerK))
    : 2.5;
  const routeDriveMinutes = Number.isFinite(Number(options.routeDriveMinutes))
    ? Math.max(0, Number(options.routeDriveMinutes))
    : (Number(property.routeDriveMinutes) || GLOBAL.DRIVE_TIME);
  const targetGrossMargin = Number.isFinite(Number(options.targetLawnGrossMargin))
    && Number(options.targetLawnGrossMargin) > 0
    && Number(options.targetLawnGrossMargin) < 1
    ? Number(options.targetLawnGrossMargin)
    : 0.55;
  const features = property.features || {};
  const complexity = String(features.complexity || property.landscapeComplexity || '').toLowerCase();
  const shrubs = String(features.shrubs || property.shrubDensity || '').toLowerCase();
  const maintenance = String(property.maintenanceCondition || '').toUpperCase().replace(/[\s-]+/g, '_');
  const pressure = String(property.overallPestPressure || '').toUpperCase().replace(/[\s-]+/g, '_');
  const complexityMinutes =
    (complexity === 'moderate' ? 5 : 0) +
    (complexity === 'complex' ? 10 : 0) +
    (shrubs === 'heavy' ? 5 : 0) +
    ((property.fenceType || features.gate || features.accessDifficulty || '').toString().toLowerCase().includes('privacy') || features.largeDriveway ? 5 : 0);
  const callbackReservePerVisit =
    2 +
    (['POOR', 'DEFERRED'].includes(maintenance) ? 5 : 0) +
    (['HIGH', 'SEVERE', 'VERY_HIGH'].includes(pressure) ? 5 : 0);

  const materialCostPerVisit = turfK * materialCostPerK;
  const laborMinutesPerVisit = laborMinutesBase + turfK * laborMinutesPerK + complexityMinutes;
  const laborCostPerVisit = GLOBAL.LABOR_RATE * laborMinutesPerVisit / 60;
  const driveCostPerVisit = GLOBAL.LABOR_RATE * routeDriveMinutes / 60;
  const equipmentCostPerVisit = 4;
  const perVisitCost = materialCostPerVisit + laborCostPerVisit + driveCostPerVisit + equipmentCostPerVisit + callbackReservePerVisit;
  const annualCost = visits * perVisitCost + GLOBAL.ADMIN_ANNUAL;
  return Math.round((annualCost / (1 - targetGrossMargin)) * 100) / 100;
}

function priceLawnCare(property, options = {}) {
  const {
    track = 'st_augustine',
    tier = 'enhanced',
    lawnFreq,
    shadeClassification = 'FULL_SUN',
    useLawnCostFloor = false,
  } = options;

  const normalizedTrack = normalizeGrassType(track);
  const selectedTier = resolveLawnTier(tier, lawnFreq);
  const tierConfig = LAWN_TIERS[selectedTier];
  if (!tierConfig) throw new Error(`Unknown lawn tier: ${selectedTier}`);

  const hasTurfSf = property.turfSf !== undefined && property.turfSf !== null && property.turfSf !== '';
  const hasLawnSqFt = property.lawnSqFt !== undefined && property.lawnSqFt !== null && property.lawnSqFt !== '';
  const turfSqFt = Number(property.turfSf);
  const legacyLawnSqFt = Number(property.lawnSqFt);
  const lawnSqFt = hasTurfSf && Number.isFinite(turfSqFt) && turfSqFt >= 0
    ? turfSqFt
    : (hasLawnSqFt && Number.isFinite(legacyLawnSqFt) && legacyLawnSqFt >= 0 ? legacyLawnSqFt : 4500);

  // Lookup annual cost from v4 protocol data (approximate model)
  // These are based on actual visit-by-visit product costing from v4 protocols
  const materialByTier = {
    st_augustine: {
      FULL_SUN: { basic: 64, standard: 83, enhanced: 141, premium: 205 },
      MODERATE_SHADE: { basic: 50, standard: 65, enhanced: 110, premium: 155 },
      HEAVY_SHADE: { basic: 44, standard: 58, enhanced: 100, premium: 138 },
    },
    bermuda: { FULL_SUN: { basic: 55, standard: 79, enhanced: 140, premium: 215 } },
    zoysia: { FULL_SUN: { basic: 60, standard: 82, enhanced: 148, premium: 178 } },
    bahia: { FULL_SUN: { basic: 45, standard: 68, enhanced: 95, premium: 115 } },
  };

  const trackMaterials = materialByTier[normalizedTrack] || materialByTier.st_augustine;
  const shadeMaterials = trackMaterials[shadeClassification] || trackMaterials.FULL_SUN;
  const annualMaterial = shadeMaterials[selectedTier] || 100;

  // Labor: v4 protocol uses $26.96/visit across all tracks
  const laborPerVisit = 26.96;
  const annualLabor = laborPerVisit * tierConfig.freq;

  // Scale material by lawn size relative to reference (4500 sqft)
  const sizeRatio = Math.max(0.6, Math.min(2.5, lawnSqFt / 4500));
  const scaledMaterial = Math.round(annualMaterial * sizeRatio);

  const annualCost = scaledMaterial + annualLabor + GLOBAL.ADMIN_ANNUAL;

  // ── Tier array: basic / standard / enhanced / premium pre-priced ──
  const TIER_LIST = ['basic', 'standard', 'enhanced', 'premium'];
  const tiers = TIER_LIST.map((t) => {
    const tc = LAWN_TIERS[t];
    if (!tc) return null;
    const market = lookupLawnBracket(lawnSqFt, tc.index, normalizedTrack);
    const marketMonthly = market.monthly;
    const marketAnnual = Math.round(marketMonthly * 12);
    const costFloorAnnual = calcLawnAnnualCostFloor(lawnSqFt, normalizedTrack, tc.freq, property, options);
    const costFloorApplied = !!useLawnCostFloor && costFloorAnnual > marketAnnual;
    const ann = costFloorApplied ? costFloorAnnual : marketAnnual;
    return {
      tier: t,
      index: tc.index,
      visits: tc.freq,
      freq: tc.freq,
      perApp: Math.round(ann / tc.freq * 100) / 100,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      label: `${t.charAt(0).toUpperCase()}${t.slice(1)} (${tc.freq}/yr)`,
      recommended: t === selectedTier,
      pricingBasis: market.pricingBasis,
      pricingSource: costFloorApplied ? 'COST_FLOOR' : market.pricingSource,
      marketMonthly,
      marketAnnual,
      costFloorAnnual,
      costFloorApplied,
    };
  }).filter(Boolean);
  const selected = tiers.find(t => t.tier === selectedTier) || tiers[2];
  const monthly = selected.monthly;
  const annual = selected.annual;
  const perApp = selected.perApp;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;
  const customQuoteFlag = lawnSqFt > LAWN_TABLE_MAX_SQFT;
  const display = LAWN_TRACK_DISPLAY[normalizedTrack] || LAWN_TRACK_DISPLAY.st_augustine;

  return {
    service: 'lawn_care',
    track: normalizedTrack,
    grassCode: display.code,
    grassType: display.label,
    tier: selectedTier,
    shadeClassification,
    lawnSqFt,
    turfSf: lawnSqFt,
    turfEstimated: property.turfEstimated,
    turfConfidence: property.turfConfidence,
    turfBasis: property.turfBasis,
    frequency: tierConfig.freq,
    monthly, annual, perApp,
    tiers,
    selected,
    recommended: selected,
    wgMonthly: selected.monthly,
    pricingBasis: selected.costFloorApplied ? 'COST_FLOOR_OVER_MARKET_TABLE' : selected.pricingBasis,
    pricingSource: selected.pricingSource,
    customQuoteFlag,
    notes: customQuoteFlag
      ? [`Turf area exceeds ${LAWN_TABLE_MAX_SQFT.toLocaleString()} sq ft. Pricing was extrapolated and requires field verification/custom quote.`]
      : [],
    marketMonthly: selected.marketMonthly,
    marketAnnual: selected.marketAnnual,
    costFloorAnnual: selected.costFloorAnnual,
    costFloorApplied: selected.costFloorApplied,
    costs: { annualMaterial: scaledMaterial, annualLabor: Math.round(annualLabor), annualAdmin: GLOBAL.ADMIN_ANNUAL, total: Math.round(annualCost) },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
  };
}

// ============================================================
// TREE & SHRUB
// ============================================================
function hasNonNegativePricingNumber(value) {
  return value !== undefined &&
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0;
}

function hasPositivePricingNumber(value) {
  return value !== undefined &&
    value !== null &&
    value !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0;
}

function normalizeTreeShrubEnum(value, fallback = '') {
  return String(value || fallback || '').trim().toLowerCase();
}

function getTreeShrubShrubDensity(property = {}) {
  return normalizeTreeShrubEnum(
    property.shrubDensity || property.features?.shrubs,
    'moderate'
  );
}

function getTreeShrubComplexity(property = {}) {
  return normalizeTreeShrubEnum(
    property.complexity || property.landscapeComplexity || property.features?.complexity,
    'standard'
  );
}

function normalizeTreeShrubPressure(value) {
  return normalizeTreeShrubEnum(value).replace(/[\s-]+/g, '_');
}

function hasKnownTreeShrubPressure(property = {}) {
  const directSignals = [
    property.pestPressure,
    property.diseasePressure,
    property.features?.pestPressure,
    property.features?.diseasePressure,
  ];
  for (const signal of directSignals) {
    if (signal === true) return true;
    const normalized = normalizeTreeShrubPressure(signal);
    if (normalized && !['false', 'no', 'none', 'low', 'unknown'].includes(normalized)) {
      return true;
    }
  }

  const overallPressure = normalizeTreeShrubPressure(
    property.overallPestPressure || property.features?.overallPestPressure
  );
  return ['high', 'very_high', 'severe'].includes(overallPressure);
}

function estimateTreeShrubBedAreaFromLot(property = {}) {
  const lotSqFt = Number(property.lotSqFt) || 0;
  if (lotSqFt <= 0) return null;

  const shrubDensity = getTreeShrubShrubDensity(property);
  const complexity = getTreeShrubComplexity(property);
  const density = BED_DENSITY[shrubDensity] || BED_DENSITY.moderate;
  let pct = density.basePct;
  if (complexity === 'complex' || complexity === 'moderate') pct += density.complexAdd;

  const rawBedArea = Math.max(0, Math.round(lotSqFt * pct));
  return {
    bedArea: Math.min(rawBedArea, BED_AREA_CAP),
    capped: rawBedArea >= BED_AREA_CAP,
  };
}

function resolveTreeShrubBedArea(property = {}, warnings = []) {
  const sourceHint = normalizeTreeShrubEnum(property.bedAreaSource);
  if (sourceHint === 'fallback') {
    warnings.push('Tree & Shrub bed area was not provided; fallback 2,000 sqft was used.');
    return {
      bedArea: 2000,
      bedAreaSource: 'fallback',
      pricingConfidence: 'low',
      requiresManualReview: true,
    };
  }

  if (hasPositivePricingNumber(property.bedArea)) {
    const bedAreaSource = sourceHint === 'estimated' ? 'estimated' : 'explicit';
    return {
      bedArea: Number(property.bedArea),
      bedAreaSource,
      pricingConfidence: bedAreaSource === 'estimated' ? 'medium' : 'high',
      requiresManualReview: false,
    };
  }

  const estimatedBedAreaValue = hasPositivePricingNumber(property.estimatedBedArea)
    ? property.estimatedBedArea
    : property.estimatedBedAreaSf;
  if (hasPositivePricingNumber(estimatedBedAreaValue)) {
    const rawBedArea = Number(estimatedBedAreaValue);
    return {
      bedArea: Math.min(rawBedArea, BED_AREA_CAP),
      bedAreaSource: 'estimated',
      pricingConfidence: 'medium',
      requiresManualReview: false,
      capped: rawBedArea >= BED_AREA_CAP,
    };
  }

  const lotEstimate = estimateTreeShrubBedAreaFromLot(property);
  if (lotEstimate) {
    return {
      bedArea: lotEstimate.bedArea,
      bedAreaSource: 'estimated',
      pricingConfidence: 'medium',
      requiresManualReview: false,
      capped: lotEstimate.capped,
    };
  }

  warnings.push('Tree & Shrub bed area was not provided; fallback 2,000 sqft was used.');
  return {
    bedArea: 2000,
    bedAreaSource: 'fallback',
    pricingConfidence: 'low',
    requiresManualReview: true,
  };
}

function recommendTreeShrubTier(property = {}) {
  let bedArea = 0;
  if (hasPositivePricingNumber(property.bedArea)) {
    bedArea = Number(property.bedArea);
  } else if (hasPositivePricingNumber(property.estimatedBedArea)) {
    bedArea = Number(property.estimatedBedArea);
  } else if (hasPositivePricingNumber(property.estimatedBedAreaSf)) {
    bedArea = Number(property.estimatedBedAreaSf);
  } else {
    bedArea = estimateTreeShrubBedAreaFromLot(property)?.bedArea || 0;
  }
  const heavyDensity = getTreeShrubShrubDensity(property) === 'heavy';
  const complex = ['moderate', 'complex'].includes(getTreeShrubComplexity(property));
  const highTreeCount = Number(property.treeCount || property.features?.treeCount || 0) >= 8;
  const difficultAccess = normalizeTreeShrubEnum(property.access || property.features?.access) === 'difficult';
  const knownPressure = hasKnownTreeShrubPressure(property);

  if (
    bedArea >= 2000 ||
    heavyDensity ||
    complex ||
    highTreeCount ||
    difficultAccess ||
    knownPressure
  ) {
    return 'enhanced';
  }

  return TREE_SHRUB.defaultTier || 'standard';
}

function normalizeTreeShrubTier(requestedTier, warnings = []) {
  const normalized = normalizeTreeShrubEnum(requestedTier, TREE_SHRUB.defaultTier || 'standard');
  if (normalized === 'premium') {
    warnings.push('Premium Tree & Shrub has been deprecated; Enhanced 9-visit plan was used.');
    return { tier: 'enhanced', legacyTierRequested: 'premium' };
  }
  if (!TREE_SHRUB.tiers[normalized]) throw new Error(`Unknown T&S tier: ${requestedTier}`);
  return { tier: normalized, legacyTierRequested: null };
}

function priceTreeShrub(property, options = {}) {
  property = property || {};
  const warnings = [];
  const access = normalizeTreeShrubEnum(options.access || property.access || property.features?.access, 'easy');
  const treeCount = Math.max(0, Number(
    options.treeCount ?? property.treeCount ?? property.features?.treeCount ?? 0
  ) || 0);
  const recommendationInput = {
    ...property,
    access,
    treeCount,
    features: {
      ...(property.features || {}),
      access,
      treeCount,
    },
  };
  const recommendedTier = recommendTreeShrubTier(recommendationInput);
  const requestedTier = options.tier || recommendedTier;
  const { tier, legacyTierRequested } = normalizeTreeShrubTier(requestedTier, warnings);
  const tierConfig = TREE_SHRUB.tiers[tier];

  const bedAreaInfo = resolveTreeShrubBedArea(property, warnings);
  const bedArea = bedAreaInfo.bedArea;

  const accessMin = TREE_SHRUB.accessMinutes[access] || 0;
  const onSiteMin = Math.max(25, 20 + Math.round(bedArea / 500) + Math.round(treeCount * 1.5) + accessMin);

  const frequency = tierConfig.frequency;
  const materialRate = tierConfig.materialRate;
  const materialCost = Math.max(frequency * 10, bedArea * materialRate);

  const laborPerVisit = GLOBAL.LABOR_RATE * ((onSiteMin + 10) / 60);
  const laborAnnual = laborPerVisit * frequency;

  const annualDirectCost = materialCost + laborAnnual;
  const directCostRatioTarget = TREE_SHRUB.directCostRatioTarget || GLOBAL.DIRECT_COST_RATIO_TARGET_TS || 0.43;
  const baseAnnualPrice = annualDirectCost / directCostRatioTarget;
  const monthlyCalc = baseAnnualPrice / 12;
  const monthly = Math.max(tierConfig.monthlyFloor, roundMoney(monthlyCalc));
  const annual = roundMoney(monthly * 12);
  const internalPerVisitRevenue = roundMoney(annual / frequency);
  const baseMarginRaw = annual > 0 ? (annual - annualDirectCost - GLOBAL.ADMIN_ANNUAL) / annual : 0;
  const baseMargin = roundRatio(baseMarginRaw);

  let requiresManualReview = !!bedAreaInfo.requiresManualReview;
  if (bedAreaInfo.bedAreaSource === 'fallback') {
    requiresManualReview = true;
  }
  if (bedArea >= BED_AREA_CAP || bedAreaInfo.capped) {
    requiresManualReview = true;
    warnings.push('Tree & Shrub bed area hit the estimator cap; manual review recommended.');
  }
  if (treeCount >= 15) {
    requiresManualReview = true;
    warnings.push('High tree count; manual review recommended.');
  }
  if (access === 'difficult' && bedArea >= 4000) {
    requiresManualReview = true;
    warnings.push('Difficult access with large bed area; manual review recommended.');
  }

  return {
    service: 'tree_shrub',
    tier,
    ...(legacyTierRequested ? { legacyTierRequested } : {}),
    recommendedTier,
    recommended: tier === recommendedTier,
    availableTiers: Object.keys(TREE_SHRUB.tiers),
    frequency,
    bedArea,
    bedAreaSource: bedAreaInfo.bedAreaSource,
    pricingConfidence: bedAreaInfo.pricingConfidence,
    treeCount,
    access,
    onSiteMin,
    materialRate,
    monthly,
    annual,
    internalPerVisitRevenue,
    perApp: internalPerVisitRevenue,
    costs: {
      materialCost: roundMoney(materialCost),
      laborCost: roundMoney(laborAnnual),
      adminCost: GLOBAL.ADMIN_ANNUAL,
      directCost: roundMoney(annualDirectCost),
      totalWithAdmin: roundMoney(annualDirectCost + GLOBAL.ADMIN_ANNUAL),
      total: roundMoney(annualDirectCost + GLOBAL.ADMIN_ANNUAL),
    },
    directCostRatioTarget,
    baseMargin,
    margin: baseMargin,
    marginFloorOk: baseMarginRaw >= (TREE_SHRUB.marginFloor || GLOBAL.MARGIN_FLOOR),
    requiresManualReview,
    warnings: [...new Set(warnings)],
  };
}

// ============================================================
// PALM INJECTION
// ============================================================
const PALM_WARNING_TEXT = {
  nutrition: 'Corrective injection; not a replacement for full granular palm fertilization.',
  combo: 'Do not model as tank mix; separate compatible application steps.',
  fungal: 'Diagnosis/product-driven treatment.',
  lethalBronzing: 'Preventive program only; not a cure for symptomatic or positive palms.',
  treeAge: 'Annual value is annualized from a 24-month interval; perVisit is the event price.',
};

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isMissingPrice(value) {
  return value === null || value === undefined || value === '';
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw buildPricingError(`${name} must be a positive integer`, { field: name, value });
  }
  return value;
}

function assertPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw buildPricingError(`${name} must be a positive number`, { field: name, value });
  }
  return value;
}

function assertEnum(value, allowedValues, name) {
  if (!allowedValues.includes(value)) {
    throw buildPricingError(`${name} must be one of: ${allowedValues.join(', ')}`, {
      field: name,
      value,
      allowedValues,
    });
  }
  return value;
}

function buildPricingError(message, metadata = {}) {
  const err = new Error(message);
  err.name = 'PricingError';
  err.status = 400;
  err.statusCode = 400;
  err.code = 'PRICING_VALIDATION_ERROR';
  err.isOperational = true;
  err.metadata = metadata;
  return err;
}

function assertCustomPriceIfPresent(customPricePerPalm) {
  if (isMissingPrice(customPricePerPalm)) return;
  if (typeof customPricePerPalm !== 'number' || !Number.isFinite(customPricePerPalm)) {
    throw new Error('customPricePerPalm must be a finite number');
  }
  if (customPricePerPalm < 0) {
    throw new Error('customPricePerPalm must be non-negative');
  }
}

function resolveQuotePrice(customPricePerPalm, floorPerPalm) {
  assertCustomPriceIfPresent(customPricePerPalm);
  if (isMissingPrice(customPricePerPalm)) {
    return {
      pricePerPalm: floorPerPalm,
      quoteFloorApplied: false,
      customPriceProvided: false,
    };
  }

  return {
    pricePerPalm: Math.max(customPricePerPalm, floorPerPalm),
    quoteFloorApplied: customPricePerPalm < floorPerPalm,
    customPriceProvided: true,
  };
}

function resolveAppsPerYear(treatment, options = {}) {
  if (!isMissingPrice(options.appsPerYear)) {
    return assertPositiveNumber(options.appsPerYear, 'appsPerYear');
  }
  if (!isMissingPrice(options.intervalMonths)) {
    return roundCurrency(12 / assertPositiveNumber(options.intervalMonths, 'intervalMonths'));
  }
  if (treatment.intervalMonths) {
    const intervalAppsPerYear = 12 / treatment.intervalMonths;
    if (typeof treatment.appsPerYear === 'number') return treatment.appsPerYear;
    return roundCurrency(intervalAppsPerYear);
  }
  if (typeof treatment.defaultAppsPerYear === 'number') return treatment.defaultAppsPerYear;
  if (typeof treatment.appsPerYear === 'number') return treatment.appsPerYear;
  throw new Error('appsPerYear could not be resolved for palm treatment');
}

function getTierByPalmSize(treatment, palmSize) {
  if (!palmSize) throw new Error('palmSize is required for this palm treatment');
  const tier = (treatment.tiers || []).find(t => t.size === palmSize);
  if (!tier) throw new Error('palmSize must be one of: small, medium, large');
  return tier;
}

function getTreeAgeTier(treatment, dbhInches) {
  return (treatment.tiers || []).find(t => t.dbhMax === null || dbhInches <= t.dbhMax);
}

function formatInterval(intervalMonths) {
  if (!intervalMonths) return undefined;
  const unit = intervalMonths === 1 ? 'month' : 'months';
  return `every ${intervalMonths} ${unit}`;
}

function shouldIncludePalmInternalCostBasis(options) {
  return options.includeInternalCostBasis === true
    && (options.internal === true || options.isInternal === true || options.admin === true || options.isAdmin === true);
}

function pricePalmInjection(property, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Palm injection options are required');
  }

  const { treatmentType, customPricePerPalm } = options;
  if (!treatmentType) throw new Error('Palm treatmentType is required');

  const treatment = PALM.treatments[treatmentType];
  if (!treatment) throw new Error(`Unknown palm treatment: ${treatmentType}`);

  const palmCount = assertPositiveInteger(options.palmCount, 'palmCount');
  assertCustomPriceIfPresent(customPricePerPalm);

  let palmSize;
  let dbhInches;
  let intervalMonths;
  let appsPerYear;
  let pricePerPalm;
  let quoteBased = treatment.quoteBased === true;
  let quoteFloorApplied = false;
  let customPriceProvided = false;
  const warnings = [];
  if (PALM_WARNING_TEXT[treatmentType]) warnings.push(PALM_WARNING_TEXT[treatmentType]);

  if (treatment.pricingType === 'fixed') {
    if (!isMissingPrice(options.appsPerYear)) {
      appsPerYear = assertPositiveNumber(options.appsPerYear, 'appsPerYear');
      if (!treatment.allowedAppsPerYear.includes(appsPerYear)) {
        throw new Error(`appsPerYear for ${treatmentType} must be one of: ${treatment.allowedAppsPerYear.join(', ')}`);
      }
    } else {
      appsPerYear = treatment.defaultAppsPerYear;
    }
    pricePerPalm = treatment.pricePerPalm;
  } else if (treatment.pricingType === 'tiered') {
    palmSize = options.palmSize;
    const tier = getTierByPalmSize(treatment, palmSize);
    appsPerYear = treatment.defaultAppsPerYear;

    const quoteFlags = treatment.quoteBasedWhen || [];
    const requiresQuotePrice = quoteFlags.some(flag => options[flag] === true);
    if (requiresQuotePrice) {
      if (isMissingPrice(customPricePerPalm)) {
        throw new Error(`customPricePerPalm is required for quote-based ${treatmentType} palm pricing`);
      }
      const quotePrice = resolveQuotePrice(customPricePerPalm, tier.pricePerPalm);
      pricePerPalm = quotePrice.pricePerPalm;
      quoteFloorApplied = quotePrice.quoteFloorApplied;
      customPriceProvided = quotePrice.customPriceProvided;
      quoteBased = true;
    } else {
      pricePerPalm = tier.pricePerPalm;
    }
  } else if (treatmentType === 'fungal') {
    if (options.diagnosisConfirmed !== true) {
      throw new Error('diagnosisConfirmed must be true for fungal palm treatment pricing');
    }
    if (!options.selectedProduct) {
      throw new Error('selectedProduct is required for fungal palm treatment pricing');
    }
    if (!treatment.products.includes(options.selectedProduct)) {
      throw new Error(`selectedProduct must be one of: ${treatment.products.join(', ')}`);
    }
    if (isMissingPrice(options.appsPerYear) && isMissingPrice(options.intervalMonths)) {
      throw new Error('fungal palm treatment pricing requires appsPerYear or intervalMonths');
    }
    intervalMonths = !isMissingPrice(options.intervalMonths)
      ? assertPositiveNumber(options.intervalMonths, 'intervalMonths')
      : undefined;
    appsPerYear = resolveAppsPerYear(treatment, options);
    const quotePrice = resolveQuotePrice(customPricePerPalm, treatment.floorPerPalm);
    pricePerPalm = quotePrice.pricePerPalm;
    quoteFloorApplied = quotePrice.quoteFloorApplied;
    customPriceProvided = quotePrice.customPriceProvided;
  } else if (treatmentType === 'lethalBronzing') {
    const palmStatus = options.palmStatus;
    if (!palmStatus) throw new Error('palmStatus is required for lethal bronzing palm pricing');
    if (treatment.ineligibleStatuses.includes(palmStatus)) {
      throw new Error('Palm is not eligible for lethal bronzing injection pricing and should be handled outside this service');
    }
    if (!treatment.eligibleStatuses.includes(palmStatus)) {
      throw new Error(`Unknown or invalid lethal bronzing palmStatus: ${palmStatus}`);
    }
    intervalMonths = treatment.intervalMonths;
    appsPerYear = resolveAppsPerYear(treatment);
    const quotePrice = resolveQuotePrice(customPricePerPalm, treatment.floorPerPalm);
    pricePerPalm = quotePrice.pricePerPalm;
    quoteFloorApplied = quotePrice.quoteFloorApplied;
    customPriceProvided = quotePrice.customPriceProvided;
  } else if (treatmentType === 'treeAge') {
    dbhInches = assertPositiveNumber(options.dbhInches, 'dbhInches');
    const tier = getTreeAgeTier(treatment, dbhInches);
    const tierFloor = tier.pricePerPalm || 110;
    if (tier.quoteBased && isMissingPrice(customPricePerPalm)) {
      throw new Error('customPricePerPalm is required for Tree-Age pricing above 20 DBH inches');
    }
    if ((options.product === 'Tree-Age R10' || options.restrictedUseProduct === true) && options.licensedApplicator !== true) {
      throw new Error('licensedApplicator is required for restricted-use Tree-Age product pricing');
    }
    intervalMonths = treatment.intervalMonths;
    appsPerYear = resolveAppsPerYear(treatment);
    const quotePrice = resolveQuotePrice(customPricePerPalm, tierFloor);
    pricePerPalm = quotePrice.pricePerPalm;
    quoteFloorApplied = quotePrice.quoteFloorApplied;
    customPriceProvided = quotePrice.customPriceProvided;
  } else {
    throw new Error(`Unsupported palm treatment pricing type: ${treatment.pricingType}`);
  }

  const rawPerVisit = roundCurrency(pricePerPalm * palmCount);
  const perVisit = roundCurrency(Math.max(rawPerVisit, PALM.minPerVisit));
  const minimumApplied = perVisit > rawPerVisit;
  const minimumShortfallPerVisit = minimumApplied ? roundCurrency(perVisit - rawPerVisit) : 0;
  const rawAnnual = roundCurrency(rawPerVisit * appsPerYear);
  const annualBeforeCredits = roundCurrency(perVisit * appsPerYear);
  const monthlyBeforeCredits = roundCurrency(annualBeforeCredits / 12);

  const result = {
    service: 'palm_injection',

    treatmentType,
    treatmentLabel: treatment.label,
    pricingType: treatment.pricingType,

    palmCount,
    palmSize,
    dbhInches,

    pricePerPalm: roundCurrency(pricePerPalm),
    quoteBased,
    quoteFloorApplied,
    customPriceProvided,

    appsPerYear,
    intervalMonths,
    minimumProgramMonths: treatment.minimumProgramMonths,

    rawPerVisit,
    perVisit,
    minimumApplied,
    minimumShortfallPerVisit,

    rawAnnual,
    annualBeforeCredits,
    monthlyBeforeCredits,

    annual: annualBeforeCredits,
    monthly: monthlyBeforeCredits,

    tierQualifier: PALM.tierQualifier,
    excludeFromPctDiscount: PALM.excludeFromPctDiscount,

    flatCredit: PALM.flatCreditPerPalm,
    flatCreditPerPalm: PALM.flatCreditPerPalm,
    flatCreditMinTier: PALM.flatCreditMinTier,

    warnings,
  };

  if (intervalMonths) {
    result.displayFrequency = formatInterval(intervalMonths);
    result.annualized = intervalMonths > 12;
  }
  if (options.selectedProduct) result.selectedProduct = options.selectedProduct;
  if (shouldIncludePalmInternalCostBasis(options)) result.internalCostBasis = PALM.internalCostBasis;

  return result;
}

// ============================================================
// MOSQUITO
// ============================================================
function priceMosquito(property, options = {}) {
  const {
    tier = null,
    modifiers = {},
    stationCount = 0,
    dunkCount = 0,
  } = options;

  const lotCategory = property.mosquitoLotCategory || property.lotCategory;
  const basePrices = MOSQUITO.basePrices[lotCategory];
  if (!basePrices) throw new Error(`Unknown lot category: ${lotCategory}`);

  // Pressure multiplier
  let pressure = 1.00;
  const f = property.features || {};
  if (f.trees === 'heavy') pressure += MOSQUITO.pressureFactors.trees_heavy;
  else if (f.trees === 'moderate') pressure += MOSQUITO.pressureFactors.trees_moderate;
  if (f.complexity === 'complex') pressure += MOSQUITO.pressureFactors.complexity_complex;
  else if (f.complexity === 'moderate') pressure += MOSQUITO.pressureFactors.complexity_moderate;
  if (f.pool || f.poolCage) pressure += MOSQUITO.pressureFactors.pool;
  if (f.nearWater) pressure += MOSQUITO.pressureFactors.nearWater;
  if (f.irrigation) pressure += MOSQUITO.pressureFactors.irrigation;
  if (lotCategory === 'ACRE') pressure += MOSQUITO.pressureFactors.lot_acre;
  else if (lotCategory === 'HALF') pressure += MOSQUITO.pressureFactors.lot_half;
  // v2 graduated water proximity replaces binary nearWater when provided
  const waterMultiplier = Number(modifiers.mosquitoWaterMult || 1);
  if (waterMultiplier && waterMultiplier !== 1.0) {
    pressure *= waterMultiplier;
  }
  pressure = Math.min(pressure, MOSQUITO.pressureCap);

  const recommendedProgram = (
    pressure >= 1.30 ||
    waterMultiplier >= 1.20 ||
    f.trees === 'heavy'
  ) ? 'monthly12' : 'seasonal9';
  const selectedProgram = normalizeMosquitoProgramKey(tier) || recommendedProgram;
  const tierIndex = MOSQUITO.programs.indexOf(selectedProgram);
  if (tierIndex < 0) throw new Error(`Unknown mosquito program: ${tier}`);
  const basePrice = basePrices[tierIndex];

  const perVisit = Math.round(basePrice * pressure);
  const visits = MOSQUITO.tierVisits[selectedProgram];
  const stationQty = Math.max(0, Math.round(Number(stationCount) || 0));
  const dunkQty = Math.max(0, Math.round(Number(dunkCount) || 0));
  const stationAddOn = stationQty * MOSQUITO.addOns.in2CareStation.price;
  const dunkAddOn = dunkQty * MOSQUITO.addOns.dunkTablet.price;
  const annualAddOns = stationAddOn + dunkAddOn;
  const annual = perVisit * visits + annualAddOns;
  const monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate
  const treatableThousands = Math.max(1, (property.mosquitoTreatableSqFt || 0) / 1000);
  const usage = MOSQUITO.productUsage;
  const costs = MOSQUITO.productCosts;
  const usesPrecisionAdulticide = false;
  const adulticideCost = usesPrecisionAdulticide
    ? (usage.scionBaseOz + usage.scionOzPer1000 * treatableThousands) * costs.scionOz
    : Math.max(usage.bifenthrinBaseOz, usage.bifenthrinOzPer1000 * treatableThousands) * costs.bifenthrinOz;
  const igrCost = usage.tekkoProOz * costs.tekkoProOz;
  const materialPerVisit = Math.round((adulticideCost + igrCost) * 100) / 100;
  const addOnCost = stationQty * costs.in2CareStation + dunkQty * costs.summitDunkTablet;
  const laborPerVisitCost = laborCost(30);
  const annualCost = (materialPerVisit + laborPerVisitCost) * visits + addOnCost + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  const tiers = MOSQUITO.programs.map((name, idx) => {
    const bp = basePrices[idx];
    const pv = Math.round(bp * pressure);
    const v = MOSQUITO.tierVisits[name];
    const ann = pv * v + annualAddOns;
    return {
      tier: name,
      perVisit: pv,
      visits: v,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      name: MOSQUITO.programLabels[name] || name.charAt(0).toUpperCase() + name.slice(1),
      recommended: name === selectedProgram,
      selected: name === selectedProgram,
      pressureRecommended: name === recommendedProgram,
    };
  });

  return {
    service: 'mosquito',
    tier: selectedProgram,
    lotCategory,
    grossLotCategory: property.lotCategory,
    mosquitoTreatableSqFt: property.mosquitoTreatableSqFt || 0,
    basePrice, pressureMultiplier: pressure,
    perVisit, visits, annual, monthly,
    tiers,
    addOns: {
      stationCount: stationQty,
      dunkCount: dunkQty,
      stationAddOn,
      dunkAddOn,
      annualAddOns,
    },
    costs: {
      adulticide: usesPrecisionAdulticide ? 'Gamma-cyhalothrin' : 'Bifenthrin',
      igr: 'Pyriproxyfen + Novaluron',
      materialPerVisit,
      addOnCost: Math.round(addOnCost * 100) / 100,
      laborPerVisit: Math.round(laborPerVisitCost * 100) / 100,
      annualCost: Math.round(annualCost),
    },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    recommendedTier: selectedProgram,
    recommendedProgram,
    waterMultiplier,
  };
}

// ============================================================
// TERMITE BAIT STATIONS
// ============================================================
function priceTermiteBait(property, options = {}) {
  const {
    // Default switched to Advance Apr 2026 (was 'trelona') for competitive
    // doorstep pricing. Trelona remains available as the premium upgrade.
    system = 'advance',
    monitoringTier = 'basic',
    modifiers = {},
  } = options;

  const footprint = property.footprint;
  const complexity = (property.features || {}).complexity;
  const perimMult = (complexity === 'complex' || complexity === 'moderate')
    ? TERMITE.perimeterMultiplier.complex
    : TERMITE.perimeterMultiplier.standard;
  const perimeter = Math.round(4 * Math.sqrt(footprint) * perimMult);
  const stations = Math.max(TERMITE.minStations, Math.ceil(perimeter / TERMITE.stationSpacing));

  const sys = TERMITE.systems[system];
  const conMult = modifiers.termiteConstructionMult || 1.0;
  const foundAdj = modifiers.termiteFoundationAdj || 0;
  const installMaterialCost = stations * (sys.stationCost + sys.laborMaterial + sys.misc);
  // 5 min per station — calibrated Apr 2026 against All U Need invoice
  // (21 Sentricon stations installed in 78 min by one tech = 3.7 min/sta).
  // Prior value was 0.25 hr (15 min/sta), ~4x the observed pace, which made
  // reported install margin look artificially negative under the 1.45x mult.
  const installLabor = stations * 0.083 * GLOBAL.LABOR_RATE;
  const installCost = installMaterialCost + installLabor;
  const installPrice = Math.round(installMaterialCost * TERMITE.installMultiplier * conMult + foundAdj);
  const installMargin = installPrice > 0 ? (installPrice - installCost) / installPrice : 0;

  const mon = TERMITE.monitoring[monitoringTier];
  const monitoringMonthly = mon.monthly;
  const monitoringAnnual = monitoringMonthly * 12;

  return {
    service: 'termite_bait',
    system, monitoringTier,
    perimeter, stations,
    installation: {
      materialCost: Math.round(installMaterialCost),
      laborCost: Math.round(installLabor),
      totalCost: Math.round(installCost),
      price: installPrice,
      margin: Math.round(installMargin * 1000) / 1000,
    },
    monitoring: {
      monthly: monitoringMonthly,
      annual: monitoringAnnual,
    },
    annual: monitoringAnnual,
    monthly: monitoringMonthly,
  };
}

// ============================================================
// RODENT BAIT STATIONS
// ============================================================
function priceRodentBait(property, options = {}) {
  const { modifiers = {}, postExclusion = false } = options;
  const footprint = property.footprint;
  const lotSqFt = property.lotSqFt;
  const f = property.features || {};

  let score = 0;
  if (footprint >= 2500) score += RODENT.baitScoreFactors.footprint_2500plus;
  else if (footprint >= 1800) score += RODENT.baitScoreFactors.footprint_1800plus;
  if (lotSqFt >= 20000) score += RODENT.baitScoreFactors.lot_20000plus;
  else if (lotSqFt >= 12000) score += RODENT.baitScoreFactors.lot_12000plus;
  if (f.nearWater) score += RODENT.baitScoreFactors.nearWater;
  if (f.trees === 'heavy') score += RODENT.baitScoreFactors.trees_heavy;
  // Tile roof (barrel-tile nesting harborage) bumps size tier
  if ((property.roofType || '').toUpperCase() === 'TILE') score += 1;

  let size, monthly;
  if (score <= 1) { size = 'small'; monthly = RODENT.baitMonthly.small.monthly; }
  else if (score <= 2) { size = 'medium'; monthly = RODENT.baitMonthly.medium.monthly; }
  else { size = 'large'; monthly = RODENT.baitMonthly.large.monthly; }

  // Add roof-type adjustment (annual) for additional stations on tile/metal roofs
  const roofAnnualAdj = (modifiers.rodentRoofAdj || 0);
  let annual = monthly * 12 + roofAnnualAdj;
  monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate: quarterly visits (4/yr) — billed monthly to customer.
  // On-site time per visit is slightly longer than the old monthly model
  // because the tech inspects all stations in one pass instead of spreading
  // checks across the year.
  const visitsPerYear = RODENT.baitVisitsPerYear || 4;
  let onSiteMin = size === 'small' ? 25 : size === 'medium' ? 30 : 40;
  let materialPerVisit = size === 'small' ? 6 : size === 'medium' ? 9 : 12;
  let stationAmortAnnual = size === 'small' ? 30 : size === 'medium' ? 45 : 60;

  // POST-EXCLUSION MODIFIER — sealed structure = lighter scope
  // Three independent levers (per post-exclusion-modifier-spec.md):
  //   1. Station count   ~ -35% (perimeter only, floor 4 stations) → revenue-side ~0.65×
  //   2. Bait cost       ~ -20% (lower uptake on sealed structure)
  //   3. Labor           ~ -40% (no diagnostic, lighter visits)
  // Net combined revenue impact ≈ 0.72×. Floor rebased to $39/mo for new
  // quarterly-cadence base prices ($49/$59/$69).
  if (postExclusion) {
    const cfg = RODENT.baitPostExclusion || { multiplier: 0.72, floorMonthly: 39 };
    monthly = Math.max(cfg.floorMonthly, Math.round(monthly * cfg.multiplier * 100) / 100);
    annual = Math.round(monthly * 12);
    materialPerVisit = Math.round(materialPerVisit * 0.80 * 100) / 100;
    onSiteMin = Math.round(onSiteMin * 0.60);
  }

  const laborPerVisitCost = laborCost(onSiteMin);
  const annualCost =
    (materialPerVisit + laborPerVisitCost) * visitsPerYear
    + stationAmortAnnual
    + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  return {
    service: 'rodent_bait',
    score, size, monthly, annual,
    visitsPerYear,
    postExclusion,
    costs: {
      materialPerVisit,
      laborPerVisit: Math.round(laborPerVisitCost * 100) / 100,
      stationAmortAnnual,
      annualCost: Math.round(annualCost),
    },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    tierQualifier: RODENT.tierQualifier,
    excludeFromPctDiscount: RODENT.excludeFromPctDiscount,
  };
}

// ============================================================
// RODENT TRAPPING (One-Time)
// ============================================================
// Base price = setup visit + 2 included follow-up trap checks. Final price
// adjusts for home size, lot size, rodent pressure, and optional emergency
// surcharge. Additional follow-ups beyond the 2 included billed via
// priceRodentTrappingFollowups().
//
// Inputs:
//   property: { footprint, lotSqFt, features }
//   options:
//     pressure: 'light' | 'normal' | 'moderate' | 'heavy' | 'severe'
//     emergency: boolean — same-day / urgent surcharge
//
// Pressure inferred from property.features when not provided:
//   trees=heavy + nearWater  → heavy
//   trees=heavy or nearWater → moderate
//   default                  → normal
function _bracketLookup(value, brackets, key) {
  for (const b of brackets) {
    if (value <= b[key]) return b;
  }
  return brackets[brackets.length - 1];
}

function priceRodentTrapping(property, options = {}) {
  const cfg = RODENT.trapping;
  const footprint = property.footprint || 0;
  const lotSqFt = property.lotSqFt || 0;
  const f = property.features || {};
  const { emergency = false } = options;

  // Default pressure inference from property features.
  let pressure = options.pressure;
  if (!pressure) {
    if (f.trees === 'heavy' && f.nearWater) pressure = 'heavy';
    else if (f.trees === 'heavy' || f.nearWater) pressure = 'moderate';
    else pressure = 'normal';
  }

  const homeBracket = _bracketLookup(footprint, cfg.homeSizeAdjustments, 'maxSqFt');
  const lotBracket = _bracketLookup(lotSqFt, cfg.lotAdjustments, 'maxLotSqFt');
  const homeAdj = homeBracket.adjustment;
  const lotAdj = lotBracket.adjustment;
  const pressureAdj = cfg.pressureAdjustments[pressure] ?? 0;

  let raw = cfg.base + homeAdj + lotAdj + pressureAdj;

  // Emergency surcharge: 20% of subtotal OR fixed minimum, whichever is higher.
  let emergencySurcharge = 0;
  if (emergency) {
    const pctSurcharge = raw * (cfg.emergencyMultiplier - 1);
    emergencySurcharge = Math.max(pctSurcharge, cfg.emergencyMinimumSurcharge);
    raw += emergencySurcharge;
  }

  const rounded = Math.round(raw / 5) * 5;
  const customRecommended = !!(homeBracket.customRecommended || lotBracket.customRecommended);
  const price = Math.max(cfg.floor, Math.min(cfg.ceilingBeforeCustom, rounded));

  return {
    service: 'rodent_trapping',
    price,
    base: cfg.base,
    homeAdj,
    lotAdj,
    pressure,
    pressureAdj,
    emergency,
    emergencySurcharge: Math.round(emergencySurcharge),
    includedFollowUps: cfg.includedFollowUps,
    customRecommended,
    detail: `Setup + ${cfg.includedFollowUps} follow-ups | ${pressure} pressure${emergency ? ' | EMERGENCY' : ''}`,
  };
}

// ============================================================
// RODENT TRAPPING — ADDITIONAL FOLLOW-UP VISITS
// ============================================================
// Base trapping price includes setup + 2 follow-ups. Use this for additional
// checks on active infestations beyond the included visits.
function priceRodentTrappingFollowups(count = 1) {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return null;

  const perVisit = RODENT.trapping.additionalFollowUpRate;
  const price = n * perVisit;

  return {
    service: 'rodent_trapping_followup',
    count: n,
    perVisit,
    price,
    detail: `${n} additional follow-up${n === 1 ? '' : 's'} @ $${perVisit}/ea`,
  };
}

// ============================================================
// RODENT SANITATION (bleach + wipe; CDC-aligned cleanup)
// ============================================================
// Three tiers — light / standard / heavy — with affected-sqft scaling
// and per-cu-ft contaminated-debris pricing.
//
// Inputs:
//   tier:                  'light' | 'standard' | 'heavy' (alias 'medium' → 'standard')
//   affectedSqFt:          actual cleanup area on site
//   insulationRemovalCuFt: contaminated debris volume to dispose
//   accessType:            'normal' | 'crawlspace' | 'tight' (heavy tier only)
//
// Pricing formula:
//   tier base
//   + max(0, affectedSqFt - includedSqFt)   * additionalPerSqFt
//   + max(0, debrisCuFt    - includedDebris) * additionalDebrisPerCuFt
//   * accessMultiplier (heavy tier)
//
// Heavy tier requires custom-quote review when debris > 25 cu ft (this is
// the cutoff at which most real attic insulation removal jobs need a sub
// or HEPA truck — we flag rather than silently underprice).
function priceSanitation(options = {}) {
  const {
    tier: rawTier = 'standard',
    affectedSqFt = 0,
    insulationRemovalCuFt = 0,
    accessType = 'normal',
  } = options;

  const aliasedTier = RODENT.sanitation.legacyAliases?.[rawTier] || rawTier;
  const cfg = RODENT.sanitation[aliasedTier];
  if (!cfg || aliasedTier === 'legacyAliases') {
    throw new Error(`Unknown sanitation tier: ${rawTier}`);
  }

  const sqFtOverage = Math.max(0, affectedSqFt - cfg.includedSqFt);
  const debrisOverage = Math.max(0, insulationRemovalCuFt - (cfg.includedDebrisCuFt || 0));
  const sqFtCharge = sqFtOverage * cfg.additionalPerSqFt;
  const debrisCharge = debrisOverage * (cfg.additionalDebrisPerCuFt || 0);

  let raw = cfg.base + sqFtCharge + debrisCharge;

  // Heavy-tier access multipliers
  let accessMult = 1.0;
  if (aliasedTier === 'heavy') {
    if (accessType === 'crawlspace') accessMult = cfg.crawlspaceMultiplier || 1.0;
    else if (accessType === 'tight') accessMult = cfg.tightAccessMultiplier || 1.0;
  }
  raw *= accessMult;

  const price = Math.max(cfg.floor, Math.round(raw / 5) * 5);

  // Flag for custom quote when debris exceeds heavy-tier ceiling
  const customQuoteRecommended = aliasedTier === 'heavy' && insulationRemovalCuFt > 25 + 25;

  return {
    service: 'rodent_sanitation',
    tier: aliasedTier,
    name: `Rodent Sanitation (${cfg.label})`,
    price,
    base: cfg.base,
    sqFtOverage,
    debrisOverage,
    sqFtCharge: Math.round(sqFtCharge * 100) / 100,
    debrisCharge: Math.round(debrisCharge),
    accessMult,
    customQuoteRecommended,
    detail: `${cfg.label} — ${cfg.durationMin} min | ${affectedSqFt} sf affected`
      + (debrisOverage > 0 ? ` | +${debrisOverage} cu ft debris` : '')
      + (accessMult > 1 ? ` | ${accessType} access ×${accessMult}` : ''),
  };
}

// ============================================================
// BAIT-STATION SETUP FEE (waived in standard recurring sign-up)
// ============================================================
// Returns 0 when waived (caller decides). Constant retained on the
// books so non-recurring edge cases can invoice it explicitly.
function priceBaitSetup(options = {}) {
  const { waived = true } = options;
  return {
    service: 'rodent_bait_setup',
    name: 'Bait Station Setup',
    price: waived ? 0 : RODENT.baitSetupFee,
    waived,
    detail: waived
      ? 'Waived with recurring plan'
      : `One-time $${RODENT.baitSetupFee} setup`,
  };
}

// ============================================================
// ONE-TIME PEST
// ============================================================
function priceOneTimePest(property, options = {}) {
  const {
    urgency = 'NONE',
    afterHours = false,
    isRecurringCustomer = false,
    recurringPestPerApp = null,
    roachType = 'none',
  } = options;

  let base;
  if (recurringPestPerApp) {
    const roachMod = PEST.roachModifier[roachType] || 0;
    // Legacy guard: roach modifiers are currently zero, but keep the backout
    // harmless if an old saved estimate or future config reintroduces a value.
    base = recurringPestPerApp / (1 + roachMod);
  } else {
    const pestResult = pricePestControl(property, { frequency: 'quarterly', roachType: 'none' });
    base = pestResult.basePrice;
  }

  const preUrgencyPrice = applyOneTimeFloor(
    Math.round(base * ONE_TIME.pest.multiplier),
    ONE_TIME.pest.floor
  );
  const urgencyMultiplier = getOneTimeUrgencyMultiplier({ urgency, afterHours });
  const discountBase = preUrgencyPrice * urgencyMultiplier;
  const discounted = applyOneTimeRecurringCustomerDiscount(discountBase, { isRecurringCustomer });
  const price = applyOneTimeFloor(discounted.price, ONE_TIME.pest.floor);

  return {
    service: 'one_time_pest',
    price,
    urgency,
    afterHours,
    isRecurringCustomer,
    basePrice: Math.round(base * 100) / 100,
    preUrgencyPrice,
    urgencyMultiplier,
    subtotalBeforeRecurringCustomerDiscount: Math.round(discountBase),
    recurringCustomerDiscountRate: discounted.rate,
    recurringCustomerDiscountAmount: Math.max(0, Math.round(discountBase) - price),
    discountHandledByPricingFunction: true,
  };
}

// ============================================================
// ONE-TIME LAWN
// ============================================================
function priceOneTimeLawn(property, options = {}) {
  const {
    treatmentType = 'weed',
    urgency = 'NONE',
    afterHours = false,
    isRecurringCustomer = false,
    track = 'st_augustine',
    tier = 'enhanced',
    lawnFreq,
  } = options;

  const normalizedTreatment = treatmentType === 'fertilization' ? 'fert' : treatmentType;
  const lawnResult = priceLawnCare(property, {
    track,
    tier,
    lawnFreq,
    useLawnCostFloor: false,
  });
  const base = Math.max(ONE_TIME.lawn.floor, Math.round(lawnResult.perApp * ONE_TIME.lawn.oneTimeMultiplier));

  const treatMult = ONE_TIME.lawn.treatmentMultipliers[normalizedTreatment] || 1.0;
  const preUrgencyPrice = applyOneTimeFloor(Math.round(base * treatMult), ONE_TIME.lawn.floor);
  const urgencyMultiplier = getOneTimeUrgencyMultiplier({ urgency, afterHours });
  const discountBase = preUrgencyPrice * urgencyMultiplier;
  const discounted = applyOneTimeRecurringCustomerDiscount(discountBase, { isRecurringCustomer });
  const price = applyOneTimeFloor(discounted.price, ONE_TIME.lawn.floor);

  return {
    service: 'one_time_lawn',
    price,
    treatmentType: normalizedTreatment,
    urgency,
    afterHours,
    isRecurringCustomer,
    basePrice: base,
    treatmentMultiplier: treatMult,
    preUrgencyPrice,
    urgencyMultiplier,
    subtotalBeforeRecurringCustomerDiscount: Math.round(discountBase),
    recurringCustomerDiscountRate: discounted.rate,
    recurringCustomerDiscountAmount: Math.max(0, Math.round(discountBase) - price),
    discountHandledByPricingFunction: true,
    baselinePerApp: lawnResult.perApp,
    baselinePricingBasis: lawnResult.pricingBasis,
    baselinePricingSource: lawnResult.pricingSource,
    customQuoteFlag: lawnResult.customQuoteFlag,
    notes: lawnResult.notes || [],
  };
}

// ============================================================
// ONE-TIME MOSQUITO
// ============================================================
function getOneTimeMosquitoAreaBucket(mosquitoTreatableSqFt) {
  const sqft = Math.max(0, Math.round(Number(mosquitoTreatableSqFt) || 0));
  if (sqft <= 7500) return 'SMALL';
  if (sqft <= 11000) return 'STANDARD';
  if (sqft <= 16000) return 'LARGE';
  if (sqft <= 24000) return 'XL';
  if (sqft <= 32000) return 'ESTATE';
  if (sqft <= 43560) return 'ACRE_CLASS';
  return 'OVER_ACRE';
}

function getOneTimeMosquitoBase(mosquitoTreatableSqFt) {
  const sqft = Math.max(0, Math.round(Number(mosquitoTreatableSqFt) || 0));
  const areaBucket = getOneTimeMosquitoAreaBucket(sqft);
  const base = ONE_TIME.mosquito[areaBucket] || ONE_TIME.mosquito.SMALL;
  if (areaBucket !== 'OVER_ACRE') {
    return { areaBucket, basePrice: base, requiresManualReview: false };
  }
  const overageSqFt = Math.max(0, sqft - 43560);
  const incrementCount = Math.ceil(overageSqFt / ONE_TIME.mosquito.overAcreIncrementSqFt);
  return {
    areaBucket,
    basePrice: base + incrementCount * ONE_TIME.mosquito.overAcreIncrementPrice,
    requiresManualReview: true,
    overageSqFt,
    incrementCount,
  };
}

function priceOneTimeMosquito(property, options = {}) {
  const fallbackTreatableSqFt = Math.max(
    0,
    (Number(property.lotSqFt) || 0) - (Number(property.footprint) || 0) - (Number(property.hardscape) || 0)
  );
  const mosquitoTreatableSqFt = Math.max(
    0,
    Math.round(Number(property.mosquitoTreatableSqFt ?? fallbackTreatableSqFt) || 0)
  );
  const base = getOneTimeMosquitoBase(mosquitoTreatableSqFt);
  const stationCount = Math.max(0, Math.round(Number(options.stationCount) || 0));
  const dunkCount = Math.max(0, Math.round(Number(options.dunkCount) || 0));
  const stationAddOnTotal = stationCount * ONE_TIME.mosquito.stationAddOn;
  const dunkAddOnTotal = dunkCount * ONE_TIME.mosquito.dunkAddOn;
  const subtotalBeforeRecurringCustomerDiscount = base.basePrice + stationAddOnTotal + dunkAddOnTotal;
  const discounted = applyOneTimeRecurringCustomerDiscount(subtotalBeforeRecurringCustomerDiscount, {
    isRecurringCustomer: !!options.isRecurringCustomer,
  });
  const price = discounted.price;
  const detailParts = [];
  if (stationCount > 0) detailParts.push(`${stationCount} mosquito station${stationCount === 1 ? '' : 's'} (+$${Math.round(stationAddOnTotal)})`);
  if (dunkCount > 0) detailParts.push(`${dunkCount} Bti dunk tablet${dunkCount === 1 ? '' : 's'} (+$${Math.round(dunkAddOnTotal)})`);
  return {
    service: 'one_time_mosquito',
    key: 'oneTimeMosquito',
    name: 'One-Time Mosquito Treatment',
    recurring: false,
    price,
    mosquitoTreatableSqFt,
    areaBucket: base.areaBucket,
    lotCategory: base.areaBucket,
    basePrice: base.basePrice,
    stationCount,
    stationAddOnTotal,
    dunkCount,
    dunkAddOnTotal,
    subtotalBeforeRecurringCustomerDiscount,
    recurringCustomerDiscountRate: discounted.rate,
    recurringCustomerDiscountAmount: discounted.amount,
    requiresManualReview: base.requiresManualReview,
    overageSqFt: base.overageSqFt || 0,
    incrementCount: base.incrementCount || 0,
    detail: detailParts.join(' + '),
    addOns: {
      stationCount,
      dunkCount,
      stationAddOn: stationAddOnTotal,
      dunkAddOn: dunkAddOnTotal,
      stationAddOnTotal,
      dunkAddOnTotal,
    },
    discountHandledByPricingFunction: true,
  };
}

// ============================================================
// SPECIALTY SERVICES
// ============================================================

function priceTrenching(property) {
  const perimeter = property.perimeter;
  const f = property.features || {};
  let concretePct = SPECIALTY.trenching.concretePctBase;
  if (f.poolCage) concretePct = SPECIALTY.trenching.concretePctCage;
  else if (f.pool) concretePct = SPECIALTY.trenching.concretePctPool;
  if (f.largeDriveway) concretePct += SPECIALTY.trenching.concretePctDriveway;
  concretePct = Math.min(concretePct, SPECIALTY.trenching.concretePctCap);

  const dirtLF = Math.round(perimeter * (1 - concretePct));
  const concreteLF = Math.round(perimeter * concretePct);
  const price = Math.max(
    SPECIALTY.trenching.floor,
    dirtLF * SPECIALTY.trenching.dirtPerLF + concreteLF * SPECIALTY.trenching.concretePerLF
  );

  return {
    service: 'trenching', perimeter, concretePct, dirtLF, concreteLF,
    price, renewal: SPECIALTY.trenching.renewal,
  };
}

function priceBoraCare(atticSqFt) {
  const gallons = Math.max(3, Math.ceil(atticSqFt / SPECIALTY.boraCare.coverage));
  const isMultiDay = atticSqFt > 4500;
  const laborHrs = isMultiDay
    ? Math.min(10, Math.max(6, 1.5 + atticSqFt / 800))
    : Math.min(6, Math.max(2, 1.5 + atticSqFt / 1000));
  const cost = gallons * SPECIALTY.boraCare.galCost + laborHrs * GLOBAL.LABOR_RATE + SPECIALTY.boraCare.equipCost;
  const price = Math.round(cost / SPECIALTY.boraCare.marginDivisor);

  return { service: 'bora_care', atticSqFt, gallons, laborHrs: Math.round(laborHrs * 10) / 10, cost: Math.round(cost), price };
}

function pricePreSlabTermidor(slabSqFt, volumeDiscount = 'none') {
  const bottles = Math.max(1, Math.ceil(slabSqFt / SPECIALTY.preSlabTermidor.coverage));
  const laborHrs = Math.min(5, Math.max(1, 0.5 + slabSqFt / 1500));
  const cost = bottles * SPECIALTY.preSlabTermidor.bottleCost + laborHrs * GLOBAL.LABOR_RATE + SPECIALTY.preSlabTermidor.equipCost;
  let price = Math.round(cost / SPECIALTY.preSlabTermidor.marginDivisor);
  const volMult = SPECIALTY.preSlabTermidor.volumeDiscounts[volumeDiscount] || 1.0;
  price = Math.round(price * volMult);

  return { service: 'pre_slab_termidor', slabSqFt, bottles, laborHrs: Math.round(laborHrs * 10) / 10, cost: Math.round(cost), price, volumeDiscount };
}

function priceGermanRoach(property) {
  const footprint = property.footprint;
  const adj = interpolate(footprint, SPECIALTY.germanRoach.footprintAdj);
  const price = Math.max(SPECIALTY.germanRoach.floor, SPECIALTY.germanRoach.base + Math.round(adj));

  return {
    service: 'german_roach',
    price,
    setupCharge: SPECIALTY.germanRoach.setupCharge,
    total: price + SPECIALTY.germanRoach.setupCharge,
    visits: 3,
  };
}

// Legacy explicit German roach initial. The current v2 adapter uses
// pest_initial_roach for recurring German roach auto-fire; this remains for
// older direct engine callers that still pass services.germanRoachInitial.
function priceGermanRoachInitial(options = {}) {
  const {
    urgency = 'NONE',
    afterHours = false,
    isRecurringCustomer = false,
  } = options;
  const BASE = 100;
  const urgencyMult = afterHours
    ? (URGENCY[urgency] || URGENCY.NONE).afterHours || 1
    : (URGENCY[urgency] || URGENCY.NONE).standard;
  const rcDisc = isRecurringCustomer ? (1 - WAVEGUARD.recurringCustomerOneTimePerk) : 1;
  const price = Math.round(BASE * urgencyMult * rcDisc);
  return {
    service: 'german_roach_initial',
    name: 'German Roach Initial (3-Visit)',
    price,
    visits: 3,
  };
}

function normalizeBedBugEnum(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return String(value).trim().toUpperCase();
}

function readBedBugEnum(value) {
  if (value === null || value === undefined || value === '') return undefined;
  return typeof value === 'string' ? value.trim() : value;
}

function readBedBugPropertyNumber(value) {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeBedBugOptions(property = {}, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw buildPricingError('Bed bug options are required', { field: 'options' });
  }

  const method = readBedBugEnum(options.method ?? options.bedbugMethod);
  if (!method) throw buildPricingError('Bed bug method is required', { field: 'method' });
  if (method === 'BOTH') {
    throw buildPricingError('Bed bug method BOTH is invalid; use HYBRID for heat plus targeted residual protection', {
      field: 'method',
      value: method,
    });
  }
  assertEnum(method, BED_BUG.allowedMethods, 'method');

  const roomsValue = options.rooms ?? options.bedbugRooms;
  if (roomsValue === null || roomsValue === undefined || roomsValue === '') {
    throw buildPricingError('Bed bug rooms is required', { field: 'rooms' });
  }
  const rooms = assertPositiveInteger(roomsValue, 'rooms');

  const severity = options.severity ?? options.bedbugSeverity;
  if (!severity) throw buildPricingError('Bed bug severity is required', { field: 'severity' });
  assertEnum(severity, Object.keys(BED_BUG.severity), 'severity');

  const prepStatus = options.prepStatus ?? options.bedbugPrepStatus;
  if (!prepStatus) throw buildPricingError('Bed bug prepStatus is required', { field: 'prepStatus' });
  assertEnum(prepStatus, Object.keys(BED_BUG.prepStatus), 'prepStatus');
  const quoteRequiredReason = BED_BUG.severity[severity].quoteRequired
    ? 'SEVERE_INFESTATION'
    : ((BED_BUG.prepStatus[prepStatus].quoteRequired || BED_BUG.prepStatus[prepStatus].allowed === false)
        ? 'PREP_REFUSED'
        : null);

  const occupancyType = options.occupancyType ?? options.bedbugOccupancyType;
  if (!occupancyType) throw buildPricingError('Bed bug occupancyType is required', { field: 'occupancyType' });
  assertEnum(occupancyType, Object.keys(BED_BUG.occupancyType), 'occupancyType');

  const hasOptionFootprint = options.footprint !== null &&
    options.footprint !== undefined &&
    options.footprint !== '';
  const propertyFootprint = property.footprint;
  const footprintValue = hasOptionFootprint
    ? options.footprint
    : (
        propertyFootprint === 0 || propertyFootprint === '0'
          ? undefined
          : propertyFootprint
      );
  const footprint = footprintValue === null || footprintValue === undefined || footprintValue === ''
    ? undefined
    : assertPositiveNumber(footprintValue, 'footprint');

  const storiesValue = options.stories ?? property.stories;
  const stories = storiesValue === null || storiesValue === undefined || storiesValue === ''
    ? undefined
    : assertPositiveInteger(storiesValue, 'stories');

  const equipmentValue = options.equipment ?? options.bedbugEquipment;
  const equipment = readBedBugEnum(equipmentValue);
  const heatScope = readBedBugEnum(options.heatScope ?? options.bedbugHeatScope);
  const warnings = [];
  let heatAreaSqFt;

  if (method === 'CHEMICAL') {
    if (equipment) warnings.push('Equipment was supplied for CHEMICAL bed bug pricing and was ignored.');
    if (heatScope) {
      assertEnum(heatScope, BED_BUG.heat.heatScope.allowed, 'heatScope');
      warnings.push('heatScope was supplied for CHEMICAL bed bug pricing and was ignored.');
    }
  } else {
    if (!equipment) throw buildPricingError('equipment is required for HEAT and HYBRID bed bug pricing', { field: 'equipment' });
    assertEnum(equipment, BED_BUG.heat.allowedEquipment, 'equipment');
    if (!heatScope) throw buildPricingError('heatScope is required for HEAT and HYBRID bed bug pricing', { field: 'heatScope' });
    assertEnum(heatScope, BED_BUG.heat.heatScope.allowed, 'heatScope');
    if (heatScope === 'WHOLE_HOME') {
      heatAreaSqFt = readBedBugPropertyNumber(
        options.heatAreaSqFt ?? options.heatSqFt ?? options.homeSqFt ?? property.homeSqFt ?? property.squareFootage,
      );
    }
  }

  const subcontractCostValue = options.subcontractCost ?? options.bedbugSubcontractCost;
  let subcontractCost;
  if (quoteRequiredReason) {
    if (method !== 'CHEMICAL' && equipment === 'SUBCONTRACT' && subcontractCostValue !== null && subcontractCostValue !== undefined && subcontractCostValue !== '') {
      subcontractCost = assertPositiveNumber(subcontractCostValue, 'subcontractCost');
    } else if (subcontractCostValue !== null && subcontractCostValue !== undefined && subcontractCostValue !== '') {
      warnings.push('subcontractCost was supplied for non-subcontract bed bug pricing and was ignored.');
    }

    return {
      method,
      rooms,
      footprint,
      heatAreaSqFt,
      stories,
      severity,
      prepStatus,
      occupancyType,
      equipment: method === 'CHEMICAL' ? undefined : equipment,
      heatScope: method === 'CHEMICAL' ? undefined : heatScope,
      subcontractCost,
      quoteRequiredReason,
      urgency: options.urgency ?? options.bedbugUrgency ?? 'standard',
      afterHours: options.afterHours ?? options.isAfterHours ?? false,
      includeInternalCostBasis: options.includeInternalCostBasis === true,
      isInternal: options.internal === true || options.isInternal === true || options.admin === true || options.isAdmin === true || options.debug === true,
      warnings,
    };
  }

  if (method !== 'CHEMICAL' && equipment === 'SUBCONTRACT') {
    subcontractCost = subcontractCostValue === null || subcontractCostValue === undefined || subcontractCostValue === ''
      ? undefined
      : assertPositiveNumber(subcontractCostValue, 'subcontractCost');
    if (subcontractCost === undefined) {
      throw buildPricingError('subcontractCost is required when equipment is SUBCONTRACT', {
        field: 'subcontractCost',
        reason: 'MISSING_VENDOR_COST',
      });
    }
  } else if (subcontractCostValue !== null && subcontractCostValue !== undefined && subcontractCostValue !== '') {
    warnings.push('subcontractCost was supplied for non-subcontract bed bug pricing and was ignored.');
  }

  if ((method === 'HEAT' || method === 'HYBRID') && heatScope === 'WHOLE_HOME' && footprint === undefined && heatAreaSqFt === undefined) {
    throw buildPricingError('footprint is required when heatScope is WHOLE_HOME', {
      field: 'footprint',
      reason: 'WHOLE_HOME_REQUIRES_FOOTPRINT',
    });
  }

  return {
    method,
    rooms,
    footprint,
    heatAreaSqFt,
    stories,
    severity,
    prepStatus,
    occupancyType,
    equipment: method === 'CHEMICAL' ? undefined : equipment,
    heatScope: method === 'CHEMICAL' ? undefined : heatScope,
    subcontractCost,
    urgency: options.urgency ?? options.bedbugUrgency ?? 'standard',
    afterHours: options.afterHours ?? options.isAfterHours ?? false,
    includeInternalCostBasis: options.includeInternalCostBasis === true,
    isInternal: options.internal === true || options.isInternal === true || options.admin === true || options.isAdmin === true || options.debug === true,
    warnings,
  };
}

function getStoryMultiplier(stories) {
  if (!stories) return 1;
  if (stories <= BED_BUG.stories.one.maxStories) return BED_BUG.stories.one.multiplier;
  if (stories <= BED_BUG.stories.two.maxStories) return BED_BUG.stories.two.multiplier;
  return BED_BUG.stories.threePlus.multiplier;
}

function getFootprintModifier(footprint, modifierRules = []) {
  if (footprint === undefined || footprint === null) return 1;
  for (const rule of modifierRules) {
    if (rule.minFootprintExclusive !== undefined && footprint > rule.minFootprintExclusive) return rule.multiplier;
    if (rule.maxFootprintExclusive !== undefined && footprint < rule.maxFootprintExclusive) return rule.multiplier;
  }
  return 1;
}

function getUrgencyMultiplier(options = {}) {
  const afterHours = options.afterHours === true || String(options.afterHours || '').toUpperCase() === 'YES';
  const key = String(options.urgency || 'standard').trim().replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (key === 'soonafterhours') return BED_BUG.urgencyMultipliers.soonAfterHours;
  if (key === 'emergencyafterhours' || key === 'urgentafterhours') return BED_BUG.urgencyMultipliers.emergencyAfterHours;
  if (key === 'soon') return afterHours ? BED_BUG.urgencyMultipliers.soonAfterHours : BED_BUG.urgencyMultipliers.soon;
  if (key === 'emergency' || key === 'urgent') return afterHours ? BED_BUG.urgencyMultipliers.emergencyAfterHours : BED_BUG.urgencyMultipliers.emergency;
  return BED_BUG.urgencyMultipliers.standard;
}

function getBedBugLaborRate() {
  const globalRate = Number(GLOBAL.LABOR_RATE);
  return Number.isFinite(globalRate) && globalRate > 0
    ? globalRate
    : BED_BUG.laborRate;
}

function getBedBugDriveMinutes() {
  const globalDrive = Number(GLOBAL.DRIVE_TIME);
  return Number.isFinite(globalDrive) && globalDrive >= 0
    ? globalDrive
    : BED_BUG.driveMinutes;
}

function roundPrice(value) {
  return Math.round(value);
}

function roundedRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function getBedBugMultipliers(normalized, footprintRules) {
  return {
    footprint: getFootprintModifier(normalized.footprint, footprintRules),
    severity: BED_BUG.severity[normalized.severity].multiplier,
    prep: BED_BUG.prepStatus[normalized.prepStatus].multiplier,
    occupancy: BED_BUG.occupancyType[normalized.occupancyType].multiplier,
    stories: getStoryMultiplier(normalized.stories),
    urgency: getUrgencyMultiplier(normalized),
    recurring: 1,
  };
}

function applyBedBugMultipliers(basePrice, multipliers) {
  return basePrice
    * multipliers.footprint
    * multipliers.severity
    * multipliers.prep
    * multipliers.occupancy
    * multipliers.stories
    * multipliers.urgency;
}

function uniqueWarnings(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

function bedBugPrepWarnings(normalized) {
  return BED_BUG.prepStatus[normalized.prepStatus].warnings || [];
}

function bedBugMethodLabel(method) {
  if (method === 'CHEMICAL') return BED_BUG.chemical.label;
  if (method === 'HEAT') return BED_BUG.heat.label;
  if (method === 'HYBRID') return BED_BUG.hybrid.label;
  return 'Bed Bug Treatment';
}

function buildBedBugChemicalProtocol(includedVisits) {
  const chemical = BED_BUG.chemical;
  return {
    ...(chemical.protocol || {}),
    includedVisits,
    followUpDays: chemical.followUpDays,
  };
}

function buildBedBugHeatProtocol() {
  const heat = BED_BUG.heat;
  return {
    targetAmbientTempF: heat.protocol.targetAmbientTempF,
    requiredMinimumTempF: heat.protocol.requiredMinimumTempF,
    minimumHoldTimeMinutes: heat.protocol.minimumHoldTimeMinutes,
    minSensors: heat.protocol.minSensors,
    activeMonitoringRequired: heat.protocol.activeMonitoringRequired,
    requiresPrepChecklist: heat.protocol.requiresPrepChecklist,
    requiresHeatSensitiveItemPlan: heat.protocol.requiresHeatSensitiveItemPlan,
  };
}

function buildBedBugHybridProtocol(heatProtocol) {
  return {
    ...heatProtocol,
    ...(BED_BUG.hybrid.protocol || {}),
    postInspectionDays: BED_BUG.hybrid.postInspectionDays,
  };
}

function buildBedBugQuoteRequired(normalized, reason, warnings = []) {
  const label = `${bedBugMethodLabel(normalized.method)} — ${normalized.rooms} room(s) — Quote Required`;
  const detail = reason === 'PREP_REFUSED'
    ? 'Prep refused requires inspection/manager quote before treatment.'
    : 'Inspection and custom quote required before treatment.';
  return {
    service: BED_BUG.service,
    label,
    method: normalized.method,
    rooms: normalized.rooms,
    footprint: normalized.footprint,
    heatAreaSqFt: normalized.heatAreaSqFt,
    stories: normalized.stories,
    severity: normalized.severity,
    prepStatus: normalized.prepStatus,
    occupancyType: normalized.occupancyType,
    equipment: normalized.equipment,
    heatScope: normalized.heatScope,
    quoteRequired: true,
    reason,
    detail,
    warnings: uniqueWarnings(warnings, normalized.warnings, bedBugPrepWarnings(normalized)),
    treatmentLines: [],
    recurringDiscountEligible: false,
    recurringDiscountApplied: 0,
    requiresInspection: true,
    requiresPrepChecklist: true,
    requiresCustomerAcknowledgement: true,
    warrantyEligible: false,
  };
}

function bedBugCommonResult(normalized, fields) {
  const warnings = uniqueWarnings(fields.warnings || [], normalized.warnings, bedBugPrepWarnings(normalized));
  const price = fields.price;
  return {
    service: BED_BUG.service,
    label: fields.label,
    method: normalized.method,
    rooms: normalized.rooms,
    footprint: normalized.footprint,
    heatAreaSqFt: normalized.heatAreaSqFt,
    stories: normalized.stories,
    severity: normalized.severity,
    prepStatus: normalized.prepStatus,
    occupancyType: normalized.occupancyType,
    equipment: normalized.equipment,
    heatScope: normalized.heatScope,
    quoteRequired: false,
    treatmentLines: (fields.treatmentLines || []).map(line => ({
      ...line,
      warnings: uniqueWarnings(line.warnings || [], warnings),
    })),
    basePrice: roundCurrency(fields.basePrice),
    totalBeforeDiscounts: price,
    totalAfterDiscounts: price,
    price,
    multipliers: fields.multipliers,
    recurringDiscountEligible: false,
    recurringDiscountApplied: 0,
    requiresInspection: true,
    requiresPrepChecklist: true,
    requiresCustomerAcknowledgement: true,
    warrantyEligible: false,
    warnings,
    discountHandledByPricingFunction: true,
    recurringCustomerDiscountRate: 0,
    recurringCustomerDiscountAmount: 0,
    ...(fields.extra || {}),
  };
}

function resolveChemicalPrice(normalized) {
  const chemical = BED_BUG.chemical;
  const rooms = normalized.rooms;
  const extraRooms = rooms - 1;
  const severityConfig = BED_BUG.severity[normalized.severity];
  const laborRate = getBedBugLaborRate();
  const driveMinutes = getBedBugDriveMinutes();

  const visit1Minutes =
    chemical.visitMinutes.visit1.setupBase
    + chemical.visitMinutes.visit1.applicationBase
    + chemical.visitMinutes.visit1.perExtraRoom * extraRooms
    + driveMinutes;
  const visit2Minutes =
    chemical.visitMinutes.visit2.followUpBase
    + chemical.visitMinutes.visit2.perExtraRoom * extraRooms
    + driveMinutes;
  const visit1Material = chemical.materialPerRoomVisit1 * rooms;
  const visit2Material = chemical.materialPerRoomVisit1 * rooms * chemical.materialPerRoomVisit2Factor;

  let directCost =
    visit1Material
    + visit2Material
    + laborRate * visit1Minutes / 60
    + laborRate * visit2Minutes / 60;

  const includedVisits = Math.max(chemical.includedVisits, severityConfig.visits);
  if (includedVisits > 2) {
    const extraVisitCount = includedVisits - 2;
    const extraVisitMinutes =
      chemical.visitMinutes.extraFollowUp.followUpBase
      + chemical.visitMinutes.extraFollowUp.perExtraRoom * extraRooms
      + driveMinutes;
    const extraVisitMaterial =
      chemical.materialPerRoomVisit1
      * rooms
      * chemical.extraFollowUpMaterialFactor;
    directCost += extraVisitCount * (
      extraVisitMaterial
      + laborRate * extraVisitMinutes / 60
    );
  }

  const costRatioPrice = directCost / chemical.targetCostRatio;
  const minimumPrice = chemical.minimumBase + chemical.minimumAdditionalRoom * extraRooms;
  const baseChemicalPrice = Math.max(costRatioPrice, minimumPrice);
  const multipliers = getBedBugMultipliers(normalized, chemical.sizeModifiers);
  const price = roundPrice(applyBedBugMultipliers(baseChemicalPrice, multipliers));
  const warnings = uniqueWarnings(chemical.warnings);
  const protocol = buildBedBugChemicalProtocol(includedVisits);
  const estimatedGrossMargin = price > 0 ? roundedRatio((price - directCost) / price) : 0;

  return bedBugCommonResult(normalized, {
    label: `${chemical.label} — ${rooms} room(s), ${includedVisits} visit(s)`,
    basePrice: baseChemicalPrice,
    price,
    multipliers,
    warnings,
    treatmentLines: [{
      label: `${chemical.label} — ${rooms} room(s), ${includedVisits} visit(s)`,
      method: normalized.method,
      price,
      includedVisits,
      followUpDays: chemical.followUpDays,
      protocol,
      directCostEstimate: roundCurrency(directCost),
      costRatio: chemical.targetCostRatio,
      actualCostRatio: price > 0 ? roundedRatio(directCost / price) : 0,
      estimatedGrossMargin,
      warnings,
    }],
    extra: {
      includedVisits,
      followUpDays: chemical.followUpDays,
      directCostEstimate: roundCurrency(directCost),
      costRatio: chemical.targetCostRatio,
      actualCostRatio: price > 0 ? roundedRatio(directCost / price) : 0,
      estimatedGrossMargin,
      pricingModel: chemical.pricingModel,
      targetCostRatio: chemical.targetCostRatio,
      protocol,
    },
  });
}

function getHeatRoomRate(rooms) {
  if (rooms === 1) return BED_BUG.heat.roomRates.oneRoom;
  if (rooms === 2) return BED_BUG.heat.roomRates.twoRooms;
  return BED_BUG.heat.roomRates.threePlusRooms;
}

function resolveHeatPrice(property, normalized, options = {}) {
  const { applyCommonModifiers = true } = options;
  const heat = BED_BUG.heat;
  const rooms = normalized.rooms;
  const extraRooms = rooms - 1;
  const roomRate = getHeatRoomRate(rooms);
  let roomBasedPrice = roomRate * rooms;
  let equipmentFee = 0;
  let vendorBasedPrice;

  if (normalized.equipment === 'INHOUSE') {
    equipmentFee = heat.inHouseEquipmentFee.base + heat.inHouseEquipmentFee.perExtraRoom * extraRooms;
    roomBasedPrice += equipmentFee;
    roomBasedPrice = Math.max(roomBasedPrice, heat.minimums.inHouse);
  } else if (normalized.equipment === 'SUBCONTRACT') {
    vendorBasedPrice = normalized.subcontractCost * heat.subcontractMarkup;
    roomBasedPrice = Math.max(roomBasedPrice, vendorBasedPrice, heat.minimums.subcontract);
  }

  let sqftBasedPrice;
  let baseHeatPrice = roomBasedPrice;
  if (normalized.heatScope === 'WHOLE_HOME') {
    const sqftRate = normalized.equipment === 'INHOUSE'
      ? heat.sqftRates.inHouse
      : heat.sqftRates.subcontract;
    const heatAreaSqFt = normalized.heatAreaSqFt ?? normalized.footprint;
    sqftBasedPrice = heatAreaSqFt * sqftRate;
    baseHeatPrice = Math.max(roomBasedPrice, sqftBasedPrice);
  }

  const multipliers = getBedBugMultipliers(normalized, heat.sizeModifiers);
  const price = applyCommonModifiers
    ? roundPrice(applyBedBugMultipliers(baseHeatPrice, multipliers))
    : roundCurrency(baseHeatPrice);
  const warnings = uniqueWarnings(heat.warnings);
  const protocol = buildBedBugHeatProtocol();
  const line = {
    label: `${heat.label} — ${rooms} room(s) — ${normalized.equipment}`,
    method: normalized.method,
    price,
    includedTreatmentEvents: heat.includedTreatmentEvents,
    includePostInspection: heat.includePostInspection,
    postInspectionDays: heat.postInspectionDays,
    heatScope: normalized.heatScope,
    equipment: normalized.equipment,
    protocol,
    warnings,
  };

  const result = {
    label: line.label,
    basePrice: baseHeatPrice,
    price,
    multipliers,
    treatmentLines: [line],
    warnings,
    extra: {
      roomRate,
      roomBasedPrice: roundCurrency(roomBasedPrice),
      equipmentFee,
      vendorBasedPrice: vendorBasedPrice === undefined ? undefined : roundCurrency(vendorBasedPrice),
      sqftBasedPrice: sqftBasedPrice === undefined ? undefined : roundCurrency(sqftBasedPrice),
      includedTreatmentEvents: heat.includedTreatmentEvents,
      includePostInspection: heat.includePostInspection,
      postInspectionDays: heat.postInspectionDays,
      protocol: line.protocol,
    },
  };

  if (!applyCommonModifiers) return result;
  return bedBugCommonResult(normalized, result);
}

function resolveHybridPrice(property, normalized) {
  const heatBase = resolveHeatPrice(property, normalized, { applyCommonModifiers: false });
  const residualAddOnBase =
    BED_BUG.hybrid.residualAddOn.base
    + BED_BUG.hybrid.residualAddOn.perRoom * normalized.rooms;
  const combinedBase = heatBase.basePrice + residualAddOnBase;
  const multipliers = getBedBugMultipliers(normalized, BED_BUG.heat.sizeModifiers);
  const price = roundPrice(applyBedBugMultipliers(combinedBase, multipliers));
  const warnings = uniqueWarnings(BED_BUG.heat.warnings, BED_BUG.hybrid.warnings);
  const note = 'Hybrid is heat plus targeted residual protection, not a duplicate full chemical program.';
  const protocol = buildBedBugHybridProtocol(heatBase.treatmentLines[0].protocol);

  return bedBugCommonResult(normalized, {
    label: `${BED_BUG.hybrid.label} — ${normalized.rooms} room(s)`,
    basePrice: combinedBase,
    price,
    multipliers,
    warnings,
    treatmentLines: [{
      label: `${BED_BUG.hybrid.label} — ${normalized.rooms} room(s)`,
      method: normalized.method,
      price,
      includedTreatmentEvents: BED_BUG.heat.includedTreatmentEvents,
      heatEvent: true,
      residualApplication: true,
      residualAddOnBase,
      includePostInspection: BED_BUG.hybrid.includePostInspection,
      postInspectionDays: BED_BUG.hybrid.postInspectionDays,
      heatScope: normalized.heatScope,
      equipment: normalized.equipment,
      protocol,
      warnings,
      note,
    }],
    extra: {
      heatEvent: true,
      residualApplication: true,
      residualAddOnBase,
      combinedBase: roundCurrency(combinedBase),
      heatBasePrice: roundCurrency(heatBase.basePrice),
      includePostInspection: BED_BUG.hybrid.includePostInspection,
      postInspectionDays: BED_BUG.hybrid.postInspectionDays,
      protocol,
      note,
    },
  });
}

function priceBedBugTreatment(property, options) {
  const normalized = normalizeBedBugOptions(property, options);
  const severityConfig = BED_BUG.severity[normalized.severity];
  const prepConfig = BED_BUG.prepStatus[normalized.prepStatus];

  if (severityConfig.quoteRequired) {
    return buildBedBugQuoteRequired(normalized, 'SEVERE_INFESTATION', [
      'Severe bed bug infestations require inspection and custom quote.',
    ]);
  }
  if (prepConfig.quoteRequired || prepConfig.allowed === false) {
    return buildBedBugQuoteRequired(normalized, 'PREP_REFUSED', [
      'Prep refused requires inspection/manager quote before treatment.',
    ]);
  }

  let result;
  if (normalized.method === 'CHEMICAL') result = resolveChemicalPrice(normalized);
  else if (normalized.method === 'HEAT') result = resolveHeatPrice(property, normalized);
  else result = resolveHybridPrice(property, normalized);

  if (normalized.includeInternalCostBasis && normalized.isInternal) {
    result.internalCostBasis = BED_BUG.internalCostBasis;
  }
  return result;
}

// Deprecated compatibility wrapper for old direct imports. New callers must
// use priceBedBugTreatment(property, options) with strict method/risk inputs.
function priceBedBug(rooms, method = 'CHEMICAL', footprint = 2000) {
  const normalizedMethod = normalizeBedBugEnum(method);
  if (normalizedMethod === 'BOTH') throw buildPricingError('Bed bug method BOTH is invalid; use HYBRID');
  assertEnum(normalizedMethod, BED_BUG.allowedMethods, 'method');
  return priceBedBugTreatment({ footprint, stories: 1 }, {
    rooms,
    method: normalizedMethod,
    severity: 'light',
    prepStatus: 'ready',
    occupancyType: 'singleFamily',
    equipment: normalizedMethod === 'CHEMICAL' ? undefined : 'INHOUSE',
    heatScope: normalizedMethod === 'CHEMICAL' ? undefined : 'ROOMS_ONLY',
  });
}

function priceWDO(footprint) {
  for (const bracket of SPECIALTY.wdo.brackets) {
    if (footprint <= bracket.maxSqFt) return { service: 'wdo_inspection', price: bracket.price };
  }
  return { service: 'wdo_inspection', price: SPECIALTY.wdo.brackets[SPECIALTY.wdo.brackets.length - 1].price };
}

function priceFlea(property) {
  // Simplified — full implementation would use footprint/lot adjustments
  const initial = SPECIALTY.flea.initial.base;
  const followUp = SPECIALTY.flea.followUp.base;
  return { service: 'flea_package', initial, followUp, total: initial + followUp, visits: 2 };
}

function priceTopDressing(lawnSqFt, depth = 'eighth', hasRecurringLawn = false) {
  const lawnEst = hasRecurringLawn ? lawnSqFt : lawnSqFt * 0.65;
  const k = lawnEst / 1000;
  const cfg = SPECIALTY.topDressing[depth];

  let price;
  if (depth === 'eighth') {
    const materialCost = k * 1.04 * cfg.sandRate + k * cfg.deliveryRate;
    const laborMin = lawnEst / 130 + 30;
    const laborCostVal = GLOBAL.LABOR_RATE * laborMin / 60;
    price = Math.round((materialCost + laborCostVal) / cfg.marginDivisor);
  } else {
    const materialCost = k * 2.08 * cfg.sandRate + k * cfg.deliveryRate;
    const laborMin = lawnEst / 130 * 1.5 + 45;
    const laborCostVal = GLOBAL.LABOR_RATE * laborMin / 60;
    price = Math.round((materialCost + laborCostVal) / cfg.marginDivisor);
  }
  price = Math.max(cfg.floor, price);

  return { service: 'top_dressing', depth, lawnSqFt: Math.round(lawnEst), price };
}

function priceDethatching(lawnSqFt) {
  const lawnEst = lawnSqFt;
  const timeMin = lawnEst / 100 + lawnEst / 200 + 30;
  const cost = GLOBAL.LABOR_RATE * (timeMin / 60) + (lawnEst / 1000) * SPECIALTY.dethatching.materialPer1K;
  const price = Math.max(SPECIALTY.dethatching.floor, Math.round(cost / SPECIALTY.dethatching.marginDivisor));

  return { service: 'dethatching', lawnSqFt, price };
}

// ============================================================
// PLUGGING (sod plug install by spacing)
// ============================================================
// Urgency handling matches v2 applyOT (urgency multiplier only — rc discount
// is applied downstream by the discount engine for one-time services).
function pricePlugging(lawnSqFt, spacing = 12, options = {}) {
  const { urgency = 'ROUTINE', afterHours = false } = options;
  const cfg = SPECIALTY.plugging;
  const ppsf = cfg.spacingRates[`${spacing}inch`] || cfg.spacingRates['12inch'];
  const label = spacing === 6 ? '6" Premium' : spacing === 9 ? '9" Standard' : '12" Economy';
  const totalPlugs = Math.ceil(lawnSqFt * ppsf);
  const trays = Math.ceil(totalPlugs / cfg.plugsPerTray);
  const cost = totalPlugs * cfg.costPerPlug + (totalPlugs / cfg.laborPerPlugs) * GLOBAL.LABOR_RATE;
  // v2 parity: raw floor 250 (not r'd), raw margin 1 - 0.45 = 0.55
  let price = Math.max(250, Math.round(cost / 0.55));
  price = applyUrgency(price, urgency, afterHours);
  const perSf = Math.round(price / Math.max(1, lawnSqFt) * 100) / 100;
  return {
    service: 'plugging',
    name: 'Lawn Plugging',
    price,
    detail: `${label} | ${lawnSqFt.toLocaleString()} sf | ${totalPlugs.toLocaleString()} plugs | $${perSf}/sf`,
    lawnSqFt, spacing, totalPlugs, trays, perSf, label,
    sodWarning: spacing === 6,
  };
}

// ============================================================
// FOAM & DRILL (termite perimeter injection)
// ============================================================
function resolveFoamDrillTier(points, tiers = SPECIALTY.foamDrill.tiers) {
  const pointCount = Number(points);
  if (!Number.isInteger(pointCount) || pointCount < 1) {
    throw new Error('Foam drill point count must be a positive whole number.');
  }
  const tier = tiers.find(t => pointCount <= t.maxPoints);
  if (!tier) {
    const max = tiers[tiers.length - 1]?.maxPoints || 0;
    throw new Error(`Foam drill point count ${pointCount} exceeds the configured ${max}-point maximum.`);
  }
  return { pointCount, tier };
}

function priceFoamDrill(points = 5, options = {}) {
  const { urgency = 'ROUTINE', afterHours = false } = options;
  const cfg = SPECIALTY.foamDrill;
  const { pointCount, tier } = resolveFoamDrillTier(points, cfg.tiers);
  const cost = tier.cans * cfg.canCost + tier.laborHrs * GLOBAL.LABOR_RATE + cfg.bitsCost;
  let price = Math.max(cfg.floor, Math.round(cost / cfg.marginDivisor));
  price = applyUrgency(price, urgency, afterHours);
  const label = tier.label + (tier.maxPoints === 5 ? ' (1–5)' : tier.maxPoints === 10 ? ' (6–10)' : tier.maxPoints === 15 ? ' (11–15)' : '');
  return {
    service: 'foam_drill',
    name: 'Drill-and-Foam Termite',
    price,
    detail: `${label} | ${tier.cans} can${tier.cans > 1 ? 's' : ''}`,
    points: pointCount, tier: label, cans: tier.cans,
  };
}

// ============================================================
// STINGING INSECT (wasps, hornets, bees)
// ============================================================
function priceStingingInsect(options = {}) {
  const {
    species = 'PAPER_WASP', tier = 2, removal = 'NONE',
    aggressive = 'NO', height = 'GROUND', confined = 'NO',
    urgency = 'ROUTINE', afterHours = false,
    hasRecurringPest = false,
  } = options;
  const cfg = SPECIALTY.wasp;
  const speciesNames = {
    PAPER_WASP: 'Paper Wasps', YJ_AERIAL: 'Yellow Jackets (aerial)',
    YJ_GROUND: 'Yellow Jackets (ground)', MUD_DAUBER: 'Mud Daubers',
    HONEYBEE_NEW: 'Honeybees (new)', HONEYBEE_EST: 'Honeybees (established)',
    CARPENTER: 'Carpenter Bees', BALDFACED: 'Baldfaced Hornets',
    AFRICANIZED: 'Africanized Bees',
  };

  let price = cfg.tiers[Math.max(0, Math.min(cfg.tiers.length - 1, tier - 1))];
  const mods = [];
  // v2 parity: raw addon values (not r'd). Base tiers stay r'd-matched.
  if (aggressive === 'MILD') { price += 75; mods.push('+$75 aggressive'); }
  else if (aggressive === 'HIGH') { price += 150; mods.push('+$150 aggressive'); }
  else if (aggressive === 'EXTREME') { price += 200; mods.push('+$200 aggressive'); }

  if (height === 'MID') { price += 75; mods.push('+$75 height'); }
  else if (height === 'HIGH') { price += 150; mods.push('+$150 height'); }

  if (confined === 'YES') {
    const add = tier >= 3 ? 200 : 100;
    price += add; mods.push(`+$${add} confined`);
  }

  if (urgency === 'SOON') { price += 75; mods.push('+$75 same-day'); }
  else if (urgency === 'URGENT') { price = Math.round(price * 1.5); mods.push('+50% emergency'); }
  if (afterHours) { price += 75; mods.push('+$75 after-hours'); }

  let removalPrice = 0, removalLabel = '';
  // v2 parity: raw removal values
  if (removal === 'SMALL') { removalPrice = 75; removalLabel = 'Small nest'; }
  else if (removal === 'LARGE') { removalPrice = 250; removalLabel = 'Large comb'; }
  else if (removal === 'HONEYCOMB') { removalPrice = 375; removalLabel = 'Honeycomb extraction'; }
  else if (removal === 'RELOCATE') { removalPrice = 450; removalLabel = 'Live bee relocation'; }

  const total = price + removalPrice;
  const includedOnProgram = cfg.freeWithRecurringPest && hasRecurringPest
    && (species === 'PAPER_WASP' || species === 'MUD_DAUBER') && tier <= 1;

  return {
    service: 'stinging_insect',
    name: `Stinging Insect — ${speciesNames[species] || species}`,
    price: includedOnProgram ? 0 : total,
    detail: `Tier ${tier} — ${speciesNames[species] || species}${mods.length ? ' | ' + mods.join(', ') : ''}`,
    species, tier, mods,
    removal: removalPrice > 0 ? { name: removalLabel, price: removalPrice } : null,
    includedOnProgram,
  };
}

// ============================================================
// EXCLUSION (rodent entry-point sealing)
// ============================================================
// V1+V2 unified pricer: per-entry-point structure (V1) with home-size
// minimums and story/roof/construction multipliers (V2).
//
// Multipliers apply to the (moderate + advanced) subtotal only — simple
// interior gaps don't scale by structure access.
//
// Inputs:
//   simple/moderate/advanced: entry-point counts
//   specialty:                 specialty repair count (custom $275+ each)
//   homeSqFt:                  for minimum-floor lookup
//   stories:                   1 / 2 / 3+ (numeric)
//   roofType:                  shingle / flat / metal / tile / steep_or_fragile
//   constructionType:          block / stucco / frame / mixed
//   waiveInspection:           caller-controlled
//   hasServiceOptIn:           legacy auto-waive (any rodent service)
//   approvedTotalForWaiver:    waive if total approved work exceeds $995
//   urgency / afterHours:      passed to applyUrgency
function priceExclusion(options = {}) {
  const {
    simple = 0,
    moderate = 0,
    advanced = 0,
    specialty = 0,
    specialtyCustomTotal = 0,   // caller-supplied custom amount when specialty > 0
    homeSqFt = 2000,
    stories = 1,
    roofType = 'shingle',
    constructionType = 'block',
    waiveInspection = false,
    hasServiceOptIn = false,
    approvedTotalForWaiver = 0,
    urgency = 'ROUTINE', afterHours = false,
  } = options;

  const cfg = SPECIALTY.exclusion;
  const ins = RODENT.inspection || { fee: cfg.inspectionFee, waiveIfApprovedTotalOver: 995 };

  const simpleSubtotal = simple * cfg.perPoint.simple;
  const accessSubtotal = (moderate * cfg.perPoint.moderate) + (advanced * cfg.perPoint.advanced);

  const storiesNum = Number(stories) || 1;
  const storyKey = storiesNum >= 3 ? 'three' : (storiesNum === 2 ? 'two' : 'one');
  const storyMult = cfg.storyMultipliers?.[storyKey] ?? 1.0;
  const roofMult = cfg.roofMultipliers?.[roofType] ?? 1.0;
  const constructionMult = cfg.constructionMultipliers?.[constructionType] ?? 1.0;

  const accessAdjusted = accessSubtotal * storyMult * roofMult * constructionMult;

  // Specialty: caller may provide a custom total; otherwise charge the floor per unit
  const specialtyTotal = specialty > 0
    ? Math.max(specialtyCustomTotal, specialty * cfg.perPoint.specialtyMinimum)
    : 0;

  const rawSubtotal = simpleSubtotal + accessAdjusted + specialtyTotal;

  // Home-size minimum lookup
  const minBracket = _bracketLookup(homeSqFt, cfg.minimumsByHomeSqFt, 'maxSqFt');
  const minimumFloor = minBracket.minimum;

  const epSubtotal = Math.max(minimumFloor, Math.round(rawSubtotal / 10) * 10);
  const subtotalWithUrgency = applyUrgency(epSubtotal, urgency, afterHours);

  // Inspection waiver: explicit waive, OR any-rodent-service opt-in (legacy),
  // OR approved-total over the waiver threshold.
  const inspectionWaived =
    waiveInspection ||
    hasServiceOptIn ||
    (approvedTotalForWaiver >= ins.waiveIfApprovedTotalOver);
  const insp = inspectionWaived ? 0 : ins.fee;

  const total = subtotalWithUrgency + insp;

  let tier = 'Basic';
  if (advanced > 0) tier = 'Advanced (Roof)';
  else if (moderate > 0) tier = 'Moderate';
  if (specialty > 0) tier += ' + Specialty';

  const inspectDetail = insp > 0
    ? ` + $${insp} inspect`
    : (inspectionWaived ? ' (inspect waived)' : '');

  return {
    service: 'exclusion',
    name: 'Rodent Exclusion',
    price: total,
    detail: `${tier} — ${simple + moderate + advanced + specialty} points${inspectDetail}`,
    points: { simple, moderate, advanced, specialty },
    subtotalBeforeMin: Math.round(rawSubtotal),
    minimumFloor,
    inspectionFee: insp,
    inspectionWaived,
    tier,
    storyMult,
    roofMult,
    constructionMult,
    customRecommended: !!minBracket.customRecommended,
  };
}

// ============================================================
// RODENT INSPECTION (standalone diagnostic visit)
// ============================================================
// Creditable toward exclusion or full remediation when approved within 14
// days. Used when a customer wants a paid inspection without committing to
// remediation work upfront.
function priceRodentInspection() {
  const ins = RODENT.inspection;
  return {
    service: 'rodent_inspection',
    name: 'Rodent Inspection',
    price: ins.fee,
    creditableWithinDays: ins.creditableWithinDays,
    detail: `$${ins.fee} inspection (creditable for ${ins.creditableWithinDays} days toward remediation work)`,
  };
}

// ============================================================
// RODENT GUARANTEE (gated, 3 tiers by complexity)
// ============================================================
// Eligibility: trap + exclusion + (sanitation OR photo baseline) + no
// activity after final trap check. Caller passes the eligibility flags
// and home-complexity facts; we determine tier and price.
function priceRodentGuarantee(options = {}) {
  const {
    homeSqFt = 2000,
    stories = 1,
    roofType = 'shingle',
    sealedPoints = 0,
    eligibility = {},
  } = options;

  const cfg = RODENT.guarantee;

  // Eligibility check — caller signals each flag; missing = not eligible
  const required = cfg.eligibilityRequires;
  const missing = required.filter(flag => !eligibility[flag]);
  const eligible = missing.length === 0;

  // Tier selection by complexity:
  //   estate  — >4,000 sf or >15 sealed points
  //   complex — 2,501–4,000 sf, two-story, tile roof, or 9–15 sealed points
  //   standard — everything else
  const storiesNum = Number(stories) || 1;
  const homeSqFtNum = Number(homeSqFt) || 0;
  const sealedPointsNum = Number(sealedPoints) || 0;
  let tier = 'standard';
  if (homeSqFtNum > 4000 || sealedPointsNum > 15) {
    tier = 'estate';
  } else if (
    homeSqFtNum > 2500 ||
    storiesNum >= 2 ||
    roofType === 'tile' ||
    sealedPointsNum >= 9
  ) {
    tier = 'complex';
  }

  const price = cfg[tier];

  return {
    service: 'rodent_guarantee',
    name: `Rodent Guarantee (${tier})`,
    price,
    tier,
    eligible,
    eligibilityMissing: missing,
    detail: eligible
      ? `$${price}/yr — 12-month re-entry warranty (${tier} tier)`
      : `INELIGIBLE — missing: ${missing.join(', ')}`,
  };
}

// ============================================================
// SPEC FUNCTIONS — Missing services pricing spec (April 2026)
// Distinct from legacy pest/lawn pricers above. Spec doc:
// ~/Downloads/missing-services-pricing-spec.md
// ============================================================

function _applyMargin(cost, targetMargin) {
  return cost / (1 - targetMargin);
}
function _round5(price) {
  return Math.round(price / 5) * 5;
}

// 1. Rodent Plugging (entry-point sealing)
function calculatePluggingPrice(config = {}) {
  const {
    entryPoints = 0,
    materialType = 'caulkSealant',
    isStandalone = true,
    accessDifficulty = 'standard',
  } = config;
  const MATERIAL_COSTS = { copperMesh: 0.85, steelWool: 0.40, xcluder: 1.50, caulkSealant: 0.30 };
  const MINUTES_PER_POINT = { standard: 3, difficult: 5 };
  const TRIP_CHARGE = isStandalone ? 45.00 : 0;
  const materialCost = entryPoints * (MATERIAL_COSTS[materialType] ?? 1.00);
  const laborMinutes = entryPoints * (MINUTES_PER_POINT[accessDifficulty] ?? 3);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const MINIMUM_PRICE = isStandalone ? 95 : 45;
  const totalCost = materialCost + laborCost + TRIP_CHARGE;
  const price = Math.max(MINIMUM_PRICE, _applyMargin(totalCost, 0.65));
  return {
    service: 'rodent_plugging',
    name: 'Rodent Entry-Point Plugging',
    price: _round5(price),
    detail: `${entryPoints} pt${entryPoints === 1 ? '' : 's'} | ${materialType}${isStandalone ? ' | standalone' : ' | add-on'}`,
    materialCost: Math.round(materialCost * 100) / 100,
    laborCost: Math.round(laborCost * 100) / 100,
    tripCharge: TRIP_CHARGE,
    upsellExclusion: entryPoints >= 16,
  };
}

// 2. Termite Foam (Termidor Foam spot treatment)
function calculateFoamPrice(config = {}) {
  const {
    applicationPoints = 0,
    cansEstimated,
    isAddOnToLiquid = false,
    accessType = 'accessible',
  } = config;
  const FOAM_COST_PER_CAN = 30.00;
  const cans = cansEstimated || Math.max(1, Math.ceil(applicationPoints / 10));
  const materialCost = cans * FOAM_COST_PER_CAN;
  const MINUTES_PER_POINT = { accessible: 2, drillRequired: 4 };
  const laborMinutes = applicationPoints * (MINUTES_PER_POINT[accessType] ?? 2);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const setupLabor = (10 / 60) * GLOBAL.LABOR_RATE;
  const BUNDLE_DISCOUNT = isAddOnToLiquid ? 0.15 : 0;
  const totalCost = materialCost + laborCost + setupLabor;
  const preDiscountPrice = _applyMargin(totalCost, 0.62);
  const price = preDiscountPrice * (1 - BUNDLE_DISCOUNT);
  const MINIMUM_PRICE = 125;
  return {
    service: 'termite_foam',
    name: 'Termidor Foam Spot Treatment',
    price: Math.max(MINIMUM_PRICE, _round5(price)),
    detail: `${applicationPoints} pt${applicationPoints === 1 ? '' : 's'} | ${cans} can${cans === 1 ? '' : 's'}${isAddOnToLiquid ? ' | bundled (-15%)' : ''}`,
    materialCost: Math.round(materialCost * 100) / 100,
    laborCost: Math.round((laborCost + setupLabor) * 100) / 100,
    cansUsed: cans,
    bundleDiscount: BUNDLE_DISCOUNT > 0,
  };
}

// 3. Stinging Insect (multiplier-stack spec version)
function calculateStingingPrice(config = {}) {
  const {
    nestCount = 1,
    nestType = 'wasp',
    location = 'eave',
    isUrgent = false,
    isAfterHours = false,
  } = config;
  const NEST_TYPE_MULTIPLIER = { mudDauber: 1.0, wasp: 1.2, hornet: 1.5, yellowJacket: 1.8 };
  const LOCATION_MULTIPLIER = { ground: 1.0, eave: 1.1, tree: 1.2, wall: 1.4, attic: 1.5, high: 1.6 };
  const BASE_MATERIAL_PER_NEST = 12.00;
  const laborMinutes = 15 + (Math.max(0, nestCount - 1) * 8);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const materialCost = nestCount * BASE_MATERIAL_PER_NEST;
  const typeMult = NEST_TYPE_MULTIPLIER[nestType] ?? 1.2;
  const locationMult = LOCATION_MULTIPLIER[location] ?? 1.0;
  const URGENT_SURCHARGE = isUrgent ? 1.25 : 1.0;
  const AFTER_HOURS_SURCHARGE = isAfterHours ? 1.50 : 1.0;
  const baseCost = materialCost + laborCost;
  const adjustedCost = baseCost * typeMult * locationMult;
  const preMarginPrice = _applyMargin(adjustedCost, 0.68);
  const price = preMarginPrice * URGENT_SURCHARGE * AFTER_HOURS_SURCHARGE;
  const MIN = isAfterHours ? 175 : isUrgent ? 125 : 95;
  return {
    service: 'stinging_insect_v2',
    name: `Stinging Insect — ${nestType}`,
    price: Math.max(MIN, _round5(price)),
    detail: `${nestCount} nest${nestCount === 1 ? '' : 's'} | ${nestType} | ${location}${isUrgent ? ' | urgent' : ''}${isAfterHours ? ' | after-hours' : ''}`,
    materialCost: Math.round(materialCost * 100) / 100,
    laborCost: Math.round(laborCost * 100) / 100,
    nestCount, nestType,
    surcharges: { urgent: isUrgent, afterHours: isAfterHours },
    riskLevel: typeMult >= 1.5 ? 'high' : 'moderate',
  };
}

// 4. Exclusion V2 (sqft-tiered, roof/construction-aware)
function calculateExclusionPrice(config = {}) {
  const {
    sqft = 0,
    stories = 1,
    roofType = 'shingle',
    entryPointsFound,
    includesScreening = false,
    constructionType = 'stucco',
  } = config;
  const estimatedPoints = entryPointsFound || (Math.ceil(sqft / 200) + (stories > 1 ? 8 : 0));
  const BLENDED_MATERIAL_PER_POINT = 3.50;
  const materialCost = estimatedPoints * BLENDED_MATERIAL_PER_POINT;
  const screeningCost = includesScreening ? (sqft * 0.015) + 45 : 0;
  const ROOF_MULTIPLIER = { shingle: 1.0, flat: 1.0, metal: 1.2, tile: 1.4 };
  const baseMinutesPerPoint = 5;
  const roofMult = ROOF_MULTIPLIER[roofType] ?? 1.0;
  const storyMult = stories > 1 ? 1.3 : 1.0;
  const laborMinutes = (estimatedPoints * baseMinutesPerPoint * roofMult * storyMult)
    + 30 + (includesScreening ? 45 : 0);
  const laborCost = (laborMinutes / 60) * GLOBAL.LABOR_RATE;
  const CONSTRUCTION_MULT = { block: 1.0, stucco: 1.1, frame: 1.2 };
  const constructionMult = CONSTRUCTION_MULT[constructionType] ?? 1.1;
  const totalCost = (materialCost + screeningCost + laborCost) * constructionMult;
  const price = _applyMargin(totalCost, 0.60);
  const MIN_BY_TIER = { small: 395, medium: 595, large: 895, xlarge: 1295 };
  const tier = sqft < 1500 ? 'small' : sqft < 2500 ? 'medium' : sqft < 4000 ? 'large' : 'xlarge';
  return {
    service: 'exclusion_v2',
    name: 'Full Rodent Exclusion',
    price: Math.max(MIN_BY_TIER[tier], _round5(price)),
    detail: `${tier} (${sqft} sf) | ${estimatedPoints} pts | ${roofType} roof, ${stories}-story${includesScreening ? ' | +screening' : ''}`,
    materialCost: Math.round((materialCost + screeningCost) * 100) / 100,
    laborCost: Math.round(laborCost * 100) / 100,
    estimatedPoints, tier,
    estimatedHours: Math.round(laborMinutes / 60 * 10) / 10,
    multiVisit: laborMinutes > 240,
  };
}

// 5. Rodent Guarantee Combo (Exclusion + Bait Stations + guarantee premium)
function calculateRodentGuaranteeCombo(config = {}) {
  const {
    sqft = 0, stories = 1, roofType = 'shingle', entryPointsFound,
    includesScreening = false, constructionType = 'stucco',
    baitStationTier = 'enhanced',
    stationCount,
    guaranteeTerm = 12,
  } = config;

  const exclusion = calculateExclusionPrice({
    sqft, stories, roofType, entryPointsFound, includesScreening, constructionType,
  });

  // Reuse legacy bait-station pricer (monthly) → quarterly.
  // Auto-flag postExclusion: combo context = sealed structure, lighter scope.
  const stations = stationCount || (Math.ceil(sqft / 500) + 2);
  const bait = priceRodentBait(
    { footprint: sqft, lawnSqFt: 0, lotSqFt: sqft, features: {}, roofType },
    { postExclusion: true }
  );
  const baitQuarterly = (bait.monthly || 0) * 3;

  const GUARANTEE_PREMIUM = { 12: 0.15, 24: 0.25 };
  const term = GUARANTEE_PREMIUM[guaranteeTerm] ? guaranteeTerm : 12;
  const guaranteePremiumRate = GUARANTEE_PREMIUM[term];
  const BUNDLE_DISCOUNT = 0.10;

  const baitTotal = baitQuarterly * (term === 24 ? 8 : 4);
  const componentTotal = exclusion.price + baitTotal;
  const discountedComponents = componentTotal * (1 - BUNDLE_DISCOUNT);
  const guaranteeSurcharge = discountedComponents * guaranteePremiumRate;
  const totalPackagePrice = discountedComponents + guaranteeSurcharge;

  const MINIMUM_COMBO = { 12: 695, 24: 995 };
  const finalPrice = Math.max(MINIMUM_COMBO[term], _round5(totalPackagePrice));
  const upfrontRevenue = exclusion.price * (1 - BUNDLE_DISCOUNT) + guaranteeSurcharge;

  return {
    service: 'rodent_guarantee_combo',
    name: `Rodent Guarantee Combo (${term} mo)`,
    price: finalPrice,
    detail: `Exclusion + ${stations} bait stations + ${term}-mo guarantee`,
    breakdown: {
      exclusionPrice: exclusion.price,
      baitStationQuarterly: baitQuarterly,
      baitStationTotal: baitTotal,
      bundleDiscount: BUNDLE_DISCOUNT,
      guaranteePremium: guaranteePremiumRate,
      guaranteeSurcharge: _round5(guaranteeSurcharge),
    },
    guaranteeTerm: term,
    stationCount: stations,
    exclusionDetails: {
      estimatedPoints: exclusion.estimatedPoints,
      estimatedHours: exclusion.estimatedHours,
      multiVisit: exclusion.multiVisit,
    },
    upfrontRevenue: _round5(upfrontRevenue),
    recurringRevenue: baitQuarterly,
  };
}

// ============================================================
// RODENT BUNDLE DISCOUNTS (combo selector)
// ============================================================
// Given the priced components present in the estimate, returns the
// discount factor and floor that should apply, plus the bundle name.
// Returns null when no bundle qualifies.
function selectRodentBundle({ hasTrapping, hasExclusion, hasSanitation, sanitationTier }) {
  const cfg = RODENT.bundles;
  if (hasTrapping && hasExclusion && hasSanitation) {
    const tier = RODENT.sanitation.legacyAliases?.[sanitationTier] || sanitationTier || 'standard';
    const floor = cfg.fullRemediation.floors[tier] || cfg.fullRemediation.floors.standard;
    return { kind: 'fullRemediation', discount: cfg.fullRemediation.discount, floor };
  }
  if (hasTrapping && hasExclusion) {
    return { kind: 'trapExclusion', discount: cfg.trapExclusion.discount, floor: cfg.trapExclusion.floor };
  }
  if (hasTrapping && hasSanitation) {
    return { kind: 'trapSanitation', discount: cfg.trapSanitation.discount, floor: cfg.trapSanitation.floor };
  }
  return null;
}

function applyRodentBundle(componentTotal, bundle) {
  if (!bundle) return { discounted: componentTotal, savings: 0 };
  const discounted = componentTotal * (1 - bundle.discount);
  const floored = Math.max(bundle.floor, Math.round(discounted / 10) * 10);
  return {
    discounted: floored,
    savings: Math.round(componentTotal - floored),
  };
}

module.exports = {
  pricePestControl, pricePestInitialRoach, priceLawnCare, priceTreeShrub, pricePalmInjection,
  priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
  priceRodentTrappingFollowups, priceSanitation, priceBaitSetup,
  priceRodentInspection,
  selectRodentBundle, applyRodentBundle,
  priceOneTimePest, priceOneTimeLawn, priceOneTimeMosquito,
  priceTrenching, priceBoraCare, pricePreSlabTermidor,
  priceGermanRoach, priceGermanRoachInitial, priceBedBug, priceBedBugTreatment, priceWDO, priceFlea,
  priceTopDressing, priceDethatching,
  pricePlugging, priceFoamDrill, priceStingingInsect, priceExclusion, priceRodentGuarantee,
  // Spec functions (Apr 2026)
  calculatePluggingPrice, calculateFoamPrice, calculateStingingPrice,
  calculateExclusionPrice, calculateRodentGuaranteeCombo,
  interpolate, laborCost,
  getOneTimeUrgencyMultiplier, applyOneTimeRecurringCustomerDiscount,
  applyOneTimeFloor, getOneTimeMosquitoAreaBucket, getOneTimeMosquitoBase,
  normalizeGrassType, calcLawnAnnualCostFloor,
  recommendTreeShrubTier,
};
