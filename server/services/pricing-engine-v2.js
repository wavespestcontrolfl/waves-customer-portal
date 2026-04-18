/**
 * WAVES PEST CONTROL — Pricing Engine v2.0
 *
 * @deprecated Since 2026-04-15. Retained until Session 11.
 *
 * Used by property-lookup-v2.js for Virginia's primary lookup estimate flow
 * (POST /api/admin/estimator/calculate-estimate). v2 emits a tiered output
 * shape (rec.lawn.tiers[], rec.pest.tiers[], etc.) + specialty pricing
 * (bedbug, exclusion, boracare, preslab, foam, stinging, plug, one-time
 * lawn) that the modular engine at server/services/pricing-engine/ does not
 * yet emit. ~40-50% of this file is specialty logic with no v1 equivalent.
 *
 * Full retirement planned as part of Session 11 v1 specialty/one-time
 * service port. Session 11 also absorbs the client-side migration
 * (EstimatePage.jsx + EstimateViewPage.jsx + estimateEngine.js deletion).
 *
 * DO NOT extend with new functionality. Add new pricing features to
 * pricing-engine/modifiers.js or pricing-engine/service-pricing.js.
 */

const DEFAULT_LABOR_RATE = 35;    // $/hr loaded rate
const DEFAULT_DRIVE_TIME = 20;    // minutes average drive (Zone A)
const DEFAULT_ADMIN_ANNUAL = 51;  // annual admin overhead per service

let LABOR_RATE = DEFAULT_LABOR_RATE;
let DRIVE_TIME = DEFAULT_DRIVE_TIME;
let ADMIN_ANNUAL = DEFAULT_ADMIN_ANNUAL;

// ─────────────────────────────────────────────
// PRICING CONFIG LOADER — pulls admin-editable values
// from pricing_config + lawn_pricing_brackets. Cached 60s so
// edits in /📐 Pricing Logic flow through to estimates.
// ─────────────────────────────────────────────
let _cfgCache = null;
let _cfgCacheAt = 0;
const CFG_TTL_MS = 60_000;

async function loadPricingConfig() {
  if (_cfgCache && Date.now() - _cfgCacheAt < CFG_TTL_MS) return _cfgCache;
  const cfg = {
    pestBase: null, pestFloor: null,
    pestFootprint: null, pestFeatures: {}, pestPropertyType: {},
    lawnBrackets: null,
  };
  try {
    const db = require('../models/db');
    if (await db.schema.hasTable('pricing_config')) {
      const rows = await db('pricing_config').select('config_key', 'data');
      const byKey = {};
      for (const r of rows) {
        byKey[r.config_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      }
      if (byKey.global_labor_rate?.value) LABOR_RATE = byKey.global_labor_rate.value;
      else LABOR_RATE = DEFAULT_LABOR_RATE;
      if (byKey.global_drive_time?.value) DRIVE_TIME = byKey.global_drive_time.value;
      else DRIVE_TIME = DEFAULT_DRIVE_TIME;
      if (byKey.global_admin_annual?.value) ADMIN_ANNUAL = byKey.global_admin_annual.value;
      else ADMIN_ANNUAL = DEFAULT_ADMIN_ANNUAL;

      if (byKey.pest_base) {
        if (byKey.pest_base.base != null) cfg.pestBase = byKey.pest_base.base;
        if (byKey.pest_base.floor != null) cfg.pestFloor = byKey.pest_base.floor;
      }
      if (byKey.pest_footprint?.breakpoints?.length) {
        cfg.pestFootprint = byKey.pest_footprint.breakpoints.map(bp => [bp.sqft, bp.adj]);
      }
      if (byKey.pest_features) cfg.pestFeatures = byKey.pest_features;
      if (byKey.pest_property_type) cfg.pestPropertyType = byKey.pest_property_type;
    }

    if (await db.schema.hasTable('lawn_pricing_brackets')) {
      const lawnRows = await db('lawn_pricing_brackets')
        .orderBy('grass_track').orderBy('sqft_bracket').orderBy('tier');
      if (lawnRows.length) {
        const TIER_INDEX = { basic: 0, standard: 1, enhanced: 2, premium: 3 };
        const TRACK_TO_GRASS = { A: 'st_augustine', B: 'st_augustine', C1: 'bermuda', C2: 'zoysia', D: 'bahia' };
        const byTrack = {};
        for (const row of lawnRows) {
          const grass = TRACK_TO_GRASS[row.grass_track] || row.grass_track;
          const sqft = Number(row.sqft_bracket);
          const idx = TIER_INDEX[row.tier];
          if (idx === undefined) continue;
          if (!byTrack[grass]) byTrack[grass] = new Map();
          if (!byTrack[grass].has(sqft)) byTrack[grass].set(sqft, [sqft, 0, 0, 0, 0]);
          byTrack[grass].get(sqft)[idx + 1] = Number(row.monthly_price);
        }
        cfg.lawnBrackets = {};
        for (const [grass, bracketMap] of Object.entries(byTrack)) {
          cfg.lawnBrackets[grass] = [...bracketMap.values()].sort((a, b) => a[0] - b[0]);
        }
      }
    }
  } catch (err) {
    console.error('[pricing-engine-v2] config load failed, using defaults:', err.message);
  }
  _cfgCache = cfg;
  _cfgCacheAt = Date.now();
  return cfg;
}

function invalidatePricingConfigCache() {
  _cfgCache = null;
  _cfgCacheAt = 0;
}

// ─────────────────────────────────────────────
// MAIN ENTRY POINT
// ─────────────────────────────────────────────
async function calculateEstimate(profile, selectedServices, options = {}) {
  const PRICING_CFG = await loadPricingConfig();
  const {
    grassType: _grassType = 'st_augustine',
    lawnFreq = 9,
    pestFreq = 4,
    manualDiscount = null, // { type: 'FIXED'|'PERCENT', value: number, label?: string }
    roachModifier = 'NONE',
    urgency = 'ROUTINE',
    afterHours = false,
    recurringCustomer = false,
    // Plugging
    plugArea = 0,
    plugSpacing = 12,
    // Bora-Care
    boracareSqft = 0,
    // Pre-slab
    preslabSqft = 0,
    preslabWarranty = 'BASIC',
    preslabVolume = 'NONE',
    // Foam
    foamPoints = 5,
    // Stinging insect
    stingSpecies = 'PAPER_WASP',
    stingTier = 2,
    stingRemoval = 'NONE',
    stingAggressive = 'NO',
    stingHeight = 'GROUND',
    stingConfined = 'NO',
    // Bed bug
    bedbugRooms = 1,
    bedbugMethod = 'BOTH',
    // Exclusion
    exclSimple = 0,
    exclModerate = 0,
    exclAdvanced = 0,
    exclWaiveInspection = false,
    // Roach
    roachType = 'REGULAR',
    // One-time lawn
    onetimeLawnType = 'FERT',
    // Commercial overrides
    commBuildingType = 'APARTMENT',
    commPestFreq = 12,
    commLawnFreq = 0,
    commAfterHours = false,
  } = options;

  const p = profile; // shorthand
  const mods = p.modifiers || {};

  // Backward compat: map old track letters to new keys
  const TRACK_MAP = { A: 'st_augustine', B: 'st_augustine', C1: 'bermuda', C2: 'zoysia', D: 'bahia' };
  const grassType = TRACK_MAP[_grassType] || _grassType || 'st_augustine';

  // Zone-based drive time adjustment.
  // Must match v1 modifiers.zoneMultiplier() and constants.ZONES. v2 remains
  // Virginia's property-lookup hot path until Session 11; keeping it aligned
  // prevents customers from seeing different quotes on lookup vs admin paths.
  const zoneMultipliers = { A: 1.0, B: 1.05, C: 1.12, D: 1.20, UNKNOWN: 1.05 };
  const zoneMult = zoneMultipliers[p.serviceZone] || 1.05;

  // Urgency/after-hours multiplier
  let urgMult = 1.0, urgLabel = '';
  if (urgency === 'SOON') {
    urgMult = afterHours ? 1.50 : 1.25;
    urgLabel = afterHours ? 'Soon+AH (+50%)' : 'Soon (+25%)';
  } else if (urgency === 'URGENT') {
    urgMult = afterHours ? 2.0 : 1.50;
    urgLabel = afterHours ? 'Emerg AH (+100%)' : 'Emergency (+50%)';
  }

  // Recurring customer discount for one-time services
  const rcDiscount = recurringCustomer ? 0.85 : 1.0;
  const applyOT = (base) => Math.round(base * urgMult * rcDiscount);

  // ── Compute footprint ──
  let footprint = p.footprint || 0;
  let footprintEstimated = false;
  if (footprint <= 0 && p.lotSqFt > 0) {
    const pt = (p.propertyType || '').toLowerCase();
    let lotRatio = 0.22;
    if (pt.includes('town') || pt.includes('duplex')) lotRatio = 0.30;
    else if (pt.includes('condo')) lotRatio = 0.35;
    footprint = Math.round(p.lotSqFt * lotRatio);
    footprintEstimated = true;
  }

  // ── Compute bed area ──
  let bedArea = p.estimatedBedAreaSf || 0;
  if (bedArea <= 0 && p.lotSqFt > 0) {
    let bp = p.shrubDensity === 'HEAVY' ? 0.25 :
             p.shrubDensity === 'MODERATE' ? 0.18 : 0.10;
    if (p.landscapeComplexity === 'COMPLEX') bp += 0.05;
    bedArea = Math.min(8000, Math.round(p.lotSqFt * bp));
  }

  // ── Compute turf area: fixed hardscape + complexity scoring + smoothed turf factor ──
  let turfSf = p.estimatedTurfSf || 0;
  if (turfSf <= 0 && p.lotSqFt > 0) {
    const ptl = (p.propertyType || '').toLowerCase();
    let hardscape = 0;
    if (ptl.includes('commercial')) {
      hardscape = Math.round(p.lotSqFt * 0.15);
    } else {
      let base = 800, marginal = 0.03;
      if (ptl.includes('town') || ptl.includes('duplex')) { base = 400; marginal = 0.02; }
      else if (ptl.includes('condo')) { base = 200; marginal = 0.05; }
      hardscape = base + Math.max(0, Math.round((p.lotSqFt - 7500) * marginal));
    }
    if (p.poolCage === 'YES') hardscape += 600;
    else if (p.pool === 'YES') hardscape += 450;
    if (p.hasLargeDriveway) hardscape += 300;

    const openArea = Math.max(0, Math.round(p.lotSqFt - footprint - hardscape));

    // Complexity score
    let sc = 0;
    if (p.pool === 'YES') sc += 2;
    if (p.poolCage === 'YES') sc += 2;
    if (p.hasLargeDriveway) sc += 2;
    if (p.shrubDensity === 'MODERATE') sc += 1; else if (p.shrubDensity === 'HEAVY') sc += 2;
    if (p.treeDensity === 'MODERATE') sc += 1; else if (p.treeDensity === 'HEAVY') sc += 2;
    if (p.landscapeComplexity === 'MODERATE') sc += 1; else if (p.landscapeComplexity === 'COMPLEX') sc += 2;
    if (bedArea > 0 && p.lotSqFt > 0) {
      const bedRatio = bedArea / p.lotSqFt;
      if (bedRatio >= 0.20) sc += 3;
      else if (bedRatio >= 0.10) sc += 1;
    }

    const tfTable = [0.78, 0.73, 0.68, 0.63, 0.58, 0.53, 0.48, 0.43, 0.38, 0.33];
    const tf = tfTable[Math.min(sc, 9)];
    turfSf = Math.max(0, Math.round(openArea * tf));
  }

  // ── Estimate attic sqft (for Bora-Care) ──
  const atticSqft = boracareSqft ||
    (p.homeSqFt > 0 ? Math.round(p.homeSqFt / (p.stories || 1) * 0.85) : 0);

  // ── Estimate slab sqft (for pre-slab) ──
  const slabSqft = preslabSqft ||
    (p.homeSqFt > 0 ? Math.round(p.homeSqFt / (p.stories || 1)) : 0);

  // ──────────────────────────────────────
  // RESULTS OBJECT
  // ──────────────────────────────────────
  const result = {
    property: {
      address: p.address,
      type: p.propertyType,
      category: p.category,
      homeSqFt: p.homeSqFt,
      lotSqFt: p.lotSqFt,
      stories: p.stories,
      footprint,
      footprintEstimated,
      turfSf,
      bedArea,
      yearBuilt: p.yearBuilt,
      constructionAge: p.constructionAge,
      constructionMaterial: p.constructionMaterial,
      foundationType: p.foundationType,
      roofType: p.roofType,
      pool: p.pool,
      poolCage: p.poolCage,
      largeDriveway: p.largeDriveway,
      shrubDensity: p.shrubDensity,
      treeDensity: p.treeDensity,
      landscapeComplexity: p.landscapeComplexity,
      nearWater: p.nearWater,
      waterDistance: p.waterDistance,
      isHOA: p.isHOA,
      hoaFee: p.hoaFee,
      isRental: p.isRental,
      isNewHomeowner: p.isNewHomeowner,
      serviceZone: p.serviceZone,
      fenceType: p.fenceType,
      outbuildingCount: p.outbuildingCount,
      maintenanceCondition: p.maintenanceCondition,
      overallPestPressure: p.overallPestPressure,
      estimatedValue: p.estimatedValue || null,
      estimatedValueLow: p.estimatedValueLow || null,
      estimatedValueHigh: p.estimatedValueHigh || null,
    },
    modifiers: mods,
    zoneMult,
    urgency: { mult: urgMult, label: urgLabel },
    recurringCustomer,

    recurring: {},
    oneTime: {},
    specialty: {},
    waveguard: {},
    totals: {},

    fieldVerify: p.fieldVerifyFlags || [],
    notes: [],
  };

  // ── HOA Notes ──
  if (p.isHOA) {
    result.notes.push({
      type: 'HOA',
      text: `HOA community ($${p.hoaFee}/mo). Check for: lawn chemical restrictions, vendor insurance requirements, gate access codes, service hour restrictions.`,
      priority: 'MEDIUM'
    });
  }

  // ── New Homeowner Note ──
  if (p.isNewHomeowner) {
    result.notes.push({
      type: 'SALES',
      text: `New homeowner (purchased ${p.lastSaleDate ? new Date(p.lastSaleDate).toLocaleDateString('en-US', { timeZone: 'America/New_York' }) : 'recently'}). High bundle potential — recommend WaveGuard Platinum pitch.`,
      priority: 'HIGH'
    });
  }

  // ── Rental Property Note ──
  if (p.isRental) {
    result.notes.push({
      type: 'OWNER',
      text: 'Organization-owned (rental property). Verify tenant has authority to approve services, or contact property manager.',
      priority: 'MEDIUM'
    });
  }

  // ── Foundation Note ──
  if (p.foundationType === 'CRAWLSPACE' || p.foundationType === 'RAISED') {
    result.notes.push({
      type: 'STRUCTURE',
      text: `${p.foundationType} foundation detected. Termite treatment approach must be modified — standard perimeter trenching does not apply. Additional inspection time required for WDO.`,
      priority: 'HIGH'
    });
  }

  // ── Construction Note ──
  if (p.constructionMaterial === 'WOOD_FRAME') {
    result.notes.push({
      type: 'STRUCTURE',
      text: 'Wood frame construction — elevated termite risk. Recommend Bora-Care preventive treatment and bait station monitoring. Check for wood-to-ground contact points.',
      priority: 'HIGH'
    });
  }

  // ── Tile Roof Note ──
  if (p.roofType === 'TILE') {
    result.notes.push({
      type: 'STRUCTURE',
      text: 'Tile roof — elevated roof rat risk. Barrel tiles provide nesting habitat. Recommend bait stations with focus on roofline entry points.',
      priority: 'MEDIUM'
    });
  }

  // ── Vegetation on Structure ──
  if (p.vegetationOnStructure === 'SIGNIFICANT') {
    result.notes.push({
      type: 'MAINTENANCE',
      text: 'Significant vegetation touching structure detected. Recommend customer cut back all vegetation 18"+ from exterior walls before service.',
      priority: 'MEDIUM'
    });
  }

  // ── Fence Note ──
  if (p.fenceType === 'PRIVACY_WOOD' || p.fenceType === 'PRIVACY_VINYL') {
    result.notes.push({
      type: 'ACCESS',
      text: `${p.fenceType.replace('_', ' ')} fencing detected. Verify gate access for perimeter treatment. Privacy fences create rodent harborage — check fence line during service.`,
      priority: 'LOW'
    });
  }


  // ═══════════════════════════════════════════
  // RECURRING SERVICES
  // ═══════════════════════════════════════════

  // ── LAWN CARE ──
  if (selectedServices.includes('LAWN') && turfSf > 0) {
    result.recurring.lawn = calcLawn(turfSf, grassType, p, PRICING_CFG, lawnFreq);
  }

  // ── PEST CONTROL ──
  if (selectedServices.includes('PEST') && footprint > 0) {
    result.recurring.pest = calcPest(footprint, p, mods, pestFreq, roachModifier, zoneMult, PRICING_CFG);
  }

  // ── TREE & SHRUB ──
  if (selectedServices.includes('TREE_SHRUB') && p.lotSqFt > 0) {
    result.recurring.treeShrub = calcTreeShrub(bedArea, p);
  }

  // ── MOSQUITO ──
  if (selectedServices.includes('MOSQUITO') && p.lotSqFt > 0) {
    result.recurring.mosquito = calcMosquito(p, mods);
  }

  // ── TERMITE BAIT ──
  if (selectedServices.includes('TERMITE_BAIT') && footprint > 0) {
    result.recurring.termiteBait = calcTermiteBait(footprint, p, mods);
  }

  // ── RODENT BAIT ──
  if (selectedServices.includes('RODENT_BAIT') && footprint > 0) {
    result.recurring.rodentBait = calcRodentBait(footprint, p, mods);
  }


  // ═══════════════════════════════════════════
  // ONE-TIME SERVICES
  // ═══════════════════════════════════════════

  if (selectedServices.includes('OT_PEST') && footprint > 0) {
    const basePP = result.recurring.pest?.perApp || calcPestBase(footprint, p, mods, PRICING_CFG);
    result.oneTime.pest = { name: 'One-Time Pest', price: applyOT(Math.max(150, Math.round(basePP * 1.30))) };
  }

  if (selectedServices.includes('OT_LAWN') && turfSf > 0) {
    const lawnPA = result.recurring.lawn?.tiers?.[2]?.perApp || 75;
    let base = Math.max(115, Math.round(lawnPA * 1.50));
    const otMult = { FERT: 1.0, WEED: 1.12, PEST: 1.30, FUNGICIDE: 1.38 };
    base = Math.round(base * (otMult[onetimeLawnType] || 1.0));
    result.oneTime.lawn = { name: `One-Time Lawn (${onetimeLawnType})`, price: applyOT(Math.max(115, base)) };
  }

  if (selectedServices.includes('OT_MOSQUITO') && p.lotSqFt > 0) {
    let mp = 200;
    if (p.lotSqFt >= 43560) mp = 350;
    else if (p.lotSqFt >= 21780) mp = 300;
    else if (p.lotSqFt >= 14520) mp = 275;
    else if (p.lotSqFt >= 10890) mp = 250;
    result.oneTime.mosquito = { name: 'One-Time Mosquito', price: applyOT(mp) };
  }

  if (selectedServices.includes('PLUGGING') && plugArea > 0) {
    result.oneTime.plugging = calcPlugging(plugArea, plugSpacing, applyOT);
  }

  if (selectedServices.includes('TOPDRESS') && turfSf > 0) {
    result.oneTime.topdress = calcTopdress(turfSf, applyOT);
  }

  if (selectedServices.includes('DETHATCH') && turfSf > 0) {
    const dt = turfSf / 100 + turfSf / 200 + 30;
    const dc = LABOR_RATE * (dt / 60) + turfSf / 1000 * 2.10;
    result.oneTime.dethatch = { name: 'Dethatching', price: applyOT(Math.max(150, Math.round(dc / 0.40))) };
  }

  if (selectedServices.includes('TRENCHING') && footprint > 0) {
    result.oneTime.trenching = calcTrenching(footprint, p, mods, applyOT);
  }

  if (selectedServices.includes('BORACARE') && atticSqft > 0) {
    result.oneTime.boracare = calcBoraCare(atticSqft, applyOT);
  }

  if (selectedServices.includes('PRESLAB') && slabSqft > 0) {
    result.oneTime.preslab = calcPreslab(slabSqft, preslabWarranty, preslabVolume, applyOT);
  }

  if (selectedServices.includes('FOAM')) {
    result.oneTime.foam = calcFoam(foamPoints, applyOT);
  }

  if (selectedServices.includes('RODENT_TRAP')) {
    result.oneTime.rodentTrap = calcRodentTrap(footprint, p.lotSqFt, applyOT);
  }

  if (selectedServices.includes('WDO')) {
    result.oneTime.wdo = calcWDO(footprint, p, mods, applyOT);
  }

  // German roach initial (triggered by roach modifier on recurring pest)
  if (roachModifier === 'GERMAN') {
    result.oneTime.germanRoachInitial = { name: 'German Roach Initial (3-Visit)', price: applyOT(100) };
  }


  // ═══════════════════════════════════════════
  // SPECIALTY PEST
  // ═══════════════════════════════════════════

  if (selectedServices.includes('FLEA')) {
    result.specialty.flea = calcFlea(footprint, p, applyOT);
  }

  if (selectedServices.includes('ROACH')) {
    result.specialty.roach = calcRoach(footprint, p, roachType, result.recurring.pest, applyOT);
  }

  if (selectedServices.includes('STING')) {
    result.specialty.sting = calcSting(
      stingSpecies, stingTier, stingRemoval, stingAggressive,
      stingHeight, stingConfined, urgency, afterHours, result.recurring.pest
    );
  }

  if (selectedServices.includes('BEDBUG')) {
    result.specialty.bedbug = calcBedbug(bedbugRooms, bedbugMethod, footprint, applyOT);
  }

  if (selectedServices.includes('EXCLUSION') && (exclSimple + exclModerate + exclAdvanced) > 0) {
    result.specialty.exclusion = calcExclusion(exclSimple, exclModerate, exclAdvanced, exclWaiveInspection, applyOT);
  }

  // Rodent guarantee (when both trapping + exclusion selected)
  if (selectedServices.includes('RODENT_TRAP') && selectedServices.includes('EXCLUSION') &&
      (exclSimple + exclModerate + exclAdvanced) > 0) {
    result.specialty.rodentGuarantee = {
      name: 'Rodent Guarantee',
      price: 199,
      detail: '$199/yr — unlimited callbacks + re-sealing for 12 months'
    };
  }


  // ═══════════════════════════════════════════
  // WAVEGUARD BUNDLE
  // ═══════════════════════════════════════════
  result.waveguard = await calcWaveGuard(result.recurring);
  result.totals = calcTotals(result, manualDiscount);

  return result;
}


// ─────────────────────────────────────────────
// INTERPOLATION UTILITY
// ─────────────────────────────────────────────
function interpolate(v, breakpoints) {
  if (!breakpoints.length) return 0;
  if (v <= breakpoints[0].at) return breakpoints[0].adj;
  if (v >= breakpoints[breakpoints.length - 1].at) return breakpoints[breakpoints.length - 1].adj;
  for (let i = 0; i < breakpoints.length - 1; i++) {
    const lo = breakpoints[i], hi = breakpoints[i + 1];
    if (v >= lo.at && v <= hi.at) {
      const span = hi.at - lo.at;
      if (span === 0) return lo.adj;
      const ratio = (v - lo.at) / span;
      return lo.adj + ratio * (hi.adj - lo.adj);
    }
  }
  return breakpoints[breakpoints.length - 1].adj;
}


// ─────────────────────────────────────────────
// LAWN CARE
// ─────────────────────────────────────────────
function calcLawn(turfSf, grassType, p, cfg = null, lawnFreq = 9) {
  // Default lawn brackets — overridden at runtime by lawn_pricing_brackets table (edited in 📐 Pricing Logic)
  const DEFAULT_LAWN_PRICES = {
    st_augustine: { name: 'St. Augustine', pts: [[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]] },
    // Session 5: 4K-7K regenerated per tier scaling ($3/$4.50/$7 per K). 4K Basic clamped to $32 (margin floor). 8K+ unchanged.
    bermuda: { name: 'Bermuda', pts: [[0,32,44,54,75],[4000,32,44,54,75],[5000,33,47,61,86],[6000,36,50,68,97],[7000,39,53,75,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],[15000,65,88,132,199],[20000,81,111,169,256]] },
    zoysia: { name: 'Zoysia', pts: [[0,32,44,55,75],[4000,32,44,55,75],[5000,33,47,62,87],[6000,36,50,69,98],[7000,39,53,76,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],[15000,66,89,134,202],[20000,83,112,171,259]] },
    bahia: { name: 'Bahia', pts: [[0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],[5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],[10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223]] }
  };

  const C = cfg || _cfgCache || {};
  const GRASS_NAMES = { st_augustine: 'St. Augustine', bermuda: 'Bermuda', zoysia: 'Zoysia', bahia: 'Bahia' };
  let lp = DEFAULT_LAWN_PRICES[grassType] || DEFAULT_LAWN_PRICES.st_augustine;
  if (C.lawnBrackets?.[grassType]?.length) {
    lp = { name: GRASS_NAMES[grassType] || lp.name, pts: C.lawnBrackets[grassType] };
  }

  function lawnLookup(sf, freqIdx) {
    const pts = lp.pts;
    if (!pts.length) return 0;
    if (sf <= pts[0][0]) return pts[0][freqIdx + 1];
    if (sf >= pts[pts.length - 1][0]) return pts[pts.length - 1][freqIdx + 1];
    for (let i = 0; i < pts.length - 1; i++) {
      const lo = pts[i], hi = pts[i + 1];
      if (sf >= lo[0] && sf <= hi[0]) {
        const span = hi[0] - lo[0];
        if (span === 0) return lo[freqIdx + 1];
        const ratio = (sf - lo[0]) / span;
        return Math.round(lo[freqIdx + 1] + ratio * (hi[freqIdx + 1] - lo[freqIdx + 1]));
      }
    }
    return pts[pts.length - 1][freqIdx + 1];
  }

  const freqs = [
    { visits: 4, label: '4x/yr' },
    { visits: 6, label: '6x/yr' },
    { visits: 9, label: '9x/yr' },
    { visits: 12, label: '12x/yr' }
  ];

  const tiers = freqs.map((f, i) => {
    const mo = lawnLookup(turfSf, i);
    const ann = mo * 12;
    const perApp = Math.round(ann / f.visits * 100) / 100;
    return {
      visits: f.visits,
      label: f.label,
      monthly: mo,
      annual: ann,
      perApp,
      recommended: f.visits === lawnFreq,
    };
  });

  const selected = tiers.find(t => t.visits === lawnFreq) || tiers[2];

  return {
    service: 'Lawn Care',
    grassType: lp.name,
    turfSf,
    tiers,
    recommended: selected,
    selected,
    wgMonthly: selected.monthly,
  };
}


// ─────────────────────────────────────────────
// PEST CONTROL
// ─────────────────────────────────────────────
function calcPestBase(footprint, p, mods, cfg = null) {
  const C = cfg || _cfgCache || {};
  const F = C.pestFeatures || {};
  const PT = C.pestPropertyType || {};
  let adj = 0;
  const adjItems = [];

  // Footprint adjustment — admin-editable brackets (pest_footprint)
  const fpBrackets = (C.pestFootprint && C.pestFootprint.length)
    ? C.pestFootprint.map(([at, a]) => ({ at, adj: a }))
    : [
        { at: 800, adj: -20 }, { at: 1200, adj: -12 }, { at: 1500, adj: -6 },
        { at: 2000, adj: 0 }, { at: 2500, adj: 6 }, { at: 3000, adj: 12 },
        { at: 4000, adj: 20 }, { at: 5500, adj: 28 },
      ];
  const fpAdj = interpolate(footprint, fpBrackets);
  adj += fpAdj;
  adjItems.push({ name: `Footprint (${footprint.toLocaleString()} sf)`, value: fpAdj });

  const pick = (k, d) => (F[k] != null ? Number(F[k]) : d);

  // Shrub density
  let shrAdj = 0;
  if (p.shrubDensity === 'LIGHT') shrAdj = pick('shrubs_light', -5);
  else if (p.shrubDensity === 'MODERATE') shrAdj = pick('shrubs_moderate', 5);
  else if (p.shrubDensity === 'HEAVY') shrAdj = pick('shrubs_heavy', 10);
  adj += shrAdj;
  adjItems.push({ name: `Shrubs (${p.shrubDensity})`, value: shrAdj });

  // Pool
  let poolAdj = 0;
  if (p.poolCage === 'YES') poolAdj = pick('pool_cage', 10);
  else if (p.pool === 'YES') poolAdj = pick('pool_no_cage', 5);
  adj += poolAdj;
  adjItems.push({ name: `Pool`, value: poolAdj });

  // Tree density
  let treeAdj = 0;
  if (p.treeDensity === 'LIGHT') treeAdj = pick('trees_light', -5);
  else if (p.treeDensity === 'MODERATE') treeAdj = pick('trees_moderate', 5);
  else if (p.treeDensity === 'HEAVY') treeAdj = pick('trees_heavy', 10);
  adj += treeAdj;
  adjItems.push({ name: `Trees (${p.treeDensity})`, value: treeAdj });

  // Complexity
  let compAdj = 0;
  if (p.landscapeComplexity === 'COMPLEX') compAdj = pick('landscape_complex', 5);
  adj += compAdj;
  adjItems.push({ name: `Complexity (${p.landscapeComplexity})`, value: compAdj });

  // Near water
  let waterAdj = 0;
  if (p.nearWater && p.nearWater !== 'NONE' && p.nearWater !== 'NO') waterAdj = pick('near_water', 2.5);
  if (waterAdj > 0) {
    adj += waterAdj;
    adjItems.push({ name: 'Near water', value: waterAdj });
  }

  // Large driveway
  if (p.hasLargeDriveway) {
    const v = pick('large_driveway', 2.5);
    adj += v;
    adjItems.push({ name: 'Large driveway', value: v });
  }

  // Indoor treatment
  if (p.indoor) {
    const v = pick('indoor', 10);
    adj += v;
    adjItems.push({ name: 'Indoor treatment', value: v });
  }

  // ── Property type adjustment (admin-editable via pest_property_type) ──
  const ptLower = (p.propertyType || '').toLowerCase();
  const ptKey = (k, d) => (PT[k] != null ? Number(PT[k]) : d);
  let propTypeAdj = 0;
  if (ptLower.includes('townhome') || ptLower.includes('town home') || ptLower.includes('townhouse')) {
    propTypeAdj = ptLower.includes('interior') || ptLower.includes('inner')
      ? ptKey('townhome_interior', -15) : ptKey('townhome', -8);
  } else if (ptLower.includes('duplex')) { propTypeAdj = ptKey('duplex', -10); }
  else if (ptLower.includes('condo')) {
    propTypeAdj = ptLower.includes('upper') || ptLower.includes('2nd') || ptLower.includes('3rd')
      ? ptKey('condo_upper', -25) : ptKey('condo', -20);
  }
  if (propTypeAdj !== 0) {
    adj += propTypeAdj;
    adjItems.push({ name: `Property type (${p.propertyType})`, value: propTypeAdj });
  }

  // ── Home value modifier (RentCast AVM) ──
  // Higher-value homes get a small premium — larger contents, higher callback
  // expectations, longer service times. Pest control only.
  const hv = Number(p.estimatedValue) || 0;
  let hvAdj = 0;
  if (hv >= 1_000_000) hvAdj = 10;
  else if (hv >= 750_000) hvAdj = 7.5;
  else if (hv >= 500_000) hvAdj = 5;
  if (hvAdj > 0) {
    adj += hvAdj;
    adjItems.push({ name: `Home value ($${Math.round(hv).toLocaleString()})`, value: hvAdj });
  }

  const base = C.pestBase != null ? Number(C.pestBase) : 117;
  const floor = C.pestFloor != null ? Number(C.pestFloor) : 89;
  const basePrice = Math.max(floor, base + adj);
  return basePrice;
}

function calcPest(footprint, p, mods, pestFreq, roachMod, zoneMult, cfg = null) {
  const basePrice = calcPestBase(footprint, p, mods, cfg);

  // Roach modifier
  let rOG = 0;
  if (roachMod === 'REGULAR' || roachMod === 'GERMAN') {
    rOG = Math.round(basePrice * 0.15 * 100) / 100;
  }

  // WaveGuard Membership fee — flat $99, waived with annual prepay
  const initFee = 99;

  const prepayAnn = basePrice * 4;

  const freqTiers = [
    { freq: 4, label: 'Quarterly', disc: 1.0 },
    { freq: 6, label: 'Bi-Monthly', disc: 0.85 },
    { freq: 12, label: 'Monthly', disc: 0.70 }
  ];

  const tiers = freqTiers.map(ft => {
    const perApp = Math.round((basePrice * ft.disc + rOG) * zoneMult * 100) / 100;
    const ann = Math.round(perApp * ft.freq * 100) / 100;
    const mo = Math.round(ann / 12 * 100) / 100;
    return {
      freq: ft.freq,
      label: ft.label,
      perApp,
      annual: ann,
      monthly: mo,
      recommended: ft.freq === pestFreq
    };
  });

  const selected = tiers.find(t => t.freq === pestFreq) || tiers[0];

  return {
    service: 'Pest Control',
    basePrice: Math.round(basePrice),
    adjustments: [],
    roachModifier: roachMod,
    roachAdj: rOG,
    initialFee: initFee,
    initialFeeLabel: 'WaveGuard Membership',
    initialFeeWaivedWithPrepay: true,
    prepayAnnual: prepayAnn,
    tiers,
    selected,
    perApp: selected.perApp,
    wgMonthly: selected.monthly
  };
}


// ─────────────────────────────────────────────
// TREE & SHRUB
// ─────────────────────────────────────────────
function calcTreeShrub(bedArea, p) {
  const palmCount = p.estimatedPalmCount || (
    p.treeDensity === 'HEAVY' ? 8 : p.treeDensity === 'MODERATE' ? 4 : 2
  );
  const treeCount = p.estimatedTreeCount || (
    p.treeDensity === 'HEAVY' ? 12 : p.treeDensity === 'MODERATE' ? 5 : 2
  );

  // v3 Matrix lookup by palm tier
  const TS = {
    2:  [[0,35,45],[2000,35,45],[2500,37,46],[3000,41,50],[4000,48,60],[5000,55,69],[6000,63,79],[7000,70,88],[8000,78,97],[10000,92,116]],
    4:  [[0,35,45],[2000,36,45],[2500,40,49],[3000,43,53],[4000,51,63],[5000,58,72],[6000,66,82],[7000,73,91],[8000,80,101],[10000,95,119]],
    6:  [[0,35,45],[1750,37,45],[2000,39,47],[2500,42,52],[3000,46,57],[4000,54,66],[5000,61,76],[6000,68,85],[7000,76,94],[8000,83,104],[10000,98,123]],
    8:  [[0,35,45],[1250,36,45],[1500,38,46],[2000,41,50],[2500,45,55],[3000,49,60],[4000,56,69],[5000,64,79],[6000,71,88],[7000,78,97],[8000,86,107],[10000,101,126]],
    12: [[0,35,45],[500,36,45],[750,38,45],[1000,40,47],[1500,43,52],[2000,47,57],[2500,51,61],[3000,54,66],[4000,62,76],[5000,69,85],[6000,77,94],[7000,84,104],[8000,91,113],[10000,106,132]]
  };

  const palmTiers = [2, 4, 6, 8, 12];
  let closestPT = 2;
  palmTiers.forEach(pt => { if (Math.abs(palmCount - pt) < Math.abs(palmCount - closestPT)) closestPT = pt; });
  const pts = TS[closestPT];

  function tsLookup(sf, fi) {
    if (sf >= pts[pts.length - 1][0]) return pts[pts.length - 1][fi + 1];
    for (let i = 1; i < pts.length; i++) {
      if (sf <= pts[i][0]) {
        const lo = pts[i - 1], hi = pts[i];
        if (lo[0] === hi[0]) return hi[fi + 1];
        const t = (sf - lo[0]) / (hi[0] - lo[0]);
        return Math.round(lo[fi + 1] + (hi[fi + 1] - lo[fi + 1]) * t);
      }
    }
    return pts[pts.length - 1][fi + 1];
  }

  // Palm injection add-on — combo pricing ($55/palm default for estimates)
  const injectionPalms = Math.max(1, Math.round(palmCount * 0.40));
  const palmPerApp = 55;
  const injPerVisit = Math.max(75, injectionPalms * palmPerApp);
  const injAnn = injPerVisit * 2;
  const injMo = Math.round(injAnn / 12 * 100) / 100;

  const tiers = [
    { visits: 4, label: '4x/yr' },
    { visits: 6, label: '6x/yr' }
  ].map((f, i) => {
    const mo = tsLookup(bedArea, i);
    const ann = mo * 12;
    const perApp = Math.round(ann / f.visits * 100) / 100;
    return { visits: f.visits, label: f.label, monthly: mo, annual: ann, perApp, recommended: i === 1 };
  });

  return {
    service: 'Tree & Shrub',
    bedArea,
    palmCount,
    treeCount,
    palmTier: closestPT,
    tiers,
    injection: { palms: injectionPalms, perVisit: injPerVisit, annual: injAnn, monthly: injMo },
    recommended: tiers[1],
    wgMonthly: tiers[1].monthly + (palmCount > 0 ? injMo : 0)
  };
}


// ─────────────────────────────────────────────
// MOSQUITO — with graduated water proximity
// ─────────────────────────────────────────────
function calcMosquito(p, mods) {
  let sz = 'SMALL';
  if (p.lotSqFt >= 43560) sz = 'ACRE';
  else if (p.lotSqFt >= 21780) sz = 'HALF';
  else if (p.lotSqFt >= 14520) sz = 'THIRD';
  else if (p.lotSqFt >= 10890) sz = 'QUARTER';

  // ── NEW: Graduated water multiplier (replaces binary) ──
  const waterMult = mods.mosquitoWaterMult || 1.0;

  // Other pressure factors
  let pr = 1.0;
  if (p.treeDensity === 'HEAVY') pr += 0.15;
  else if (p.treeDensity === 'MODERATE') pr += 0.05;
  if (p.landscapeComplexity === 'COMPLEX') pr += 0.10;
  else if (p.landscapeComplexity === 'MODERATE') pr += 0.05;
  if (p.pool === 'YES') pr += 0.05;
  if (sz === 'ACRE') pr += 0.15;
  else if (sz === 'HALF') pr += 0.05;

  // Combine with water multiplier (multiplicative, not additive)
  pr = Math.round(pr * waterMult * 100) / 100;
  // Cap raised from 1.50 to 2.0 for extreme water proximity
  pr = Math.min(2.0, pr);

  const bp = {
    SMALL: { b: 80, s: 90, g: 100, p: 110 },
    QUARTER: { b: 90, s: 100, g: 115, p: 125 },
    THIRD: { b: 100, s: 110, g: 125, p: 135 },
    HALF: { b: 110, s: 125, g: 145, p: 155 },
    ACRE: { b: 140, s: 155, g: 180, p: 200 }
  };
  const base = bp[sz] || bp.SMALL;

  const tiers = [
    { name: 'Bronze', perVisit: Math.round(base.b * pr), visits: 12 },
    { name: 'Silver', perVisit: Math.round(base.s * pr), visits: 12 },
    { name: 'Gold', perVisit: Math.round(base.g * pr), visits: 15 },
    { name: 'Platinum', perVisit: Math.round(base.p * pr), visits: 17 }
  ].map(t => ({
    ...t,
    annual: t.perVisit * t.visits,
    monthly: Math.round(t.perVisit * t.visits / 12 * 100) / 100
  }));

  // Recommend based on pressure
  let recIdx = 1;
  if (p.treeDensity === 'HEAVY' || waterMult >= 1.40) recIdx = 2;
  if (waterMult >= 1.60) recIdx = 3;

  tiers.forEach((t, i) => t.recommended = i === recIdx);

  return {
    service: 'Mosquito',
    lotSize: sz,
    pressure: pr,
    waterMultiplier: waterMult,
    waterType: p.nearWater,
    tiers,
    recommended: tiers[recIdx],
    wgMonthly: tiers[recIdx].monthly
  };
}


// ─────────────────────────────────────────────
// TERMITE BAIT — with construction & foundation modifiers
// ─────────────────────────────────────────────
function calcTermiteBait(footprint, p, mods) {
  let pm = p.landscapeComplexity === 'MODERATE' || p.landscapeComplexity === 'COMPLEX' ? 1.35 : 1.25;
  const perim = Math.round(4 * Math.sqrt(footprint) * pm);
  const stations = Math.max(8, Math.ceil(perim / 10));

  // ── NEW: Construction multiplier on install cost ──
  const conMult = mods.termiteConstructionMult || 1.0;

  // ── NEW: Foundation adjustment ──
  const foundAdj = mods.termiteFoundationAdj || 0;

  const advanceInstall = Math.round((stations * 14 + stations * 5.25 + stations * 0.75) * 1.75 * conMult) + foundAdj;
  const trelonaInstall = Math.round((stations * 24 + stations * 5.25 + stations * 0.75) * 1.75 * conMult) + foundAdj;

  return {
    service: 'Termite Bait Stations',
    perimeter: perim,
    stations,
    constructionMult: conMult,
    foundationAdj: foundAdj,
    advance: { install: advanceInstall, basicMo: 35, premierMo: 65 },
    trelona: { install: trelonaInstall, basicMo: 35, premierMo: 65 },
    wgMonthly: 35 // Basic tier default
  };
}


// ─────────────────────────────────────────────
// RODENT BAIT STATIONS
// ─────────────────────────────────────────────
function calcRodentBait(footprint, p, mods) {
  let stations = 4;
  if (footprint > 3000) stations = 6;
  else if (footprint > 2000) stations = 5;
  if (p.nearWater !== 'NONE' || p.shrubDensity === 'HEAVY') stations += 2;

  // ── NEW: Tile roof = more stations ──
  if (p.roofType === 'TILE') stations += 1;

  stations = Math.min(8, stations);

  const stationScale = stations / 4;
  const costs = { 4: 191.23, 6: 217.77, 12: 297.39 };
  const tiers = [
    { name: '4x/yr', freq: 4, cost: Math.round(costs[4] * stationScale * 100) / 100, moLow: 55, moHigh: 65 },
    { name: '6x/yr', freq: 6, cost: Math.round(costs[6] * stationScale * 100) / 100, moLow: 60, moHigh: 70 },
    { name: '12x/yr', freq: 12, cost: Math.round(costs[12] * stationScale * 100) / 100, moLow: 70, moHigh: 85 }
  ];

  // ── NEW: Adjust monthly based on roof rodent modifier ──
  const roofAdj = mods.rodentRoofAdj || 0;
  tiers.forEach(t => {
    t.moLow += Math.round(roofAdj * 0.5);  // Split adj across low/high
    t.moHigh += roofAdj;
  });

  let recIdx = 1;
  if (p.nearWater !== 'NONE' || p.shrubDensity === 'HEAVY' || p.roofType === 'TILE') recIdx = 2;

  tiers.forEach((t, i) => {
    t.recommended = i === recIdx;
    t.margin = Math.round((1 - t.cost / (t.moLow * 12)) * 100);
  });

  return {
    service: 'Rodent Bait Stations',
    stations,
    roofType: p.roofType,
    roofAdj,
    tiers,
    recommended: tiers[recIdx],
    wgMonthly: 0 // Not included in WaveGuard bundle
  };
}


// ─────────────────────────────────────────────
// TRENCHING — with foundation modifier
// ─────────────────────────────────────────────
function calcTrenching(footprint, p, mods, applyOT) {
  let pm = p.landscapeComplexity === 'MODERATE' || p.landscapeComplexity === 'COMPLEX' ? 1.35 : 1.25;
  const perim = Math.round(4 * Math.sqrt(footprint) * pm);

  let cp = 0.25;
  if (p.poolCage === 'YES') cp = 0.35;
  else if (p.pool === 'YES') cp = 0.30;
  if (p.largeDriveway) cp += 0.05;
  cp = Math.min(0.50, cp);

  const dirtLF = Math.round(perim * (1 - cp));
  const concreteLF = Math.round(perim * cp);

  let basePrice = Math.max(600, dirtLF * 10 + concreteLF * 14);

  // ── NEW: Foundation modifier ──
  const foundAdj = mods.termiteFoundationAdj || 0;
  basePrice += foundAdj;

  // ── NEW: Construction multiplier ──
  const conMult = mods.termiteConstructionMult || 1.0;
  basePrice = Math.round(basePrice * conMult);

  return {
    name: 'Termite Trenching',
    price: applyOT(basePrice),
    detail: `${dirtLF} LF dirt + ${concreteLF} LF concrete`,
    perimeter: perim,
    renewal: 325,
    foundationAdj: foundAdj,
    constructionMult: conMult
  };
}


// ─────────────────────────────────────────────
// WDO INSPECTION — with construction & foundation modifiers
// ─────────────────────────────────────────────
function calcWDO(footprint, p, mods, applyOT) {
  let basePrice = 175;
  if (footprint > 2500) basePrice = 200;
  if (footprint > 3500) basePrice = 225;

  // ── NEW: WDO time multiplier based on construction + foundation ──
  const timeMult = mods.wdoTimeMult || 1.0;
  basePrice = Math.round(basePrice * timeMult);

  return {
    name: 'WDO Inspection',
    price: applyOT(basePrice),
    detail: `Wood-Destroying Organism Inspection (Form 13645)`,
    timeMult,
    constructionMaterial: p.constructionMaterial,
    foundationType: p.foundationType
  };
}


// ─────────────────────────────────────────────
// BORA-CARE
// ─────────────────────────────────────────────
function calcBoraCare(atticSqft, applyOT) {
  const BC_GAL = 91.98, BC_COV = 275, BC_EQUIP = 17.50;
  const gal = Math.max(3, Math.ceil(atticSqft / BC_COV));
  const lhr = Math.min(6, Math.max(2, 1.5 + atticSqft / 1000));
  const cost = gal * BC_GAL + lhr * LABOR_RATE + BC_EQUIP;
  return {
    name: 'Attic Termite Remediation (Bora-Care)',
    price: applyOT(Math.round(cost / 0.45)),
    detail: `~${atticSqft.toLocaleString()} sf | ${gal} gal | ${lhr.toFixed(1)} hrs`,
    atticSqft, gallons: gal, laborHrs: lhr
  };
}


// ─────────────────────────────────────────────
// PRE-SLAB
// ─────────────────────────────────────────────
function calcPreslab(slabSqft, warranty, volume, applyOT) {
  const PS_BTL = 152.10, PS_COV = 1250, PS_EQUIP = 15;
  const bottles = Math.max(1, Math.ceil(slabSqft / PS_COV));
  const lhr = Math.min(5, Math.max(1, 0.5 + slabSqft / 1500));
  const cost = bottles * PS_BTL + lhr * LABOR_RATE + PS_EQUIP;
  let price = Math.round(cost / 0.45);
  if (volume === '10') price = Math.round(price * 0.85);
  else if (volume === '5') price = Math.round(price * 0.90);
  const warrAdd = warranty === 'EXTENDED' ? 200 : 0;
  return {
    name: 'Pre-Slab Termite (Termidor SC)',
    price: applyOT(price) + warrAdd,
    detail: `${slabSqft.toLocaleString()} sf | ${bottles} bottles`,
    slabSqft, bottles, warranty, volume, warrantyAdd: warrAdd
  };
}


// ─────────────────────────────────────────────
// FOAM DRILL
// ─────────────────────────────────────────────
function calcFoam(points, applyOT) {
  const FM_CAN = 39.08, FM_BITS = 8;
  const tiers = {
    5: { c: 1, l: 1, n: 'Spot (1–5)' },
    10: { c: 2, l: 1.5, n: 'Moderate (6–10)' },
    15: { c: 3, l: 2, n: 'Extensive (11–15)' },
    20: { c: 4, l: 3, n: 'Full Perimeter' }
  };
  const t = tiers[points] || tiers[5];
  const cost = t.c * FM_CAN + t.l * LABOR_RATE + FM_BITS;
  return {
    name: 'Drill-and-Foam Termite',
    price: applyOT(Math.max(250, Math.round(cost / 0.45))),
    detail: `${t.n} | ${t.c} cans`,
    points, tier: t.n
  };
}


// ─────────────────────────────────────────────
// PLUGGING
// ─────────────────────────────────────────────
function calcPlugging(area, spacing, applyOT) {
  const cpp = 19.99 / 18;
  let ppsf, label;
  if (spacing == 6) { ppsf = 4; label = '6" Premium'; }
  else if (spacing == 9) { ppsf = 1.78; label = '9" Standard'; }
  else { ppsf = 1; label = '12" Economy'; }
  const totalPlugs = Math.ceil(area * ppsf);
  const trays = Math.ceil(totalPlugs / 18);
  const price = Math.max(250, Math.round((totalPlugs * cpp + (totalPlugs / 150) * LABOR_RATE) / (1 - 0.45)));
  const perSf = Math.round(price / area * 100) / 100;
  return {
    name: 'Lawn Plugging',
    price: applyOT(price),
    detail: `${label} | ${area.toLocaleString()} sf | ${totalPlugs.toLocaleString()} plugs | $${perSf}/sf`,
    area, spacing, totalPlugs, trays, perSf, label,
    sodWarning: spacing == 6
  };
}


// ─────────────────────────────────────────────
// TOP DRESSING
// ─────────────────────────────────────────────
function calcTopdress(turfSf, applyOT) {
  const lk = turfSf / 1000;
  const eighth = applyOT(Math.max(250, Math.round((lk * 1.04 * 4.09 + lk * 2.62 + LABOR_RATE * (turfSf / 130 + 30) / 60) / 0.40)));
  const quarter = applyOT(Math.max(450, Math.round((lk * 2.08 * 4.09 + lk * 5.24 + LABOR_RATE * (turfSf / 130 * 1.5 + 45) / 60) / 0.35)));
  return {
    name: 'Top Dressing',
    tiers: [
      { name: '1/8" Depth', price: eighth, detail: 'St. Augustine standard', recommended: true },
      { name: '1/4" Depth', price: quarter, detail: 'Bermuda / leveling', recommended: false }
    ],
    customQuoteFlag: turfSf > 3000
  };
}


// ─────────────────────────────────────────────
// RODENT TRAPPING
// ─────────────────────────────────────────────
function calcRodentTrap(footprint, lotSqFt, applyOT) {
  let p = 350;
  p += interpolate(footprint, [
    { at: 800, adj: -25 }, { at: 1500, adj: -10 }, { at: 2000, adj: 0 },
    { at: 2500, adj: 20 }, { at: 3000, adj: 40 }, { at: 4000, adj: 65 }
  ]);
  p += interpolate(lotSqFt, [
    { at: 5000, adj: 0 }, { at: 10000, adj: 10 }, { at: 15000, adj: 20 }, { at: 25000, adj: 35 }
  ]);
  return { name: 'Rodent Trapping', price: applyOT(Math.max(350, p)), detail: 'Setup + check visits' };
}


// ─────────────────────────────────────────────
// FLEA
// ─────────────────────────────────────────────
function calcFlea(footprint, p, applyOT) {
  let fi = 225, ff = 125;
  fi += interpolate(footprint, [{ at: 800, adj: -25 }, { at: 1200, adj: -15 }, { at: 1500, adj: -5 }, { at: 2000, adj: 0 }, { at: 2500, adj: 15 }, { at: 3000, adj: 25 }, { at: 4000, adj: 40 }]);
  ff += interpolate(footprint, [{ at: 800, adj: -15 }, { at: 1200, adj: -10 }, { at: 1500, adj: -3 }, { at: 2000, adj: 0 }, { at: 2500, adj: 8 }, { at: 3000, adj: 15 }, { at: 4000, adj: 25 }]);
  fi += interpolate(p.lotSqFt, [{ at: 3000, adj: -15 }, { at: 5000, adj: -5 }, { at: 7500, adj: 0 }, { at: 10000, adj: 10 }, { at: 15000, adj: 20 }, { at: 25000, adj: 35 }]);
  ff += interpolate(p.lotSqFt, [{ at: 3000, adj: -8 }, { at: 5000, adj: -3 }, { at: 7500, adj: 0 }, { at: 10000, adj: 5 }, { at: 15000, adj: 12 }, { at: 25000, adj: 20 }]);
  if (p.treeDensity === 'HEAVY') { fi += 20; ff += 10; }
  else if (p.treeDensity === 'MODERATE') { fi += 10; ff += 5; }
  if (p.landscapeComplexity === 'COMPLEX') { fi += 15; ff += 10; }
  else if (p.landscapeComplexity === 'MODERATE') { fi += 5; ff += 5; }
  fi = Math.max(185, fi); ff = Math.max(95, ff);
  return { name: 'Flea (2-visit)', price: applyOT(fi + ff), detail: `$${fi} + $${ff}` };
}


// ─────────────────────────────────────────────
// ROACH
// ─────────────────────────────────────────────
function calcRoach(footprint, p, roachType, pestResult, applyOT) {
  if (roachType === 'REGULAR') {
    const bpp = pestResult?.perApp || 117;
    return { name: 'Regular Roach', price: applyOT(Math.max(150, Math.round(bpp * 1.15 * 1.30))), detail: 'Enhanced treatment' };
  }
  let gp = 450 + interpolate(footprint, [
    { at: 800, adj: -40 }, { at: 1200, adj: -20 }, { at: 1500, adj: -10 },
    { at: 2000, adj: 0 }, { at: 2500, adj: 25 }, { at: 3000, adj: 50 }, { at: 4000, adj: 85 }
  ]);
  return { name: 'German Roach (3-visit)', price: applyOT(Math.max(400, gp)), detail: 'Gel+IGR+monitoring' };
}


// ─────────────────────────────────────────────
// STINGING INSECT
// ─────────────────────────────────────────────
function calcSting(species, tier, removal, aggressive, height, confined, urgency, afterHours, pestResult) {
  const tierBase = { 1: 150, 2: 250, 3: 435, 4: 775 };
  let price = tierBase[tier] || 250;
  const speciesNames = {
    PAPER_WASP: 'Paper Wasps', YJ_AERIAL: 'Yellow Jackets (aerial)',
    YJ_GROUND: 'Yellow Jackets (ground)', MUD_DAUBER: 'Mud Daubers',
    HONEYBEE_NEW: 'Honeybees (new)', HONEYBEE_EST: 'Honeybees (established)',
    CARPENTER: 'Carpenter Bees', BALDFACED: 'Baldfaced Hornets',
    AFRICANIZED: 'Africanized Bees'
  };

  const mods = [];
  if (aggressive === 'MILD') { price += 75; mods.push('+$75 aggressive'); }
  else if (aggressive === 'HIGH') { price += 150; mods.push('+$150 aggressive'); }
  else if (aggressive === 'EXTREME') { price += 200; mods.push('+$200 aggressive'); }
  if (height === 'MID') { price += 75; mods.push('+$75 height'); }
  else if (height === 'HIGH') { price += 150; mods.push('+$150 height'); }
  if (confined === 'YES') { const ca = tier >= 3 ? 200 : 100; price += ca; mods.push(`+$${ca} confined`); }
  if (urgency === 'SOON') { price += 75; mods.push('+$75 same-day'); }
  else if (urgency === 'URGENT') { price = Math.round(price * 1.5); mods.push('+50% emergency'); }
  if (afterHours) { price += 75; mods.push('+$75 after-hours'); }

  let removalPrice = 0, removalLabel = '';
  const removals = { SMALL: [75, 'Small nest'], LARGE: [250, 'Large comb'], HONEYCOMB: [375, 'Honeycomb extraction'], RELOCATE: [450, 'Live bee relocation'] };
  if (removals[removal]) { [removalPrice, removalLabel] = removals[removal]; }

  const total = price + removalPrice;
  const includedOnProgram = pestResult && (species === 'PAPER_WASP' || species === 'MUD_DAUBER') && tier <= 1;

  return {
    name: `Stinging Insect — ${speciesNames[species] || species}`,
    price: includedOnProgram ? 0 : total,
    detail: `Tier ${tier} — ${speciesNames[species] || species}${mods.length ? ' | ' + mods.join(', ') : ''}`,
    species, tier, mods,
    removal: removalPrice > 0 ? { name: removalLabel, price: removalPrice } : null,
    includedOnProgram
  };
}


// ─────────────────────────────────────────────
// BED BUG
// ─────────────────────────────────────────────
function calcBedbug(rooms, method, footprint, applyOT) {
  const results = [];
  if (method !== 'HEAT') {
    const lv1 = 45 + Math.max(0, (rooms - 1) * 30) + 30 + DRIVE_TIME;
    const lv2 = 25 + Math.max(0, (rooms - 1) * 20) + DRIVE_TIME;
    const mpr = 50.42;
    let cp = Math.round((mpr * rooms + LABOR_RATE * (lv1 / 60) + mpr * rooms * 0.5 + LABOR_RATE * (lv2 / 60)) / 0.35 * 100) / 100;
    const fl = 400 + (rooms - 1) * 250;
    if (cp < fl) cp = fl;
    if (footprint > 2500) cp = Math.round(cp * 1.10);
    else if (footprint > 1800) cp = Math.round(cp * 1.05);
    results.push({ method: 'Chemical', price: applyOT(cp), detail: `${rooms} room${rooms > 1 ? 's' : ''}, 2 visits` });
  }
  if (method !== 'CHEMICAL') {
    let hpr = rooms === 1 ? 1000 : rooms === 2 ? 850 : 750;
    let hp = hpr * rooms;
    if (footprint > 2500) hp = Math.round(hp * 1.10);
    else if (footprint < 1200) hp = Math.round(hp * 0.95);
    results.push({ method: 'Heat', price: applyOT(hp), detail: `${rooms} room${rooms > 1 ? 's' : ''} — $${Math.round(applyOT(hp) / rooms)}/room` });
  }
  return { name: 'Bed Bug Treatment', methods: results };
}


// ─────────────────────────────────────────────
// EXCLUSION
// ─────────────────────────────────────────────
function calcExclusion(simple, moderate, advanced, waive, applyOT) {
  const sc = simple * 37.50 + moderate * 75 + advanced * 150;
  const ep = Math.max(150, Math.round(sc));
  const insp = waive ? 0 : 85;
  const total = applyOT(ep) + insp;
  let tier = 'Basic';
  if (advanced > 0) tier = 'Advanced (Roof)';
  else if (moderate > 0) tier = 'Moderate';
  return {
    name: 'Rodent Exclusion',
    price: total,
    detail: `${tier} — ${simple + moderate + advanced} points${insp > 0 ? ' + $85 inspect' : ' (inspect waived)'}`,
    points: { simple, moderate, advanced }, inspectionFee: insp, tier
  };
}


// ─────────────────────────────────────────────
// WAVEGUARD BUNDLE CALCULATION
// ─────────────────────────────────────────────
async function calcWaveGuard(recurring) {
  let serviceCount = 0;
  let annualBeforeDiscount = 0;
  const services = [];

  // Count qualifying services and sum annual costs
  const qualifyingKeys = ['lawn', 'pest', 'treeShrub', 'mosquito', 'termiteBait'];
  qualifyingKeys.forEach(key => {
    const svc = recurring[key];
    if (!svc) return;
    serviceCount++;
    const recTier = svc.selected || svc.recommended || svc;
    const ann = recTier.annual || (recTier.monthly || svc.wgMonthly || 0) * 12;
    annualBeforeDiscount += ann;
    services.push({
      name: svc.service || key,
      monthly: recTier.monthly || svc.wgMonthly || Math.round(ann / 12 * 100) / 100
    });
  });

  // Determine tier from service count, then look up discount from DB
  let tier = 'Bronze';
  if (serviceCount >= 4) tier = 'Platinum';
  else if (serviceCount === 3) tier = 'Gold';
  else if (serviceCount === 2) tier = 'Silver';
  else tier = 'Bronze';

  let discountPct = 0;
  try {
    const DiscountEngine = require('./discount-engine');
    discountPct = await DiscountEngine.getDiscountForTier(tier);
  } catch {
    // Fallback if discount engine unavailable
    const fallback = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };
    discountPct = fallback[tier] || 0;
  }

  const discountAmount = Math.round(annualBeforeDiscount * discountPct * 100) / 100;
  const annualAfterDiscount = Math.round((annualBeforeDiscount - discountAmount) * 100) / 100;
  const monthlyAfterDiscount = Math.round(annualAfterDiscount / 12 * 100) / 100;

  return {
    tier,
    serviceCount,
    discountPct,
    discountAmount,
    annualBeforeDiscount: Math.round(annualBeforeDiscount * 100) / 100,
    annualAfterDiscount,
    monthlyBeforeDiscount: Math.round(annualBeforeDiscount / 12 * 100) / 100,
    monthlyAfterDiscount,
    services,
    savings: discountAmount
  };
}


// ─────────────────────────────────────────────
// TOTALS
// ─────────────────────────────────────────────
function calcTotals(result, manualDiscount = null) {
  const wg = result.waveguard;
  const rec = result.recurring;

  // Rodent bait is separate from WaveGuard
  const rodentBaitAnn = rec.rodentBait?.recommended?.moLow
    ? rec.rodentBait.recommended.moLow * 12
    : 0;
  const rodentBaitMo = rec.rodentBait?.recommended?.moLow || 0;

  // One-time total
  let oneTimeTotal = 0;
  const otItems = [];
  Object.values(result.oneTime).forEach(ot => {
    if (ot.price) { oneTimeTotal += ot.price; otItems.push({ name: ot.name, price: ot.price }); }
    if (ot.tiers) { const rec = ot.tiers.find(t => t.recommended) || ot.tiers[0]; oneTimeTotal += rec.price; otItems.push({ name: rec.name || ot.name, price: rec.price }); }
  });

  // Specialty total
  let specialtyTotal = 0;
  const specItems = [];
  Object.values(result.specialty).forEach(sp => {
    if (sp.methods) {
      sp.methods.forEach(m => { specialtyTotal += m.price; specItems.push({ name: `${sp.name} (${m.method})`, price: m.price }); });
    } else if (!sp.includedOnProgram && sp.price > 0) {
      specialtyTotal += sp.price;
      specItems.push({ name: sp.name, price: sp.price });
    }
  });

  // WaveGuard Membership fee — waived with annual prepay
  const membershipFee = rec.pest?.initialFee || 0;
  if (membershipFee > 0) {
    oneTimeTotal += membershipFee;
    otItems.push({ name: 'WaveGuard Membership', price: membershipFee, waivedWithPrepay: true });
  }

  // Termite bait install
  const tmInstall = rec.termiteBait?.trelona?.install || 0;
  if (tmInstall > 0) {
    oneTimeTotal += tmInstall;
    otItems.push({ name: 'Trelona Install', price: tmInstall });
  }

  const totalOneTimeAndSpecialty = oneTimeTotal + specialtyTotal;

  // ── Manual discount (applies on top of WaveGuard) ──
  let manualDiscountAmount = 0;
  let manualDiscountInfo = null;
  const baseRecurringAnn = wg.annualAfterDiscount + rodentBaitAnn;
  if (manualDiscount && Number(manualDiscount.value) > 0) {
    const v = Number(manualDiscount.value);
    if (manualDiscount.type === 'PERCENT') {
      manualDiscountAmount = Math.round(baseRecurringAnn * (v / 100) * 100) / 100;
    } else {
      manualDiscountAmount = Math.round(v * 100) / 100;
    }
    manualDiscountAmount = Math.min(manualDiscountAmount, baseRecurringAnn);
    manualDiscountInfo = {
      type: manualDiscount.type === 'PERCENT' ? 'PERCENT' : 'FIXED',
      value: v,
      amount: manualDiscountAmount,
      label: manualDiscount.label || (manualDiscount.type === 'PERCENT' ? `Discount (${v}%)` : `Discount -$${v.toFixed(2)}`),
    };
  }

  const recurringAnnual = Math.round((baseRecurringAnn - manualDiscountAmount) * 100) / 100;
  const recurringMonthly = Math.round(recurringAnnual / 12 * 100) / 100;
  const year1 = Math.round((recurringAnnual + totalOneTimeAndSpecialty) * 100) / 100;
  const year2 = recurringAnnual;
  const year2mo = recurringMonthly;

  return {
    recurringMonthly,
    recurringAnnual,
    rodentBaitMonthly: rodentBaitMo,
    rodentBaitAnnual: rodentBaitAnn,
    oneTimeItems: otItems,
    oneTimeTotal,
    specialtyItems: specItems,
    specialtyTotal,
    totalOneTimeAndSpecialty,
    year1,
    year2,
    year2Monthly: year2mo,
    waveguardTier: wg.tier,
    waveguardSavings: wg.savings,
    manualDiscount: manualDiscountInfo,
  };
}


module.exports = { calculateEstimate, invalidatePricingConfigCache, loadPricingConfig };
