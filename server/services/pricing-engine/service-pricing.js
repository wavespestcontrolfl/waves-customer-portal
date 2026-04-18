// ============================================================
// service-pricing.js — All service line pricing calculations
// ============================================================
const {
  GLOBAL, PROPERTY_TYPE_ADJ, PEST, LAWN_TIERS, LAWN_BRACKETS,
  TREE_SHRUB, PALM, MOSQUITO, TERMITE, RODENT, ONE_TIME, SPECIALTY, URGENCY,
} = require('./constants');

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

// ── Urgency multiplier helper (matches v2 applyOT — urgency only, ────
// not recurring-customer discount which is handled by discount-engine) ─
function applyUrgency(price, urgency = 'ROUTINE', afterHours = false) {
  let mult = 1.0;
  if (urgency === 'SOON') mult = afterHours ? 1.50 : 1.25;
  else if (urgency === 'URGENT') mult = afterHours ? 2.0 : 1.50;
  return Math.round(price * mult);
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
  if (f.poolCage) additionalAdj += PEST.additionalAdjustments.poolCage;
  else if (f.pool) additionalAdj += PEST.additionalAdjustments.poolNoCage;
  if (f.trees === 'heavy') additionalAdj += PEST.additionalAdjustments.trees_heavy;
  else if (f.trees === 'moderate') additionalAdj += PEST.additionalAdjustments.trees_moderate;
  if (f.complexity === 'complex') additionalAdj += PEST.additionalAdjustments.complexity_complex;
  if (f.nearWater) additionalAdj += PEST.additionalAdjustments.nearWater;
  if (f.largeDriveway) additionalAdj += PEST.additionalAdjustments.largeDriveway;

  const propAdj = PROPERTY_TYPE_ADJ[property.propertyType] || 0;
  const ageAdj = modifiers.pestAgeAdj || 0;
  if (property.attachedGarage) additionalAdj += 5;
  let basePrice = Math.max(PEST.floor, PEST.base + Math.round(footprintAdj) + additionalAdj + propAdj + ageAdj);

  const roachMod = PEST.roachModifier[roachType] || 0;
  const roachAddOn = Math.round(basePrice * roachMod);

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
    roachAddOn, freqMult, frequency, visitsPerYear, pricingVersion,
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
  };
}

// ============================================================
// LAWN CARE
// ============================================================
function lookupLawnBracket(lawnSqFt, tierIndex, track = 'st_augustine') {
  const brackets = LAWN_BRACKETS[track];
  if (!brackets || !brackets.length) return 0;

  if (lawnSqFt <= brackets[0][0]) return brackets[0][tierIndex + 1];
  if (lawnSqFt >= brackets[brackets.length - 1][0]) return brackets[brackets.length - 1][tierIndex + 1];

  for (let i = 0; i < brackets.length - 1; i++) {
    if (lawnSqFt >= brackets[i][0] && lawnSqFt <= brackets[i + 1][0]) {
      const lo = brackets[i], hi = brackets[i + 1];
      const ratio = (lawnSqFt - lo[0]) / (hi[0] - lo[0]);
      return Math.round(lo[tierIndex + 1] + ratio * (hi[tierIndex + 1] - lo[tierIndex + 1]));
    }
  }
  return brackets[brackets.length - 1][tierIndex + 1];
}

function priceLawnCare(property, options = {}) {
  const {
    track = 'st_augustine',
    tier = 'enhanced',
    shadeClassification = 'FULL_SUN',
  } = options;

  const tierConfig = LAWN_TIERS[tier];
  if (!tierConfig) throw new Error(`Unknown lawn tier: ${tier}`);

  const lawnSqFt = property.lawnSqFt || 4500;
  const monthly = lookupLawnBracket(lawnSqFt, tierConfig.index, track);
  const annual = monthly * 12;
  const perApp = Math.round(annual / tierConfig.freq * 100) / 100;

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

  const trackMaterials = materialByTier[track] || materialByTier.st_augustine;
  const shadeMaterials = trackMaterials[shadeClassification] || trackMaterials.FULL_SUN;
  const annualMaterial = shadeMaterials[tier] || 100;

  // Labor: v4 protocol uses $26.96/visit across all tracks
  const laborPerVisit = 26.96;
  const annualLabor = laborPerVisit * tierConfig.freq;

  // Scale material by lawn size relative to reference (4500 sqft)
  const sizeRatio = Math.max(0.6, Math.min(2.5, lawnSqFt / 4500));
  const scaledMaterial = Math.round(annualMaterial * sizeRatio);

  const annualCost = scaledMaterial + annualLabor + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  // ── Tier array: basic / standard / enhanced / premium pre-priced ──
  const TIER_LIST = ['basic', 'standard', 'enhanced', 'premium'];
  const tiers = TIER_LIST.map((t) => {
    const tc = LAWN_TIERS[t];
    if (!tc) return null;
    const mo = lookupLawnBracket(lawnSqFt, tc.index, track);
    const ann = mo * 12;
    return {
      tier: t,
      index: tc.index,
      visits: tc.freq,
      freq: tc.freq,
      perApp: Math.round(ann / tc.freq * 100) / 100,
      annual: ann,
      monthly: mo,
      label: `${t.charAt(0).toUpperCase()}${t.slice(1)} (${tc.freq}/yr)`,
      recommended: t === tier,
    };
  }).filter(Boolean);

  return {
    service: 'lawn_care',
    track, tier, shadeClassification,
    lawnSqFt, frequency: tierConfig.freq,
    monthly, annual, perApp,
    tiers,
    costs: { annualMaterial: scaledMaterial, annualLabor: Math.round(annualLabor), annualAdmin: GLOBAL.ADMIN_ANNUAL, total: Math.round(annualCost) },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
  };
}

// ============================================================
// TREE & SHRUB
// ============================================================
function priceTreeShrub(property, options = {}) {
  const {
    tier = 'enhanced',
    access = 'easy',
    treeCount = 0,
  } = options;

  const tierConfig = TREE_SHRUB.tiers[tier];
  if (!tierConfig) throw new Error(`Unknown T&S tier: ${tier}`);

  const bedArea = property.bedArea || 2000;
  const accessMin = TREE_SHRUB.accessMinutes[access] || 0;
  const onSiteMin = Math.max(25, 20 + Math.round(bedArea / 500) + Math.round(treeCount * 1.5) + accessMin);

  const materialRate = TREE_SHRUB.materialRates[tier] || TREE_SHRUB.materialRates.enhanced;
  const materialCost = Math.max(tierConfig.freq * 10, bedArea * materialRate);

  const laborPerVisit = GLOBAL.LABOR_RATE * ((onSiteMin + 10) / 60);
  const laborCostAnnual = laborPerVisit * tierConfig.freq;

  const annualCost = materialCost + laborCostAnnual;
  const annualPrice = annualCost / TREE_SHRUB.marginTarget;
  const monthlyCalc = annualPrice / 12;
  const monthly = Math.max(tierConfig.floor, Math.round(monthlyCalc * 100) / 100);
  const annual = monthly * 12;
  const perApp = Math.round(annual / tierConfig.freq * 100) / 100;
  const margin = annual > 0 ? (annual - annualCost - GLOBAL.ADMIN_ANNUAL) / annual : 0;

  return {
    service: 'tree_shrub',
    tier, bedArea, treeCount, access,
    onSiteMin, materialRate,
    frequency: tierConfig.freq,
    monthly, annual, perApp,
    costs: { materialCost: Math.round(materialCost), laborCost: Math.round(laborCostAnnual), adminCost: GLOBAL.ADMIN_ANNUAL, total: Math.round(annualCost + GLOBAL.ADMIN_ANNUAL) },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
  };
}

// ============================================================
// PALM INJECTION
// ============================================================
function pricePalmInjection(property, options = {}) {
  const {
    palmCount = 1,
    treatmentType = 'combo',
    customPricePerPalm = null, // For quote-based treatments (LB, Tree-Age)
  } = options;

  const treatment = PALM.treatmentTypes[treatmentType];
  if (!treatment) throw new Error(`Unknown palm treatment: ${treatmentType}`);

  let pricePerPalm;
  if (treatment.quoteBased) {
    pricePerPalm = customPricePerPalm || treatment.floorPerPalm;
    if (pricePerPalm < treatment.floorPerPalm) pricePerPalm = treatment.floorPerPalm;
  } else {
    pricePerPalm = treatment.pricePerPalm;
  }

  const appsPerYear = treatment.appsPerYear;
  const annualCostPerPalm = pricePerPalm * appsPerYear;
  const annual = annualCostPerPalm * palmCount;
  const monthly = Math.round(annual / 12 * 100) / 100;

  // Per-visit minimum check
  const perVisitTotal = pricePerPalm * palmCount;
  const perVisitEffective = Math.max(perVisitTotal, PALM.minPerVisit);

  return {
    service: 'palm_injection',
    treatmentType, palmCount, pricePerPalm, appsPerYear,
    perVisit: perVisitEffective,
    annual, monthly,
    tierQualifier: PALM.tierQualifier,
    excludeFromPctDiscount: true,
    flatCredit: PALM.flatCreditPerPalm,
    flatCreditMinTier: PALM.flatCreditMinTier,
    quoteBased: treatment.quoteBased || false,
  };
}

// ============================================================
// MOSQUITO
// ============================================================
function priceMosquito(property, options = {}) {
  const {
    tier = 'silver', // bronze, silver, gold, platinum
    modifiers = {},
  } = options;

  const lotCategory = property.lotCategory;
  const tierIndex = { bronze: 0, silver: 1, gold: 2, platinum: 3 }[tier];
  if (tierIndex === undefined) throw new Error(`Unknown mosquito tier: ${tier}`);

  const basePrices = MOSQUITO.basePrices[lotCategory];
  if (!basePrices) throw new Error(`Unknown lot category: ${lotCategory}`);
  const basePrice = basePrices[tierIndex];

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
  if (modifiers.mosquitoWaterMult && modifiers.mosquitoWaterMult !== 1.0) {
    pressure *= modifiers.mosquitoWaterMult;
  }
  pressure = Math.min(pressure, MOSQUITO.pressureCap);

  const perVisit = Math.round(basePrice * pressure);
  const visits = MOSQUITO.tierVisits[tier];
  const annual = perVisit * visits;
  const monthly = Math.round(annual / 12 * 100) / 100;

  // Cost estimate
  const materialPerVisit = 18;
  const laborPerVisitCost = laborCost(30);
  const annualCost = (materialPerVisit + laborPerVisitCost) * visits + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  // ── Tier array: bronze / silver / gold / platinum pre-priced ──
  const TIER_NAMES = ['bronze', 'silver', 'gold', 'platinum'];
  const recommendedTier = f.nearWater && pressure >= 1.60 ? 'platinum' : f.trees === 'heavy' ? 'gold' : 'silver';
  const tiers = TIER_NAMES.map((name, idx) => {
    const bp = basePrices[idx];
    const pv = Math.round(bp * pressure);
    const v = MOSQUITO.tierVisits[name];
    const ann = pv * v;
    return {
      tier: name,
      perVisit: pv,
      visits: v,
      annual: ann,
      monthly: Math.round(ann / 12 * 100) / 100,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      recommended: name === recommendedTier,
    };
  });

  return {
    service: 'mosquito',
    tier, lotCategory, basePrice, pressureMultiplier: pressure,
    perVisit, visits, annual, monthly,
    tiers,
    costs: { materialPerVisit, laborPerVisit: Math.round(laborPerVisitCost * 100) / 100, annualCost: Math.round(annualCost) },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    recommendedTier,
  };
}

// ============================================================
// TERMITE BAIT STATIONS
// ============================================================
function priceTermiteBait(property, options = {}) {
  const {
    system = 'trelona',
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
  const installLabor = stations * 0.25 * GLOBAL.LABOR_RATE; // ~15 min per station
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

  // Cost estimate: 12 visits/year
  let onSiteMin = size === 'small' ? 15 : size === 'medium' ? 20 : 25;
  let materialPerVisit = size === 'small' ? 10 : size === 'medium' ? 12 : 15;

  // POST-EXCLUSION MODIFIER — sealed structure = lighter scope
  // Three independent levers (per post-exclusion-modifier-spec.md):
  //   1. Station count   ~ -35% (perimeter only, floor 4 stations) → revenue-side ~0.65×
  //   2. Bait cost       ~ -20% (lower uptake on sealed structure)
  //   3. Labor           ~ -40% (no diagnostic, ~24min vs ~40min visits)
  // Net combined revenue impact ≈ 0.72× (25–30% off). Floor: $55/mo.
  if (postExclusion) {
    const POST_EXCL_MULT = 0.72;
    const POST_EXCL_FLOOR_MONTHLY = 55;
    monthly = Math.max(POST_EXCL_FLOOR_MONTHLY, Math.round(monthly * POST_EXCL_MULT * 100) / 100);
    annual = Math.round(monthly * 12);
    materialPerVisit = Math.round(materialPerVisit * 0.80 * 100) / 100;
    onSiteMin = Math.round(onSiteMin * 0.60);
  }

  const laborPerVisitCost = laborCost(onSiteMin);
  const annualCost = (materialPerVisit + laborPerVisitCost) * 12 + GLOBAL.ADMIN_ANNUAL;
  const margin = annual > 0 ? (annual - annualCost) / annual : 0;

  return {
    service: 'rodent_bait',
    score, size, monthly, annual,
    visitsPerYear: 12,
    postExclusion,
    costs: { materialPerVisit, laborPerVisit: Math.round(laborPerVisitCost * 100) / 100, annualCost: Math.round(annualCost) },
    margin: Math.round(margin * 1000) / 1000,
    marginFloorOk: margin >= GLOBAL.MARGIN_FLOOR,
    tierQualifier: RODENT.tierQualifier,
    excludeFromPctDiscount: RODENT.excludeFromPctDiscount,
  };
}

// ============================================================
// RODENT TRAPPING (One-Time)
// ============================================================
function priceRodentTrapping(property) {
  const footprint = property.footprint;
  const lotSqFt = property.lotSqFt;
  const f = property.features || {};

  const footprintAdj = interpolate(footprint, RODENT.trapping.footprintAdj);
  const lotAdj = interpolate(lotSqFt, RODENT.trapping.lotAdj);

  let base = RODENT.trapping.base + Math.round(footprintAdj) + Math.round(lotAdj);
  if (f.trees === 'heavy') base += 10;
  if (f.trees === 'moderate') base += 5;

  const price = Math.max(RODENT.trapping.floor, base);

  return { service: 'rodent_trapping', price, footprintAdj: Math.round(footprintAdj), lotAdj: Math.round(lotAdj) };
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
    base = recurringPestPerApp / (1 + roachMod); // Back out roach modifier
  } else {
    const pestResult = pricePestControl(property, { frequency: 'quarterly', roachType: 'none' });
    base = pestResult.basePrice;
  }

  let price = Math.max(ONE_TIME.pest.floor, Math.round(base * ONE_TIME.pest.multiplier));

  if (isRecurringCustomer) {
    price = Math.round(price * (1 - WAVEGUARD_RECURRING_DISC()));
  }

  const urgencyMult = afterHours
    ? (URGENCY[urgency] || URGENCY.NONE).afterHours || 1
    : (URGENCY[urgency] || URGENCY.NONE).standard;
  price = Math.round(price * urgencyMult);

  // Re-apply floor after discounts
  price = Math.max(ONE_TIME.pest.floor, price);

  return { service: 'one_time_pest', price, urgency, afterHours, isRecurringCustomer };
}

function WAVEGUARD_RECURRING_DISC() {
  const { WAVEGUARD } = require('./constants');
  return WAVEGUARD.recurringCustomerOneTimePerk;
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
    hasRecurringLawn = false,
  } = options;

  let base;
  if (hasRecurringLawn) {
    const lawnResult = priceLawnCare(property, { tier: 'enhanced' });
    base = lawnResult.perApp;
  } else {
    base = Math.round(55 * 12 / 9 * 100) / 100; // $73.33
  }

  if (treatmentType === 'fungicide' && !hasRecurringLawn) {
    base = Math.max(base, ONE_TIME.lawn.fungicideFloor);
  }

  const treatMult = ONE_TIME.lawn.treatmentMultipliers[treatmentType] || 1.0;
  let price = Math.max(ONE_TIME.lawn.floor, Math.round(base * ONE_TIME.lawn.oneTimeMultiplier * treatMult));

  if (isRecurringCustomer) {
    price = Math.round(price * (1 - WAVEGUARD_RECURRING_DISC()));
  }

  const urgencyMult = afterHours
    ? (URGENCY[urgency] || URGENCY.NONE).afterHours || 1
    : (URGENCY[urgency] || URGENCY.NONE).standard;
  price = Math.round(price * urgencyMult);
  price = Math.max(ONE_TIME.lawn.floor, price);

  return { service: 'one_time_lawn', price, treatmentType, urgency, afterHours, isRecurringCustomer };
}

// ============================================================
// ONE-TIME MOSQUITO
// ============================================================
function priceOneTimeMosquito(property) {
  const lotCategory = property.lotCategory;
  const price = ONE_TIME.mosquito[lotCategory] || ONE_TIME.mosquito.SMALL;
  return { service: 'one_time_mosquito', price, lotCategory };
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

function priceBedBug(rooms, method = 'chemical', footprint = 2000) {
  // 'both' returns v2 composite shape; dispatch in estimate-engine decomposes
  // into two flat line items for downstream pipeline compatibility.
  if (method === 'both' || method === 'BOTH') {
    const chem = priceBedBug(rooms, 'chemical', footprint);
    const heat = priceBedBug(rooms, 'heat', footprint);
    return {
      name: 'Bed Bug Treatment',
      methods: [
        { method: 'Chemical', price: chem.price, detail: `${rooms} room${rooms > 1 ? 's' : ''}, 2 visits` },
        { method: 'Heat',     price: heat.price, detail: `${rooms} room${rooms > 1 ? 's' : ''} — $${Math.round(heat.price / rooms)}/room` },
      ],
    };
  }

  if (method === 'heat') {
    const perRoom = rooms <= 1 ? SPECIALTY.bedBug.heat.perRoom[1]
      : rooms <= 2 ? SPECIALTY.bedBug.heat.perRoom[2]
      : SPECIALTY.bedBug.heat.perRoom[3];
    let price = perRoom * rooms;
    if (footprint > 2500) price = Math.round(price * SPECIALTY.bedBug.heat.footprintMult.over2500);
    else if (footprint < 1200) price = Math.round(price * SPECIALTY.bedBug.heat.footprintMult.under1200);
    return { service: 'bed_bug_heat', rooms, price };
  }

  // Chemical method
  const mpr = SPECIALTY.bedBug.chemical.materialPerRoom;
  const driveMin = GLOBAL.DRIVE_TIME;
  const v1min = 45 + (rooms - 1) * 30 + 30 + driveMin;
  const v2min = 25 + (rooms - 1) * 20 + driveMin;
  const cost = (mpr * rooms + GLOBAL.LABOR_RATE * v1min / 60 + mpr * rooms * 0.5 + GLOBAL.LABOR_RATE * v2min / 60);
  let price = Math.round(cost / SPECIALTY.bedBug.chemical.marginDivisor * 100) / 100;
  const floor = SPECIALTY.bedBug.chemical.floorBase + Math.max(0, rooms - 1) * SPECIALTY.bedBug.chemical.floorPerExtraRoom;
  price = Math.max(floor, price);
  if (footprint > 2500) price = Math.round(price * SPECIALTY.bedBug.chemical.footprintMult.over2500);
  else if (footprint > 1800) price = Math.round(price * SPECIALTY.bedBug.chemical.footprintMult.over1800);

  return { service: 'bed_bug_chemical', rooms, price };
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
// v2 parity: exact-match tier lookup (5/10/15/20 only; falls back to Spot).
function priceFoamDrill(points = 5, options = {}) {
  const { urgency = 'ROUTINE', afterHours = false } = options;
  const cfg = SPECIALTY.foamDrill;
  const tierMap = { 5: cfg.tiers[0], 10: cfg.tiers[1], 15: cfg.tiers[2], 20: cfg.tiers[3] };
  const tier = tierMap[points] || cfg.tiers[0];
  const cost = tier.cans * cfg.canCost + tier.laborHrs * GLOBAL.LABOR_RATE + cfg.bitsCost;
  let price = Math.max(cfg.floor, Math.round(cost / cfg.marginDivisor));
  price = applyUrgency(price, urgency, afterHours);
  const label = tier.label + (tier.maxPoints === 5 ? ' (1–5)' : tier.maxPoints === 10 ? ' (6–10)' : tier.maxPoints === 15 ? ' (11–15)' : '');
  return {
    service: 'foam_drill',
    name: 'Drill-and-Foam Termite',
    price,
    detail: `${label} | ${tier.cans} can${tier.cans > 1 ? 's' : ''}`,
    points, tier: label, cans: tier.cans,
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
// v2 parity: urgency applied to points subtotal, NOT to inspection fee.
function priceExclusion(options = {}) {
  const {
    simple = 0, moderate = 0, advanced = 0, waiveInspection = false,
    urgency = 'ROUTINE', afterHours = false,
  } = options;
  const cfg = SPECIALTY.exclusion;
  const sc = simple * cfg.perPoint.simple + moderate * cfg.perPoint.moderate + advanced * cfg.perPoint.advanced;
  const ep = Math.max(cfg.floor, Math.round(sc));
  const insp = waiveInspection ? 0 : cfg.inspectionFee;
  const total = applyUrgency(ep, urgency, afterHours) + insp;
  let tier = 'Basic';
  if (advanced > 0) tier = 'Advanced (Roof)';
  else if (moderate > 0) tier = 'Moderate';
  return {
    service: 'exclusion',
    name: 'Rodent Exclusion',
    price: total,
    detail: `${tier} — ${simple + moderate + advanced} points${insp > 0 ? ` + $${insp} inspect` : ' (inspect waived)'}`,
    points: { simple, moderate, advanced }, inspectionFee: insp, tier,
  };
}

// ============================================================
// RODENT GUARANTEE (combo bundle: trap + exclusion)
// ============================================================
function priceRodentGuarantee() {
  const price = SPECIALTY.exclusion.rodentGuarantee;
  return {
    service: 'rodent_guarantee',
    name: 'Rodent Guarantee',
    price,
    detail: `$${price}/yr — unlimited callbacks + re-sealing for 12 months`,
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

module.exports = {
  pricePestControl, priceLawnCare, priceTreeShrub, pricePalmInjection,
  priceMosquito, priceTermiteBait, priceRodentBait, priceRodentTrapping,
  priceOneTimePest, priceOneTimeLawn, priceOneTimeMosquito,
  priceTrenching, priceBoraCare, pricePreSlabTermidor,
  priceGermanRoach, priceBedBug, priceWDO, priceFlea,
  priceTopDressing, priceDethatching,
  pricePlugging, priceFoamDrill, priceStingingInsect, priceExclusion, priceRodentGuarantee,
  // Spec functions (Apr 2026)
  calculatePluggingPrice, calculateFoamPrice, calculateStingingPrice,
  calculateExclusionPrice, calculateRodentGuaranteeCombo,
  interpolate, laborCost,
};
